// ════════════════════════════════════════════════════════════════
//  מי הגליל GIS — טבלת מאפיינים נערכת (ArcGIS-style Attribute Table)
//  לחיצה על פיצ'ר → טבלה תחתונה עם כל פיצ'רי הקטגוריה + כל השדות,
//  והשורה שנבחרה מסומנת ונגללת לתצוגה. קישור דו-כיווני מפה↔טבלה.
//
//  עריכה (לשכבות שעברו מיגרציה למנוע — features table):
//    • עריכת ערכים: דאבל-קליק על תא → עריכה → שמירה (GIS.features.updateFeature)
//    • הוספת עמודה / מחיקת עמודה (GIS.fields.addColumn / deleteColumn) — אדמין
//  נתוני כפר שעדיין לא עברו מיגרציה: תצוגה בלבד + כפתור "ייבא לעריכה".
//
//  חיבור ללא נגיעה בליבה: עוטף את window.buildPopup.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

var CAP = 1500, HIDE = /^_|^__/;
var CAT_HE = {
  water_pipes:'קווי מים', sewage_pipes:'קווי ביוב', main_sewer:'ביב ראשי', supply_pipe:'קו הספקה',
  valves:'מגופים', control_valves:'מגופים שולטים', hydrants:'הידרנטים', water_meters:'מדי מים',
  sewage_manholes:'שוחות ביוב', connection_points:'נקודות חיבור', reservoirs:'מאגרים', pump_stations:'תחנות שאיבה'
};

var css = document.createElement('style');
css.textContent = `
#gis-tbl{position:fixed;left:0;right:0;bottom:0;height:44vh;z-index:1200;background:#fff;direction:rtl;
  box-shadow:0 -6px 24px rgba(0,0,0,.18);display:none;flex-direction:column;font-family:'Segoe UI',Tahoma,Arial,sans-serif;}
#gis-tbl.open{display:flex;}
.gt-head{display:flex;align-items:center;gap:8px;background:#0d3b5e;color:#fff;padding:8px 12px;flex-shrink:0;flex-wrap:wrap;}
.gt-title{font-weight:700;font-size:13px;}.gt-sub{font-size:11px;opacity:.85;}
.gt-spacer{flex:1;}
.gt-search{border:none;border-radius:7px;padding:6px 10px;font-size:13px;direction:rtl;width:200px;}
.gt-ico{background:rgba(255,255,255,.12);border:none;color:#fff;font-size:12.5px;cursor:pointer;border-radius:6px;padding:5px 9px;white-space:nowrap;}
.gt-ico:hover{background:rgba(255,255,255,.28);}
.gt-ico.act{background:#16a34a;}
.gt-ico.warn{background:#b45309;}
.gt-wrap{flex:1;overflow:auto;}
.gt-table{border-collapse:collapse;font-size:12.5px;white-space:nowrap;min-width:100%;}
.gt-table th{position:sticky;top:0;background:#eef2f6;color:#0d3b5e;text-align:right;padding:7px 12px;border-bottom:2px solid #cbd5e1;cursor:pointer;user-select:none;z-index:1;}
.gt-table th.calc::after{content:' ƒ';color:#1a7fc1;}
.gt-table th .a{opacity:.5;font-size:10px;margin-right:3px;}
.gt-table td{padding:6px 12px;border-bottom:1px solid #f1f5f9;color:#1e293b;}
.gt-table td.idx{color:#94a3b8;background:#fafcff;text-align:center;position:sticky;right:0;}
.gt-table td.editable{cursor:cell;}
.gt-table td.editable:hover{background:#eef6ff;outline:1px dashed #93c5fd;}
.gt-table tr:hover td{background:#f8fafc;}
.gt-table tr.sel td{background:#cfe2ff !important;}
.gt-table tr.sel td.idx{background:#a8c7fa !important;color:#0d3b5e;font-weight:700;}
.gt-cell-input{width:100%;min-width:90px;border:1px solid #2563eb;border-radius:4px;padding:3px 6px;font-size:12.5px;direction:rtl;box-sizing:border-box;}
.gt-empty{padding:20px;color:#94a3b8;font-size:13px;text-align:center;}
.gt-foot{flex-shrink:0;background:#f8fafc;border-top:1px solid #e2e8f0;padding:5px 12px;font-size:11px;color:#64748b;display:flex;gap:12px;align-items:center;}
.gt-foot .ok{color:#16a34a;}.gt-foot .er{color:#dc2626;}`;
document.head.appendChild(css);

var el = document.createElement('div');
el.id = 'gis-tbl';
el.innerHTML =
  '<div class="gt-head">' +
    '<span class="gt-title" id="gt-title">טבלת מאפיינים</span>' +
    '<span class="gt-sub" id="gt-sub"></span>' +
    '<span class="gt-spacer"></span>' +
    '<button class="gt-ico" id="gt-addrow" style="display:none">➕ שורה</button>' +
    '<button class="gt-ico" id="gt-delrow" style="display:none">🗑 שורה</button>' +
    '<button class="gt-ico" id="gt-add" style="display:none">➕ עמודה</button>' +
    '<button class="gt-ico" id="gt-ren" style="display:none">✏️ עמודה</button>' +
    '<button class="gt-ico" id="gt-del" style="display:none">➖ עמודה</button>' +
    '<button class="gt-ico warn" id="gt-migrate" style="display:none">⬆️ ייבא לעריכה</button>' +
    '<input class="gt-search" id="gt-search" placeholder="סינון…">' +
    '<button class="gt-ico" id="gt-zoom" title="התמקד בנבחר">🎯</button>' +
    '<button class="gt-ico" id="gt-x" title="סגור">✕</button>' +
  '</div>' +
  '<div class="gt-wrap" id="gt-wrap"><div class="gt-empty">—</div></div>' +
  '<div class="gt-foot" id="gt-foot"></div>';
document.body.appendChild(el);

var state = {
  source:null, vid:null, catId:null, layerId:null,
  all:[], cols:[], fieldDefs:{}, selected:null,
  sortKey:null, sortDir:1, filter:'', editable:false, role:null
};
var hl = null;

document.getElementById('gt-x').onclick = close;
document.getElementById('gt-zoom').onclick = function () { if (state.selected) zoomTo(state.selected); };
document.getElementById('gt-search').oninput = debounce(function (e) { state.filter = e.target.value; renderBody(); }, 180);
document.getElementById('gt-add').onclick = addColumn;
document.getElementById('gt-ren').onclick = renameColumnUI;
document.getElementById('gt-del').onclick = deleteColumn;
document.getElementById('gt-addrow').onclick = addRow;
document.getElementById('gt-delrow').onclick = deleteRow;
document.getElementById('gt-migrate').onclick = migrateThis;
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.classList.contains('open') && !el.querySelector('.gt-cell-input')) close(); });

function close() { el.classList.remove('open'); clearHl(); }

var GISTable = { autoOpen: true, open: open, openLayer: openLayer, close: close };
window.GISTable = GISTable;

// ── פתיחה מנתוני כפר (זיכרון). אם הקטגוריה עברה מיגרציה → מעבר אוטומטי למצב מנוע נערך ──
async function open(vid, catId, selProps) {
  var feats = featuresFor(vid, catId);
  if (!feats || !feats.length) return;
  var village = (window.gVillageById && gVillageById[vid]) || {};

  state.source = 'village'; state.vid = vid; state.catId = catId; state.layerId = null;
  state.all = feats; state.editable = false; state.fieldDefs = {};
  state.cols = deriveColumns(feats);
  state.sortKey = null; state.sortDir = 1; state.filter = ''; document.getElementById('gt-search').value = '';
  state.selected = selProps ? (feats.find(function (f) { return f.properties === selProps; }) ||
                               feats.find(function (f) { return shallowMatch(f.properties, selProps); }) || null) : null;

  setHeader('📋 ' + (CAT_HE[catId] || catId), (village.village_name || '') + ' · ' + feats.length + ' פריטים');
  toolbar({ migrate: false, schema: false, rows: false });
  el.classList.add('open'); invalidateMap();
  renderBody(true);
  if (state.selected) zoomTo(state.selected, true);

  // האם הקטגוריה כבר במנוע? אם כן — עבור למצב נערך ושמור את הבחירה.
  try {
    var layerName = (village.village_name || vid) + ' · ' + catId;
    var layer = await GIS.layers.findByName(layerName);
    if (layer) {
      var selCode = state.selected && state.selected.properties && state.selected.properties.asset_code;
      await openLayer(layer.id, selCode, { title: '📋 ' + (CAT_HE[catId] || catId), sub: village.village_name });
    } else {
      toolbar({ migrate: true, schema: false, rows: false });   // אפשר ייבוא
      footer('תצוגה בלבד — ייבא לעריכה');
    }
  } catch (e) { /* נשאר בתצוגת כפר */ }
}

// ── פתיחה משכבת מנוע (features table) — מצב נערך ─────────────────────────────────
async function openLayer(layerId, selectAssetCode, meta) {
  meta = meta || {};
  el.classList.add('open'); invalidateMap();
  footer('טוען…');
  var fc = await GIS.features.getFeatures(layerId);
  var defs = await GIS.fields.getFields(layerId);
  state.fieldDefs = {}; defs.forEach(function (d) { state.fieldDefs[d.name] = d; });

  state.source = 'engine'; state.layerId = layerId; state.all = fc.features || [];
  state.cols = deriveColumns(state.all);
  state.role = await GIS.currentRole();
  state.editable = GIS.permissions.canEditGis(state.role);
  if (meta.reset !== false) { state.sortKey = null; state.sortDir = 1; }
  state.selected = selectAssetCode
    ? state.all.find(function (f) { return f.properties.asset_code === selectAssetCode; }) || null
    : state.selected;

  setHeader(meta.title || '📋 שכבת מנוע', (meta.sub ? meta.sub + ' · ' : '') + state.all.length + ' פריטים' + (state.editable ? ' · נערך' : ' · תצוגה'));
  toolbar({ migrate: false, schema: state.editable && state.role === 'admin', rows: state.editable });
  renderBody(true);
  if (state.selected) zoomTo(state.selected, true);
  footer(state.editable ? 'דאבל-קליק על תא לעריכה' : ('תצוגה בלבד (' + (state.role || 'אורח') + ')'));
}

// ── מקור נתוני כפר ──────────────────────────────────────────────────────────────
function featuresFor(vid, catId) {
  var byCat = window.gVillageFeatures && window.gVillageFeatures[vid];
  return (byCat && byCat[catId]) || null;
}
function deriveColumns(feats) {
  var seen = {}, cols = [];
  (feats || []).slice(0, 80).forEach(function (f) {
    Object.keys(f.properties || {}).forEach(function (k) { if (!HIDE.test(k) && !seen[k]) { seen[k] = 1; cols.push(k); } });
  });
  return cols;
}

// ── רינדור ────────────────────────────────────────────────────────────────────
function renderBody(scrollToSel) {
  var wrap = document.getElementById('gt-wrap');
  var rows = state.all;
  if (state.filter) {
    var q = state.filter.toLowerCase();
    rows = rows.filter(function (f) { var p = f.properties || {}; return state.cols.some(function (c) { return String(p[c] == null ? '' : p[c]).toLowerCase().indexOf(q) >= 0; }); });
  }
  if (state.sortKey) {
    var k = state.sortKey, dir = state.sortDir;
    rows = rows.slice().sort(function (a, b) {
      var av = a.properties[k], bv = b.properties[k], na = parseFloat(av), nb = parseFloat(bv);
      if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
      return String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv), 'he') * dir;
    });
  }
  var total = rows.length, capped = total > CAP, view = rows.slice(0, CAP);
  if (state.selected && view.indexOf(state.selected) === -1 && rows.indexOf(state.selected) >= 0) view = [state.selected].concat(view.slice(0, CAP - 1));
  if (!total) { wrap.innerHTML = '<div class="gt-empty">אין תוצאות</div>'; return; }

  var arrow = function (c) { return '<span class="a">' + (state.sortKey === c ? (state.sortDir > 0 ? '▲' : '▼') : '↕') + '</span>'; };
  var html = '<table class="gt-table"><thead><tr><th class="idx">#</th>';
  state.cols.forEach(function (c) {
    var calc = state.fieldDefs[c] && state.fieldDefs[c].is_calculated;
    html += '<th data-col="' + esc(c) + '"' + (calc ? ' class="calc"' : '') + '>' + esc(c) + arrow(c) + '</th>';
  });
  html += '</tr></thead><tbody>';
  view.forEach(function (f, i) {
    var p = f.properties || {};
    html += '<tr class="' + (f === state.selected ? 'sel' : '') + '" data-i="' + i + '"><td class="idx">' + (rows.indexOf(f) + 1) + '</td>';
    state.cols.forEach(function (c) {
      var calc = state.fieldDefs[c] && state.fieldDefs[c].is_calculated;
      var editable = state.editable && !calc;
      html += '<td' + (editable ? ' class="editable" data-col="' + esc(c) + '"' : '') + '>' + esc(p[c] == null ? '' : p[c]) + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
  if (state.source === 'engine') footer(state.editable ? 'דאבל-קליק על תא לעריכה' : 'תצוגה בלבד');
  else document.getElementById('gt-foot').firstChild || footer(capped ? ('מציג ' + view.length + ' מתוך ' + total) : ('סה״כ ' + total));

  // מיון
  Array.prototype.forEach.call(wrap.querySelectorAll('th[data-col]'), function (th) {
    th.onclick = function () { var c = th.getAttribute('data-col'); if (state.sortKey === c) state.sortDir *= -1; else { state.sortKey = c; state.sortDir = 1; } renderBody(); };
  });
  // בחירת שורה + קישור למפה
  Array.prototype.forEach.call(wrap.querySelectorAll('tbody tr'), function (tr) {
    tr.onclick = function (ev) {
      if (ev.target.classList.contains('editable') || ev.target.classList.contains('gt-cell-input')) return;
      var f = view[+tr.getAttribute('data-i')];
      state.selected = f;
      Array.prototype.forEach.call(wrap.querySelectorAll('tbody tr'), function (x) { x.classList.remove('sel'); });
      tr.classList.add('sel'); zoomTo(f);
    };
  });
  // עריכת תא (דאבל-קליק)
  if (state.editable) {
    Array.prototype.forEach.call(wrap.querySelectorAll('td.editable'), function (td) {
      td.ondblclick = function () { editCell(td, view[+td.parentNode.getAttribute('data-i')], td.getAttribute('data-col')); };
    });
  }
  if (scrollToSel && state.selected) { var sr = wrap.querySelector('tbody tr.sel'); if (sr) sr.scrollIntoView({ block: 'center' }); }
}

// ── עריכת ערך תא ────────────────────────────────────────────────────────────────
function editCell(td, feature, col) {
  if (td.querySelector('input')) return;
  var orig = feature.properties[col];
  var input = document.createElement('input');
  input.className = 'gt-cell-input';
  input.value = orig == null ? '' : orig;
  td.innerHTML = ''; td.appendChild(input); input.focus(); input.select();
  var done = false;
  var commit = async function (save) {
    if (done) return; done = true;
    if (!save) { td.textContent = orig == null ? '' : orig; return; }
    var val = input.value;
    var def = state.fieldDefs[col];
    if (def && (def.type === 'int' || def.type === 'float')) val = val === '' ? null : Number(val);
    else if (def && def.type === 'bool') val = /^(true|1|כן|yes)$/i.test(val);
    td.textContent = '⏳';
    try {
      var props = {};
      Object.keys(feature.properties).forEach(function (k) { if (!HIDE.test(k)) props[k] = feature.properties[k]; });
      props[col] = val;
      var updated = await GIS.features.updateFeature(feature.properties.__id || feature.id, props);
      feature.properties = Object.assign({}, feature.properties, updated.properties);
      footer('<span class="ok">✓ נשמר</span>');
      renderBody();            // ירענן שדות מחושבים (length_m/age) אם השתנו
    } catch (e) {
      td.textContent = orig == null ? '' : orig;
      footer('<span class="er">✕ ' + esc(e.message) + '</span>');
    }
  };
  input.onkeydown = function (e) { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); };
  input.onblur = function () { commit(true); };
}

// Reload the current engine layer in place, preserving header + selection.
async function reloadLayer(selCode) {
  await openLayer(state.layerId,
    selCode !== undefined ? selCode : (state.selected && state.selected.properties.asset_code),
    { title: document.getElementById('gt-title').textContent,
      sub: document.getElementById('gt-sub').textContent.split(' · ')[0], reset: false });
}

// ── עמודות (אדמין): הוספה / שינוי שם / מחיקה ────────────────────────────────────
async function addColumn() {
  if (!state.layerId) return;
  var name = window.prompt('שם העמודה החדשה (אנגלית, ללא רווחים):');
  if (!name) return;
  var type = (window.prompt('סוג: text / int / float / bool', 'text') || 'text').trim();
  footer('מוסיף עמודה…');
  try {
    await GIS.fields.addColumn(state.layerId, { name: name.trim(), type: type });
    await reloadLayer();
    footer('<span class="ok">✓ נוספה עמודה ' + esc(name) + '</span>');
  } catch (e) { footer('<span class="er">✕ ' + esc(e.message) + '</span>'); }
}
async function renameColumnUI() {
  if (!state.layerId) return;
  var oldName = window.prompt('עמודה לשינוי שם:\n' + state.cols.join(', '));
  if (!oldName) return;
  var newName = window.prompt('שם חדש ל-"' + oldName.trim() + '" (אנגלית, ללא רווחים):');
  if (!newName) return;
  footer('משנה שם…');
  try {
    await GIS.fields.renameColumn(state.layerId, oldName.trim(), newName.trim());
    await reloadLayer();
    footer('<span class="ok">✓ שונה שם → ' + esc(newName) + '</span>');
  } catch (e) { footer('<span class="er">✕ ' + esc(e.message) + '</span>'); }
}
async function deleteColumn() {
  if (!state.layerId) return;
  var name = window.prompt('שם העמודה למחיקה:\n' + state.cols.join(', '));
  if (!name) return;
  if (!window.confirm('למחוק את העמודה "' + name + '" מכל הפיצ\'רים? פעולה בלתי הפיכה.')) return;
  footer('מוחק עמודה…');
  try {
    await GIS.fields.deleteColumn(state.layerId, name.trim());
    await reloadLayer();
    footer('<span class="ok">✓ נמחקה עמודה ' + esc(name) + '</span>');
  } catch (e) { footer('<span class="er">✕ ' + esc(e.message) + '</span>'); }
}

// ── שורות (פיצ'רים): הוספה / מחיקה ──────────────────────────────────────────────
async function addRow() {
  if (!state.layerId) return;
  // גאומטריה: שכפול מהנבחר (או מהראשון) — ניתן לכוונן בהמשך
  var src = state.selected || state.all[0];
  if (!src || !src.geometry) { alert('אין גאומטריה לשכפול — בחר פיצ\'ר קיים תחילה'); return; }
  var geom = JSON.parse(JSON.stringify(src.geometry));
  var code = 'NEW-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000);
  var props = {};
  state.cols.forEach(function (c) { var d = state.fieldDefs[c]; if (!(d && d.is_calculated)) props[c] = null; });
  footer('מוסיף שורה…');
  try {
    await GIS.features.createFeature(state.layerId, geom, props, code);
    await reloadLayer(code);   // טען מחדש ובחר את החדש
    footer('<span class="ok">✓ נוספה שורה — ערוך את הערכים (דאבל-קליק)</span>');
  } catch (e) { footer('<span class="er">✕ ' + esc(e.message) + '</span>'); }
}
async function deleteRow() {
  if (!state.layerId || !state.selected) { alert('בחר שורה למחיקה (לחיצה על שורה)'); return; }
  var id = state.selected.properties.__id || state.selected.id;
  var code = state.selected.properties.asset_code || '';
  if (!window.confirm('למחוק את הפיצ\'ר ' + code + '? פעולה בלתי הפיכה.')) return;
  footer('מוחק שורה…');
  try {
    await GIS.features.deleteFeature(id);
    clearHl(); state.selected = null;
    await reloadLayer(null);
    footer('<span class="ok">✓ השורה נמחקה</span>');
  } catch (e) { footer('<span class="er">✕ ' + esc(e.message) + '</span>'); }
}

// ── ייבוא (מיגרציה) של הקטגוריה/כפר למנוע ───────────────────────────────────────
async function migrateThis() {
  if (!state.vid) return;
  var village = (window.gVillageById && gVillageById[state.vid]) || {};
  if (!window.confirm('לייבא את נתוני "' + (village.village_name || state.vid) + '" למנוע ה-GIS? יאפשר עריכה מלאה. (פעולה חד-פעמית, חוזרת על עצמה בבטחה)')) return;
  document.getElementById('gt-migrate').disabled = true;
  try {
    await GIS.migrate.village(state.vid, { onProgress: function (d, t) { footer('מייבא… ' + d + '/' + t); } });
    footer('<span class="ok">✓ הייבוא הושלם — נטען מצב עריכה…</span>');
    var layerName = (village.village_name || state.vid) + ' · ' + state.catId;
    var layer = await GIS.layers.findByName(layerName);
    if (layer) await openLayer(layer.id, state.selected && state.selected.properties && state.selected.properties.asset_code, { title: '📋 ' + (CAT_HE[state.catId] || state.catId), sub: village.village_name });
  } catch (e) { footer('<span class="er">✕ ' + esc(e.message) + '</span>'); }
  finally { document.getElementById('gt-migrate').disabled = false; }
}

// ── מפה ↔ טבלה ──────────────────────────────────────────────────────────────────
function zoomTo(feature, noFly) {
  if (!window.gMap || !feature || !feature.geometry) return;
  clearHl();
  var g = feature.geometry, latlngs;
  if (g.type === 'Point') {
    var ll = [g.coordinates[1], g.coordinates[0]];
    hl = L.circleMarker(ll, { radius: 11, color: '#f59e0b', weight: 3, fillColor: '#fde047', fillOpacity: .6 }).addTo(gMap);
    if (!noFly) gMap.flyTo(ll, Math.max(gMap.getZoom(), 18), { duration: .6 });
  } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
    var lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    latlngs = lines.map(function (seg) { return seg.map(function (c) { return [c[1], c[0]]; }); });
    hl = L.polyline(latlngs, { color: '#f59e0b', weight: 6, opacity: .9 }).addTo(gMap);
    if (!noFly) gMap.flyToBounds(hl.getBounds(), { maxZoom: 19, duration: .6, padding: [40, 40] });
  } else if (g.type === 'Polygon') {
    latlngs = g.coordinates[0].map(function (c) { return [c[1], c[0]]; });
    hl = L.polygon(latlngs, { color: '#f59e0b', weight: 4, fillOpacity: .15 }).addTo(gMap);
    if (!noFly) gMap.flyToBounds(hl.getBounds(), { maxZoom: 19, duration: .6, padding: [40, 40] });
  }
  if (hl && hl.bringToFront) hl.bringToFront();
}
function clearHl() { if (hl && window.gMap) { gMap.removeLayer(hl); hl = null; } }

// ── עזרים ל-UI ──────────────────────────────────────────────────────────────────
function setHeader(title, sub) { document.getElementById('gt-title').textContent = title; document.getElementById('gt-sub').textContent = sub || ''; }
function footer(htmlStr) { document.getElementById('gt-foot').innerHTML = htmlStr || ''; }
function toolbar(o) {
  document.getElementById('gt-migrate').style.display = o.migrate ? '' : 'none';
  document.getElementById('gt-add').style.display = o.schema ? '' : 'none';
  document.getElementById('gt-ren').style.display = o.schema ? '' : 'none';
  document.getElementById('gt-del').style.display = o.schema ? '' : 'none';
  document.getElementById('gt-addrow').style.display = o.rows ? '' : 'none';
  document.getElementById('gt-delrow').style.display = o.rows ? '' : 'none';
}
function invalidateMap() { if (window.gMap) setTimeout(function () { gMap.invalidateSize(); }, 260); }

// ── חיבור: עטיפת buildPopup ─────────────────────────────────────────────────────
function wirePopup() {
  if (typeof window.buildPopup !== 'function' || window.buildPopup.__gisWrapped) return false;
  var orig = window.buildPopup;
  var wrapped = function (props, def, village, catId) {
    var html = orig.apply(this, arguments);
    var vid = village && village.village_id;
    if (vid && catId) {
      if (GISTable.autoOpen) setTimeout(function () { open(vid, catId, props); }, 0);
      html += '<button onclick="window.GISTable&&GISTable.open(\'' + esc(vid) + '\',\'' + esc(catId) + '\')" ' +
        'style="margin-top:7px;width:100%;background:#0d3b5e;color:#fff;border:none;border-radius:7px;padding:7px;font-size:12px;font-weight:600;cursor:pointer">📋 טבלת מאפיינים</button>';
    }
    return html;
  };
  wrapped.__gisWrapped = true; window.buildPopup = wrapped; return true;
}
if (!wirePopup()) { var n = 0, t = setInterval(function () { if (wirePopup() || ++n > 40) clearInterval(t); }, 150); }

function shallowMatch(a, b) {
  if (!a || !b) return false;
  var keys = ['OBJECTID', 'GlobalID', 'EntityHand', 'asset_code', 'SectionNum', 'ManholeNum'];
  for (var i = 0; i < keys.length; i++) if (a[keys[i]] !== undefined && a[keys[i]] === b[keys[i]]) return true;
  return false;
}
function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]; }); }
function debounce(fn, ms) { var t; return function (e) { clearTimeout(t); t = setTimeout(function () { fn(e); }, ms); }; }

})();
