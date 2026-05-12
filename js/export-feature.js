// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Export Feature (with DWG support)
//  כלול ב-index.html אחרי cloudconvert-dwg.js:
//    <script src="cloudconvert-dwg.js"></script>
//    <script src="export-feature.js"></script>
// ════════════════════════════════════════════════════════════════
(function() {
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
var gFiltered = [], gExportBlob = null, gExportName = '', gExportFormat = '';

// ── INJECT STYLES ──
var s = document.createElement('style');
s.textContent = '#exp-fab{position:absolute;bottom:30px;left:14px;background:#0d3b5e;color:#fff;border:none;border-radius:50%;width:54px;height:54px;font-size:22px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.3);z-index:400;display:flex;align-items:center;justify-content:center}#exp-fab:hover{background:#1a7fc1}.exp-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1500;align-items:center;justify-content:center}.exp-bg.open{display:flex}.exp-mod{background:#fff;border-radius:14px;padding:24px;width:560px;max-width:95vw;direction:rtl;box-shadow:0 12px 40px rgba(0,0,0,0.25);max-height:90vh;overflow-y:auto;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif}.exp-t{font-size:18px;font-weight:700;color:#0d3b5e;margin-bottom:6px}.exp-st{font-size:12px;color:#64748b;margin-bottom:16px;line-height:1.5}.exp-cats{display:grid;grid-template-columns:1fr 1fr;gap:6px;max-height:300px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;padding:10px;background:#f8fafc;margin-bottom:14px}.exp-cat{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;font-size:12px;user-select:none}.exp-cat:hover{background:#eff6ff;border-color:#1a7fc1}.exp-cat input{margin:0;cursor:pointer;flex-shrink:0}.exp-cat-l{flex:1}.exp-cat-c{font-size:10px;color:#94a3b8}.exp-bar{display:flex;gap:8px;justify-content:flex-end;margin-bottom:10px}.exp-bar button{padding:6px 12px;border-radius:6px;border:1px solid #e2e8f0;background:#fff;color:#0d3b5e;font-size:11px;cursor:pointer;font-family:inherit}.exp-bar button:hover{background:#eff6ff}.exp-btns{display:flex;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid #e2e8f0;flex-wrap:wrap}.exp-btn{padding:10px 16px;border-radius:7px;border:none;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit}.exp-btn-p{flex:1;background:#0d3b5e;color:#fff;min-width:140px}.exp-btn-p:hover{background:#1a7fc1}.exp-btn-c{background:transparent;color:#64748b;border:1px solid #e2e8f0}.exp-btn-d{background:#16a34a;color:#fff}.exp-btn-d:hover{background:#15803d}.exp-btn-m{background:#7c3aed;color:#fff}.exp-btn-m:hover{background:#6d28d9}.exp-fmt{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}.exp-fmt-c{padding:14px;border:2px solid #e2e8f0;border-radius:9px;cursor:pointer;text-align:center;background:#fff}.exp-fmt-c:hover{border-color:#1a7fc1}.exp-fmt-c.sel{border-color:#0d3b5e;background:#eff6ff}.exp-fmt-c.dwg-special{border-color:#fde68a;background:linear-gradient(135deg,#fffbeb,#fef3c7)}.exp-fmt-c.dwg-special.sel{border-color:#d97706;background:linear-gradient(135deg,#fef3c7,#fde68a)}.exp-fmt-i{font-size:24px;margin-bottom:4px}.exp-fmt-n{font-size:13px;font-weight:700;color:#0d3b5e}.exp-fmt-d{font-size:10px;color:#64748b;margin-top:2px}.exp-info{background:#dbeafe;border:1px solid #93c5fd;border-radius:7px;padding:9px 12px;font-size:12px;color:#1e40af;margin-bottom:12px}.exp-warn{background:#fef3c7;border:1px solid #fde68a;border-radius:7px;padding:9px 12px;font-size:12px;color:#92400e;margin-bottom:12px}.exp-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px}.exp-stat{background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;padding:10px;text-align:center}.exp-stat-n{font-size:18px;font-weight:700;color:#0d3b5e}.exp-stat-l{font-size:10px;color:#64748b;margin-top:2px}.exp-mailbox{margin-bottom:14px}.exp-mailbox label{display:block;font-size:11px;font-weight:600;color:#64748b;margin-bottom:4px}.exp-mailbox input{width:100%;padding:9px 11px;border:1.5px solid #e2e8f0;border-radius:7px;font-size:13px;font-family:inherit;direction:ltr;text-align:right}.exp-mailbox input:focus{outline:none;border-color:#1a7fc1}#exp-cancel-draw{position:absolute;top:14px;right:14px;background:#dc2626;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;z-index:500;display:none;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.25)}#exp-cancel-draw.show{display:block}.exp-banner{position:absolute;top:14px;left:50%;transform:translateX(-50%);background:#0d3b5e;color:#fff;padding:8px 16px;border-radius:8px;font-size:12px;font-weight:600;z-index:500;display:none;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.25)}.exp-banner.show{display:block}.exp-progress{display:none;margin:14px 0}.exp-progress.show{display:block}.exp-prog-stage{font-size:11px;color:#1a7fc1;font-weight:600;text-align:center;margin-bottom:6px}.exp-prog-bar{height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden}.exp-prog-fill{height:100%;background:linear-gradient(90deg,#1a7fc1,#5ab8e8);width:0;transition:width 0.3s;border-radius:3px}.exp-prog-text{font-size:11px;color:#64748b;text-align:center;margin-top:6px}';
document.head.appendChild(s);

// ── INJECT FAB & MODALS ──
function injectUI() {
  var mw = document.getElementById('map-wrap');
  if (!mw) { console.error('Export: #map-wrap not found'); return; }

  var fab = document.createElement('button');
  fab.id = 'exp-fab';
  fab.title = 'יצוא נתונים';
  fab.innerHTML = '📥';
  fab.onclick = openExportModal;
  mw.appendChild(fab);

  var banner = document.createElement('div');
  banner.id = 'exp-banner';
  banner.className = 'exp-banner';
  banner.textContent = '🖱️ סמן את האזור לייצוא — לחץ והחזק במפה וגרור';
  mw.appendChild(banner);

  var cancelBtn = document.createElement('button');
  cancelBtn.id = 'exp-cancel-draw';
  cancelBtn.textContent = '✖ בטל בחירה';
  cancelBtn.onclick = cancelDrawing;
  mw.appendChild(cancelBtn);

  var modals = document.createElement('div');
  modals.innerHTML = ''+
    '<div class="exp-bg" id="exp-modal" onclick="if(event.target.id===\'exp-modal\')closeExportModal()">'+
      '<div class="exp-mod">'+
        '<div class="exp-t">📥 יצוא נתונים</div>'+
        '<div class="exp-st">בחר את השכבות שתרצה לייצא, ולאחר מכן סמן אזור על המפה.</div>'+
        '<div class="exp-info" id="exp-area-info">📍 לא נבחר אזור עדיין — תיבחר בשלב הבא</div>'+
        '<div class="exp-bar"><button onclick="window.expSelectAll()">✓ סמן הכל</button><button onclick="window.expSelectNone()">✗ נקה הכל</button></div>'+
        '<div class="exp-cats" id="exp-cats"></div>'+
        '<div class="exp-btns">'+
          '<button class="exp-btn exp-btn-p" onclick="window.expStartDraw()">🖱️ סמן אזור על המפה</button>'+
          '<button class="exp-btn exp-btn-c" onclick="closeExportModal()">ביטול</button>'+
        '</div>'+
      '</div>'+
    '</div>'+

    '<div class="exp-bg" id="exp-fmt-modal" onclick="if(event.target.id===\'exp-fmt-modal\')closeFmtModal()">'+
      '<div class="exp-mod">'+
        '<div class="exp-t">📦 בחר פורמט יצוא</div>'+
        '<div class="exp-stats">'+
          '<div class="exp-stat"><div class="exp-stat-n" id="exp-stat-feat">0</div><div class="exp-stat-l">אובייקטים</div></div>'+
          '<div class="exp-stat"><div class="exp-stat-n" id="exp-stat-cats">0</div><div class="exp-stat-l">קטגוריות</div></div>'+
          '<div class="exp-stat"><div class="exp-stat-n" id="exp-stat-vill">0</div><div class="exp-stat-l">כפרים</div></div>'+
        '</div>'+
        '<div class="exp-fmt">'+
          '<div class="exp-fmt-c sel" data-fmt="geojson" onclick="window.expSelectFmt(\'geojson\')"><div class="exp-fmt-i">🗺️</div><div class="exp-fmt-n">GeoJSON</div><div class="exp-fmt-d">סטנדרט GIS · מהיר</div></div>'+
          '<div class="exp-fmt-c" data-fmt="dxf" onclick="window.expSelectFmt(\'dxf\')"><div class="exp-fmt-i">📐</div><div class="exp-fmt-n">DXF</div><div class="exp-fmt-d">AutoCAD · מהיר</div></div>'+
          '<div class="exp-fmt-c dwg-special" data-fmt="dwg" onclick="window.expSelectFmt(\'dwg\')"><div class="exp-fmt-i">📐</div><div class="exp-fmt-n">DWG</div><div class="exp-fmt-d">AutoCAD מקורי · 10-30ש</div></div>'+
          '<div class="exp-fmt-c" data-fmt="csv" onclick="window.expSelectFmt(\'csv\')"><div class="exp-fmt-i">📊</div><div class="exp-fmt-n">CSV</div><div class="exp-fmt-d">Excel · מהיר</div></div>'+
        '</div>'+
        '<div class="exp-warn" id="exp-dwg-warn" style="display:none">⚠️ יצוא ל-DWG דורש המרה דרך CloudConvert (10-30 שניות, צורך 1 credit).</div>'+
        '<div class="exp-progress" id="exp-progress">'+
          '<div class="exp-prog-stage" id="exp-prog-stage">מתחיל...</div>'+
          '<div class="exp-prog-bar"><div class="exp-prog-fill" id="exp-prog-fill"></div></div>'+
          '<div class="exp-prog-text" id="exp-prog-text">—</div>'+
        '</div>'+
        '<div class="exp-btns" id="exp-fmt-btns">'+
          '<button class="exp-btn exp-btn-p" id="exp-gen-btn" onclick="window.expGenerate()">⚙️ צור קובץ</button>'+
          '<button class="exp-btn exp-btn-c" onclick="closeFmtModal()">ביטול</button>'+
        '</div>'+
      '</div>'+
    '</div>'+

    '<div class="exp-bg" id="exp-done-modal" onclick="if(event.target.id===\'exp-done-modal\')closeDoneModal()">'+
      '<div class="exp-mod">'+
        '<div class="exp-t" id="exp-done-title">✅ הקובץ מוכן!</div>'+
        '<div class="exp-st" id="exp-done-sub">הקובץ נוצר בהצלחה. בחר פעולה:</div>'+
        '<div class="exp-mailbox">'+
          '<label>📧 אימייל לשליחה (אופציונלי)</label>'+
          '<input type="email" id="exp-mail" placeholder="recipient@example.com"/>'+
        '</div>'+
        '<div class="exp-warn">💡 שליחה במייל פותחת את לקוח המייל. תצטרך לצרף את הקובץ ידנית אחרי הורדה.</div>'+
        '<div class="exp-btns">'+
          '<button class="exp-btn exp-btn-d" onclick="window.expDownload()" style="flex:1">💾 הורדה</button>'+
          '<button class="exp-btn exp-btn-m" onclick="window.expEmail()" style="flex:1">✉️ שלח במייל</button>'+
          '<button class="exp-btn exp-btn-c" onclick="closeDoneModal()">סגור</button>'+
        '</div>'+
      '</div>'+
    '</div>';
  document.body.appendChild(modals);
}

// ── MODAL FLOW ──
function openExportModal() {
  if (!window.gMap || !window.gVillages) { alert('המפה עדיין לא נטענה'); return; }
  renderCatsList();
  document.getElementById('exp-modal').classList.add('open');
}
function closeExportModal() { document.getElementById('exp-modal').classList.remove('open'); }
function closeFmtModal() {
  document.getElementById('exp-fmt-modal').classList.remove('open');
  document.getElementById('exp-progress').classList.remove('show');
  document.getElementById('exp-fmt-btns').style.display = 'flex';
}
function closeDoneModal() { document.getElementById('exp-done-modal').classList.remove('open'); }
window.closeExportModal = closeExportModal;
window.closeFmtModal = closeFmtModal;
window.closeDoneModal = closeDoneModal;

function renderCatsList() {
  var counts = {};
  if (window.gVillageState) {
    Object.keys(window.gVillageState).forEach(function(vid) {
      var st = window.gVillageState[vid];
      Object.keys(st.counts || {}).forEach(function(c) {
        counts[c] = (counts[c] || 0) + st.counts[c];
      });
    });
  }
  var keys = Object.keys(counts).sort();
  if (!keys.length) {
    document.getElementById('exp-cats').innerHTML = '<div style="grid-column:span 2;text-align:center;padding:20px;color:#64748b">אין שכבות טעונות.</div>';
    return;
  }
  document.getElementById('exp-cats').innerHTML = keys.map(function(k) {
    var lbl = LABELS[k] || k;
    return '<label class="exp-cat"><input type="checkbox" value="'+k+'" checked/><span class="exp-cat-l">'+lbl+'</span><span class="exp-cat-c">'+counts[k]+'</span></label>';
  }).join('');
}

window.expSelectAll = function() {
  document.querySelectorAll('#exp-cats input').forEach(function(i){i.checked=true;});
};
window.expSelectNone = function() {
  document.querySelectorAll('#exp-cats input').forEach(function(i){i.checked=false;});
};

window.expStartDraw = function() {
  var checked = document.querySelectorAll('#exp-cats input:checked');
  if (!checked.length) { alert('בחר לפחות שכבה אחת'); return; }
  closeExportModal();
  if (gRect) { window.gMap.removeLayer(gRect); gRect = null; }
  gDrawing = true;
  document.getElementById('exp-banner').classList.add('show');
  document.getElementById('exp-cancel-draw').classList.add('show');
  window.gMap.dragging.disable();
  window.gMap.getContainer().style.cursor = 'crosshair';
  window.gMap.on('mousedown', onDrawStart);
};

function onDrawStart(e) {
  if (!gDrawing) return;
  gDrawStart = e.latlng;
  window.gMap.on('mousemove', onDrawMove);
  window.gMap.once('mouseup', onDrawEnd);
}

function onDrawMove(e) {
  if (gDrawTemp) window.gMap.removeLayer(gDrawTemp);
  gDrawTemp = L.rectangle([gDrawStart, e.latlng], { color:'#0d3b5e', weight:2, fillOpacity:0.15, dashArray:'5,5' }).addTo(window.gMap);
}

function onDrawEnd(e) {
  window.gMap.off('mousemove', onDrawMove);
  if (gDrawTemp) window.gMap.removeLayer(gDrawTemp);
  if (!gDrawStart) return cancelDrawing();
  gRect = L.rectangle([gDrawStart, e.latlng], { color:'#16a34a', weight:3, fillOpacity:0.1 }).addTo(window.gMap);
  finishDrawing();
}

function finishDrawing() {
  gDrawing = false; gDrawStart = null; gDrawTemp = null;
  document.getElementById('exp-banner').classList.remove('show');
  document.getElementById('exp-cancel-draw').classList.remove('show');
  window.gMap.dragging.enable();
  window.gMap.getContainer().style.cursor = '';
  window.gMap.off('mousedown', onDrawStart);
  filterAndShowFmt();
}

function cancelDrawing() {
  gDrawing = false; gDrawStart = null;
  if (gDrawTemp) { window.gMap.removeLayer(gDrawTemp); gDrawTemp = null; }
  document.getElementById('exp-banner').classList.remove('show');
  document.getElementById('exp-cancel-draw').classList.remove('show');
  window.gMap.dragging.enable();
  window.gMap.getContainer().style.cursor = '';
  window.gMap.off('mousedown', onDrawStart);
  window.gMap.off('mousemove', onDrawMove);
}
window.cancelDrawing = cancelDrawing;

async function filterAndShowFmt() {
  if (!gRect) return;
  var bounds = gRect.getBounds();
  var selectedCats = [];
  document.querySelectorAll('#exp-cats input:checked').forEach(function(i){selectedCats.push(i.value);});

  gFiltered = [];
  var villages = window.gVillages || [];
  for (var i = 0; i < villages.length; i++) {
    var v = villages[i];
    try {
      var urlRes = window.gSb.storage.from('village-layers').getPublicUrl(v.file_path);
      var resp = await fetch(urlRes.data.publicUrl);
      if (!resp.ok) continue;
      var data = await resp.json();
      data.features.forEach(function(f) {
        if (!f.geometry) return;
        var cat = (f.properties && f.properties._category) || 'other';
        if (selectedCats.indexOf(cat) === -1) return;
        if (!isInBounds(f.geometry, bounds)) return;
        f.properties = f.properties || {};
        f.properties._village = v.village_name;
        f.properties._village_id = v.village_id;
        gFiltered.push(f);
      });
    } catch(e) { console.error('filter err', e); }
  }

  if (!gFiltered.length) {
    alert('לא נמצאו אובייקטים באזור שבחרת. נסה אזור אחר.');
    if (gRect) { window.gMap.removeLayer(gRect); gRect = null; }
    return;
  }

  var cats = {}, vills = {};
  gFiltered.forEach(function(f) {
    cats[f.properties._category] = true;
    vills[f.properties._village] = true;
  });
  document.getElementById('exp-stat-feat').textContent = gFiltered.length;
  document.getElementById('exp-stat-cats').textContent = Object.keys(cats).length;
  document.getElementById('exp-stat-vill').textContent = Object.keys(vills).length;
  gExportFormat = 'geojson';
  updateFmtSelection();
  document.getElementById('exp-fmt-modal').classList.add('open');
}

function isInBounds(g, b) {
  if (g.type === 'Point') return b.contains([g.coordinates[1], g.coordinates[0]]);
  if (g.type === 'LineString') return g.coordinates.some(function(c){return b.contains([c[1],c[0]]);});
  if (g.type === 'MultiLineString') return g.coordinates.some(function(line){return line.some(function(c){return b.contains([c[1],c[0]]);});});
  if (g.type === 'Polygon') return g.coordinates[0].some(function(c){return b.contains([c[1],c[0]]);});
  return false;
}

window.expSelectFmt = function(fmt) {
  gExportFormat = fmt;
  updateFmtSelection();
  document.getElementById('exp-dwg-warn').style.display = (fmt === 'dwg') ? 'block' : 'none';
};

function updateFmtSelection() {
  document.querySelectorAll('.exp-fmt-c').forEach(function(el) {
    el.classList.toggle('sel', el.getAttribute('data-fmt') === gExportFormat);
  });
}

// ── GENERATE FILE ──
window.expGenerate = async function() {
  if (!gFiltered.length) return;
  var fc = { type:'FeatureCollection', features: gFiltered };
  var ts = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-');
  var content, mime, ext;

  if (gExportFormat === 'geojson') {
    content = JSON.stringify(fc, null, 2);
    mime = 'application/geo+json'; ext = 'geojson';
    finalizeBlob(new Blob([content], { type: mime }), ts, ext);
  } else if (gExportFormat === 'dxf') {
    content = buildDXF(gFiltered);
    mime = 'application/dxf'; ext = 'dxf';
    finalizeBlob(new Blob([content], { type: mime }), ts, ext);
  } else if (gExportFormat === 'csv') {
    content = '\uFEFF' + buildCSV(gFiltered);
    mime = 'text/csv;charset=utf-8'; ext = 'csv';
    finalizeBlob(new Blob([content], { type: mime }), ts, ext);
  } else if (gExportFormat === 'dwg') {
    // ── DWG via CloudConvert ──
    if (!window.geojsonToDWG) {
      alert('CloudConvert לא זמין. ודא ש-cloudconvert-dwg.js נטען.');
      return;
    }
    document.getElementById('exp-fmt-btns').style.display = 'none';
    var prog = document.getElementById('exp-progress');
    var fill = document.getElementById('exp-prog-fill');
    var stage = document.getElementById('exp-prog-stage');
    var text = document.getElementById('exp-prog-text');
    prog.classList.add('show');

    try {
      var dwgBlob = await window.geojsonToDWG(fc, function(s, pct, msg) {
        stage.textContent = s === 'local' ? 'מכין DXF' : (s === 'cloud' ? 'CloudConvert' : (s === 'process' ? 'ממיר' : (s === 'download' ? 'מוריד' : 'הושלם')));
        fill.style.width = pct + '%';
        text.textContent = msg;
      });
      finalizeBlob(dwgBlob, ts, 'dwg');
    } catch(e) {
      alert('שגיאה בהמרה ל-DWG: ' + e.message);
      console.error(e);
      prog.classList.remove('show');
      document.getElementById('exp-fmt-btns').style.display = 'flex';
    }
  }
};

function finalizeBlob(blob, ts, ext) {
  gExportBlob = blob;
  gExportName = 'mei-hagalil-export-' + ts + '.' + ext;
  document.getElementById('exp-done-title').textContent = '✅ ' + gExportName;
  document.getElementById('exp-done-sub').textContent = gFiltered.length + ' אובייקטים, ' + (gExportBlob.size/1024).toFixed(1) + ' KB';
  closeFmtModal();
  document.getElementById('exp-done-modal').classList.add('open');
}

// ── DXF GENERATION (local, free) ──
function buildDXF(features) {
  var lines = ['0','SECTION','2','HEADER','9','$ACADVER','1','AC1009','0','ENDSEC'];
  lines.push('0','SECTION','2','TABLES','0','TABLE','2','LAYER','70','24');
  var layerColors = { sewage_pipe:2, manhole:4, sleeve:6, control_point:1, water_pipes:5, water_meters:5,
    hydrants:1, valves:6, control_valves:6, buildings:8, parcels:3, sewage_pipes:42, sewage_manholes:42,
    reservoirs:3, pump_stations:2, sampling_points:6, connection_points:5, pipe_label:7,
    elevation_label:7, attribute_label:7, distance_label:7, dimension_line:9, manhole_drawing:8, other:7 };
  var seenLayers = {};
  features.forEach(function(f) {
    var c = (f.properties && f.properties._category) || 'other';
    if (seenLayers[c]) return;
    seenLayers[c] = true;
    lines.push('0','LAYER','2',c,'70','0','62',String(layerColors[c]||7),'6','CONTINUOUS');
  });
  lines.push('0','ENDTAB','0','ENDSEC');
  lines.push('0','SECTION','2','ENTITIES');
  features.forEach(function(f) {
    var layer = (f.properties && f.properties._category) || 'other';
    var g = f.geometry;
    if (g.type === 'Point') {
      lines.push('0','POINT','8',layer,'10',String(g.coordinates[0]),'20',String(g.coordinates[1]),'30','0');
      if (f.properties && f.properties.Text) {
        lines.push('0','TEXT','8',layer,'10',String(g.coordinates[0]),'20',String(g.coordinates[1]),'30','0','40','0.0001','1',String(f.properties.Text));
      }
    } else if (g.type === 'LineString') {
      addPolyline(lines, g.coordinates, layer);
    } else if (g.type === 'MultiLineString') {
      g.coordinates.forEach(function(line) { addPolyline(lines, line, layer); });
    } else if (g.type === 'Polygon') {
      addPolyline(lines, g.coordinates[0], layer, true);
    }
  });
  lines.push('0','ENDSEC','0','EOF');
  return lines.join('\r\n');
}

function addPolyline(lines, coords, layer, closed) {
  lines.push('0','POLYLINE','8',layer,'66','1','70', closed?'1':'0','10','0','20','0','30','0');
  coords.forEach(function(c) {
    lines.push('0','VERTEX','8',layer,'10',String(c[0]),'20',String(c[1]),'30','0');
  });
  lines.push('0','SEQEND','8',layer);
}

function buildCSV(features) {
  var rows = [['village','category','lon','lat','geometry_type','text','layer','entity_handle','properties_json']];
  features.forEach(function(f) {
    var p = f.properties || {};
    var g = f.geometry;
    var lon='', lat='';
    if (g.type === 'Point') { lon = g.coordinates[0]; lat = g.coordinates[1]; }
    else if (g.type === 'LineString' && g.coordinates.length) { lon = g.coordinates[0][0]; lat = g.coordinates[0][1]; }
    else if (g.type === 'Polygon' && g.coordinates[0] && g.coordinates[0].length) { lon = g.coordinates[0][0][0]; lat = g.coordinates[0][0][1]; }
    rows.push([
      p._village || '', p._category || '', lon, lat, g.type,
      p.Text || '', p.Layer || '', p.EntityHand || '', JSON.stringify(p)
    ]);
  });
  return rows.map(function(r) {
    return r.map(function(v) {
      var s = String(v == null ? '' : v).replace(/"/g, '""');
      return '"' + s + '"';
    }).join(',');
  }).join('\n');
}

window.expDownload = function() {
  if (!gExportBlob) return;
  var url = URL.createObjectURL(gExportBlob);
  var a = document.createElement('a');
  a.href = url; a.download = gExportName;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){URL.revokeObjectURL(url);}, 1000);
};

window.expEmail = function() {
  var to = document.getElementById('exp-mail').value.trim();
  if (!to) { alert('הזן כתובת מייל'); return; }
  window.expDownload();
  var subject = 'יצוא נתוני GIS — מי הגליל';
  var body = 'שלום,\n\nמצורף קובץ יצוא ממערכת ה-GIS של מי הגליל.\n\n' +
             'שם הקובץ: ' + gExportName + '\n' +
             'מספר אובייקטים: ' + gFiltered.length + '\n\n' +
             '⚠️ אנא צרף ידנית את הקובץ שירד כעת (מהורדות) להודעה זו.\n\n' +
             'בברכה,\nמערכת מי הגליל GIS';
  var mailto = 'mailto:' + encodeURIComponent(to) +
               '?subject=' + encodeURIComponent(subject) +
               '&body=' + encodeURIComponent(body);
  window.location.href = mailto;
};

function init() {
  if (!document.getElementById('map-wrap')) { setTimeout(init, 200); return; }
  injectUI();
  console.log('✓ Export feature loaded (with DWG support)');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
