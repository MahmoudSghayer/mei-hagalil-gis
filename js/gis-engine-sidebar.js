// ════════════════════════════════════════════════════════════════
//  מי הגליל GIS — פאנל שכבות מנוע בסרגל הצד (Phase 2)
//  מזריק פאנל "שכבות מנוע GIS" לתוך הסרגל הקיים (#layers-scroll-area),
//  ליד שכבות התשתית. מציג את כל שכבות המנוע (כולל כפרים שעברו מיגרציה),
//  עם הדלקה/כיבוי, כיווץ, וספירה — ולחיצה על פיצ'ר פותחת את הטבלה הנערכת.
//  עצמאי, ללא נגיעה ב-index.js.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

var STYLE = {
  point: { color: '#0d3b5e' }, LineString: { color: '#1a7fc1' }, Polygon: { color: '#0e7490' }
};
function colorFor(geomType) { return geomType === 'Point' ? '#0d3b5e' : geomType === 'Polygon' ? '#0e7490' : '#1a7fc1'; }

var css = document.createElement('style');
css.textContent = `
#gis-eng-panel .ge-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-radius:7px;cursor:pointer;font-size:12.5px;}
#gis-eng-panel .ge-row:hover{background:#f1f5f9;}
#gis-eng-panel .ge-row input{accent-color:#0d3b5e;width:14px;height:14px;cursor:pointer;}
#gis-eng-panel .ge-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
#gis-eng-panel .ge-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#gis-eng-panel .ge-count{font-size:10.5px;color:#94a3b8;}
#gis-eng-panel .ge-empty{font-size:11px;color:#94a3b8;padding:6px 2px;}
#gis-eng-panel .ge-refresh{background:none;border:none;cursor:pointer;color:#64748b;font-size:13px;}
#gis-eng-panel.collapsed .ge-body{display:none;}`;
document.head.appendChild(css);

var loaded = {};   // layerId → L.layer

var tries = 0;
var t = setInterval(function () {
  tries++;
  if (window.GIS && window.gMap && document.getElementById('layers-scroll-area')) {
    clearInterval(t); build().catch(function (e) { console.error('[GISEngineSidebar]', e); });
  } else if (tries > 80) { clearInterval(t); }
}, 200);

async function build() {
  var host = document.getElementById('layers-scroll-area');
  var panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = 'gis-eng-panel';
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
    if (!layers.length) { body.innerHTML = '<div class="ge-empty">אין שכבות מנוע. ייבא כפר מהטבלה (⬆️ ייבא לעריכה).</div>'; return; }
    body.innerHTML = '';
    layers.forEach(function (l) { body.appendChild(row(l)); });
  } catch (e) {
    body.innerHTML = '<div class="ge-empty" style="color:#dc2626">' + esc(e.message) + '</div>';
  }
}

function row(layer) {
  var color = colorFor(layer.geometry_type);
  var el = document.createElement('label');
  el.className = 'ge-row';
  el.innerHTML =
    '<input type="checkbox">' +
    '<span class="ge-dot" style="background:' + color + '"></span>' +
    '<span class="ge-name" title="' + esc(layer.name) + '">' + esc(layer.name) + '</span>' +
    '<span class="ge-count"></span>';
  var cb = el.querySelector('input');
  var cnt = el.querySelector('.ge-count');
  cb.onchange = async function () {
    if (cb.checked) {
      cb.disabled = true; cnt.textContent = '…';
      try {
        var fc = await GIS.features.getFeatures(layer.id);
        var lyr = L.geoJSON(fc, {
          style: function () { return { color: color, weight: 3, opacity: .9 }; },
          pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 6, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: .9 }); },
          onEachFeature: function (f, lf) {
            lf.on('click', function () {
              if (window.GISTable) GISTable.openLayer(layer.id, f.properties && f.properties.asset_code, { title: '📋 ' + layer.name, sub: layer.name });
            });
          }
        }).addTo(window.gMap);
        loaded[layer.id] = lyr;
        cnt.textContent = (fc.features || []).length;
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
