// ════════════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Management Reporting (W4.2)
//  Incidents per village/month, MTTR, CSV export. Role-gated to
//  engineer/admin both here (client redirect) AND in the DB (is_editor()
//  guard inside the incidents_report() RPC — see
//  gis-engine/sql/migrations/2026-07-14-reports.sql).
//
//  Data split:
//    • Aggregates (KPIs + all 4 charts) come from ONE RPC call —
//      gSb.rpc('incidents_report', {...}) — computed server-side over the
//      full filtered set (not just the visible page).
//    • Table rows come from a plain `gSb.from('incidents').select(...)`
//      (existing incidents RLS applies, unchanged) and are paginated
//      client-side (≤50/page) — same pattern as pages/logs.html.
//
//  Pure/testable logic (date presets, RPC-param building, chart-model
//  transforms, MTTR formatting, CSV serialization + formula-injection
//  guard, pagination) is exposed on window.__reportsTest — see
//  test/reports/reports.test.js. Those functions have no runtime callers
//  of their own; the DOM-driving code below calls the SAME functions
//  directly (not through the test hook), so tests exercise real logic.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── Canonical village list (matches js/pages/index.js / js/gis-field.js) ──
  var VILLAGES = ['מגד אל-כרום', 'בענה', 'דיר אל-אסד', 'נחף', 'סחנין', 'דיר חנא', 'עראבה'];

  var STATUS_LABEL   = { open: 'פתוחה', in_progress: 'בטיפול', closed: 'סגורה' };
  var PRIORITY_LABEL = { high: 'גבוהה', medium: 'בינונית', low: 'נמוכה' };
  var PRIORITY_ORDER = ['high', 'medium', 'low'];
  var PRIORITY_COLOR = { high: 'var(--red)', medium: 'var(--amber)', low: 'var(--green)' };
  var CSV_HEADER = ['כותרת', 'ישוב', 'עדיפות', 'סטטוס', 'נפתח', 'נסגר', 'ימים פתוחה'];
  var PAGE_SIZE = 50;

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  // ── date-preset computation (pure) ────────────────────────────────────────
  function toISODate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function computeDatePreset(days, now) {
    now = now || new Date();
    var to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var from = new Date(to);
    from.setDate(from.getDate() - (Math.max(1, days) - 1));
    return { from: toISODate(from), to: toISODate(to) };
  }

  // ── UTC day-boundary helper — shared by both the RPC call and the raw
  //    table-rows query, so both see an identical [from 00:00, to+1 00:00)
  //    window. Mirrors the migration's `p_to::date + 1` exclusive-upper-bound
  //    trick so a UI date range of "today to today" includes all of today.
  function dateRangeTimestamps(fromISO, toISO) {
    var start = fromISO + 'T00:00:00.000Z';
    var toDate = new Date(toISO + 'T00:00:00.000Z');
    toDate.setUTCDate(toDate.getUTCDate() + 1);
    return { start: start, endExclusive: toDate.toISOString() };
  }

  // ── filter state → RPC param object (pure) ────────────────────────────────
  function buildRpcParams(filters) {
    filters = filters || {};
    var villages = Array.isArray(filters.villages) ? filters.villages.filter(Boolean) : [];
    return {
      p_from: filters.from || null,
      p_to: filters.to || null,
      p_villages: villages.length ? villages : null,
      p_status: filters.status || 'all'
    };
  }

  // ── month-range generator + monthly bucketing incl. empty months (pure) ──
  function monthRange(fromISO, toISO) {
    var months = [];
    var f = fromISO.split('-'), t = toISO.split('-');
    var y = parseInt(f[0], 10), m = parseInt(f[1], 10);
    var ey = parseInt(t[0], 10), em = parseInt(t[1], 10);
    var guard = 0;
    while ((y < ey || (y === ey && m <= em)) && guard < 1000) {
      months.push(y + '-' + pad2(m));
      m++; if (m > 12) { m = 1; y++; }
      guard++;
    }
    return months;
  }
  function bucketMonthly(monthlyArr, fromISO, toISO) {
    var byMonth = {};
    (monthlyArr || []).forEach(function (r) { byMonth[r.month] = r; });
    return monthRange(fromISO, toISO).map(function (mo) {
      var r = byMonth[mo];
      return { month: mo, total: r ? (r.total || 0) : 0, open: r ? (r.open || 0) : 0, closed: r ? (r.closed || 0) : 0 };
    });
  }

  // ── village sorting (pure) — count desc, Hebrew-collated tie-break ────────
  function sortVillageCounts(arr) {
    return (arr || []).slice().sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return String(a.village).localeCompare(String(b.village), 'he');
    });
  }

  // ── priority percentages (pure) ────────────────────────────────────────────
  function priorityPercentages(arr) {
    var counts = { high: 0, medium: 0, low: 0 };
    (arr || []).forEach(function (r) { if (counts.hasOwnProperty(r.priority)) counts[r.priority] = r.count || 0; });
    var total = counts.high + counts.medium + counts.low;
    var out = {};
    PRIORITY_ORDER.forEach(function (p) {
      out[p] = { count: counts[p], pct: total ? Math.round((counts[p] / total) * 1000) / 10 : 0 };
    });
    return out;
  }

  // ── MTTR formatting (pure) ────────────────────────────────────────────────
  function formatMTTR(days) {
    if (days == null || isNaN(days)) return '—';
    return (Math.round(days * 10) / 10).toFixed(1) + ' ימים';
  }

  // ── days-open for the table (pure; `now` injectable for tests) ───────────
  function daysOpen(createdAt, closedAt, now) {
    if (!createdAt) return 0;
    var start = new Date(createdAt).getTime();
    var end = closedAt ? new Date(closedAt).getTime() : (now || new Date()).getTime();
    if (isNaN(start) || isNaN(end)) return 0;
    return Math.max(0, Math.round(((end - start) / 86400000) * 10) / 10);
  }

  // ── simple DD/MM/YYYY formatter (pure, UTC-based so it is 100%
  //    timezone-independent/deterministic for CSV export + tests, unlike
  //    Date's local getters; on-screen table uses toLocaleDateString like
  //    other pages — see renderTable — where local-timezone display IS the
  //    intent) ─────────────────────────────────────────────────────────
  function formatDateShort(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getUTCDate()) + '/' + pad2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
  }

  function statusLabel(s) { return STATUS_LABEL[s] || s || '—'; }
  function priorityLabel(p) { return PRIORITY_LABEL[p] || p || '—'; }

  // ── CSV formula-injection guard (pure) — mirrors js/export-formats.js
  //    buildCSV() / js/gis-feature-table.js csvEscapeCell() exactly (CWE-1236):
  //    a cell whose first char is = + - @ TAB or CR is run as a live formula
  //    by Excel/Sheets; prefix ' to force plain text, then escape quotes. ──
  function csvEscapeCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    s = s.replace(/"/g, '""');
    return '"' + s + '"';
  }

  // ── full CSV serialization (pure) — rows are raw incident objects ────────
  function buildReportCSV(rows) {
    var lines = [CSV_HEADER.map(csvEscapeCell).join(',')];
    (rows || []).forEach(function (r) {
      var closedAt = r.status === 'closed' ? r.closed_at : null;
      var open = daysOpen(r.created_at, closedAt);
      lines.push([
        r.title || '',
        r.village || '',
        priorityLabel(r.priority),
        statusLabel(r.status),
        formatDateShort(r.created_at),
        closedAt ? formatDateShort(closedAt) : '',
        open
      ].map(csvEscapeCell).join(','));
    });
    return lines.join('\r\n');
  }

  // ── client-side pagination (pure) ─────────────────────────────────────────
  function paginate(rows, page, pageSize) {
    rows = rows || [];
    pageSize = pageSize || PAGE_SIZE;
    var totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.min(Math.max(0, page || 0), totalPages - 1);
    var start = page * pageSize;
    return { page: page, totalPages: totalPages, items: rows.slice(start, start + pageSize), total: rows.length };
  }

  // Test-only hook (same convention as GISTable._test / review.js) — pure
  // logic only, no DOM/network. See test/reports/reports.test.js.
  window.__reportsTest = {
    VILLAGES: VILLAGES,
    computeDatePreset: computeDatePreset,
    dateRangeTimestamps: dateRangeTimestamps,
    buildRpcParams: buildRpcParams,
    monthRange: monthRange,
    bucketMonthly: bucketMonthly,
    sortVillageCounts: sortVillageCounts,
    priorityPercentages: priorityPercentages,
    formatMTTR: formatMTTR,
    daysOpen: daysOpen,
    formatDateShort: formatDateShort,
    statusLabel: statusLabel,
    priorityLabel: priorityLabel,
    csvEscapeCell: csvEscapeCell,
    buildReportCSV: buildReportCSV,
    paginate: paginate
  };

  if (typeof window === 'undefined' || !window.document || !window.document.getElementById) return;

  // ══════════════════════════════════════════════════════════════════════
  //  DOM / network glue — everything below drives the actual page.
  // ══════════════════════════════════════════════════════════════════════
  var gVillagesSel = {};   // village -> true when selected
  var gAgg = null;         // last incidents_report() payload
  var gRows = [];          // last raw table rows (full filtered set)
  var gPage = 0;

  function esc(v) { return window.escHtml ? window.escHtml(v) : String(v == null ? '' : v); }
  function toast(msg, type) { if (window.MotionUtils) MotionUtils.showToast(msg, type); }
  function sb() { return window.gSb; }

  window.addEventListener('load', init);

  async function init() {
    var s = await sb().auth.getSession();
    if (!s.data || !s.data.session) { window.location.replace('login.html'); return; }
    var prof = await getProfile(s.data.session.user, true);
    if (!prof) return;
    if (prof.role !== 'engineer' && prof.role !== 'admin') { window.location.replace('../index.html'); return; }

    document.getElementById('role-badge').textContent = prof.role === 'admin' ? 'מנהל מערכת' : 'מהנדס';
    if (prof.role !== 'admin') {
      var la = document.getElementById('link-admin'); if (la) la.remove();
      var ll = document.getElementById('link-logs');  if (ll) ll.remove();
    }

    buildVillageChips();
    wireFilters();

    var preset = computeDatePreset(90);
    document.getElementById('f-from').value = preset.from;
    document.getElementById('f-to').value = preset.to;

    document.body.classList.add('ready');
    if (window.MotionUtils) MotionUtils.animatePageIn();
    loadReport();
  }

  function buildVillageChips() {
    var wrap = document.getElementById('f-villages');
    wrap.innerHTML = VILLAGES.map(function (v) {
      return '<button type="button" class="village-chip" data-village="' + esc(v) + '">' + esc(v) + '</button>';
    }).join('');
    wrap.querySelectorAll('.village-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-village');
        gVillagesSel[v] = !gVillagesSel[v];
        btn.classList.toggle('on', !!gVillagesSel[v]);
      });
    });
  }

  function wireFilters() {
    document.querySelectorAll('.preset-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var days = parseInt(btn.getAttribute('data-days'), 10);
        var preset = computeDatePreset(days);
        document.getElementById('f-from').value = preset.from;
        document.getElementById('f-to').value = preset.to;
        loadReport();
      });
    });
    document.getElementById('btn-apply').addEventListener('click', function () { gPage = 0; loadReport(); });
    document.getElementById('report-retry').addEventListener('click', loadReport);
    document.getElementById('btn-csv').addEventListener('click', exportCSV);
    document.getElementById('btn-print').addEventListener('click', function () { window.print(); });
    document.getElementById('report-prev').addEventListener('click', function () { gPage--; renderTable(); });
    document.getElementById('report-next').addEventListener('click', function () { gPage++; renderTable(); });
  }

  function currentFilters() {
    var from = document.getElementById('f-from').value;
    var to = document.getElementById('f-to').value;
    var status = document.getElementById('f-status').value;
    var villages = Object.keys(gVillagesSel).filter(function (v) { return gVillagesSel[v]; });
    return { from: from, to: to, status: status, villages: villages };
  }

  function showError(msg) {
    document.getElementById('report-error-msg').textContent = msg || 'שגיאה בטעינת הדוח.';
    document.getElementById('report-error').style.display = 'flex';
  }
  function hideError() { document.getElementById('report-error').style.display = 'none'; }

  async function loadReport() {
    var filters = currentFilters();
    if (!filters.from || !filters.to) { toast('יש לבחור טווח תאריכים', 'error'); return; }
    if (filters.from > filters.to) { toast('"מתאריך" חייב להיות לפני "עד תאריך"', 'error'); return; }

    hideError();
    renderKpiSkeletons();
    ['chart-monthly', 'chart-village', 'chart-priority', 'chart-trend'].forEach(function (id) {
      document.getElementById(id).innerHTML = '<div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row" style="width:70%"></div><div class="skeleton skeleton-row" style="width:50%"></div>';
    });
    document.getElementById('report-table-wrap').innerHTML = '<div class="empty"><div class="empty-icon">⏳</div>טוען...</div>';

    var params = buildRpcParams(filters);

    try {
      var [aggRes, rows] = await Promise.all([
        sb().rpc('incidents_report', params),
        fetchTableRows(filters)
      ]);
      if (aggRes.error) throw aggRes.error;
      gAgg = aggRes.data || {};
      gRows = rows;
      gPage = 0;
      renderKpis(gAgg);
      renderCharts(gAgg, filters);
      renderTable();
    } catch (e) {
      console.error('reports: loadReport failed', e);
      showError('שגיאה בטעינת הדוח: ' + (e && e.message ? e.message : 'שגיאה לא ידועה'));
      renderKpiSkeletons(true);
      ['chart-monthly', 'chart-village', 'chart-priority', 'chart-trend'].forEach(function (id) {
        document.getElementById(id).innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div>שגיאה בטעינה</div>';
      });
      document.getElementById('report-table-wrap').innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div>שגיאה בטעינה</div>';
    }
  }

  async function fetchTableRows(filters) {
    var range = dateRangeTimestamps(filters.from, filters.to);
    var q = sb().from('incidents').select('*')
      .gte('created_at', range.start)
      .lt('created_at', range.endExclusive)
      .order('created_at', { ascending: false });
    if (filters.status === 'open') q = q.neq('status', 'closed');
    else if (filters.status === 'closed') q = q.eq('status', 'closed');
    if (filters.villages && filters.villages.length) q = q.in('village', filters.villages);
    var res = await q;
    if (res.error) throw res.error;
    return res.data || [];
  }

  function renderKpiSkeletons(isError) {
    ['kpi-total', 'kpi-open', 'kpi-closed', 'kpi-mttr'].forEach(function (id) {
      document.getElementById(id).innerHTML = isError ? '—' : '<span class="skeleton skeleton-title" style="width:40%"></span>';
    });
  }

  function renderKpis(agg) {
    document.getElementById('kpi-total').textContent  = (agg.total || 0).toLocaleString('he-IL');
    document.getElementById('kpi-open').textContent   = (agg.open || 0).toLocaleString('he-IL');
    document.getElementById('kpi-closed').textContent = (agg.closed || 0).toLocaleString('he-IL');
    document.getElementById('kpi-mttr').textContent   = formatMTTR(agg.mttr_days);
  }

  function barRow(label, count, max) {
    var pct = max > 0 ? Math.round((count / max) * 100) : 0;
    return '<div class="bar-row"><span class="bar-label" title="' + esc(label) + '">' + esc(label) + '</span>' +
      '<span class="bar-track"><i style="width:' + pct + '%"></i></span>' +
      '<span class="bar-count">' + count + '</span></div>';
  }

  function monthLabel(ym) {
    var parts = ym.split('-');
    var MONTHS_HE = ['ינו', 'פבר', 'מרץ', 'אפר', 'מאי', 'יונ', 'יול', 'אוג', 'ספט', 'אוק', 'נוב', 'דצמ'];
    var mi = parseInt(parts[1], 10) - 1;
    return (MONTHS_HE[mi] || parts[1]) + " '" + parts[0].slice(2);
  }

  function renderCharts(agg, filters) {
    renderMonthlyChart(agg, filters);
    renderVillageChart(agg);
    renderPriorityChart(agg);
    renderTrendChart(agg, filters);
  }

  function renderMonthlyChart(agg, filters) {
    var el = document.getElementById('chart-monthly');
    var months = bucketMonthly(agg.monthly, filters.from, filters.to);
    if (!months.length || !months.some(function (m) { return m.total > 0; })) {
      el.innerHTML = '<div class="empty">אין נתונים בטווח שנבחר</div>'; return;
    }
    var max = months.reduce(function (m, r) { return Math.max(m, r.total); }, 1);
    el.innerHTML = '<div class="vbar-chart">' + months.map(function (r) {
      var h = max > 0 ? Math.round((r.total / max) * 100) : 0;
      return '<div class="vbar-col"><div class="vbar-track"><i style="height:' + h + '%" title="' + r.total + '"></i></div>' +
        '<span class="vbar-n">' + r.total + '</span><span class="vbar-label">' + monthLabel(r.month) + '</span></div>';
    }).join('') + '</div>';
  }

  function renderVillageChart(agg) {
    var el = document.getElementById('chart-village');
    var sorted = sortVillageCounts(agg.by_village);
    if (!sorted.length) { el.innerHTML = '<div class="empty">אין נתונים בטווח שנבחר</div>'; return; }
    var max = sorted.reduce(function (m, r) { return Math.max(m, r.count); }, 1);
    el.innerHTML = sorted.map(function (r) { return barRow(r.village, r.count, max); }).join('');
  }

  function renderPriorityChart(agg) {
    var el = document.getElementById('chart-priority');
    var pct = priorityPercentages(agg.by_priority);
    var total = pct.high.count + pct.medium.count + pct.low.count;
    if (!total) { el.innerHTML = '<div class="empty">אין נתונים בטווח שנבחר</div>'; return; }
    var segs = PRIORITY_ORDER.map(function (p) {
      return '<i style="width:' + pct[p].pct + '%;background:' + PRIORITY_COLOR[p] + '" title="' + priorityLabel(p) + ': ' + pct[p].count + '"></i>';
    }).join('');
    var legend = PRIORITY_ORDER.map(function (p) {
      return '<span class="prio-legend-item"><i style="background:' + PRIORITY_COLOR[p] + '"></i>' + priorityLabel(p) + ' — ' + pct[p].count + ' (' + pct[p].pct + '%)</span>';
    }).join('');
    el.innerHTML = '<div class="stacked-bar">' + segs + '</div><div class="prio-legend">' + legend + '</div>';
  }

  function renderTrendChart(agg, filters) {
    var el = document.getElementById('chart-trend');
    var months = bucketMonthly(agg.monthly, filters.from, filters.to);
    if (!months.length || !months.some(function (m) { return m.total > 0; })) {
      el.innerHTML = '<div class="empty">אין נתונים בטווח שנבחר</div>'; return;
    }
    var max = months.reduce(function (m, r) { return Math.max(m, r.open, r.closed); }, 1);
    el.innerHTML = '<div class="trend-legend"><span class="prio-legend-item"><i style="background:var(--amber)"></i>פתוחות</span>' +
      '<span class="prio-legend-item"><i style="background:var(--green)"></i>סגורות</span></div>' +
      '<div class="vbar-chart">' + months.map(function (r) {
        var ho = max > 0 ? Math.round((r.open / max) * 100) : 0;
        var hc = max > 0 ? Math.round((r.closed / max) * 100) : 0;
        return '<div class="vbar-col"><div class="vbar-group">' +
          '<div class="vbar-track"><i style="height:' + ho + '%;background:var(--amber)" title="פתוחות: ' + r.open + '"></i></div>' +
          '<div class="vbar-track"><i style="height:' + hc + '%;background:var(--green)" title="סגורות: ' + r.closed + '"></i></div>' +
          '</div><span class="vbar-label">' + monthLabel(r.month) + '</span></div>';
      }).join('') + '</div>';
  }

  function renderTable() {
    var wrap = document.getElementById('report-table-wrap');
    document.getElementById('table-count').textContent = gRows.length;
    if (!gRows.length) {
      wrap.innerHTML = '<div class="empty"><div class="empty-icon">📭</div>אין נתונים בטווח שנבחר</div>';
      document.getElementById('report-pagination').style.display = 'none';
      return;
    }
    var pg = paginate(gRows, gPage, PAGE_SIZE);
    gPage = pg.page;

    wrap.innerHTML = '<table class="report-table"><thead><tr>' +
      '<th>כותרת</th><th>ישוב</th><th>עדיפות</th><th>סטטוס</th><th>נפתח</th><th>נסגר</th><th>ימים פתוחה</th>' +
      '</tr></thead><tbody>' +
      pg.items.map(function (r) {
        var closedAt = r.status === 'closed' ? r.closed_at : null;
        var open = daysOpen(r.created_at, closedAt);
        var created = r.created_at ? new Date(r.created_at).toLocaleDateString('he-IL') : '—';
        var closed = closedAt ? new Date(closedAt).toLocaleDateString('he-IL') : '—';
        return '<tr>' +
          '<td>' + esc(r.title || '—') + '</td>' +
          '<td>' + esc(r.village || '—') + '</td>' +
          '<td><span class="priority-pill priority-' + esc(r.priority) + '">' + priorityLabel(r.priority) + '</span></td>' +
          '<td><span class="status-pill status-' + esc(r.status) + '">' + statusLabel(r.status) + '</span></td>' +
          '<td>' + created + '</td>' +
          '<td>' + closed + '</td>' +
          '<td>' + open + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table>';

    if (window.MotionUtils) MotionUtils.animateTableRows(document.querySelector('#report-table-wrap tbody'));

    document.getElementById('report-pagination').style.display = pg.totalPages > 1 ? 'flex' : 'none';
    document.getElementById('report-page-info').textContent = 'עמוד ' + (pg.page + 1) + ' מתוך ' + pg.totalPages + ' · ' + pg.total + ' רשומות';
    document.getElementById('report-prev').disabled = pg.page === 0;
    document.getElementById('report-next').disabled = pg.page >= pg.totalPages - 1;
  }

  function exportCSV() {
    if (!gRows.length) { toast('אין נתונים לייצוא', 'error'); return; }
    var csv = buildReportCSV(gRows);
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    a.href = url; a.download = 'דוח-תקלות-' + ts + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast('✓ יוצא CSV — ' + gRows.length + ' שורות', 'success');
  }
})();
