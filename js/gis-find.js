/* ══════════════════════════════════════════════════════════════════════════
   Find / Locate — unified ArcGIS-style search.
   One box finds, IN PARALLEL and rendered the moment each source returns
   (meters first — assets/addresses never hold them up):
     • Meters   — Arad watermeters by id / customer id / name / address
                  (GIS.meters.search → search_meters RPC).
     • Assets   — any attribute (valve #, section, asset_code, hydrant id…).
     • Addresses— real street addresses (Nominatim; skipped for pure-number
                  queries, since meter/customer ids are never addresses).
   Click a result → fly to it + a BOLD pulsing highlight is dropped on the map
   (so the picked meter stands out from the small dots) + its panel opens.
   Self-contained IIFE. Opens from the ribbon Map → איתור tab.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var ID_FIELDS = ['asset_code', 'ValveNum', 'HydrantNum', 'SectionNum', 'arad_meter_id', 'GlobalID', 'OBJECTID', 'ManholeNum'];
  var SCAN_CAP = 60000;            // max features scanned when no layer is active
  var ASSET_MAX = 15, METER_MAX = 20, ADDR_MAX = 6;

  // sections render top→bottom; meters first because that's the priority search.
  var SECTIONS = [
    { key: 'meters', title: '🔢 מדי מים' },
    { key: 'assets', title: '🔹 נכסים' },
    { key: 'addr',   title: '📍 כתובות' }
  ];

  var _cache = {};
  var _runToken = 0;     // guards against an older query overwriting a newer one
  var _picks = {};       // pickId → result object (rebuilt per run)
  var _pickSeq = 0;
  var _hi = null;        // current feature highlight on the map (persists until next pick)
  var _addrMarker = null;

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

  // ── the three searches ──────────────────────────────────────────────────────
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

  // ArcGIS Geocoding (primary) — better Hebrew/Israel address matching. Returns null when the
  // key is missing or the service errors (bad token / referrer / network) so the caller falls
  // back to Nominatim; returns [] for a successful search with no candidates.
  async function geocodeArcGIS(q) {
    var key = window.GIS_ARCGIS_KEY;
    if (!key) return null;
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 4500);
    try {
      var url = 'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates' +
        '?f=json&singleLine=' + encodeURIComponent(q) +
        '&countryCode=ISL&maxLocations=' + ADDR_MAX +
        '&location=35.30,32.92&outFields=Match_addr&langCode=he&token=' + encodeURIComponent(key);
      var resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(to);
      if (!resp.ok) return null;
      var data = await resp.json();
      if (!data || data.error) return null;        // e.g. 498 invalid token / 403 referrer
      return (data.candidates || []).map(function (c) {
        return { kind: 'address', lat: c.location.y, lng: c.location.x, label: (c.address || '').split(',').slice(0, 3).join(',') };
      });
    } catch (e) { clearTimeout(to); return null; }
  }

  // Nominatim (fallback) — used when ArcGIS is unavailable or returns no candidates.
  async function geocodeNominatim(q) {
    try {
      var url = 'https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(q) +
        '&countrycodes=il&accept-language=he&limit=' + ADDR_MAX + '&viewbox=35.10,33.00,35.50,32.80&bounded=0';
      var ctrl = new AbortController();
      var to = setTimeout(function () { ctrl.abort(); }, 4500);
      var resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(to);
      if (!resp.ok) return [];
      var data = await resp.json();
      return (data || []).map(function (r) {
        return { kind: 'address', lat: parseFloat(r.lat), lng: parseFloat(r.lon), label: (r.display_name || '').split(',').slice(0, 3).join(',') };
      });
    } catch (e) { return []; }
  }

  async function searchAddresses(q) {
    var arc = await geocodeArcGIS(q);            // null = unavailable/errored; [] = searched, no match
    if (arc && arc.length) return { items: arc };
    return { items: await geocodeNominatim(q) }; // graceful fallback keeps address search working
  }

  // ── run: scaffold sections, then fill each independently as it returns ──────
  async function run(q) {
    var token = ++_runToken;
    q = (q || '').trim();
    var box = document.getElementById('gf-results'); if (!box) return;
    if (q.length < 2) { box.innerHTML = hint('הקלד לפחות 2 תווים…'); return; }

    _picks = {};
    var runAddr = /\D/.test(q);     // pure-digit queries (meter/customer id) skip the slow geocoder
    box.innerHTML = SECTIONS.map(function (s) {
      if (s.key === 'addr' && !runAddr) return '';
      return '<div class="gf-secwrap" id="gf-w-' + s.key + '"><div class="gf-sec">' + s.title + '</div>' +
        '<div class="gf-secbody" id="gf-b-' + s.key + '">' + hint('מחפש…') + '</div></div>';
    }).join('');

    var pm = searchMeters(q).then(function (r) { if (token === _runToken) putItems('meters', r.items, meterRow); });
    var pa = searchAssets(q).then(function (r) {
      if (token !== _runToken) return;
      putItems('assets', r.items, assetRow);
      if (r.capped && r.items.length) appendHint('assets', 'הצגת ' + r.items.length + ' ראשונות — צמצם בשכבה פעילה לדיוק');
    });
    var px = runAddr ? searchAddresses(q).then(function (r) { if (token === _runToken) putItems('addr', r.items, addrRow); }) : Promise.resolve();

    Promise.all([pm, pa, px]).then(function () {
      if (token === _runToken && !box.querySelector('.gf-item')) box.innerHTML = hint('לא נמצאו תוצאות');
    });
  }

  function register(it) { var id = String(++_pickSeq); _picks[id] = it; return id; }
  function putItems(key, items, renderRow) {
    var wrap = document.getElementById('gf-w-' + key), body = document.getElementById('gf-b-' + key);
    if (!wrap || !body) return;
    if (!items || !items.length) { wrap.style.display = 'none'; return; }
    body.innerHTML = items.map(function (it) { return renderRow(it, register(it)); }).join('');
    Array.prototype.forEach.call(body.querySelectorAll('.gf-item'), function (el) {
      el.onclick = function () { var p = _picks[el.getAttribute('data-pid')]; if (p) pick(p); };
    });
    wrap.style.display = '';
  }
  function appendHint(key, msg) { var body = document.getElementById('gf-b-' + key); if (body) body.insertAdjacentHTML('beforeend', hint(msg)); }

  function meterRow(it, id) {
    var p = it.f.properties || {};
    var nm = p.customer_name || (p.raw_data && p.raw_data.customer_name) || '';
    var sub = [(p.customer_id != null && p.customer_id !== '') ? 'צרכן ' + p.customer_id : '', p.address || ''].filter(Boolean).join(' · ');
    return '<div class="gf-item" data-pid="' + id + '"><span class="gf-code">🔢 ' + esc(p.arad_meter_id || '—') + (nm ? ' · ' + esc(nm) : '') + '</span>' +
      '<span class="gf-layer">' + esc(sub) + '</span></div>';
  }
  function assetRow(it, id) {
    return '<div class="gf-item" data-pid="' + id + '"><span class="gf-code">' + esc(resultLabel(it.f)) + '</span>' +
      '<span class="gf-layer">' + esc(layerLabel(it.layer)) + '</span></div>';
  }
  function addrRow(it, id) {
    return '<div class="gf-item" data-pid="' + id + '"><span class="gf-code">📍 ' + esc(it.label) + '</span>' +
      '<span class="gf-layer">' + it.lat.toFixed(4) + ', ' + it.lng.toFixed(4) + '</span></div>';
  }

  // ── pick + on-map highlight ─────────────────────────────────────────────────
  function flyToGeom(g) {
    if (g.type === 'Point') { window.gMap.flyTo([g.coordinates[1], g.coordinates[0]], 19, { duration: 0.7 }); return; }
    try { var tmp = L.geoJSON(g); window.gMap.flyToBounds(tmp.getBounds(), { maxZoom: 19, duration: 0.7, padding: [60, 60] }); } catch (e) {}
  }
  function ensureHiPane() {
    if (!window.gMap.getPane('gisFindHi')) {
      var p = window.gMap.createPane('gisFindHi'); p.style.zIndex = 702; p.style.pointerEvents = 'none';
    }
    return 'gisFindHi';
  }
  function clearHighlight() {
    if (_hi) { try { window.gMap.removeLayer(_hi); } catch (e) {} _hi = null; }
    if (_addrMarker) { try { window.gMap.removeLayer(_addrMarker); } catch (e) {} _addrMarker = null; }
  }
  // Bold, pulsing, distinct-colour marker so the picked feature pops out from the
  // small same-colour dots around it. Persists until the next pick (or clear).
  function highlightFeature(g, label) {
    clearHighlight();
    if (!g || !window.gMap) return;
    var pane = ensureHiPane();
    if (g.type === 'Point') {
      var icon = L.divIcon({ className: '', html: '<div class="gis-find-pulse"></div>', iconSize: [28, 28], iconAnchor: [14, 14] });
      _hi = L.marker([g.coordinates[1], g.coordinates[0]], { icon: icon, pane: pane, interactive: false, zIndexOffset: 1000 }).addTo(window.gMap);
      if (label) _hi.bindTooltip(String(label), { permanent: true, direction: 'top', offset: [0, -14], className: 'gis-find-hilabel' });
    } else {
      _hi = L.geoJSON(g, {
        pane: pane, interactive: false,
        style: { color: '#7c3aed', weight: 7, opacity: 0.95, fillColor: '#a855f7', fillOpacity: 0.25 },
        pointToLayer: function (f, ll) { return L.circleMarker(ll, { pane: pane, radius: 11, color: '#7c3aed', weight: 4, fillColor: '#a855f7', fillOpacity: 0.9 }); }
      }).addTo(window.gMap);
    }
  }

  function pick(r) {
    if (!window.gMap) return;
    if (r.kind === 'address') {
      clearHighlight();
      window.gMap.flyTo([r.lat, r.lng], 18, { duration: 0.8 });
      var pane = ensureHiPane();
      _addrMarker = L.circleMarker([r.lat, r.lng], { pane: pane, radius: 10, color: '#dc2626', weight: 3, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip('📍 ' + esc(r.label), { permanent: false, direction: 'top' });
      _addrMarker.addTo(window.gMap);
      return;
    }
    var g = r.f.geometry; if (!g) { toast('לפריט אין גאומטריה'); return; }
    flyToGeom(g);
    if (r.kind === 'meter') {
      var p = r.f.properties || {};
      highlightFeature(g, p.arad_meter_id || p.customer_name || '');
      if (window.GISPanel && GISPanel.openMeter) GISPanel.openMeter(r.f);
    } else {
      highlightFeature(g, resultLabel(r.f));
      if (window.GISPanel) GISPanel.open(r.f, { layerId: r.layer.id, sub: layerLabel(r.layer) });
    }
  }

  // ── card ───────────────────────────────────────────────────────────────────
  function toggle() {
    var c = document.getElementById('gis-find-card');
    if (c) { c.remove(); return; }
    if (!window.GIS || !window.gMap) { toast('המנוע עדיין נטען…'); return; }
    c = document.createElement('div'); c.id = 'gis-find-card';
    c.innerHTML =
      '<div class="gf-head"><input id="gf-input" class="gf-input" placeholder="אתר: מד מים (Arad) · מס׳ צרכן/שם · נכס · כתובת…" autocomplete="off"><button class="gf-x" title="סגור">✕</button></div>' +
      '<div class="gf-results" id="gf-results"><div class="gf-hint">הקלד לחיפוש מדי מים, נכסים וכתובות</div></div>';
    document.body.appendChild(c);
    var inp = document.getElementById('gf-input'); inp.focus();
    var t; inp.oninput = function () { clearTimeout(t); t = setTimeout(function () { run(inp.value); }, 260); };
    inp.onkeydown = function (e) { if (e.key === 'Escape') c.remove(); };
    c.querySelector('.gf-x').onclick = function () { c.remove(); };
  }

  // styles: section headers + the pulsing highlight (rest reuses arcgis-pro.css)
  (function injectCSS() {
    if (document.getElementById('gis-find-style')) return;
    var s = document.createElement('style'); s.id = 'gis-find-style';
    s.textContent =
      '#gis-find-card .gf-sec{padding:5px 10px;background:#f1f5f9;font-size:10px;font-weight:700;color:#64748b;letter-spacing:.4px;position:sticky;top:0}' +
      '#gis-find-card .gf-item .gf-code{display:block}' +
      '.gis-find-pulse{width:28px;height:28px;border-radius:50%;background:rgba(124,58,237,.35);border:3px solid #7c3aed;animation:gis-find-pulse 1.4s infinite}' +
      '@keyframes gis-find-pulse{0%{box-shadow:0 0 0 0 rgba(124,58,237,.55)}70%{box-shadow:0 0 0 18px rgba(124,58,237,0)}100%{box-shadow:0 0 0 0 rgba(124,58,237,0)}}' +
      '.gis-find-hilabel{background:#7c3aed;color:#fff;border:none;font-weight:700;font-size:11px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.25)}' +
      '.gis-find-hilabel:before{border-top-color:#7c3aed}';
    document.head.appendChild(s);
  })();

  window.GISFind = { toggle: toggle, clearHighlight: clearHighlight };
})();
