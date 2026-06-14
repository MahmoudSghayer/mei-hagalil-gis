/* ══════════════════════════════════════════════════════════════════════════
   Find / Locate — unified ArcGIS-style search.
   One box finds, in parallel:
     • Assets   — any attribute (valve #, section, asset_code, hydrant id…)
                  across the active engine layers (or all if none active).
     • Meters   — Arad watermeters by id / customer id / name / address
                  (GIS.meters.search → search_meters RPC).
     • Addresses— real street addresses (Nominatim/OSM, Israel-biased).
   Click a result → fly to it + open its panel (asset/meter) or drop a marker
   (address). Self-contained IIFE. Opens from the ribbon Map → איתור tab.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // id-ish fields tried first for the asset result label / match priority
  var ID_FIELDS = ['asset_code', 'ValveNum', 'HydrantNum', 'SectionNum', 'arad_meter_id', 'GlobalID', 'OBJECTID', 'ManholeNum'];
  var SCAN_CAP = 60000;   // max features scanned when no layer is active
  var ASSET_MAX = 15, METER_MAX = 15, ADDR_MAX = 6;

  var _cache = {};
  var _runToken = 0;       // guards against an older query overwriting a newer one
  var _addrMarker = null;  // temporary marker for a picked address

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2200); }
  function hint(m) { return '<div class="gf-hint">' + esc(m) + '</div>'; }

  function layerLabel(layer) {
    var i = layer.name.indexOf(' · ');
    var cat = i >= 0 ? layer.name.slice(i + 3) : layer.name;
    var v = i >= 0 ? layer.name.slice(0, i) : '';
    var l = window.GISLayerLabel ? window.GISLayerLabel(cat) : cat;
    return v ? v + ' · ' + l : l;
  }
  async function candidateLayers() {
    var act = (window.GISEngineSidebar && window.GISEngineSidebar.activeLayers) ? window.GISEngineSidebar.activeLayers() : [];
    if (act && act.length) return { layers: act, all: false };
    var all = await GIS.layers.getLayers();
    return { layers: all, all: true };
  }
  async function featuresOf(id) { if (!_cache[id]) _cache[id] = ((await GIS.features.getFeatures(id, 100000)).features) || []; return _cache[id]; }

  function resultLabel(f) {
    var p = f.properties || {};
    for (var i = 0; i < ID_FIELDS.length; i++) { var v = p[ID_FIELDS[i]]; if (v != null && v !== '') return String(v); }
    var k = Object.keys(p).find(function (x) { return !/^_/.test(x) && p[x] != null && p[x] !== ''; });
    return k ? String(p[k]) : '—';
  }
  function matches(f, q) {
    var p = f.properties || {};
    for (var k in p) { if (!Object.prototype.hasOwnProperty.call(p, k) || /^_/.test(k)) continue; var v = p[k]; if (v != null && String(v).toLowerCase().indexOf(q) >= 0) return true; }
    return false;
  }

  // ── the three searches (each returns a small result object) ────────────────
  async function searchAssets(q) {
    var ql = q.toLowerCase();
    var cand;
    try { cand = await candidateLayers(); } catch (e) { return { items: [], capped: false, all: false }; }
    var items = [], scanned = 0, capped = false;
    for (var i = 0; i < cand.layers.length && items.length < ASSET_MAX; i++) {
      var layer = cand.layers[i];
      var feats;
      try { feats = await featuresOf(layer.id); } catch (e) { continue; }
      for (var j = 0; j < feats.length; j++) {
        if (cand.all && ++scanned > SCAN_CAP) { capped = true; break; }
        if (matches(feats[j], ql)) { items.push({ kind: 'asset', f: feats[j], layer: layer }); if (items.length >= ASSET_MAX) break; }
      }
      if (capped) break;
    }
    return { items: items, capped: capped, all: cand.all };
  }

  async function searchMeters(q) {
    if (!window.GIS || !GIS.meters || !GIS.meters.search) return { items: [] };
    try {
      var fc = await GIS.meters.search(q, METER_MAX);
      return { items: (fc.features || []).map(function (f) { return { kind: 'meter', f: f }; }) };
    } catch (e) { return { items: [] }; }
  }

  async function searchAddresses(q) {
    try {
      var url = 'https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(q) +
        '&countrycodes=il&accept-language=he&limit=' + ADDR_MAX + '&viewbox=35.10,33.00,35.50,32.80&bounded=0';
      var ctrl = new AbortController();
      var to = setTimeout(function () { ctrl.abort(); }, 4500);
      var resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(to);
      if (!resp.ok) return { items: [] };
      var data = await resp.json();
      return {
        items: (data || []).map(function (r) {
          return { kind: 'address', lat: parseFloat(r.lat), lng: parseFloat(r.lon), label: (r.display_name || '').split(',').slice(0, 3).join(',') };
        })
      };
    } catch (e) { return { items: [] }; }
  }

  // ── run + render ───────────────────────────────────────────────────────────
  async function run(q) {
    var token = ++_runToken;
    q = (q || '').trim();
    var box = document.getElementById('gf-results'); if (!box) return;
    if (q.length < 2) { box.innerHTML = hint('הקלד לפחות 2 תווים…'); return; }
    box.innerHTML = hint('מחפש…');

    var res = await Promise.all([searchAssets(q), searchMeters(q), searchAddresses(q)]);
    if (token !== _runToken) return;                 // a newer keystroke superseded this
    renderResults(box, res[0], res[1], res[2]);
  }

  function renderResults(box, assets, meters, addrs) {
    var all = [], html = '';
    function section(title, items, render) {
      if (!items || !items.length) return '';
      var h = '<div class="gf-sec">' + title + '</div>';
      items.forEach(function (it) { var idx = all.length; all.push(it); h += render(it, idx); });
      return h;
    }
    html += section('🔹 נכסים', assets.items, function (it, idx) {
      return '<div class="gf-item" data-i="' + idx + '"><span class="gf-code">' + esc(resultLabel(it.f)) + '</span>' +
        '<span class="gf-layer">' + esc(layerLabel(it.layer)) + '</span></div>';
    });
    html += section('🔢 מדי מים', meters.items, function (it, idx) {
      var p = it.f.properties || {};
      var nm = p.customer_name || (p.raw_data && p.raw_data.customer_name) || '';
      var sub = [p.customer_id != null && p.customer_id !== '' ? 'צרכן ' + p.customer_id : '', p.address || ''].filter(Boolean).join(' · ');
      return '<div class="gf-item" data-i="' + idx + '"><span class="gf-code">🔢 ' + esc(p.arad_meter_id || '—') + (nm ? ' · ' + esc(nm) : '') + '</span>' +
        '<span class="gf-layer">' + esc(sub) + '</span></div>';
    });
    html += section('📍 כתובות', addrs.items, function (it, idx) {
      return '<div class="gf-item" data-i="' + idx + '"><span class="gf-code">📍 ' + esc(it.label) + '</span>' +
        '<span class="gf-layer">' + it.lat.toFixed(4) + ', ' + it.lng.toFixed(4) + '</span></div>';
    });

    if (!all.length) { box.innerHTML = hint('לא נמצאו תוצאות' + (assets.all ? ' (חיפוש בכל השכבות)' : '')); return; }
    if (assets.capped) html += hint('נכסים: הצגת ' + assets.items.length + ' ראשונות — צמצם בשכבה פעילה לדיוק');
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('.gf-item'), function (el) {
      el.onclick = function () { pick(all[+el.getAttribute('data-i')]); };
    });
  }

  // ── pick a result ──────────────────────────────────────────────────────────
  function flyToGeom(g) {
    if (g.type === 'Point') { window.gMap.flyTo([g.coordinates[1], g.coordinates[0]], 19, { duration: 0.7 }); return; }
    try { var tmp = L.geoJSON(g); window.gMap.flyToBounds(tmp.getBounds(), { maxZoom: 19, duration: 0.7, padding: [60, 60] }); } catch (e) {}
  }
  function pick(r) {
    if (!window.gMap) return;
    if (r.kind === 'address') { goAddress(r); return; }
    var g = r.f.geometry; if (!g) { toast('לפריט אין גאומטריה'); return; }
    flyToGeom(g);
    if (r.kind === 'meter') { if (window.GISPanel && GISPanel.openMeter) GISPanel.openMeter(r.f); }
    else if (window.GISPanel) GISPanel.open(r.f, { layerId: r.layer.id, sub: layerLabel(r.layer) });
  }
  function goAddress(r) {
    window.gMap.flyTo([r.lat, r.lng], 18, { duration: 0.8 });
    if (_addrMarker) { try { window.gMap.removeLayer(_addrMarker); } catch (e) {} }
    _addrMarker = L.circleMarker([r.lat, r.lng], { radius: 9, color: '#dc2626', weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .addTo(window.gMap).bindPopup('📍 ' + esc(r.label)).openPopup();
  }

  // ── card ───────────────────────────────────────────────────────────────────
  function toggle() {
    var c = document.getElementById('gis-find-card');
    if (c) { c.remove(); return; }
    if (!window.GIS || !window.gMap) { toast('המנוע עדיין נטען…'); return; }
    c = document.createElement('div'); c.id = 'gis-find-card';
    c.innerHTML =
      '<div class="gf-head"><input id="gf-input" class="gf-input" placeholder="אתר: מס׳ מגוף/נכס · מד מים (Arad) · כתובת…" autocomplete="off"><button class="gf-x" title="סגור">✕</button></div>' +
      '<div class="gf-results" id="gf-results"><div class="gf-hint">הקלד לחיפוש נכסים, מדי מים וכתובות</div></div>';
    document.body.appendChild(c);
    var inp = document.getElementById('gf-input'); inp.focus();
    var t; inp.oninput = function () { clearTimeout(t); t = setTimeout(function () { run(inp.value); }, 300); };
    inp.onkeydown = function (e) { if (e.key === 'Escape') c.remove(); };
    c.querySelector('.gf-x').onclick = function () { c.remove(); };
  }

  // section-header style (the rest reuses the .gf-* styles in arcgis-pro.css)
  (function injectCSS() {
    if (document.getElementById('gis-find-style')) return;
    var s = document.createElement('style'); s.id = 'gis-find-style';
    s.textContent =
      '#gis-find-card .gf-sec{padding:5px 10px;background:#f1f5f9;font-size:10px;font-weight:700;' +
      'color:#64748b;letter-spacing:.4px;position:sticky;top:0}' +
      '#gis-find-card .gf-item .gf-code{display:block}';
    document.head.appendChild(s);
  })();

  window.GISFind = { toggle: toggle };
})();
