// ════════════════════════════════════════════════════════════════
//  מי הגליל GIS — טבלת מאפיינים (ArcGIS-style Attribute Table)
//  מודול עצמאי: בלחיצה על פיצ'ר (למשל קו מים) נפתחת טבלה תחתונה עם
//  כל הפיצ'רים של אותה קטגוריה + כל השדות, והשורה של הפיצ'ר שנבחר
//  מסומנת ונגללת לתצוגה — בדיוק כמו ArcGIS.
//
//  חיבור ללא נגיעה בליבת המפה: עוטף את window.buildPopup הגלובלי
//  (שכבר מקושר לכל פיצ'ר כפר), כך שלחיצה פותחת/מעדכנת את הטבלה.
//  קורא את הנתונים ממקור המנוע (gVillageFeatures / GIS.villages).
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

var CAP = 1500;                 // תקרת שורות מוצגות (יציבות) — סינון מצמצם
var HIDE = /^_|^__/;            // שדות פנימיים מוסתרים מהטבלה
var CAT_HE = {                  // תוויות קטגוריה בעברית (לכותרת)
  water_pipes:'קווי מים', sewage_pipes:'קווי ביוב', main_sewer:'ביב ראשי',
  supply_pipe:'קו הספקה', valves:'מגופים', control_valves:'מגופים שולטים',
  hydrants:'הידרנטים', water_meters:'מדי מים', sewage_manholes:'שוחות ביוב',
  connection_points:'נקודות חיבור', reservoirs:'מאגרים', pump_stations:'תחנות שאיבה'
};

// ── סגנונות ───────────────────────────────────────────────────────────────────
var css = document.createElement('style');
css.textContent = `
#gis-tbl{position:fixed;left:0;right:0;bottom:0;height:42vh;z-index:1200;background:#fff;direction:rtl;
  box-shadow:0 -6px 24px rgba(0,0,0,.18);display:none;flex-direction:column;font-family:'Segoe UI',Tahoma,Arial,sans-serif;}
#gis-tbl.open{display:flex;}
.gt-head{display:flex;align-items:center;gap:10px;background:#0d3b5e;color:#fff;padding:8px 12px;flex-shrink:0;}
.gt-title{font-weight:700;font-size:13px;}
.gt-sub{font-size:11px;opacity:.85;}
.gt-spacer{flex:1;}
.gt-search{border:none;border-radius:7px;padding:6px 10px;font-size:13px;direction:rtl;width:220px;}
.gt-ico{background:rgba(255,255,255,.12);border:none;color:#fff;font-size:14px;cursor:pointer;border-radius:6px;padding:5px 10px;}
.gt-ico:hover{background:rgba(255,255,255,.25);}
.gt-wrap{flex:1;overflow:auto;}
.gt-table{border-collapse:collapse;font-size:12.5px;white-space:nowrap;min-width:100%;}
.gt-table th{position:sticky;top:0;background:#eef2f6;color:#0d3b5e;text-align:right;padding:7px 12px;
  border-bottom:2px solid #cbd5e1;cursor:pointer;user-select:none;z-index:1;}
.gt-table th .a{opacity:.5;font-size:10px;margin-right:3px;}
.gt-table td{padding:6px 12px;border-bottom:1px solid #f1f5f9;color:#1e293b;}
.gt-table td.idx{color:#94a3b8;background:#fafcff;text-align:center;position:sticky;right:0;}
.gt-table tr:hover td{background:#f8fafc;}
.gt-table tr.sel td{background:#cfe2ff !important;}
.gt-table tr.sel td.idx{background:#a8c7fa !important;color:#0d3b5e;font-weight:700;}
.gt-empty{padding:20px;color:#94a3b8;font-size:13px;text-align:center;}
.gt-foot{flex-shrink:0;background:#f8fafc;border-top:1px solid #e2e8f0;padding:5px 12px;font-size:11px;color:#64748b;}`;
document.head.appendChild(css);

// ── שלד ───────────────────────────────────────────────────────────────────────
var el = document.createElement('div');
el.id = 'gis-tbl';
el.innerHTML =
  '<div class="gt-head">' +
    '<span class="gt-title" id="gt-title">טבלת מאפיינים</span>' +
    '<span class="gt-sub" id="gt-sub"></span>' +
    '<span class="gt-spacer"></span>' +
    '<input class="gt-search" id="gt-search" placeholder="סינון…">' +
    '<button class="gt-ico" id="gt-zoom" title="התמקד בנבחר">🎯</button>' +
    '<button class="gt-ico" id="gt-x" title="סגור">✕</button>' +
  '</div>' +
  '<div class="gt-wrap" id="gt-wrap"><div class="gt-empty">—</div></div>' +
  '<div class="gt-foot" id="gt-foot"></div>';
document.body.appendChild(el);

var state = { vid:null, catId:null, all:[], cols:[], selected:null, sortKey:null, sortDir:1, filter:'' };
var hl = null;  // שכבת הדגשה זמנית על המפה

document.getElementById('gt-x').onclick = close;
document.getElementById('gt-zoom').onclick = function () { if (state.selected) zoomTo(state.selected); };
document.getElementById('gt-search').oninput = debounce(function (e) { state.filter = e.target.value; renderBody(); }, 180);
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.classList.contains('open')) close(); });

function close() { el.classList.remove('open'); clearHl(); }

// ── API ───────────────────────────────────────────────────────────────────────
var GISTable = {
  autoOpen: true,   // לחיצה על פיצ'ר פותחת/מעדכנת את הטבלה
  open: open,
  close: close
};
window.GISTable = GISTable;

// פתח/עדכן טבלה עבור קטגוריה בכפר, ובחר את הפיצ'ר (selProps = feature.properties).
function open(vid, catId, selProps) {
  var feats = featuresFor(vid, catId);
  if (!feats || !feats.length) return;

  var sameView = (state.vid === vid && state.catId === catId);
  state.vid = vid; state.catId = catId; state.all = feats;
  if (!sameView) { state.sortKey = null; state.sortDir = 1; state.filter = ''; document.getElementById('gt-search').value = ''; state.cols = deriveColumns(feats); }

  // מצא את הפיצ'ר הנבחר לפי זהות אובייקט (אותו props), אחרת לפי התאמה
  state.selected = null;
  if (selProps) {
    state.selected = feats.find(function (f) { return f.properties === selProps; }) ||
                     feats.find(function (f) { return shallowMatch(f.properties, selProps); }) || null;
  }

  var label = CAT_HE[catId] || catId;
  var village = (window.gVillageById && gVillageById[vid]) || {};
  document.getElementById('gt-title').textContent = '📋 ' + label;
  document.getElementById('gt-sub').textContent = (village.village_name || '') + ' · ' + feats.length + ' פריטים';
  el.classList.add('open');
  if (window.gMap) setTimeout(function () { gMap.invalidateSize(); }, 260); // המפה מתכווצת — רענן

  renderBody(true);
  if (state.selected) zoomTo(state.selected, true);
}

// ── מקור נתונים (מנוע) ────────────────────────────────────────────────────────
function featuresFor(vid, catId) {
  // index.js שומר gVillageFeatures[vid] = { catId: [features] } — אותם אובייקטים
  // שמקושרים למפה (זהות נשמרת לבחירה). זהו בדיוק מקור הנתונים של GIS.villages.
  var byCat = window.gVillageFeatures && window.gVillageFeatures[vid];
  if (byCat && byCat[catId]) return byCat[catId];
  return null;
}

function deriveColumns(feats) {
  var seen = {}, cols = [];
  feats.slice(0, 80).forEach(function (f) {
    Object.keys(f.properties || {}).forEach(function (k) {
      if (!HIDE.test(k) && !seen[k]) { seen[k] = 1; cols.push(k); }
    });
  });
  return cols;
}

// ── רינדור ────────────────────────────────────────────────────────────────────
function renderBody(scrollToSel) {
  var wrap = document.getElementById('gt-wrap');
  var rows = state.all;

  if (state.filter) {
    var q = state.filter.toLowerCase();
    rows = rows.filter(function (f) {
      var p = f.properties || {};
      return state.cols.some(function (c) { return String(p[c] == null ? '' : p[c]).toLowerCase().indexOf(q) >= 0; });
    });
  }
  if (state.sortKey) {
    var k = state.sortKey, dir = state.sortDir;
    rows = rows.slice().sort(function (a, b) {
      var av = a.properties[k], bv = b.properties[k];
      var na = parseFloat(av), nb = parseFloat(bv);
      if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
      return String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv), 'he') * dir;
    });
  }

  var total = rows.length;
  var capped = total > CAP;
  var view = rows.slice(0, CAP);
  // ודא שהשורה הנבחרת מוצגת גם אם מעבר לתקרה
  if (state.selected && view.indexOf(state.selected) === -1 && rows.indexOf(state.selected) >= 0) {
    view = [state.selected].concat(view.slice(0, CAP - 1));
  }

  if (!total) { wrap.innerHTML = '<div class="gt-empty">אין תוצאות לסינון</div>'; document.getElementById('gt-foot').textContent = ''; return; }

  var arrow = function (c) { return state.sortKey === c ? '<span class="a">' + (state.sortDir > 0 ? '▲' : '▼') + '</span>' : '<span class="a">↕</span>'; };
  var html = '<table class="gt-table"><thead><tr><th class="idx">#</th>';
  state.cols.forEach(function (c) { html += '<th data-col="' + esc(c) + '">' + esc(c) + arrow(c) + '</th>'; });
  html += '</tr></thead><tbody>';
  view.forEach(function (f, i) {
    var p = f.properties || {};
    var isSel = f === state.selected;
    html += '<tr class="' + (isSel ? 'sel' : '') + '" data-i="' + i + '"><td class="idx">' + (rows.indexOf(f) + 1) + '</td>';
    state.cols.forEach(function (c) { html += '<td>' + esc(p[c] == null ? '' : p[c]) + '</td>'; });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  document.getElementById('gt-foot').textContent = capped
    ? ('מציג ' + view.length + ' מתוך ' + total + ' — השתמש בסינון לצמצום')
    : ('סה״כ ' + total + ' פריטים');

  // אירועים: מיון בכותרת, בחירת שורה
  Array.prototype.forEach.call(wrap.querySelectorAll('th[data-col]'), function (th) {
    th.onclick = function () {
      var c = th.getAttribute('data-col');
      if (state.sortKey === c) state.sortDir *= -1; else { state.sortKey = c; state.sortDir = 1; }
      renderBody();
    };
  });
  Array.prototype.forEach.call(wrap.querySelectorAll('tbody tr'), function (tr) {
    tr.onclick = function () {
      var f = view[+tr.getAttribute('data-i')];
      state.selected = f;
      Array.prototype.forEach.call(wrap.querySelectorAll('tbody tr'), function (x) { x.classList.remove('sel'); });
      tr.classList.add('sel');
      zoomTo(f);
    };
  });

  if (scrollToSel && state.selected) {
    var selRow = wrap.querySelector('tbody tr.sel');
    if (selRow) selRow.scrollIntoView({ block: 'center' });
  }
}

// ── קישור לטבלה→מפה: התמקד והדגש את הפיצ'ר ─────────────────────────────────────
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
  if (hl) hl.bringToFront && hl.bringToFront();
}
function clearHl() { if (hl && window.gMap) { gMap.removeLayer(hl); hl = null; } }

// ── חיבור: עטיפת buildPopup כך שלחיצה על פיצ'ר תפתח/תעדכן את הטבלה ──────────────
function wirePopup() {
  if (typeof window.buildPopup !== 'function' || window.buildPopup.__gisWrapped) return false;
  var orig = window.buildPopup;
  var wrapped = function (props, def, village, catId) {
    var html = orig.apply(this, arguments);
    var vid = village && village.village_id;
    if (vid && catId) {
      if (GISTable.autoOpen) setTimeout(function () { open(vid, catId, props); }, 0);
      html += '<button onclick="window.GISTable&&GISTable.open(\'' + esc(vid) + '\',\'' + esc(catId) + '\')" ' +
        'style="margin-top:7px;width:100%;background:#0d3b5e;color:#fff;border:none;border-radius:7px;' +
        'padding:7px;font-size:12px;font-weight:600;cursor:pointer">📋 טבלת מאפיינים</button>';
    }
    return html;
  };
  wrapped.__gisWrapped = true;
  window.buildPopup = wrapped;
  return true;
}

// buildPopup מוגדר ב-index.js (defer, נטען לפנינו). נסה לעטוף, עם כמה ניסיונות לבטחון.
if (!wirePopup()) {
  var n = 0, t = setInterval(function () { if (wirePopup() || ++n > 40) clearInterval(t); }, 150);
}

// ── עזרים ─────────────────────────────────────────────────────────────────────
function shallowMatch(a, b) {
  if (!a || !b) return false;
  var keys = ['OBJECTID', 'GlobalID', 'EntityHand', 'asset_code', 'SectionNum', 'ManholeNum'];
  for (var i = 0; i < keys.length; i++) { if (a[keys[i]] !== undefined && a[keys[i]] === b[keys[i]]) return true; }
  return false;
}
function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]; }); }
function debounce(fn, ms) { var t; return function (e) { clearTimeout(t); t = setTimeout(function () { fn(e); }, ms); }; }

})();
