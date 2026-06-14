// ════════════════════════════════════════════════════════════════
//  מי הגליל GIS — לוח מאפיינים (Attribute Panel)
//  מודול עצמאי בסגנון ArcGIS: לחיצה על פיצ'ר → פאנל מאפיינים נשלף
//  מימין עם טבלת שדות (מיון + סינון), מידע גאומטרי, מדי-מים מקושרים,
//  ועריכה (אדמין/מהנדס בלבד).
//
//  כל הגישה לנתונים עוברת דרך מנוע ה-GIS (GIS.*) — לעולם לא gSb ישירות.
//
//  שימוש:
//    L.geoJSON(fc, { onEachFeature: GISPanel.onEachFeature }).addTo(map);
//    // או ידנית:
//    GISPanel.open(feature);
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

if (!window.GIS) { console.warn('[GISPanel] GIS engine not loaded — load gis-engine/*.js first.'); return; }

var INTERNAL = { __id: 1, __layer_id: 1, asset_code: 1 }; // shown specially / hidden from the generic table

// ── סגנונות ───────────────────────────────────────────────────────────────────
var s = document.createElement('style');
s.textContent = `
.gp-panel{position:fixed;top:0;right:0;height:100vh;width:380px;max-width:92vw;background:#fff;direction:rtl;
  box-shadow:-6px 0 28px rgba(0,0,0,0.18);z-index:1600;display:flex;flex-direction:column;
  font-family:'Segoe UI',Tahoma,Arial,sans-serif;transform:translateX(100%);transition:transform .25s ease;}
.gp-panel.open{transform:translateX(0);}
.gp-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#0d3b5e;color:#fff;flex-shrink:0;}
.gp-head .code{font-size:15px;font-weight:700;}
.gp-head .sub{font-size:11px;opacity:.8;margin-top:2px;}
.gp-x{background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;padding:4px 8px;border-radius:6px;}
.gp-x:hover{background:rgba(255,255,255,.15);}
.gp-body{flex:1;overflow-y:auto;padding:14px 16px;background:#f8fafc;}
.gp-sec{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin:16px 0 8px;}
.gp-sec:first-child{margin-top:0;}
.gp-toolbar{display:flex;gap:6px;margin-bottom:8px;}
.gp-search{flex:1;border:1px solid #e2e8f0;border-radius:7px;padding:6px 9px;font-size:13px;direction:rtl;}
.gp-tbl{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;font-size:13px;}
.gp-tbl th{background:#eef2f6;color:#0d3b5e;font-size:11px;text-transform:uppercase;letter-spacing:.04em;
  text-align:right;padding:7px 10px;cursor:pointer;user-select:none;white-space:nowrap;}
.gp-tbl th .arr{opacity:.5;font-size:10px;}
.gp-tbl td{padding:7px 10px;border-top:1px solid #f1f5f9;color:#1e293b;vertical-align:top;}
.gp-tbl td.k{color:#64748b;width:46%;word-break:break-word;}
.gp-tbl td.v{font-weight:600;word-break:break-word;}
.gp-tbl tr.calc td.k::after{content:' ƒ';color:#1a7fc1;font-weight:700;}
.gp-edit-input{width:100%;border:1px solid #cbd5e1;border-radius:6px;padding:4px 7px;font-size:13px;direction:rtl;box-sizing:border-box;}
.gp-edit-input[readonly]{background:#f1f5f9;color:#94a3b8;}
.gp-meter{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:8px;font-size:12.5px;}
.gp-meter .mid{font-weight:700;color:#0d3b5e;}
.gp-meter .row{display:flex;justify-content:space-between;color:#475569;margin-top:3px;}
.gp-meter.anom{border-color:#f59e0b;background:#fffbeb;}
.gp-badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;}
.gp-badge.warn{background:#fef3c7;color:#b45309;}
.gp-foot{flex-shrink:0;padding:12px 16px;border-top:1px solid #e2e8f0;background:#fff;display:flex;gap:8px;}
.gp-btn{flex:1;border:none;border-radius:8px;padding:9px 0;font-size:13.5px;font-weight:600;cursor:pointer;}
.gp-btn.primary{background:#0d3b5e;color:#fff;}
.gp-btn.primary:hover{background:#1a7fc1;}
.gp-btn.ghost{background:#f1f5f9;color:#0d3b5e;}
.gp-btn.ghost:hover{background:#e2e8f0;}
.gp-btn:disabled{opacity:.5;cursor:not-allowed;}
.gp-empty{color:#94a3b8;font-size:12.5px;text-align:center;padding:14px 0;}
.gp-err{color:#dc2626;font-size:12.5px;padding:8px 0;}
.gp-note{font-size:11px;color:#94a3b8;margin-top:6px;}
@media (max-width:480px){ .gp-panel{width:100vw;} }`;
document.head.appendChild(s);

// ── שלד הפאנל ─────────────────────────────────────────────────────────────────
var panel = document.createElement('div');
panel.className = 'gp-panel';
panel.innerHTML =
  '<div class="gp-head">' +
    '<div><div class="code" id="gp-code">—</div><div class="sub" id="gp-sub"></div></div>' +
    '<button class="gp-x" id="gp-x" title="סגור">✕</button>' +
  '</div>' +
  '<div class="gp-body" id="gp-body"></div>' +
  '<div class="gp-foot" id="gp-foot"></div>';
document.body.appendChild(panel);
document.getElementById('gp-x').onclick = close;
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && panel.classList.contains('open')) close();
});

// ── מצב ───────────────────────────────────────────────────────────────────────
var state = { feature: null, fields: [], role: null, editing: false, sortKey: 'k', sortDir: 1, filter: '' };

function close() { panel.classList.remove('open'); state.editing = false; }

// ── API ציבורי ───────────────────────────────────────────────────────────────
var GISPanel = {
  // לשימוש כ-onEachFeature ב-L.geoJSON
  onEachFeature: function (feature, layer) {
    layer.on('click', function () { GISPanel.open(feature); });
  },
  // קישור שכבת geoJSON קיימת
  bindLayer: function (geoJsonLayer) {
    geoJsonLayer.eachLayer(function (l) {
      if (l.feature) l.on('click', function () { GISPanel.open(l.feature); });
    });
    return geoJsonLayer;
  },
  open: open,
  openMeter: function (feature) { return open(feature, { kind: 'meter' }); },
  close: close
};
window.GISPanel = GISPanel;

// ── פתיחה ─────────────────────────────────────────────────────────────────────
// opts (אופציונלי) קובע איך ייפתח לחצן "טבלת עריכה":
//   { layerId }            → GISTable.openLayer
//   { vid, catId }         → GISTable.open (נתוני כפר; יציע ייבוא אם צריך)
async function open(feature, opts) {
  if (!feature) return;
  state.feature = feature;
  state.tableCtx = opts || null;
  state.kind = (opts && opts.kind) ? opts.kind : null;
  state.editing = false;
  state.filter = '';
  var props = feature.properties || {};
  var code = state.kind === 'meter'
    ? (props.arad_meter_id || feature.id || '—')
    : (props.asset_code || feature.id || '—');
  document.getElementById('gp-code').textContent = code;
  document.getElementById('gp-sub').textContent = state.kind === 'meter'
    ? '🔢 מד מים' : ((feature.geometry && feature.geometry.type) || '');
  panel.classList.add('open');
  document.getElementById('gp-body').innerHTML = '<div class="gp-empty">טוען…</div>';
  document.getElementById('gp-foot').innerHTML = '';

  try {
    state.role = await GIS.currentRole();
    if (state.kind !== 'meter') {
      var layerId = props.__layer_id;
      state.fields = layerId ? await GIS.fields.getFields(layerId) : [];
    } else { state.fields = []; }
  } catch (e) { state.fields = []; }

  render();
}

// ── רינדור ────────────────────────────────────────────────────────────────────
function render() {
  if (state.kind === 'meter') { renderMeter(); return; }
  var f = state.feature;
  var body = document.getElementById('gp-body');
  var fieldDefs = {}; state.fields.forEach(function (d) { fieldDefs[d.name] = d; });

  // שורות מאפיינים (ללא שדות פנימיים)
  var rows = Object.keys(f.properties || {})
    .filter(function (k) { return !INTERNAL[k]; })
    .map(function (k) { return { k: k, v: f.properties[k], calc: fieldDefs[k] && fieldDefs[k].is_calculated, def: fieldDefs[k] }; });

  // סינון
  if (state.filter) {
    var q = state.filter.toLowerCase();
    rows = rows.filter(function (r) { return r.k.toLowerCase().indexOf(q) >= 0 || String(r.v).toLowerCase().indexOf(q) >= 0; });
  }
  // מיון
  rows.sort(function (a, b) {
    var av = String(a[state.sortKey]), bv = String(b[state.sortKey]);
    var na = parseFloat(av), nb = parseFloat(bv);
    if (!isNaN(na) && !isNaN(nb) && state.sortKey === 'v') return (na - nb) * state.sortDir;
    return av.localeCompare(bv, 'he') * state.sortDir;
  });

  var arr = function (key) { return state.sortKey === key ? (state.sortDir > 0 ? '▲' : '▼') : '↕'; };

  var html = '';
  // טבלת מאפיינים
  html += '<div class="gp-sec">מאפיינים</div>';
  html += '<div class="gp-toolbar"><input class="gp-search" id="gp-search" placeholder="סינון שדות…" value="' + esc(state.filter) + '"></div>';
  html += '<table class="gp-tbl"><thead><tr>' +
            '<th data-sort="k">שדה <span class="arr">' + arr('k') + '</span></th>' +
            '<th data-sort="v">ערך <span class="arr">' + arr('v') + '</span></th>' +
          '</tr></thead><tbody>';
  if (!rows.length) html += '<tr><td colspan="2" class="gp-empty">אין שדות</td></tr>';
  var DM = window.GISDomains;
  rows.forEach(function (r) {
    var hasDom = DM && DM.has(r.k);
    html += '<tr class="' + (r.calc ? 'calc' : '') + '">';
    html += '<td class="k">' + esc(r.k) + '</td>';
    if (state.editing && !r.calc) {
      if (hasDom) {
        var opts = DM.options(r.k, r.v).map(function (o) {
          return '<option value="' + esc(o.code) + '"' + (String(r.v) === String(o.code) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }).join('');
        html += '<td class="v"><select class="gp-edit-input" data-field="' + esc(r.k) + '">' + opts + '</select></td>';
      } else {
        html += '<td class="v"><input class="gp-edit-input" data-field="' + esc(r.k) + '" value="' + esc(r.v == null ? '' : r.v) + '"></td>';
      }
    } else {
      // display: domain label (raw code shown in title for reference)
      var disp = hasDom ? DM.label(r.k, r.v) : r.v;
      html += '<td class="v"' + (hasDom && disp !== r.v ? ' title="קוד ' + esc(r.v) + '"' : '') + '>' + esc(disp == null ? '—' : disp) + '</td>';
    }
    html += '</tr>';
  });
  html += '</tbody></table>';

  // מידע גאומטרי
  html += '<div class="gp-sec">גאומטריה</div>';
  html += geometryInfo(f.geometry);

  // מדי מים מקושרים
  html += '<div class="gp-sec">מדי מים מקושרים</div><div id="gp-meters"><div class="gp-empty">טוען…</div></div>';

  body.innerHTML = html;

  // אירועים: סינון/מיון
  var search = document.getElementById('gp-search');
  if (search) search.oninput = debounce(function () { state.filter = search.value; var pos = search.selectionStart; render(); var ns = document.getElementById('gp-search'); if (ns) { ns.focus(); ns.selectionStart = ns.selectionEnd = pos; } }, 180);
  Array.prototype.forEach.call(body.querySelectorAll('th[data-sort]'), function (th) {
    th.onclick = function () {
      var k = th.getAttribute('data-sort');
      if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = 1; }
      render();
    };
  });

  renderFooter();
  loadMeters(f);
}

function geometryInfo(g) {
  if (!g) return '<div class="gp-empty">אין גאומטריה</div>';
  var html = '<table class="gp-tbl"><tbody>';
  html += row('סוג', g.type);
  if (g.type === 'Point') {
    html += row('קו אורך', g.coordinates[0]);
    html += row('קו רוחב', g.coordinates[1]);
  } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
    var len = (state.feature.properties && state.feature.properties.length_m) || GIS.spatial.geometryLength(g).toFixed(1);
    html += row('אורך (מ׳)', len);
    var n = g.type === 'LineString' ? g.coordinates.length : g.coordinates.reduce(function (t, c) { return t + c.length; }, 0);
    html += row('קודקודים', n);
  } else if (g.type === 'Polygon') {
    html += row('טבעות', g.coordinates.length);
  }
  html += '</tbody></table>';
  return html;
}

async function loadMeters(feature) {
  var box = document.getElementById('gp-meters');
  if (!box) return;
  var props = (feature && feature.properties) || {};
  var pipeId = props.__id || (feature && feature.id);
  var assetCode = props.asset_code;
  try {
    var meters = [];
    // Authoritative link: meters whose connected_pipe_id is this pipe.
    if (pipeId && GIS.meters.getForPipe) meters = await GIS.meters.getForPipe(pipeId);
    // Fallback: legacy asset_code link.
    if ((!meters || !meters.length) && assetCode) meters = await GIS.meters.getForAsset(assetCode);
    if (!meters.length) { box.innerHTML = '<div class="gp-empty">אין מדים מקושרים</div>'; return; }
    var anomalies = await GIS.meters.getAnomalies();
    var anomSet = {}; anomalies.forEach(function (a) { anomSet[a.arad_meter_id] = a.ratio; });
    box.innerHTML = '<div class="gp-note" style="margin:0 0 6px">' + meters.length.toLocaleString('he-IL') + ' מדים מקושרים</div>' +
      meters.map(function (m) {
      var isAnom = anomSet[m.arad_meter_id];
      var tLbl = m.connection_type === 'MANUAL' ? 'ידני' : (m.connection_type === 'AUTO' ? 'אוטומטי' : '');
      return '<div class="gp-meter' + (isAnom ? ' anom' : '') + '">' +
        '<div class="mid">' + esc(m.arad_meter_id) +
          (isAnom ? ' <span class="gp-badge warn">חריגה ×' + isAnom + '</span>' : '') +
          (tLbl ? ' <span class="gp-badge" style="background:#dbeafe;color:#1e40af">' + tLbl + '</span>' : '') + '</div>' +
        '<div class="row"><span>צריכה</span><span>' + fmt(m.consumption) + '</span></div>' +
        '<div class="row"><span>קריאה אחרונה</span><span>' + fmt(m.last_reading) + '</span></div>' +
        '<div class="row"><span>לקוח</span><span>' + esc(m.customer_id || '—') + '</span></div>' +
        (m.connection_distance_m != null ? '<div class="row"><span>מרחק לצינור</span><span>' + fmt(m.connection_distance_m) + ' מ׳</span></div>' : '') +
      '</div>';
    }).join('');
  } catch (e) {
    box.innerHTML = '<div class="gp-err">שגיאה בטעינת מדים: ' + esc(e.message) + '</div>';
  }
}

// ── תצוגת מד מים (Point מטבלת meters) ─────────────────────────────────────────
var METER_HIDE = {
  __id: 1, __layer_id: 1, asset_code: 1, connected_pipe_id: 1, connection_point: 1,
  connection_type: 1, connection_distance_m: 1, connection_ambiguous: 1,
  connection_updated_at: 1, connection_updated_by: 1
};

function renderMeter() {
  var f = state.feature, p = f.properties || {};
  var body = document.getElementById('gp-body');
  var rows = Object.keys(p)
    .filter(function (k) { return !METER_HIDE[k] && typeof p[k] !== 'object'; })
    .map(function (k) { return { k: k, v: p[k] }; });

  var html = '';
  html += '<div class="gp-sec">חיבור לצינור</div>' + connectionSection(p);
  html += '<div class="gp-sec">מאפיינים</div>';
  html += '<table class="gp-tbl"><tbody>';
  if (!rows.length) html += '<tr><td colspan="2" class="gp-empty">אין שדות</td></tr>';
  rows.forEach(function (r) { html += row(r.k, (r.v == null || r.v === '') ? '—' : r.v); });
  html += '</tbody></table>';
  html += '<div class="gp-sec">גאומטריה</div>' + geometryInfo(f.geometry);

  body.innerHTML = html;
  var ob = document.getElementById('gp-open-pipe');
  if (ob) ob.onclick = openConnectedPipe;
  renderMeterFooter();
}

function connectionSection(p) {
  var t = p.connection_type || 'NONE';
  var label = ({ AUTO: '🟢 אוטומטי', MANUAL: '🔵 ידני', NONE: '🟡 לא מחובר' })[t] || t;
  var html = '<table class="gp-tbl"><tbody>';
  html += row('סטטוס חיבור', label);
  if (t !== 'NONE') {
    html += row('מרחק לצינור (מ׳)', p.connection_distance_m == null ? '—' : p.connection_distance_m);
    html += row('קוד צינור (asset)', p.asset_code || '—');
    if (p.connection_ambiguous) html += row('שים לב', '⚠ צינור שני קרוב כמעט באותו מרחק');
  }
  html += '</tbody></table>';
  if (t !== 'NONE' && p.connected_pipe_id) {
    html += '<button class="gp-btn ghost" id="gp-open-pipe" style="margin-top:8px;width:100%">🚰 פתח צינור מחובר</button>';
  }
  return html;
}

async function openConnectedPipe() {
  var p = state.feature.properties || {};
  if (!p.connected_pipe_id) return;
  try {
    var pipe = await GIS.features.getFeatureById(p.connected_pipe_id);
    open(pipe, { layerId: pipe.properties && pipe.properties.__layer_id });
  } catch (e) { alert('שגיאה בפתיחת הצינור: ' + (e && e.message ? e.message : e)); }
}

function renderMeterFooter() {
  var foot = document.getElementById('gp-foot');
  var canEdit = GIS.permissions.canEditMeters(state.role);
  if (canEdit && window.GISMeterConnect && window.GISMeterConnect.editMeter) {
    foot.innerHTML = '<button class="gp-btn primary" id="gp-medit">🔗 ערוך חיבור</button>';
    document.getElementById('gp-medit').onclick = function () { window.GISMeterConnect.editMeter(state.feature); };
  } else {
    foot.innerHTML = '<div class="gp-note" style="text-align:center;width:100%">תצוגה בלבד (תפקיד: ' + esc(state.role || 'אורח') + ')</div>';
  }
}

// ── כותרת תחתונה / עריכה ──────────────────────────────────────────────────────
function renderFooter() {
  var foot = document.getElementById('gp-foot');
  var canEdit = GIS.permissions.canEditGis(state.role);

  if (state.editing) {
    foot.innerHTML =
      '<button class="gp-btn primary" id="gp-save">שמירה</button>' +
      '<button class="gp-btn ghost" id="gp-cancel">ביטול</button>';
    document.getElementById('gp-save').onclick = save;
    document.getElementById('gp-cancel').onclick = function () { state.editing = false; render(); };
    return;
  }

  var html = '';
  if (state.tableCtx && window.GISTable) html += '<button class="gp-btn primary" id="gp-table">📋 טבלת עריכה</button>';
  if (canEdit) html += '<button class="gp-btn ghost" id="gp-editbtn">✎ עריכה מהירה</button>';
  if (!html) html = '<div class="gp-note" style="text-align:center;width:100%">תצוגה בלבד (תפקיד: ' + esc(state.role || 'אורח') + ')</div>';
  foot.innerHTML = html;

  if (document.getElementById('gp-table')) document.getElementById('gp-table').onclick = openTable;
  if (document.getElementById('gp-editbtn')) document.getElementById('gp-editbtn').onclick = function () { state.editing = true; render(); };
}

// פותח את טבלת העריכה (SQL) עבור הפיצ'ר/השכבה שנבחרו.
function openTable() {
  var ctx = state.tableCtx;
  if (!ctx || !window.GISTable) return;
  var code = state.feature.properties && state.feature.properties.asset_code;
  if (ctx.layerId) window.GISTable.openLayer(ctx.layerId, code, { title: '📋 ' + (code || ''), sub: ctx.sub || '' });
  else if (ctx.vid && ctx.catId) window.GISTable.open(ctx.vid, ctx.catId, state.feature.properties);
}

async function save() {
  var foot = document.getElementById('gp-foot');
  var inputs = panel.querySelectorAll('.gp-edit-input[data-field]');
  var fieldDefs = {}; state.fields.forEach(function (d) { fieldDefs[d.name] = d; });
  var props = {};
  // התחל מהמאפיינים הקיימים (ללא שדות פנימיים) ודרוס בערוכים
  Object.keys(state.feature.properties || {}).forEach(function (k) { if (!INTERNAL[k]) props[k] = state.feature.properties[k]; });
  var DM = window.GISDomains;
  Array.prototype.forEach.call(inputs, function (inp) {
    var k = inp.getAttribute('data-field');
    var def = fieldDefs[k];
    var val = inp.value;
    if (def && (def.type === 'int' || def.type === 'float')) val = val === '' ? null : Number(val);
    else if (def && def.type === 'bool') val = /^(true|1|כן|yes)$/i.test(val);
    else if (DM && DM.has(k) && DM.numeric(k)) val = val === '' ? null : Number(val); // domain code → number
    props[k] = val;
  });

  var saveBtn = document.getElementById('gp-save');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'שומר…'; }
  try {
    var id = state.feature.id || (state.feature.properties && state.feature.properties.__id);
    var updated = await GIS.features.updateFeature(id, props);
    // עדכן את הפיצ'ר המקומי (כולל שדות שחושבו מחדש ב-DB כמו length_m/age)
    var merged = Object.assign({}, state.feature.properties, updated.properties);
    state.feature.properties = merged;
    state.editing = false;
    render();
  } catch (e) {
    foot.innerHTML = '<div class="gp-err" style="width:100%;text-align:center">' + esc(e.message) + '</div>';
    setTimeout(renderFooter, 2500);
  }
}

// ── עזרים ─────────────────────────────────────────────────────────────────────
function row(k, v) { return '<tr><td class="k">' + esc(k) + '</td><td class="v">' + esc(v) + '</td></tr>'; }
function fmt(n) { return (n == null || n === '') ? '—' : (typeof n === 'number' ? n.toLocaleString('he-IL') : esc(n)); }
function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

})();
