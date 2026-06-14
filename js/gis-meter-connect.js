/* ══════════════════════════════════════════════════════════════════════════
   GIS Meter Connect — water-meter → pipeline auto-connection (ArcGIS "Near").
   • Auto-connect  — KNN nearest pipe within a metric threshold (server-side),
                     leaving out-of-range meters flagged 'NONE' for review.
   • Show links    — draws meter→pipe connector lines for meters in view
                     (green = AUTO, blue = MANUAL) and ⚠ for unconnected.
   • Edit link     — click a meter → accept / change / remove its connection.

   Logic lives in PostGIS (gis-engine/sql/meter_connect.sql); this module only
   drives it through GIS.meters.* and renders on window.gMap. Self-contained
   IIFE; reuses the .gis-anly-* / .gad-* dialog+card styles from arcgis-pro.css.
   Wired from the רשת ribbon tab. Admin-only actions (RLS enforces it too).
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // category key → pipe network role (mirrors GISTrace.ROLE_BY_CAT).
  var PIPE_ROLE = {
    water_pipes: 'water', supply_pipe: 'water',
    sewage_pipes: 'sewer', main_sewer: 'sewer'
  };
  var DEFAULT_THRESHOLD_M = 25;
  var CLICK_FIND_M = 30;     // max click→meter pick distance when editing

  var state = { connLayer: null, editArmed: false, editHandler: null };

  // ── helpers ───────────────────────────────────────────────────────────────
  function ready() {
    if (!window.GIS || !window.gMap) { toast('המנוע עדיין נטען…'); return false; }
    return true;
  }
  function toast(msg, type) {
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.className = (type ? type + ' ' : '') + 'show';
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = ''; }, 2800);
  }
  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function num(n) { return (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('he-IL'); }
  // metres between two [lng,lat]
  function distM(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b[1] - a[1]) * toR, dLng = (b[0] - a[0]) * toR;
    var la1 = a[1] * toR, la2 = b[1] * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bboxOfView(padM) {
    var b = window.gMap.getBounds();
    var dLat = (padM || 0) / 110540;
    var dLng = (padM || 0) / (111320 * Math.cos(b.getCenter().lat * Math.PI / 180) || 1);
    return {
      minLng: b.getWest() - dLng, minLat: b.getSouth() - dLat,
      maxLng: b.getEast() + dLng, maxLat: b.getNorth() + dLat
    };
  }

  // pipe layers grouped by village, classified by category role.
  async function pipeLayers() {
    var ls = await GIS.layers.getLayers();
    return ls.map(function (l) {
      var i = l.name.indexOf(' · ');
      var cat = i >= 0 ? l.name.slice(i + 3) : l.name;
      return {
        id: l.id, name: l.name,
        village: i >= 0 ? l.name.slice(0, i) : '',
        role: PIPE_ROLE[cat] || null, geometry_type: l.geometry_type
      };
    }).filter(function (l) { return l.role === 'water' || l.role === 'sewer'; });
  }

  // ── dialog framework (mirrors gis-analysis) ─────────────────────────────────
  function row(label, inner) { return '<div class="gad-row"><label>' + label + '</label>' + inner + '</div>'; }
  function openDialog(title, bodyHTML, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var bg = document.createElement('div'); bg.className = 'gis-anly-bg';
      bg.innerHTML =
        '<div class="gis-anly-dlg"><div class="gad-head">' + title + '<button class="gad-x">✕</button></div>' +
        '<div class="gad-body">' + bodyHTML + '</div>' +
        '<div class="gad-foot"><button class="gad-ok">הפעל</button><button class="gad-cancel">ביטול</button></div></div>';
      document.body.appendChild(bg);
      if (opts.onRender) opts.onRender(bg);
      function done(v) { bg.remove(); resolve(v); }
      bg.querySelector('.gad-x').onclick = function () { done(null); };
      bg.querySelector('.gad-cancel').onclick = function () { done(null); };
      bg.onclick = function (e) { if (e.target === bg) done(null); };
      bg.querySelector('.gad-ok').onclick = function () { done(opts.collect ? opts.collect(bg) : {}); };
    });
  }

  // ── 1) Auto-connect run dialog ──────────────────────────────────────────────
  async function run() {
    if (!ready()) return;
    var layers;
    try { layers = await pipeLayers(); }
    catch (e) { toast('שגיאה בטעינת שכבות הצנרת'); return; }
    if (!layers.length) { toast('אין שכבות צנרת במנוע'); return; }

    var villages = [];
    layers.forEach(function (l) { if (l.village && villages.indexOf(l.village) === -1) villages.push(l.village); });
    var vOpts = '<option value="__all">כל הכפרים</option>' +
      villages.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');

    var body =
      row('כפר', '<select id="mc-village" class="gad-in">' + vOpts + '</select>') +
      row('רשת', '<select id="mc-net" class="gad-in">' +
        '<option value="water">מים</option><option value="sewer">ביוב</option>' +
        '<option value="both">מים + ביוב</option></select>') +
      row('מרחק מרבי (מ׳)', '<input id="mc-thr" class="gad-in" type="number" value="' + DEFAULT_THRESHOLD_M + '" min="1" step="1">') +
      '<label class="gad-chk"><input type="checkbox" id="mc-unset" checked> חבר רק מונים שעדיין לא חוברו</label>' +
      '<div class="gad-note">מונה שאין צינור בטווחו יושאר ללא חיבור ויסומן לבדיקה. חיבורים ידניים לא ישתנו.</div>';

    var res = await openDialog('🔗 חיבור מונים לצנרת', body, {
      collect: function (bg) {
        return {
          village: bg.querySelector('#mc-village').value,
          net: bg.querySelector('#mc-net').value,
          thr: parseFloat(bg.querySelector('#mc-thr').value) || DEFAULT_THRESHOLD_M,
          onlyUnset: bg.querySelector('#mc-unset').checked
        };
      }
    });
    if (!res) return;

    // resolve layer set
    var sel = layers.filter(function (l) {
      if (res.village !== '__all' && l.village !== res.village) return false;
      if (res.net !== 'both' && l.role !== res.net) return false;
      return true;
    });
    if (!sel.length) { toast('אין שכבות צנרת תואמות לבחירה'); return; }
    var layerIds = sel.map(function (l) { return l.id; });

    // scope meters to the village's extent (avoids matching far meters / timeout).
    var bbox = null;
    if (res.village !== '__all') {
      try {
        var ext = await GIS.layers.extent(layerIds); // [minLng,minLat,maxLng,maxLat]
        if (ext && ext.length === 4) {
          var padLat = res.thr / 110540, padLng = res.thr / 90000;
          bbox = { minLng: ext[0] - padLng, minLat: ext[1] - padLat, maxLng: ext[2] + padLng, maxLat: ext[3] + padLat };
        }
      } catch (e) { /* fall back to no bbox */ }
    }

    toast('מחבר מונים…');
    try {
      var r = await GIS.meters.autoConnect(layerIds, { thresholdM: res.thr, onlyUnset: res.onlyUnset, bbox: bbox });
      summaryCard(r, res);
      try { await renderConnectors(); } catch (e) {}
    } catch (e) {
      toast((e && e.message) ? e.message.replace('[GIS] ', '') : 'שגיאה בחיבור המונים', 'error');
    }
  }

  function summaryCard(r, req) {
    closeCard('gis-mc-card');
    var el = document.createElement('div'); el.id = 'gis-mc-card'; el.className = 'gis-mc-card';
    el.innerHTML =
      '<div class="gtc-head"><span>🔗 חיבור מונים</span><button class="gtc-x" title="סגור">✕</button></div>' +
      '<div class="gtc-sub">' + (req.village === '__all' ? 'כל הכפרים' : esc(req.village)) +
        ' · רשת ' + ({ water: 'מים', sewer: 'ביוב', both: 'מים + ביוב' }[req.net]) +
        ' · עד ' + num(r.threshold_m) + ' מ׳</div>' +
      '<div class="gtc-stats">' +
        stat(num(r.connected), 'חוברו') +
        stat(num(r.unmatched), 'ללא צינור בטווח') +
      '</div>' +
      '<div class="gtc-stats">' +
        stat(num(r.targets), 'נבדקו') +
        stat(num(r.ambiguous), 'דו-משמעיים') +
      '</div>' +
      (r.ambiguous ? '<div class="gtc-warn">⚠ ' + num(r.ambiguous) + ' מונים עם צינור שני קרוב כמעט באותו מרחק — מומלץ לבדוק ידנית.</div>' : '') +
      (r.unmatched ? '<div class="gtc-warn">⚠ ' + num(r.unmatched) + ' מונים נותרו ללא חיבור (לא נמצא צינור בטווח).</div>' : '') +
      '<div class="gtc-actions">' +
        '<button class="gac-btn" id="mc-show">🧷 הצג חיבורים</button>' +
        '<button class="gac-btn ghost" id="mc-close">סגור</button>' +
      '</div>';
    document.body.appendChild(el);
    el.querySelector('.gtc-x').onclick = function () { el.remove(); };
    el.querySelector('#mc-close').onclick = function () { el.remove(); };
    el.querySelector('#mc-show').onclick = function () { renderConnectors().catch(function () {}); };
  }
  function stat(n, l) { return '<div class="gtc-stat"><div class="gtc-n">' + n + '</div><div class="gtc-l">' + l + '</div></div>'; }
  function closeCard(id) { var c = document.getElementById(id); if (c) c.remove(); }

  // ── 2) Connector overlay (meters in current view) ───────────────────────────
  function ensurePane() {
    if (!window.gMap.getPane('gisMeterConn')) window.gMap.createPane('gisMeterConn').style.zIndex = 648;
  }
  function clearConnectors() {
    if (state.connLayer) { window.gMap.removeLayer(state.connLayer); state.connLayer = null; }
  }
  // returns the configured threshold for ad-hoc candidate lookups
  function clamp(z) { return z; }

  async function renderConnectors() {
    if (!ready()) return;
    if (window.gMap.getZoom() < 14) { toast('התקרב כדי להציג חיבורי מונים'); return; }
    var fc;
    try { fc = await GIS.meters.getMetersInBBox(bboxOfView(0), 8000); }
    catch (e) { toast('שגיאה בטעינת מונים'); return; }
    ensurePane(); clearConnectors();
    var grp = L.layerGroup([], { pane: 'gisMeterConn' });
    var nConn = 0, nNone = 0;
    (fc.features || []).forEach(function (f) {
      var p = f.properties || {};
      var mc = f.geometry && f.geometry.coordinates;
      if (!mc) return;
      var type = p.connection_type || 'NONE';
      if ((type === 'AUTO' || type === 'MANUAL') && p.connection_point && p.connection_point.coordinates) {
        var sc = p.connection_point.coordinates;
        var color = type === 'MANUAL' ? '#2563eb' : '#16a34a';
        L.polyline([[mc[1], mc[0]], [sc[1], sc[0]]], {
          pane: 'gisMeterConn', color: color, weight: 2.5, opacity: 0.9, interactive: false,
          dashArray: p.connection_ambiguous ? '4 4' : null
        }).addTo(grp);
        L.circleMarker([sc[1], sc[0]], { pane: 'gisMeterConn', radius: 3, color: color, weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(grp);
        nConn++;
      } else {
        L.circleMarker([mc[1], mc[0]], { pane: 'gisMeterConn', radius: 6, color: '#b45309', weight: 2, fillColor: '#fbbf24', fillOpacity: 0.95, interactive: false })
          .bindTooltip('מונה ללא חיבור', { direction: 'top' }).addTo(grp);
        nNone++;
      }
    });
    state.connLayer = grp.addTo(window.gMap);
    toast(num(nConn) + ' חיבורים · ' + num(nNone) + ' ללא חיבור (בתצוגה)');
  }

  function toggleConnectors() {
    if (state.connLayer) { clearConnectors(); toast('חיבורי מונים הוסתרו'); }
    else { renderConnectors().catch(function () {}); }
  }

  // ── 3) Edit a single meter's connection ─────────────────────────────────────
  function editArm() {
    if (!ready()) return;
    if (state.editArmed) { disarmEdit(); }
    state.editArmed = true;
    var c = window.gMap.getContainer(); c.style.cursor = 'crosshair';
    banner('✏️ <b>עריכת חיבור</b> — לחץ על מונה במפה');
    state.editHandler = function (e) { onEditClick(e); };
    window.gMap.once('click', state.editHandler);
  }
  function disarmEdit() {
    state.editArmed = false;
    if (window.gMap) window.gMap.getContainer().style.cursor = '';
    banner(false);
  }
  function banner(html) {
    var b = document.getElementById('gis-mc-banner');
    if (html === false) { if (b) b.style.display = 'none'; return; }
    if (!b) { b = document.createElement('div'); b.id = 'gis-mc-banner'; document.body.appendChild(b); }
    b.innerHTML = html; b.style.display = 'block';
  }

  async function onEditClick(e) {
    disarmEdit();
    var click = [e.latlng.lng, e.latlng.lat];
    try {
      var fc = await GIS.meters.getMetersInBBox(bboxAround(e.latlng, 60), 500);
      var best = null;
      (fc.features || []).forEach(function (f) {
        var mc = f.geometry && f.geometry.coordinates; if (!mc) return;
        var d = distM(click, mc);
        if (!best || d < best.d) best = { d: d, f: f };
      });
      if (!best || best.d > CLICK_FIND_M) { toast('לא נמצא מונה סמוך — לחץ קרוב יותר'); return; }
      openEditor(best.f);
    } catch (err) {
      toast('שגיאה באיתור המונה', 'error');
    }
  }
  function bboxAround(latlng, halfM) {
    var dLat = halfM / 110540, dLng = halfM / (111320 * Math.cos(latlng.lat * Math.PI / 180) || 1);
    return { minLng: latlng.lng - dLng, minLat: latlng.lat - dLat, maxLng: latlng.lng + dLng, maxLat: latlng.lat + dLat };
  }

  async function openEditor(meter) {
    var p = meter.properties || {};
    var meterId = p.__id;
    var type = p.connection_type || 'NONE';
    var connected = (type === 'AUTO' || type === 'MANUAL');
    var typeLabel = { AUTO: 'אוטומטי', MANUAL: 'ידני', NONE: 'לא מחובר' }[type] || type;

    closeCard('gis-mc-edit');
    var el = document.createElement('div'); el.id = 'gis-mc-edit'; el.className = 'gis-mc-card';
    el.innerHTML =
      '<div class="gtc-head"><span>✏️ חיבור מונה</span><button class="gtc-x" title="סגור">✕</button></div>' +
      '<div class="gtc-sub">מונה ' + esc(p.arad_meter_id || meterId) +
        (p.customer_id ? ' · צרכן ' + esc(p.customer_id) : '') + '</div>' +
      '<div class="mc-status mc-' + type + '">מצב: <b>' + typeLabel + '</b>' +
        (connected && p.connection_distance_m != null ? ' · ' + num(p.connection_distance_m) + ' מ׳' : '') +
        (p.connection_ambiguous ? ' · ⚠ דו-משמעי' : '') + '</div>' +
      '<div class="gtc-actions">' +
        (type === 'AUTO' ? '<button class="gac-btn" id="mc-accept">✔ אשר (נעל)</button>' : '') +
        '<button class="gac-btn" id="mc-change">🔁 ' + (connected ? 'שנה חיבור' : 'חבר לצינור') + '</button>' +
        (connected ? '<button class="gac-btn ghost" id="mc-remove">✖ הסר חיבור</button>' : '') +
      '</div>' +
      '<div id="mc-cands"></div>';
    document.body.appendChild(el);
    el.querySelector('.gtc-x').onclick = function () { el.remove(); };

    var acc = el.querySelector('#mc-accept');
    if (acc) acc.onclick = async function () {
      if (!p.connected_pipe_id) { toast('אין צינור מחובר לאישור'); return; }
      try {
        await GIS.meters.connectMeter(meterId, p.connected_pipe_id, 'MANUAL');
        toast('החיבור אושר (ידני)');
        el.remove(); renderConnectors().catch(function () {});
      } catch (e) { toast(cleanErr(e), 'error'); }
    };
    el.querySelector('#mc-change').onclick = function () { showCandidates(el, meter); };
    var rm = el.querySelector('#mc-remove');
    if (rm) rm.onclick = async function () {
      try {
        await GIS.meters.disconnectMeter(meterId);
        toast('החיבור הוסר');
        el.remove(); renderConnectors().catch(function () {});
      } catch (e) { toast(cleanErr(e), 'error'); }
    };
  }

  async function showCandidates(el, meter) {
    var box = el.querySelector('#mc-cands');
    box.innerHTML = '<div class="mc-loading">טוען צינורות סמוכים…</div>';
    var p = meter.properties || {};
    var meterId = p.__id;
    var layerIds;
    try {
      var pl = await pipeLayers();
      layerIds = pl.map(function (l) { return l.id; });
    } catch (e) { box.innerHTML = '<div class="gtc-empty">שגיאה בטעינת שכבות</div>'; return; }
    if (!layerIds.length) { box.innerHTML = '<div class="gtc-empty">אין שכבות צנרת</div>'; return; }

    var cands;
    try { cands = await GIS.meters.connectionCandidates(meterId, layerIds, 100, 6); }
    catch (e) { box.innerHTML = '<div class="gtc-empty">' + esc(cleanErr(e)) + '</div>'; return; }
    if (!cands.length) { box.innerHTML = '<div class="gtc-empty">לא נמצאו צינורות סמוכים (עד 100 מ׳)</div>'; return; }

    box.innerHTML = '<div class="mc-cands-h">בחר צינור לחיבור (מהקרוב):</div>' +
      cands.map(function (c, i) {
        var i2 = c.layer_name ? c.layer_name.indexOf(' · ') : -1;
        var nm = i2 >= 0 ? c.layer_name.slice(i2 + 3) : (c.layer_name || c.asset_code || '—');
        return '<div class="mc-cand" data-i="' + i + '">' +
          '<span class="mc-cd">' + num(c.distance_m) + ' מ׳</span>' +
          '<span class="mc-cn">' + esc(nm) + '</span></div>';
      }).join('');
    box.querySelectorAll('.mc-cand').forEach(function (rowEl) {
      rowEl.onclick = async function () {
        var c = cands[+rowEl.getAttribute('data-i')];
        try {
          await GIS.meters.connectMeter(meterId, c.pipe_id, 'MANUAL');
          toast('חובר ידנית · ' + num(c.distance_m) + ' מ׳');
          el.remove(); renderConnectors().catch(function () {});
        } catch (e) { toast(cleanErr(e), 'error'); }
      };
    });
  }

  function cleanErr(e) { return (e && e.message) ? e.message.replace('[GIS] ', '') : 'שגיאה'; }

  function clearAll() {
    clearConnectors(); disarmEdit();
    closeCard('gis-mc-card'); closeCard('gis-mc-edit');
  }

  // ── styles (only what arcgis-pro.css doesn't already provide) ───────────────
  (function injectCSS() {
    if (document.getElementById('gis-mc-style')) return;
    var s = document.createElement('style'); s.id = 'gis-mc-style';
    s.textContent =
      '.gis-mc-card{position:absolute;bottom:96px;left:14px;z-index:1200;background:#fff;border:1px solid #d6dbe2;' +
      'border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.18);padding:10px 12px;min-width:230px;max-width:300px;' +
      'font-family:inherit;direction:rtl;text-align:right}' +
      '.gis-mc-card .gtc-head{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:13px;margin-bottom:4px}' +
      '.gis-mc-card .gtc-x{border:0;background:none;cursor:pointer;font-size:14px;color:#64748b}' +
      '.gis-mc-card .gtc-sub{font-size:11.5px;color:#64748b;margin-bottom:8px}' +
      '.gis-mc-card .gtc-stats{display:flex;gap:8px;margin-bottom:6px}' +
      '.gis-mc-card .gtc-stat{flex:1;background:#f1f5f9;border-radius:8px;padding:6px 4px;text-align:center}' +
      '.gis-mc-card .gtc-n{font-size:17px;font-weight:800;color:#0f172a}' +
      '.gis-mc-card .gtc-l{font-size:10.5px;color:#64748b}' +
      '.gis-mc-card .gtc-warn{font-size:11px;color:#92400e;background:#fef3c7;border-radius:6px;padding:5px 7px;margin:5px 0}' +
      '.gis-mc-card .gtc-empty{font-size:11.5px;color:#64748b;padding:6px 0}' +
      '.gis-mc-card .gtc-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}' +
      '.gis-mc-card .gac-btn{flex:1;min-width:84px;border:1px solid #cbd5e1;background:#1a7fc1;color:#fff;border-radius:7px;' +
      'padding:6px 8px;font-size:12px;cursor:pointer;font-family:inherit}' +
      '.gis-mc-card .gac-btn.ghost{background:#fff;color:#334155}' +
      '.mc-status{font-size:12px;padding:5px 8px;border-radius:7px;background:#f1f5f9;margin-bottom:4px}' +
      '.mc-status.mc-AUTO{background:#dcfce7;color:#166534}.mc-status.mc-MANUAL{background:#dbeafe;color:#1e40af}' +
      '.mc-status.mc-NONE{background:#fef3c7;color:#92400e}' +
      '.mc-cands-h,.mc-cands-h{font-size:11px;color:#475569;margin:8px 0 4px}' +
      '.mc-cand{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:6px 8px;border:1px solid #e2e8f0;' +
      'border-radius:7px;margin-bottom:4px;cursor:pointer;font-size:12px}.mc-cand:hover{background:#eff6ff;border-color:#93c5fd}' +
      '.mc-cd{font-weight:700;color:#0f172a;white-space:nowrap}.mc-cn{color:#475569;overflow:hidden;text-overflow:ellipsis}' +
      '.mc-loading{font-size:11.5px;color:#64748b;padding:6px 0}' +
      '.gad-note{font-size:11px;color:#64748b;line-height:1.6;margin-top:6px;background:#f8fafc;border-radius:6px;padding:6px 8px}' +
      '#gis-mc-banner{position:absolute;top:64px;left:50%;transform:translateX(-50%);z-index:1300;background:#0f172a;color:#fff;' +
      'padding:8px 16px;border-radius:20px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.25);direction:rtl}';
    document.head.appendChild(s);
  })();

  window.GISMeterConnect = {
    run: run,
    toggleConnectors: toggleConnectors,
    showConnectors: renderConnectors,
    editArm: editArm,
    editMeter: openEditor,   // open the accept/change/remove editor for a meter feature
    clear: clearAll
  };
})();
