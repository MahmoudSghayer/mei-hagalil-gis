// ════════════════════════════════════════════════════════════════
//  מי הגליל GIS — פאנל שכבות מנוע בסרגל הצד (Phase 2)
//  מזריק פאנל "שכבות מנוע GIS" לסרגל הקיים, מקובץ לפי כפר:
//    📍 כפר  (לחיץ לכיווץ/הרחבה)
//        ☐ קווי מים        (123)
//        ☐ שוחות ביוב      (45)
//  הדלקה/כיבוי לכל שכבה, ולחיצה על פיצ'ר פותחת את הטבלה הנערכת.
//  עצמאי, ללא נגיעה ב-index.js.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

// תוויות קטגוריה בעברית (נגזר משם השכבה "<כפר> · <category>")
var CAT_HE = {
  water_pipes:'קווי מים', sewage_pipes:'קווי ביוב', main_sewer:'ביב ראשי', supply_pipe:'קו הספקה',
  valves:'מגופים', control_valves:'מגופים שולטים', hydrants:'הידרנטים', water_meters:'מדי מים',
  sewage_manholes:'שוחות ביוב', connection_points:'נקודות חיבור', reservoirs:'מאגרים',
  pump_stations:'תחנות שאיבה', sampling_points:'נקודות דיגום', fittings:'אביזרים', parcels:'חלקות',
  buildings:'מבנים', annotation_points:'הערות', annotation_lines:'קווי הערה', annotation_polygons:'פוליגוני הערה',
  other:'אחר'
};
var CAT_ICON = {
  water_pipes:'💧', supply_pipe:'💧', sewage_pipes:'🟤', main_sewer:'🔴', valves:'🔧', control_valves:'⚙️',
  hydrants:'🚒', water_meters:'🔢', sewage_manholes:'⭕', reservoirs:'🏗️', pump_stations:'⛽'
};
function catLabel(cat) { return (CAT_ICON[cat] ? CAT_ICON[cat] + ' ' : '') + (CAT_HE[cat] || cat); }
function defaultColor(t) { return t === 'Point' ? '#0d3b5e' : t === 'Polygon' ? '#0e7490' : '#1a7fc1'; }
function colorFor(layer) { return (layer && layer.color) || defaultColor(layer && layer.geometry_type); }
function toHex(c) { return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : defaultColor(); }

var css = document.createElement('style');
css.textContent = `
#gis-eng-panel .ge-village{border:1px solid #eef2f6;border-radius:9px;margin-bottom:6px;overflow:hidden;}
#gis-eng-panel .ge-vhead{display:flex;align-items:center;gap:7px;padding:8px 10px;cursor:pointer;background:#f8fafc;font-size:12.5px;font-weight:700;color:#0d3b5e;}
#gis-eng-panel .ge-vhead:hover{background:#eef4fb;}
#gis-eng-panel .ge-vname{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#gis-eng-panel .ge-vchev{font-size:10px;opacity:.7;}
#gis-eng-panel .ge-vcount{font-size:10.5px;color:#94a3b8;font-weight:600;}
#gis-eng-panel .ge-vbody{padding:4px 8px 6px;}
#gis-eng-panel .ge-village.collapsed .ge-vbody{display:none;}
#gis-eng-panel .ge-row{display:flex;align-items:center;gap:8px;padding:5px 4px;border-radius:6px;cursor:pointer;font-size:12.5px;color:#1e293b;}
#gis-eng-panel .ge-row:hover{background:#f1f5f9;}
#gis-eng-panel .ge-row input{accent-color:#0d3b5e;width:14px;height:14px;cursor:pointer;flex-shrink:0;}
#gis-eng-panel .ge-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
#gis-eng-panel .ge-color{width:16px;height:16px;flex-shrink:0;padding:0;border:1px solid #cbd5e1;border-radius:4px;cursor:pointer;background:none;}
#gis-eng-panel .ge-color::-webkit-color-swatch{border:none;border-radius:3px;}
#gis-eng-panel .ge-color::-webkit-color-swatch-wrapper{padding:0;}
#gis-eng-panel .ge-fly,#gis-eng-panel .ge-del{background:none;border:none;cursor:pointer;font-size:12px;padding:0 2px;opacity:.7;}
#gis-eng-panel .ge-fly:hover{opacity:1;}
#gis-eng-panel .ge-del:hover{opacity:1;filter:saturate(1.5);}
#gis-eng-panel .ge-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#gis-eng-panel .ge-count{font-size:10px;color:#94a3b8;}
#gis-eng-panel .ge-stat{display:inline-flex;align-items:center;min-width:12px;}
#gis-eng-panel .ge-spin{width:11px;height:11px;border:2px solid #cbd5e1;border-top-color:#0d3b5e;border-radius:50%;animation:ge-spin .7s linear infinite;}
#gis-eng-panel .ge-warn{color:#d97706;font-size:12px;cursor:help;}
#gis-eng-panel .ge-more{color:#2563eb;font-size:12px;cursor:help;}
@keyframes ge-spin{to{transform:rotate(360deg);}}
#gis-eng-panel .ge-empty{font-size:11px;color:#94a3b8;padding:8px 2px;line-height:1.5;}
#gis-eng-panel .ge-refresh{background:none;border:none;cursor:pointer;color:#64748b;font-size:13px;}
#gis-eng-panel.collapsed .ge-body{display:none;}`;
document.head.appendChild(css);

var loaded = {};        // layerId → GISTileLoader controller (on the map)
var active = {};        // layerId → layer (toggled on → reload on pan/zoom)
var openVillages = {};  // villageName → bool (expanded)
var meterLayers = {};       // village name → meters L.layer on the map
var moveendWired = false;
var _mt;

// Build the styled Leaflet layer(s) for ONE feature (reuses buildLayer so the
// tile loader keeps the exact symbology / labels / click behaviour). colorFor
// is read per call, so a recolour is reflected after invalidate().
function makeFeatureLayers(layer) {
  return function (f) {
    var g = buildLayer({ type: 'FeatureCollection', features: [f] }, layer, colorFor(layer));
    var out = []; g.eachLayer(function (l) { out.push(l); });
    return out;
  };
}

// One tile loader per active layer: viewport tile cache + feature cache +
// request queue + AbortController + background prefetch. Previously loaded
// features stay on the map while new tiles stream in (no clear-on-refresh).
function createLoader(layer) {
  return GISTileLoader.create({
    map: window.gMap,
    // Durable tile cache (IndexedDB) in front of the bbox RPC: a tile is fetched
    // over the network once, then reused across reloads/sessions until it ages
    // out (TTL) or the layer is edited (onInvalidate clears its tiles).
    fetchTile: function (bbox, signal, tileKey) {
      var ck = layer.id + '/' + tileKey;
      var hit = window.GISTileCache ? GISTileCache.get(ck) : Promise.resolve(null);
      return hit.then(function (cached) {
        if (cached) return cached;
        return GIS.features.getInBBox(layer.id, bbox, 2000, signal).then(function (fc) {
          if (window.GISTileCache && fc && fc.features) GISTileCache.set(ck, fc);
          return fc;
        });
      });
    },
    onInvalidate: function () { if (window.GISTileCache) GISTileCache.clearPrefix(layer.id + '/'); },
    makeLayers: makeFeatureLayers(layer),
    featureId: function (f) { return f.id != null ? f.id : (f.properties && f.properties.__id); },
    onCount: function (n) {
      if (layer._cntEl) layer._cntEl.textContent = n;
      if (window.GISSymbology && window.GISSymbology.refreshLegend) window.GISSymbology.refreshLegend();
    },
    onStatus: function (s) {
      if (!layer._statEl) return;
      var html = '';
      if (s.loading) html += '<span class="ge-spin" title="טוען אריחים…"></span>';
      else if (s.errors) html += '<span class="ge-warn" title="חלק מהאריחים נכשלו בטעינה — הזז מעט את המפה כדי לנסות שוב">⚠</span>';
      else if (s.truncated) html += '<span class="ge-more" title="יש יותר פיצ\'רים מהמוצג באזור זה — התקרב כדי לראות את כולם">⊕</span>';
      layer._statEl.innerHTML = html;
    },
    prefetchRing: 1
  });
}

// Single debounced map-movement handler → nudge every active loader to fetch
// the new edge tiles (cached tiles are reused; nothing is re-requested).
function wireMoveend() {
  if (moveendWired || !window.gMap) return;
  moveendWired = true;
  window.gMap.on('moveend', function () { clearTimeout(_mt); _mt = setTimeout(reloadActive, 250); });
}
function reloadActive() { Object.keys(loaded).forEach(function (id) { try { loaded[id].update(); } catch (e) {} }); }

var tries = 0;
var t = setInterval(function () {
  tries++;
  if (window.GIS && window.gMap && document.getElementById('layers-scroll-area')) {
    clearInterval(t); build().catch(function (e) { console.error('[GISEngineSidebar]', e); });
  } else if (tries > 80) { clearInterval(t); }
}, 200);

// Hide the old flat-file infrastructure panel — the engine is the layer system now.
function hideOldPanel() {
  var oldList = document.getElementById('dwg-layers-list');
  if (oldList) { var p = oldList.closest('.panel'); if (p) p.style.display = 'none'; }
}

function openPanelFor(f, layer) {
  if (window.GISPanel) window.GISPanel.open(f, { layerId: layer.id, sub: layer.name.split(' · ')[0] });
  else if (window.GISTable) GISTable.openLayer(layer.id, f.properties && f.properties.asset_code, { title: '📋 ' + catLabel(layer._cat), sub: layer.name.split(' · ')[0] });
}

// Build the Leaflet layer for an engine layer. NO clustering — points render
// as plain circle markers (no "bubbles"); viewport loading keeps it light.
function buildLayer(fc, layer, color) {
  var sym = window.GISSymbology;   // Phase 3: attribute-driven symbology (optional)
  return L.geoJSON(fc, {
    style: function (f) { return sym ? sym.lineStyle(layer, f, color) : { color: color, weight: 3, opacity: .9 }; },
    pointToLayer: function (f, ll) { return sym ? sym.pointToLayer(layer, f, ll, color) : L.circleMarker(ll, { radius: 5, color: '#fff', weight: 1.2, fillColor: color, fillOpacity: .9 }); },
    onEachFeature: function (f, lf) {
      lf.on('click', function () { openPanelFor(f, layer); });
      if (sym && sym.wantLabel(layer)) { var txt = sym.labelText(layer, f); if (txt) lf.bindTooltip(txt, { permanent: true, direction: 'center', className: 'gis-sym-label', opacity: 1 }); }
    }
  });
}

async function build() {
  hideOldPanel();
  var host = document.getElementById('layers-scroll-area');
  var panel = document.createElement('div');
  panel.className = 'panel'; panel.id = 'gis-eng-panel';
  panel.innerHTML =
    '<div class="panel-title" style="cursor:pointer" id="ge-head">' +
      '🧠 שכבות מנוע GIS' +
      '<span style="display:flex;align-items:center;gap:6px">' +
        '<button class="ge-refresh" id="ge-refresh" title="רענן">↻</button>' +
        '<span class="count-pill" id="ge-count">0</span>' +
        '<span id="ge-chev" style="font-size:11px">▾</span>' +
      '</span>' +
    '</div>' +
    '<div class="ge-body" id="ge-body"><div class="ge-empty">טוען…</div></div>';
  host.appendChild(panel);

  document.getElementById('ge-head').onclick = function (e) {
    if (e.target.id === 'ge-refresh') return;
    panel.classList.toggle('collapsed');
    document.getElementById('ge-chev').textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
  };
  document.getElementById('ge-refresh').onclick = function (e) { e.stopPropagation(); render(); };
  render();
}

async function render() {
  var body = document.getElementById('ge-body');
  body.innerHTML = '<div class="ge-empty">טוען…</div>';
  try {
    var layers = await GIS.layers.getLayers();
    document.getElementById('ge-count').textContent = layers.length;
    // קבץ לפי כפר (שם השכבה: "<כפר> · <category>")
    var groups = {}, order = [];
    layers.forEach(function (l) {
      var idx = l.name.indexOf(' · ');
      var village = idx >= 0 ? l.name.slice(0, idx) : 'שכבות כלליות';
      var cat = idx >= 0 ? l.name.slice(idx + 3) : l.name;
      l._cat = cat;
      if (!groups[village]) { groups[village] = []; order.push(village); }
      groups[village].push(l);
    });

    body.innerHTML = '';
    if (!layers.length) {
      var note = document.createElement('div');
      note.className = 'ge-empty';
      note.innerHTML = 'אין שכבות תשתית עדיין — הכפרים מוצגים עבור מדי מים.';
      body.appendChild(note);
    }
    order.forEach(function (village) { body.appendChild(villageBlock(village, groups[village])); });
    // Every known village is shown so its water meters are reachable even with no
    // uploaded infrastructure layers. Meters attach to a village by coordinates
    // (nearest centre) and load per-village via a bbox query (no fleet-wide load).
    Object.keys(VILLAGE_CENTERS).forEach(function (v) {
      if (order.indexOf(v) === -1) body.appendChild(villageBlock(v, []));
    });
  } catch (e) {
    body.innerHTML = '<div class="ge-empty" style="color:#dc2626">' + esc(e.message) + '</div>';
  }
}

function villageBlock(village, layers) {
  var wrap = document.createElement('div');
  wrap.className = 'ge-village' + (openVillages[village] ? '' : ' collapsed');
  var head = document.createElement('div');
  head.className = 'ge-vhead';
  head.innerHTML =
    '<span class="ge-vchev">' + (openVillages[village] ? '▾' : '▸') + '</span>' +
    '<span class="ge-vname">📍 ' + esc(village) + '</span>' +
    '<button class="ge-fly" title="התמקד בכפר">🎯</button>' +
    '<span class="ge-vcount">' + layers.length + ' שכבות</span>';
  head.onclick = function () {
    openVillages[village] = !openVillages[village];
    wrap.classList.toggle('collapsed');
    head.querySelector('.ge-vchev').textContent = openVillages[village] ? '▾' : '▸';
  };
  head.querySelector('.ge-fly').onclick = function (e) { e.stopPropagation(); flyToVillage(layers, village); };
  wrap.appendChild(head);

  var bodyEl = document.createElement('div');
  bodyEl.className = 'ge-vbody';
  layers.sort(function (a, b) { return catLabel(a._cat).localeCompare(catLabel(b._cat), 'he'); });
  layers.forEach(function (l) { bodyEl.appendChild(row(l)); });
  // Water meters for this village (own table, placed by coordinates).
  if (VILLAGE_CENTERS[village]) bodyEl.appendChild(meterVillageRow(village));
  wrap.appendChild(bodyEl);
  return wrap;
}

function flyToVillage(layers, village) {
  if (!window.gMap) return;
  if (!layers || !layers.length) {
    var c = VILLAGE_CENTERS[village];
    if (c) gMap.flyTo([c.lat, c.lng], 15, { duration: .8 });
    return;
  }
  GIS.layers.extent(layers.map(function (l) { return l.id; })).then(function (bb) {
    if (bb) gMap.flyToBounds([[bb[1], bb[0]], [bb[3], bb[2]]], { padding: [40, 40], duration: .8, maxZoom: 17 });
  }).catch(function (e) { console.warn('[GISEngineSidebar] flyTo', e); });
}

// Delete an entire village (all its engine layers + their features). Admin only.
async function deleteVillage(village, layers) {
  if (!window.confirm('למחוק את כל שכבות "' + village + '" מהמנוע? כולל כל הפיצ\'רים. פעולה בלתי הפיכה.')) return;
  for (var i = 0; i < layers.length; i++) {
    var id = layers[i].id;
    if (loaded[id]) { loaded[id].destroy(); delete loaded[id]; }
    delete active[id];
    try { await GIS.layers.deleteLayer(id); }
    catch (e) { alert('שגיאה במחיקה: ' + e.message); break; }
  }
  render();
}

function row(layer) {
  var color = colorFor(layer);
  var el = document.createElement('div');
  el.className = 'ge-row';
  el.innerHTML =
    '<input type="checkbox">' +
    '<input type="color" class="ge-color" value="' + toHex(color) + '" title="שנה צבע שכבה">' +
    '<span class="ge-name" title="' + esc(layer.name) + '">' + esc(catLabel(layer._cat)) + '</span>' +
    '<span class="ge-count"></span>' +
    '<span class="ge-stat"></span>';
  var cb = el.querySelector('input[type=checkbox]');
  var picker = el.querySelector('.ge-color');
  var cnt = el.querySelector('.ge-count');
  layer._cntEl = cnt;
  layer._statEl = el.querySelector('.ge-stat');

  // clicking the name toggles the layer (the row is a div, not a label)
  el.querySelector('.ge-name').onclick = function () { cb.checked = !cb.checked; cb.onchange(); };

  // recolour: persist + restyle live if the layer is rendered
  picker.onclick = function (e) { e.stopPropagation(); };
  picker.onchange = async function () {
    var newColor = picker.value;
    layer.color = newColor;
    try { await GIS.layers.setColor(layer.id, newColor); }
    catch (e) { alert('שגיאה בשמירת צבע: ' + e.message); return; }
    // Re-render the live tiles with the new colour (no network round-trip is
    // possible from cached layers, so invalidate refetches the current view).
    if (loaded[layer.id]) loaded[layer.id].invalidate();
  };

  cb.onchange = function () {
    if (cb.checked) {
      cnt.textContent = '…';
      active[layer.id] = layer; wireMoveend();
      if (loaded[layer.id]) loaded[layer.id].destroy();
      loaded[layer.id] = createLoader(layer);   // first viewport load kicks off now
    } else {
      delete active[layer.id];
      if (loaded[layer.id]) { loaded[layer.id].destroy(); delete loaded[layer.id]; }
      cnt.textContent = '';
    }
  };
  return el;
}

// ── Water meters (Arad) ──────────────────────────────────────────────────
// Meters live in their own table (GIS.meters), not in engine layers. They are
// shown PER VILLAGE, placed by their coordinates: each village loads only the
// meters inside its own bounding box (a GIST-indexed bbox RPC), so we never
// load the whole 30k+ fleet at once (that hits the DB statement timeout). A
// meter in an overlap zone is shown only under its NEAREST village centre.
var METER_COLOR = '#0284c7';

// The 7 villages (centre lat/lng) — mirrors upload.js VILLAGES.
var VILLAGE_CENTERS = {
  'מגד אל-כרום': { lat: 32.9189, lng: 35.2456 },
  'בענה':        { lat: 32.9485, lng: 35.2617 },
  'דיר אל-אסד':  { lat: 32.9356, lng: 35.2697 },
  'נחף':         { lat: 32.9344, lng: 35.3025 },
  'סחנין':       { lat: 32.8650, lng: 35.2978 },
  'דיר חנא':     { lat: 32.8631, lng: 35.3589 },
  'עראבה':       { lat: 32.8514, lng: 35.3339 }
};
var VILLAGE_HALF = 0.05;   // ~5 km half-box used to query a village's meters

function villageBbox(name) {
  var c = VILLAGE_CENTERS[name];
  return { minLng: c.lng - VILLAGE_HALF, minLat: c.lat - VILLAGE_HALF,
           maxLng: c.lng + VILLAGE_HALF, maxLat: c.lat + VILLAGE_HALF };
}

// Nearest of the 7 village centres to a point, or null if none within range.
function nearestVillage(lng, lat) {
  var best = null, bestD = Infinity;
  Object.keys(VILLAGE_CENTERS).forEach(function (name) {
    var c = VILLAGE_CENTERS[name];
    var d = Math.sqrt(Math.pow(lng - c.lng, 2) + Math.pow(lat - c.lat, 2));
    if (d < bestD) { bestD = d; best = name; }
  });
  return bestD <= 0.06 ? best : null;
}

function buildMeterLayer(feats) {
  return L.geoJSON({ type: 'FeatureCollection', features: feats }, {
    pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 5, color: '#fff', weight: 1.2, fillColor: METER_COLOR, fillOpacity: .9 }); },
    onEachFeature: function (f, lf) { lf.bindPopup(meterPopup(f)); }
  });
}

function meterPopup(f) {
  var p = f.properties || {};
  var rows = [
    ['מספר מונה', p.arad_meter_id],
    ['מספר צרכן', p.customer_id],
    ['שם צרכן', p.customer_name || (p.raw_data && p.raw_data.customer_name)],
    ['קריאה אחרונה', p.last_reading],
    ['כתובת', p.address || (p.raw_data && p.raw_data.address)]
  ];
  var html = '<div style="font-size:12.5px;line-height:1.6;min-width:170px"><b>🔢 מד מים</b>';
  rows.forEach(function (r) { if (r[1] != null && r[1] !== '') html += '<br>' + esc(r[0]) + ': ' + esc(r[1]); });
  return html + '</div>';
}

// A "🔢 מדי מים" toggle inside a village block. Loads only that village's meters
// (bbox RPC) and keeps the ones whose nearest village centre is this village,
// so each meter sits under exactly one (its correct) village by coordinates.
function meterVillageRow(village) {
  var el = document.createElement('div');
  el.className = 'ge-row';
  el.innerHTML =
    '<input type="checkbox">' +
    '<span class="ge-dot" style="background:' + METER_COLOR + '"></span>' +
    '<span class="ge-name" title="מדי מים מתוך מערכת Arad (עם קריאות), ממוקמים לפי קואורדינטות">🔢 מדי מים (Arad)</span>' +
    '<span class="ge-count"></span>';
  var cb = el.querySelector('input[type=checkbox]');
  var cnt = el.querySelector('.ge-count');
  el.querySelector('.ge-name').onclick = function () { cb.checked = !cb.checked; cb.onchange(); };
  cb.onchange = async function () {
    if (cb.checked) {
      cb.disabled = true; cnt.textContent = '…';
      try {
        if (!meterLayers[village]) {
          var fc = await GIS.meters.getMetersInBBox(villageBbox(village));
          var feats = (fc.features || []).filter(function (f) {
            var c = f.geometry && f.geometry.coordinates;
            return c && nearestVillage(c[0], c[1]) === village;
          });
          meterLayers[village] = buildMeterLayer(feats);
          meterLayers[village]._count = feats.length;
        }
        meterLayers[village].addTo(window.gMap);
        cnt.textContent = meterLayers[village]._count;
      } catch (e) {
        cb.checked = false; cnt.textContent = '✕';
        alert('שגיאה בטעינת מדי מים: ' + e.message);
      } finally { cb.disabled = false; }
    } else {
      if (meterLayers[village]) window.gMap.removeLayer(meterLayers[village]);
      cnt.textContent = '';
    }
  };
  return el;
}

function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]; }); }

// Expose the Hebrew category label so the legend (GISSymbology) can name layers.
window.GISLayerLabel = catLabel;

// Allow the attribute table to refresh a rendered layer on the map after an edit.
window.GISEngineSidebar = {
  reload: function (layerId) { if (loaded[layerId]) loaded[layerId].invalidate(); },        // after an edit → refetch that layer
  reloadAll: function () { Object.keys(loaded).forEach(function (id) { loaded[id].invalidate(); }); }, // re-style all active (labels toggle)
  activeLayers: function () { return Object.keys(active).map(function (id) { return active[id]; }); },
  refresh: function () { try { render(); } catch (e) {} }
};

})();
