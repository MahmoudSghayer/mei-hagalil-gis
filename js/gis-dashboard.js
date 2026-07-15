/* ══════════════════════════════════════════════════════════════════════════
   Ops Dashboard (B1) — admin/engineer overview. KPI tiles: open incidents,
   pending field submissions, meter anomalies, total meters, layers/villages.
   Self-contained IIFE; opened from the ribbon (ניתוח → סקירת מערכת).
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function sb() { return window.GIS ? GIS.sb() : window.gSb; }
  // esc() centralized in auth.js (window.escHtml)
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2200); }
  // "<village> · <category>" via LayerNaming when loaded; identical inline fallback (load-order safety)
  function parseLayerName(name) {
    name = name || '';
    if (window.LayerNaming) return LayerNaming.parse(name);
    var i = name.indexOf(' · ');
    return i >= 0 ? { village: name.slice(0, i), category: name.slice(i + 3) } : { village: null, category: name };
  }
  // { village, category } for a FULL layer row — prefers the DB-derived
  // columns (layer.village/category — W5.2) via LayerNaming.fromRow when
  // loaded; falls back to parsing layer.name (parseLayerName above)
  // otherwise. `layers` here always comes from GIS.layers.getLayers().
  function rowVC(layer) {
    if (window.LayerNaming && LayerNaming.fromRow) return LayerNaming.fromRow(layer);
    return parseLayerName(layer && layer.name);
  }

  var css = document.createElement('style');
  css.textContent =
    '#gis-dash-bg{position:fixed;inset:0;z-index:1700;background:rgba(7,30,48,.55);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;padding:16px}' +
    '#gis-dash-bg.open{display:flex}' +
    '#gis-dash{background:#fff;border-radius:16px;width:640px;max-width:96vw;max-height:90vh;overflow:auto;direction:rtl;font-family:"Rubik",sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.35)}' +
    '.gd-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:linear-gradient(135deg,#0d3b5e,#1a7fc1);color:#fff}' +
    '.gd-head .t{font-size:16px;font-weight:700}.gd-x{background:rgba(255,255,255,.18);border:none;color:#fff;width:28px;height:28px;border-radius:7px;cursor:pointer;font-size:14px}' +
    '.gd-body{padding:16px 18px}' +
    '.gd-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}' +
    '.gd-tile{background:#f8fafc;border:1px solid #eef2f6;border-radius:12px;padding:12px 14px}' +
    '.gd-tile .n{font-size:26px;font-weight:800;color:#0d3b5e;line-height:1}.gd-tile .l{font-size:11.5px;color:#64748b;margin-top:5px}' +
    '.gd-tile.alert .n{color:#dc2626}.gd-tile.warn .n{color:#b45309}.gd-tile.ok .n{color:#0d9488}' +
    '.gd-sec{font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 8px}' +
    '.gd-vrow{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12.5px}' +
    '.gd-vrow .nm{width:90px;flex-shrink:0;color:#1e293b}.gd-vrow .bar{flex:1;height:9px;background:#eef2f6;border-radius:5px;overflow:hidden}' +
    '.gd-vrow .bar i{display:block;height:100%;background:#1a7fc1}.gd-vrow .ct{width:54px;text-align:left;color:#64748b}' +
    '.gd-empty{color:#94a3b8;font-size:12.5px;padding:8px 0}';
  document.head.appendChild(css);

  var bg;
  function build() {
    bg = document.createElement('div'); bg.id = 'gis-dash-bg';
    bg.innerHTML = '<div id="gis-dash"><div class="gd-head"><span class="t">📊 סקירת מערכת</span><button class="gd-x" title="סגור">✕</button></div><div class="gd-body" id="gd-body"></div></div>';
    document.body.appendChild(bg);
    bg.querySelector('.gd-x').onclick = close;
    bg.onclick = function (e) { if (e.target === bg) close(); };
  }
  function close() { if (bg) bg.classList.remove('open'); }
  function tile(n, l, cls) { return '<div class="gd-tile ' + (cls || '') + '"><div class="n">' + n + '</div><div class="l">' + esc(l) + '</div></div>'; }

  async function open() {
    if (!window.GIS) { toast('המנוע עדיין נטען…'); return; }
    if (!bg) build();
    bg.classList.add('open');
    var body = document.getElementById('gd-body');
    body.innerHTML = '<div class="gd-empty">טוען נתונים…</div>';

    var openInc = '—', pending = '—', anomalies = '—', meters = '—', layers = [];
    await Promise.all([
      sb().from('incidents').select('id', { count: 'exact', head: true }).eq('status', 'open').then(function (r) { openInc = r.count != null ? r.count : '—'; }).catch(function () {}),
      sb().rpc('review_queue').then(function (r) { pending = (r.data || []).length; }).catch(function () {}),
      (GIS.meters && GIS.meters.getAnomalies ? GIS.meters.getAnomalies() : Promise.resolve([])).then(function (a) { anomalies = (a || []).length; }).catch(function () {}),
      (GIS.meters && GIS.meters.countMeters ? GIS.meters.countMeters() : Promise.resolve(null)).then(function (c) { meters = c && c.total != null ? c.total : '—'; }).catch(function () {}),
      GIS.layers.getLayers().then(function (ls) { layers = ls || []; }).catch(function () {})
    ]);

    // group layers by village (prefers layer.village/category — W5.2 — via
    // rowVC, falls back to parsing name = "<village> · <category>")
    var byV = {};
    layers.forEach(function (l) { var v = rowVC(l).village || 'כללי'; byV[v] = (byV[v] || 0) + 1; });
    var vEntries = Object.keys(byV).map(function (v) { return [v, byV[v]]; }).sort(function (a, b) { return b[1] - a[1]; });
    var maxv = vEntries.reduce(function (m, e) { return Math.max(m, e[1]); }, 1);

    var html = '<div class="gd-tiles">' +
      tile(openInc, 'תקלות פתוחות', 'alert') +
      tile(pending, 'ממתינות לבדיקה', 'warn') +
      tile(anomalies, 'חריגות מונים', 'warn') +
      tile(typeof meters === 'number' ? meters.toLocaleString('he-IL') : meters, 'מוני מים') +
      tile(layers.length, 'שכבות') +
      tile(vEntries.length, 'ישובים') +
    '</div>';
    html += '<div class="gd-sec">שכבות לפי ישוב</div>';
    html += vEntries.length ? vEntries.map(function (e) {
      return '<div class="gd-vrow"><span class="nm" title="' + esc(e[0]) + '">' + esc(e[0]) + '</span>' +
        '<span class="bar"><i style="width:' + Math.round(100 * e[1] / maxv) + '%"></i></span><span class="ct">' + e[1] + ' שכ׳</span></div>';
    }).join('') : '<div class="gd-empty">אין שכבות עדיין</div>';
    body.innerHTML = html;
  }

  window.GISDashboard = {
    open: open,
    // Exposed so the row-preferring lookup (LayerNaming.fromRow-backed, with
    // a name-parse fallback) is independently unit-testable (W5.2).
    _rowVC: rowVC,
    _parseLayerName: parseLayerName
  };
})();
