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
#gis-eng-panel .ge-fly{background:none;border:none;cursor:pointer;font-size:12px;padding:0 2px;opacity:.75;}
#gis-eng-panel .ge-fly:hover{opacity:1;}
#gis-eng-panel .ge-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#gis-eng-panel .ge-count{font-size:10px;color:#94a3b8;}
#gis-eng-panel .ge-empty{font-size:11px;color:#94a3b8;padding:8px 2px;line-height:1.5;}
#gis-eng-panel .ge-refresh{background:none;border:none;cursor:pointer;color:#64748b;font-size:13px;}
#gis-eng-panel.collapsed .ge-body{display:none;}`;
document.head.appendChild(css);

var loaded = {};        // layerId → L.layer
var openVillages = {};  // villageName → bool (expanded)

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

// Build the Leaflet layer for an engine layer. Point layers are clustered
// (markercluster) for performance on big datasets; lines/polygons use geoJSON.
function buildLayer(fc, layer, color) {
  var feats = fc.features || [];
  if (layer.geometry_type === 'Point' && typeof L.markerClusterGroup === 'function') {
    var cg = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50, disableClusteringAtZoom: 19, removeOutsideVisibleBounds: true });
    var markers = [];
    feats.forEach(function (f) {
      var g = f.geometry; if (!g || g.type !== 'Point') return;
      var d = 12;
      var m = L.marker([g.coordinates[1], g.coordinates[0]], { icon: L.divIcon({
        className: '', iconSize: [d, d], iconAnchor: [d / 2, d / 2],
        html: '<div style="width:' + d + 'px;height:' + d + 'px;background:' + color + ';border:1.5px solid #fff;border-radius:50%;box-sizing:border-box"></div>' }) });
      m.on('click', function () { openPanelFor(f, layer); });
      markers.push(m);
    });
    cg.addLayers(markers);
    return cg;
  }
  return L.geoJSON(fc, {
    style: function () { return { color: color, weight: 3, opacity: .9 }; },
    pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 6, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: .9 }); },
    onEachFeature: function (f, lf) { lf.on('click', function () { openPanelFor(f, layer); }); }
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
    if (!layers.length) {
      body.innerHTML = '<div class="ge-empty">אין שכבות מנוע עדיין.<br>פתח כפר במפה, לחץ על פיצ\'ר ואז "⬆️ ייבא לעריכה".</div>';
      return;
    }
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
    order.forEach(function (village) { body.appendChild(villageBlock(village, groups[village])); });
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
  head.querySelector('.ge-fly').onclick = function (e) { e.stopPropagation(); flyToVillage(layers); };
  wrap.appendChild(head);

  var bodyEl = document.createElement('div');
  bodyEl.className = 'ge-vbody';
  layers.sort(function (a, b) { return catLabel(a._cat).localeCompare(catLabel(b._cat), 'he'); });
  layers.forEach(function (l) { bodyEl.appendChild(row(l)); });
  wrap.appendChild(bodyEl);
  return wrap;
}

function flyToVillage(layers) {
  if (!window.gMap) return;
  GIS.layers.extent(layers.map(function (l) { return l.id; })).then(function (bb) {
    if (bb) gMap.flyToBounds([[bb[1], bb[0]], [bb[3], bb[2]]], { padding: [40, 40], duration: .8, maxZoom: 17 });
  }).catch(function (e) { console.warn('[GISEngineSidebar] flyTo', e); });
}

function row(layer) {
  var color = colorFor(layer);
  var el = document.createElement('div');
  el.className = 'ge-row';
  el.innerHTML =
    '<input type="checkbox">' +
    '<input type="color" class="ge-color" value="' + toHex(color) + '" title="שנה צבע שכבה">' +
    '<span class="ge-name" title="' + esc(layer.name) + '">' + esc(catLabel(layer._cat)) + '</span>' +
    '<span class="ge-count"></span>';
  var cb = el.querySelector('input[type=checkbox]');
  var picker = el.querySelector('.ge-color');
  var cnt = el.querySelector('.ge-count');

  // clicking the name toggles the layer (the row is a div, not a label)
  el.querySelector('.ge-name').onclick = function () { cb.checked = !cb.checked; cb.onchange(); };

  // recolour: persist + restyle live if the layer is rendered
  picker.onclick = function (e) { e.stopPropagation(); };
  picker.onchange = async function () {
    var newColor = picker.value;
    layer.color = newColor;
    try { await GIS.layers.setColor(layer.id, newColor); }
    catch (e) { alert('שגיאה בשמירת צבע: ' + e.message); return; }
    if (loaded[layer.id]) {
      window.gMap.removeLayer(loaded[layer.id]);
      var fc = loaded[layer.id]._gisFC;
      loaded[layer.id] = buildLayer(fc, layer, newColor).addTo(window.gMap);
      loaded[layer.id]._gisFC = fc;
    }
  };

  cb.onchange = async function () {
    if (cb.checked) {
      cb.disabled = true; cnt.textContent = '…';
      try {
        var fc = await GIS.features.getFeatures(layer.id, 100000);
        var lyr = buildLayer(fc, layer, colorFor(layer)).addTo(window.gMap);
        lyr._gisFC = fc;
        loaded[layer.id] = lyr; cnt.textContent = (fc.features || []).length;
      } catch (e) { cb.checked = false; cnt.textContent = '✕'; alert('שגיאה: ' + e.message); }
      finally { cb.disabled = false; }
    } else {
      if (loaded[layer.id]) { window.gMap.removeLayer(loaded[layer.id]); delete loaded[layer.id]; }
      cnt.textContent = '';
    }
  };
  return el;
}

function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]; }); }

})();
