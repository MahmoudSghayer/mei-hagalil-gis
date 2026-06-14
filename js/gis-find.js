/* ══════════════════════════════════════════════════════════════════════════
   Find / Locate asset — ArcGIS-style feature search.
   Search by valve number, pipe section, asset code, hydrant/meter id, or any
   attribute value, across the active engine layers (or all if none active),
   then zoom to the hit and open its attribute panel.
   Self-contained IIFE. Opens from the ribbon Map → איתור tab.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // id-ish fields tried first for the result label / match priority
  var ID_FIELDS = ['asset_code', 'ValveNum', 'HydrantNum', 'SectionNum', 'arad_meter_id', 'GlobalID', 'OBJECTID', 'ManholeNum'];
  var SCAN_CAP = 60000;   // max features scanned when no layer is active
  var MAX_RESULTS = 25;

  var _cache = {};
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2200); }

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

  async function run(q) {
    q = (q || '').trim().toLowerCase();
    var box = document.getElementById('gf-results'); if (!box) return;
    if (q.length < 2) { box.innerHTML = '<div class="gf-hint">הקלד לפחות 2 תווים…</div>'; return; }
    box.innerHTML = '<div class="gf-hint">מחפש…</div>';
    var cand = await candidateLayers();
    var results = [], scanned = 0, capped = false;
    for (var i = 0; i < cand.layers.length && results.length < MAX_RESULTS; i++) {
      var layer = cand.layers[i];
      var feats = await featuresOf(layer.id);
      for (var j = 0; j < feats.length; j++) {
        if (cand.all && ++scanned > SCAN_CAP) { capped = true; break; }
        if (matches(feats[j], q)) { results.push({ f: feats[j], layer: layer }); if (results.length >= MAX_RESULTS) break; }
      }
      if (capped) break;
    }
    if (!results.length) { box.innerHTML = '<div class="gf-hint">לא נמצאו תוצאות' + (cand.all ? ' (חיפוש בכל השכבות)' : ' בשכבות הפעילות') + '</div>'; return; }
    box.innerHTML = results.map(function (r, idx) {
      return '<div class="gf-item" data-i="' + idx + '"><span class="gf-code">🔹 ' + esc(resultLabel(r.f)) + '</span>' +
        '<span class="gf-layer">' + esc(layerLabel(r.layer)) + '</span></div>';
    }).join('') + (capped ? '<div class="gf-hint">הצגת ' + results.length + ' ראשונות — צמצם בשכבה פעילה לדיוק</div>' : '');
    Array.prototype.forEach.call(box.querySelectorAll('.gf-item'), function (el) {
      el.onclick = function () { pick(results[+el.getAttribute('data-i')]); };
    });
  }

  function pick(r) {
    var g = r.f.geometry; if (!g || !window.gMap) { toast('לפיצ׳ר אין גאומטריה'); return; }
    if (g.type === 'Point') window.gMap.flyTo([g.coordinates[1], g.coordinates[0]], 19, { duration: 0.7 });
    else {
      try {
        var tmp = L.geoJSON(g); window.gMap.flyToBounds(tmp.getBounds(), { maxZoom: 19, duration: 0.7, padding: [60, 60] });
      } catch (e) {}
    }
    if (window.GISPanel) window.GISPanel.open(r.f, { layerId: r.layer.id, sub: layerLabel(r.layer) });
  }

  function toggle() {
    var c = document.getElementById('gis-find-card');
    if (c) { c.remove(); return; }
    if (!window.GIS || !window.gMap) { toast('המנוע עדיין נטען…'); return; }
    c = document.createElement('div'); c.id = 'gis-find-card';
    c.innerHTML =
      '<div class="gf-head"><input id="gf-input" class="gf-input" placeholder="אתר נכס: מס׳ מגוף, קטע, asset_code…" autocomplete="off"><button class="gf-x" title="סגור">✕</button></div>' +
      '<div class="gf-results" id="gf-results"><div class="gf-hint">הקלד לחיפוש בשכבות הפעילות</div></div>';
    document.body.appendChild(c);
    var inp = document.getElementById('gf-input'); inp.focus();
    var t; inp.oninput = function () { clearTimeout(t); t = setTimeout(function () { run(inp.value); }, 280); };
    inp.onkeydown = function (e) { if (e.key === 'Escape') c.remove(); };
    c.querySelector('.gf-x').onclick = function () { c.remove(); };
  }

  window.GISFind = { toggle: toggle };
})();
