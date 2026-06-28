// ════════════════════════════════════════════════════════════════
//  מי הגליל GIS — שכבות מנוע GIS (GIS Engine Layers control)
//  מודול עצמאי: מוסיף פאנל בקרה למפה לטעינת שכבות הנכסים המובְנות
//  (צנרת/מגופים/הידרנטים/מדי-מים) דרך מנוע ה-GIS (GIS.*), ומחבר
//  לחיצה על פיצ'ר ל-GISPanel. לא נוגע ב-index.js / ליבת המפה.
//
//  דורש: gis-engine/*.js + js/gis-attribute-panel.js טעונים, ו-gMap.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

// סגנון לפי שם שכבה (geometry_type קובע נקודה מול קו)
var STYLE = {
  'Pipes':    { color: '#1a7fc1', kind: 'line' },
  'Valves':   { color: '#16a34a', kind: 'point' },
  'Hydrants': { color: '#dc2626', kind: 'point' },
  'Meters':   { color: '#7c3aed', kind: 'point' }
};
function styleFor(name, geomType) {
  var s = STYLE[name] || {};
  return { color: s.color || '#0d3b5e', kind: s.kind || (geomType === 'LineString' ? 'line' : 'point') };
}

// ── סגנונות UI ────────────────────────────────────────────────────────────────
var css = document.createElement('style');
css.textContent = `
#gis-engine-ctrl{position:absolute;top:14px;left:14px;z-index:500;background:#fff;border-radius:12px;
  box-shadow:0 4px 16px rgba(0,0,0,.2);font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;
  width:208px;overflow:hidden;}
#gis-engine-ctrl .gx-head{display:flex;align-items:center;justify-content:space-between;cursor:pointer;
  background:#0d3b5e;color:#fff;padding:9px 12px;font-size:13px;font-weight:700;}
#gis-engine-ctrl .gx-head .chev{font-size:11px;opacity:.8;}
#gis-engine-ctrl .gx-body{padding:6px 6px 8px;max-height:50vh;overflow-y:auto;}
#gis-engine-ctrl.collapsed .gx-body{display:none;}
.gx-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;font-size:13px;color:#1e293b;cursor:pointer;}
.gx-row:hover{background:#f1f5f9;}
.gx-row input{accent-color:#0d3b5e;width:15px;height:15px;cursor:pointer;}
.gx-dot{width:11px;height:11px;border-radius:50%;flex-shrink:0;}
.gx-name{flex:1;}
.gx-count{font-size:11px;color:#94a3b8;}
.gx-spin{font-size:11px;color:#1a7fc1;}
.gx-empty{font-size:11.5px;color:#94a3b8;text-align:center;padding:10px 0;}
.gx-err{font-size:11.5px;color:#dc2626;text-align:center;padding:8px;}`;
document.head.appendChild(css);

var loaded = {};   // key → L.layer  (key = layerId or 'meters')
var building = false;

// המתן עד שהמפה והמנוע מוכנים, ואז בנה את הבקרה.
var tries = 0;
var waiter = setInterval(function () {
  tries++;
  if (window.gMap && window.GIS && document.getElementById('map-wrap')) {
    clearInterval(waiter);
    build().catch(function (e) { console.error('[GISLayers]', e); });
  } else if (tries > 80) { // ~16s
    clearInterval(waiter);
    console.warn('[GISLayers] gMap / GIS not ready — engine layers control not shown.');
  }
}, 200);

async function build() {
  if (building) return; building = true;

  var ctrl = document.createElement('div');
  ctrl.id = 'gis-engine-ctrl';
  ctrl.innerHTML =
    '<div class="gx-head"><span>🧠 שכבות מנוע GIS</span><span class="chev">▾</span></div>' +
    '<div class="gx-body"><div class="gx-empty">טוען שכבות…</div></div>';
  document.getElementById('map-wrap').appendChild(ctrl);

  var head = ctrl.querySelector('.gx-head');
  var body = ctrl.querySelector('.gx-body');
  head.onclick = function () {
    ctrl.classList.toggle('collapsed');
    head.querySelector('.chev').textContent = ctrl.classList.contains('collapsed') ? '▸' : '▾';
  };

  try {
    var layers = await GIS.layers.getLayers();   // [{id,name,geometry_type,fields}]
    body.innerHTML = '';
    layers.forEach(function (l) { body.appendChild(makeRow(l.id, l.name, l.geometry_type)); });
    // שורת מדי-מים (טבלה נפרדת מהפיצ'רים)
    body.appendChild(makeRow('meters', 'Meters', 'Point', true));
    if (!layers.length) body.insertAdjacentHTML('afterbegin', '<div class="gx-empty">אין שכבות. הרץ את seed.sql.</div>');
  } catch (e) {
    body.innerHTML = '<div class="gx-err">' + esc(e.message) + '</div>';
  }
}

function makeRow(key, name, geomType, isMeters) {
  var st = styleFor(name, geomType);
  var row = document.createElement('label');
  row.className = 'gx-row';
  row.innerHTML =
    '<input type="checkbox">' +
    '<span class="gx-dot" style="background:' + st.color + '"></span>' +
    '<span class="gx-name">' + esc(heb(name)) + '</span>' +
    '<span class="gx-count"></span>';
  var cb = row.querySelector('input');
  var countEl = row.querySelector('.gx-count');
  cb.onchange = async function () {
    if (cb.checked) {
      cb.disabled = true; countEl.className = 'gx-spin'; countEl.textContent = '…';
      try {
        var lyr = await renderLayer(key, name, geomType, st, isMeters);
        loaded[key] = lyr;
        countEl.className = 'gx-count';
        countEl.textContent = lyr._gisCount != null ? lyr._gisCount : '';
      } catch (e) {
        cb.checked = false; countEl.className = 'gx-err'; countEl.textContent = '✕';
        console.error('[GISLayers]', e); alert('שגיאה בטעינת שכבה: ' + e.message);
      } finally { cb.disabled = false; }
    } else {
      if (loaded[key]) { window.gMap.removeLayer(loaded[key]); delete loaded[key]; }
      countEl.textContent = '';
    }
  };
  return row;
}

async function renderLayer(key, name, geomType, st, isMeters) {
  var fc = isMeters ? await GIS.meters.getMeters() : await GIS.features.getFeatures(key);
  var opts = {
    onEachFeature: window.GISPanel ? window.GISPanel.onEachFeature : undefined,
    style: function () { return { color: st.color, weight: 3, opacity: 0.9 }; },
    pointToLayer: function (feat, latlng) {
      return L.circleMarker(latlng, {
        radius: isMeters ? 5 : 6, color: '#fff', weight: 1.5,
        fillColor: st.color, fillOpacity: 0.9
      });
    }
  };
  var lyr = L.geoJSON(fc, opts).addTo(window.gMap);
  lyr._gisCount = (fc.features || []).length;
  return lyr;
}

// תרגום שמות שכבות לעברית לתצוגה
function heb(name) {
  return ({ Pipes: 'צנרת', Valves: 'מגופים', Hydrants: 'הידרנטים', Meters: 'מדי מים' })[name] || name;
}
// esc() centralized in auth.js (window.escHtml)

})();
