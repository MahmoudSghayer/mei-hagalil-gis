(function () {
'use strict';

var LABELS = {
  sewage_pipe:'קווי ביוב (DWG)', manhole:'שוחות ביוב (DWG)', sleeve:'שרוולים',
  control_point:'נקודות בקרה', pipe_label:'תוויות צנרת', elevation_label:'גבהים TL/IL',
  attribute_label:'תוויות שוחות', distance_label:'מרחקים', dimension_line:'קווי מידה',
  manhole_drawing:'שרטוטי שוחות', buildings:'בניינים', parcels:'חלקות',
  water_meters:'מדי מים', water_pipes:'קווי מים', sewage_pipes:'קווי ביוב',
  sewage_manholes:'שוחות ביוב', hydrants:'הידרנטים', valves:'מגופים',
  control_valves:'מגופים שולטים', connection_points:'נקודות חיבור מקורות',
  reservoirs:'מאגרי מים', pump_stations:'תחנות שאיבה',
  sampling_points:'נקודות דיגום', other:'אחר'
};

var gRect = null, gDrawing = false, gDrawStart = null, gDrawTemp = null;
var gExportFormat = 'dxf';
var gExpScope = 'all';

// ── STYLES ──────────────────────────────────────────────────────────────────
var s = document.createElement('style');
s.textContent =
  '#exp-fab{position:absolute;bottom:90px;right:14px;background:#0d3b5e;color:#fff;border:none;border-radius:50%;width:50px;height:50px;font-size:20px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.3);z-index:400;display:flex;align-items:center;justify-content:center;}' +
  '#exp-fab:hover{background:#1a7fc1;}' +
  '.exp-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1500;align-items:center;justify-content:center;}' +
  '.exp-bg.open{display:flex;}' +
  '.exp-mod{background:#fff;border-radius:14px;width:460px;max-width:95vw;direction:rtl;box-shadow:0 12px 40px rgba(0,0,0,0.25);max-height:90vh;overflow:hidden;display:flex;flex-direction:column;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif;}' +
  '.exp-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 16px;border-bottom:1px solid #e2e8f0;flex-shrink:0;}' +
  '.exp-title{font-size:17px;font-weight:700;color:#0d3b5e;}' +
  '.exp-close-btn{background:none;border:none;font-size:18px;cursor:pointer;color:#94a3b8;padding:2px 8px;border-radius:6px;line-height:1;}' +
  '.exp-close-btn:hover{background:#f1f5f9;color:#0d3b5e;}' +
  '.exp-body{padding:18px 20px;overflow-y:auto;flex:1;}' +
  '.exp-sec{font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px;display:flex;align-items:center;justify-content:space-between;}' +
  '.exp-sec-acts{display:flex;gap:5px;}' +
  '.exp-sec-acts button{font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;color:#64748b;font-family:inherit;}' +
  '.exp-sec-acts button:hover{background:#f1f5f9;}' +
  '.exp-pills{display:flex;gap:7px;margin-bottom:20px;}' +
  '.exp-pill{flex:1;padding:10px 6px;border:2px solid #e2e8f0;border-radius:9px;background:#fff;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;color:#64748b;text-align:center;transition:border-color .15s,background .15s;}' +
  '.exp-pill:hover{border-color:#93c5fd;color:#1a7fc1;}' +
  '.exp-pill.active{border-color:#0d3b5e;background:#eff6ff;color:#0d3b5e;}' +
  '.exp-pill-sub{font-size:9px;font-weight:400;display:block;margin-top:2px;opacity:.8;}' +
  '.exp-cats-list{border:1px solid #e2e8f0;border-radius:9px;overflow:hidden;margin-bottom:20px;max-height:210px;overflow-y:auto;}' +
  '.exp-cat-row{display:flex;align-items:center;gap:10px;padding:9px 13px;border-bottom:1px solid #f1f5f9;cursor:pointer;transition:background .1s;}' +
  '.exp-cat-row:last-child{border-bottom:none;}' +
  '.exp-cat-row:hover{background:#f8fafc;}' +
  '.exp-cat-row input{margin:0;cursor:pointer;width:15px;height:15px;flex-shrink:0;accent-color:#0d3b5e;}' +
  '.exp-cat-lbl{flex:1;font-size:13px;color:#1e293b;}' +
  '.exp-cat-cnt{font-size:11px;color:#94a3b8;background:#f1f5f9;padding:1px 8px;border-radius:10px;font-weight:600;}' +
  '.exp-scope{display:flex;flex-direction:column;gap:7px;margin-bottom:4px;}' +
  '.exp-scope-opt{display:flex;align-items:center;gap:10px;padding:11px 14px;border:2px solid #e2e8f0;border-radius:9px;cursor:pointer;transition:border-color .15s,background .15s;font-size:13px;color:#334155;user-select:none;}' +
  '.exp-scope-opt:hover{border-color:#93c5fd;}' +
  '.exp-scope-opt.active{border-color:#0d3b5e;background:#eff6ff;color:#0d3b5e;font-weight:600;}' +
  '.exp-scope-opt input{margin:0;cursor:pointer;accent-color:#0d3b5e;}' +
  '.exp-foot{padding:14px 20px;border-top:1px solid #e2e8f0;display:flex;gap:8px;justify-content:flex-end;flex-shrink:0;}' +
  '.exp-btn{padding:10px 22px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;}' +
  '.exp-btn-primary{background:#0d3b5e;color:#fff;}' +
  '.exp-btn-primary:hover{background:#1a7fc1;}' +
  '.exp-btn-secondary{background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;}' +
  '.exp-btn-secondary:hover{background:#e2e8f0;}' +
  '#exp-banner{position:absolute;top:14px;left:50%;transform:translateX(-50%);background:#0d3b5e;color:#fff;padding:10px 22px;border-radius:10px;font-size:13px;font-weight:600;z-index:500;display:none;white-space:nowrap;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.25);}' +
  '#exp-banner.show{display:block;}' +
  '#exp-cancel-draw{position:absolute;top:14px;right:14px;background:#dc2626;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;z-index:500;display:none;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.25);}' +
  '#exp-cancel-draw.show{display:block;}';
document.head.appendChild(s);

// ── INJECT HTML ──────────────────────────────────────────────────────────────
function injectUI() {
  var mw = document.getElementById('map-wrap');
  if (!mw) { setTimeout(injectUI, 200); return; }

  var fab = document.createElement('button');
  fab.id = 'exp-fab';
  fab.title = 'יצוא נתונים';
  fab.innerHTML = '📥';
  fab.onclick = openExportModal;
  mw.appendChild(fab);

  var banner = document.createElement('div');
  banner.id = 'exp-banner';
  banner.textContent = '🖱️ לחץ וגרור לסימון אזור על המפה';
  mw.appendChild(banner);

  var cancelBtn = document.createElement('button');
  cancelBtn.id = 'exp-cancel-draw';
  cancelBtn.textContent = '✖ בטל';
  cancelBtn.onclick = cancelDrawing;
  mw.appendChild(cancelBtn);

  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<div class="exp-bg" id="exp-modal">' +
      '<div class="exp-mod">' +
        '<div class="exp-head">' +
          '<div class="exp-title">📥 יצוא נתונים</div>' +
          '<button class="exp-close-btn" onclick="closeExportModal()">✕</button>' +
        '</div>' +
        '<div class="exp-body">' +

          '<div class="exp-sec">פורמט</div>' +
          '<div class="exp-pills">' +
            '<button class="exp-pill active" data-fmt="dxf" onclick="expSetFmt(\'dxf\')">📐 DXF<span class="exp-pill-sub">AutoCAD · ITM</span></button>' +
            '<button class="exp-pill" data-fmt="geojson" onclick="expSetFmt(\'geojson\')">🗺️ GeoJSON<span class="exp-pill-sub">GIS סטנדרט</span></button>' +
            '<button class="exp-pill" data-fmt="csv" onclick="expSetFmt(\'csv\')">📊 CSV<span class="exp-pill-sub">Excel</span></button>' +
          '</div>' +

          '<div class="exp-sec">שכבות<div class="exp-sec-acts"><button onclick="expSelectAll()">הכל</button><button onclick="expSelectNone()">נקה</button></div></div>' +
          '<div class="exp-cats-list" id="exp-cats"></div>' +

          '<div class="exp-sec">אזור</div>' +
          '<div class="exp-scope">' +
            '<label class="exp-scope-opt active" id="exp-scope-all" onclick="expSetScope(\'all\')">' +
              '<input type="radio" name="exp-scope" value="all" checked> כל הנתונים' +
            '</label>' +
            '<label class="exp-scope-opt" id="exp-scope-draw" onclick="expSetScope(\'draw\')">' +
              '<input type="radio" name="exp-scope" value="draw"> 🖱️ סמן אזור על המפה' +
            '</label>' +
          '</div>' +

        '</div>' +
        '<div class="exp-foot">' +
          '<button class="exp-btn exp-btn-secondary" onclick="closeExportModal()">ביטול</button>' +
          '<button class="exp-btn exp-btn-primary" onclick="expGo()">📥 ייצא</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);
}

// ── MODAL CONTROLS ───────────────────────────────────────────────────────────
function openExportModal() {
  if (!window.gMap) { alert('המפה עדיין לא נטענה'); return; }
  renderCatsList();
  document.getElementById('exp-modal').classList.add('open');
}
function closeExportModal() { document.getElementById('exp-modal').classList.remove('open'); }
window.closeExportModal = closeExportModal;

function renderCatsList() {
  var counts = {};
  if (window.gVillageState) {
    Object.keys(window.gVillageState).forEach(function (vid) {
      var st = window.gVillageState[vid];
      Object.keys(st.counts || {}).forEach(function (c) {
        counts[c] = (counts[c] || 0) + st.counts[c];
      });
    });
  }
  var el = document.getElementById('exp-cats');
  var keys = Object.keys(counts).sort();
  if (!keys.length) {
    el.innerHTML = '<div style="padding:16px;text-align:center;color:#94a3b8;font-size:13px">אין שכבות טעונות במפה</div>';
    return;
  }
  el.innerHTML = keys.map(function (k) {
    return '<label class="exp-cat-row">' +
      '<input type="checkbox" value="' + k + '" checked>' +
      '<span class="exp-cat-lbl">' + (LABELS[k] || k) + '</span>' +
      '<span class="exp-cat-cnt">' + counts[k] + '</span>' +
      '</label>';
  }).join('');
}

window.expSelectAll  = function () { document.querySelectorAll('#exp-cats input').forEach(function (i) { i.checked = true;  }); };
window.expSelectNone = function () { document.querySelectorAll('#exp-cats input').forEach(function (i) { i.checked = false; }); };

window.expSetFmt = function (fmt) {
  gExportFormat = fmt;
  document.querySelectorAll('.exp-pill').forEach(function (p) {
    p.classList.toggle('active', p.getAttribute('data-fmt') === fmt);
  });
};

window.expSetScope = function (scope) {
  gExpScope = scope;
  document.getElementById('exp-scope-all').classList.toggle('active',  scope === 'all');
  document.getElementById('exp-scope-draw').classList.toggle('active', scope === 'draw');
  document.querySelector('#exp-scope-all  input').checked = scope === 'all';
  document.querySelector('#exp-scope-draw input').checked = scope === 'draw';
};

// ── EXPORT GO ────────────────────────────────────────────────────────────────
window.expGo = function () {
  var selectedCats = [];
  document.querySelectorAll('#exp-cats input:checked').forEach(function (i) { selectedCats.push(i.value); });
  if (!selectedCats.length) { alert('בחר לפחות שכבה אחת'); return; }

  closeExportModal();

  if (gExpScope === 'draw') {
    startDrawMode(selectedCats);
  } else {
    loadAllFeatures(selectedCats, function (features) {
      if (!features.length) { alert('לא נמצאו אובייקטים'); return; }
      generateAndDownload(features);
    });
  }
};

// ── LOAD FEATURES ────────────────────────────────────────────────────────────
function loadAllFeatures(selectedCats, cb) {
  collectFeatures(selectedCats, null, cb);
}

function collectFeatures(selectedCats, bounds, cb) {
  var features = [];
  var villages = window.gVillages || [];
  if (!villages.length) { cb([]); return; }
  var remaining = villages.length;
  function done() { if (--remaining === 0) cb(features); }
  villages.forEach(function (v) {
    var urlRes = window.gSb.storage.from('village-layers').getPublicUrl(v.file_path);
    fetch(urlRes.data.publicUrl)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        (data.features || []).forEach(function (f) {
          if (!f.geometry) return;
          var cat = (f.properties && f.properties._category) || 'other';
          if (selectedCats.indexOf(cat) === -1) return;
          if (bounds && !isInBounds(f.geometry, bounds)) return;
          if (!f.properties) f.properties = {};
          f.properties._village = v.village_name;
          features.push(f);
        });
        done();
      })
      .catch(done);
  });
}

// ── DRAW MODE ────────────────────────────────────────────────────────────────
function startDrawMode(selectedCats) {
  if (gRect) { window.gMap.removeLayer(gRect); gRect = null; }
  gDrawing = true;
  document.getElementById('exp-banner').classList.add('show');
  document.getElementById('exp-cancel-draw').classList.add('show');
  window.gMap.dragging.disable();
  window.gMap.getContainer().style.cursor = 'crosshair';
  window.gMap.once('mousedown', function (e) {
    gDrawStart = e.latlng;
    window.gMap.on('mousemove', onDrawMove);
    window.gMap.once('mouseup', function (e2) {
      window.gMap.off('mousemove', onDrawMove);
      if (gDrawTemp) { window.gMap.removeLayer(gDrawTemp); gDrawTemp = null; }
      finishDraw(e2.latlng, selectedCats);
    });
  });
}

function onDrawMove(e) {
  if (gDrawTemp) window.gMap.removeLayer(gDrawTemp);
  if (!gDrawStart) return;
  gDrawTemp = L.rectangle([gDrawStart, e.latlng], { color: '#0d3b5e', weight: 2, fillOpacity: 0.1, dashArray: '5,5' }).addTo(window.gMap);
}

function finishDraw(endLatLng, selectedCats) {
  gDrawing = false;
  document.getElementById('exp-banner').classList.remove('show');
  document.getElementById('exp-cancel-draw').classList.remove('show');
  window.gMap.dragging.enable();
  window.gMap.getContainer().style.cursor = '';
  gRect = L.rectangle([gDrawStart, endLatLng], { color: '#16a34a', weight: 2, fillOpacity: 0.08 }).addTo(window.gMap);
  var bounds = gRect.getBounds();
  gDrawStart = null;
  collectFeatures(selectedCats, bounds, function (features) {
    if (gRect) { window.gMap.removeLayer(gRect); gRect = null; }
    if (!features.length) { alert('לא נמצאו אובייקטים באזור שנבחר'); return; }
    generateAndDownload(features);
  });
}

function cancelDrawing() {
  gDrawing = false; gDrawStart = null;
  if (gDrawTemp) { window.gMap.removeLayer(gDrawTemp); gDrawTemp = null; }
  document.getElementById('exp-banner').classList.remove('show');
  document.getElementById('exp-cancel-draw').classList.remove('show');
  window.gMap.dragging.enable();
  window.gMap.getContainer().style.cursor = '';
  window.gMap.off('mousemove', onDrawMove);
}
window.cancelDrawing = cancelDrawing;

// ── GENERATE & DOWNLOAD ───────────────────────────────────────────────────────
function generateAndDownload(features) {
  var ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  var blob, name;
  if (gExportFormat === 'dxf') {
    blob = new Blob([buildDXF(features)], { type: 'application/dxf' });
    name = 'mei-hagalil-' + ts + '.dxf';
  } else if (gExportFormat === 'geojson') {
    blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: features }, null, 2)], { type: 'application/geo+json' });
    name = 'mei-hagalil-' + ts + '.geojson';
  } else {
    blob = new Blob(['﻿' + buildCSV(features)], { type: 'text/csv;charset=utf-8' });
    name = 'mei-hagalil-' + ts + '.csv';
  }
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function isInBounds(g, b) {
  if (g.type === 'Point') return b.contains([g.coordinates[1], g.coordinates[0]]);
  if (g.type === 'LineString') return g.coordinates.some(function (c) { return b.contains([c[1], c[0]]); });
  if (g.type === 'MultiLineString') return g.coordinates.some(function (line) { return line.some(function (c) { return b.contains([c[1], c[0]]); }); });
  if (g.type === 'Polygon') return g.coordinates[0] && g.coordinates[0].some(function (c) { return b.contains([c[1], c[0]]); });
  return false;
}

// ── ITM CONVERSION ────────────────────────────────────────────────────────────
function makeToITM() {
  if (window.proj4 && !window.proj4.defs('EPSG:2039')) {
    window.proj4.defs('EPSG:2039',
      '+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 ' +
      '+k=1.0000067 +x_0=219529.584 +y_0=626907.39 +ellps=GRS80 ' +
      '+towgs84=-48,55,52,0,0,0,0 +units=m +no_defs');
  }
  return function (lng, lat) {
    if (window.proj4) { try { return window.proj4('EPSG:4326', 'EPSG:2039', [lng, lat]); } catch (e) {} }
    return [lng, lat];
  };
}

// ── DXF ───────────────────────────────────────────────────────────────────────
function buildDXF(features) {
  var toITM = makeToITM();
  var lines = [
    '0','SECTION','2','HEADER',
    '9','$ACADVER','1','AC1015',
    '9','$INSUNITS','70','6',
    '9','$MEASUREMENT','70','1',
    '0','ENDSEC'
  ];
  lines.push('0','SECTION','2','TABLES','0','TABLE','2','LAYER','70','24');
  var colors = {
    sewage_pipe:2,manhole:4,sleeve:6,control_point:1,water_pipes:5,water_meters:5,
    hydrants:1,valves:6,control_valves:6,buildings:8,parcels:3,sewage_pipes:42,
    sewage_manholes:42,reservoirs:3,pump_stations:2,sampling_points:6,
    connection_points:5,pipe_label:7,elevation_label:7,attribute_label:7,
    distance_label:7,dimension_line:9,manhole_drawing:8,other:7
  };
  var seen = {};
  features.forEach(function (f) {
    var c = (f.properties && f.properties._category) || 'other';
    if (seen[c]) return; seen[c] = true;
    lines.push('0','LAYER','2',c,'70','0','62',String(colors[c]||7),'6','CONTINUOUS');
  });
  lines.push('0','ENDTAB','0','ENDSEC');
  lines.push('0','SECTION','2','ENTITIES');
  features.forEach(function (f) {
    var layer = (f.properties && f.properties._category) || 'other';
    var g = f.geometry;
    if (!g) return;
    if (g.type === 'Point') {
      var p = toITM(g.coordinates[0], g.coordinates[1]);
      lines.push('0','POINT','8',layer,'10',String(p[0]),'20',String(p[1]),'30','0');
      if (f.properties && f.properties.Text)
        lines.push('0','TEXT','8',layer,'10',String(p[0]),'20',String(p[1]),'30','0','40','1.0','1',String(f.properties.Text));
    } else if (g.type === 'LineString') {
      dxfPolyline(lines, g.coordinates, layer, false, toITM);
    } else if (g.type === 'MultiLineString') {
      g.coordinates.forEach(function (seg) { dxfPolyline(lines, seg, layer, false, toITM); });
    } else if (g.type === 'Polygon') {
      dxfPolyline(lines, g.coordinates[0], layer, true, toITM);
    } else if (g.type === 'MultiPolygon') {
      g.coordinates.forEach(function (poly) { dxfPolyline(lines, poly[0], layer, true, toITM); });
    }
  });
  lines.push('0','ENDSEC','0','EOF');
  return lines.join('\r\n');
}

function dxfPolyline(lines, coords, layer, closed, toITM) {
  lines.push('0','POLYLINE','8',layer,'66','1','70',closed?'1':'0','10','0','20','0','30','0');
  coords.forEach(function (c) {
    var p = toITM(c[0], c[1]);
    lines.push('0','VERTEX','8',layer,'10',String(p[0]),'20',String(p[1]),'30','0');
  });
  lines.push('0','SEQEND','8',layer);
}

// ── CSV ───────────────────────────────────────────────────────────────────────
function buildCSV(features) {
  var rows = [['village','category','lon','lat','geometry_type','text','layer','properties_json']];
  features.forEach(function (f) {
    var p = f.properties || {}, g = f.geometry, lon = '', lat = '';
    if (g.type === 'Point') { lon = g.coordinates[0]; lat = g.coordinates[1]; }
    else if (g.type === 'LineString' && g.coordinates.length) { lon = g.coordinates[0][0]; lat = g.coordinates[0][1]; }
    else if (g.type === 'Polygon' && g.coordinates[0] && g.coordinates[0].length) { lon = g.coordinates[0][0][0]; lat = g.coordinates[0][0][1]; }
    rows.push([p._village||'', p._category||'', lon, lat, g.type, p.Text||'', p.Layer||'', JSON.stringify(p)]);
  });
  return rows.map(function (r) {
    return r.map(function (v) { var s = String(v==null?'':v).replace(/"/g,'""'); return '"'+s+'"'; }).join(',');
  }).join('\n');
}

// ── INIT ──────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectUI);
} else {
  injectUI();
}

})();
