// ════════════════════════════════════════════════════════════════
//  מי הגליל GIS — לוח סטטיסטיקה (Stats Dashboard)
//  מודול עצמאי: מזריק FAB + מודאל עם גרפים על בסיס טבלת incidents.
//  גרפים נבנים ב-SVG/CSS טהור (ללא ספריה חיצונית) — RTL, פלטת המערכת.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

// ── מיפויי תווית/צבע ──────────────────────────────────────────────────────────
var STATUS = {
  open:        { label: 'פתוחות', color: '#ef4444' },
  in_progress: { label: 'בטיפול', color: '#f59e0b' },
  closed:      { label: 'סגורות', color: '#22c55e' }
};
var PRIORITY = {
  high:   { label: 'גבוהה',  color: '#dc2626' },
  medium: { label: 'בינונית', color: '#f59e0b' },
  low:    { label: 'נמוכה',  color: '#22c55e' }
};
var HEB_MONTHS = ['ינו','פבר','מרץ','אפר','מאי','יונ','יול','אוג','ספט','אוק','נוב','דצמ'];

// ── סגנונות ───────────────────────────────────────────────────────────────────
var s = document.createElement('style');
s.textContent = `
#stats-fab{position:absolute;bottom:150px;right:14px;background:#0d3b5e;color:#fff;border:none;border-radius:50%;width:50px;height:50px;font-size:20px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.3);z-index:400;display:flex;align-items:center;justify-content:center;}
#stats-fab:hover{background:#1a7fc1;}
.st-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1500;align-items:center;justify-content:center;}
.st-bg.open{display:flex;}
.st-mod{background:#fff;border-radius:14px;width:720px;max-width:95vw;direction:rtl;box-shadow:0 12px 40px rgba(0,0,0,0.25);max-height:90vh;overflow:hidden;display:flex;flex-direction:column;font-family:'Segoe UI',Tahoma,Arial,sans-serif;}
.st-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 16px;border-bottom:1px solid #e2e8f0;flex-shrink:0;}
.st-title{font-size:17px;font-weight:700;color:#0d3b5e;}
.st-head-acts{display:flex;gap:6px;align-items:center;}
.st-icon-btn{background:none;border:none;font-size:17px;cursor:pointer;color:#94a3b8;padding:3px 9px;border-radius:6px;line-height:1;}
.st-icon-btn:hover{background:#f1f5f9;color:#0d3b5e;}
.st-body{padding:18px 20px 22px;overflow-y:auto;flex:1;background:#f8fafc;}
.st-loading,.st-empty{color:#94a3b8;font-size:13px;text-align:center;padding:26px 0;}
.st-err{color:#dc2626;font-size:13px;text-align:center;padding:26px 0;}

.st-tiles{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;}
.st-tile{flex:1;min-width:104px;background:#fff;border:1px solid #e2e8f0;border-top:3px solid var(--ac,#0d3b5e);border-radius:10px;padding:12px 10px;text-align:center;}
.st-tile .n{font-size:24px;font-weight:700;color:#0d3b5e;line-height:1.1;}
.st-tile .n.txt{font-size:16px;}
.st-tile .l{font-size:11px;color:#64748b;margin-top:4px;}

.st-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
.st-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-bottom:12px;}
.st-card-title{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin:0 0 12px;}

.st-donut-wrap{display:flex;align-items:center;gap:14px;}
.st-donut{width:118px;height:118px;flex-shrink:0;}
.st-legend{flex:1;display:flex;flex-direction:column;gap:7px;}
.st-leg-row{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#1e293b;}
.st-leg-dot{width:11px;height:11px;border-radius:3px;flex-shrink:0;}
.st-leg-label{flex:1;}
.st-leg-val{font-weight:700;color:#0d3b5e;}
.st-leg-pct{color:#94a3b8;font-size:11px;min-width:34px;text-align:left;}

.st-bar-row{display:flex;align-items:center;gap:10px;margin-bottom:9px;}
.st-bar-row:last-child{margin-bottom:0;}
.st-bar-label{width:92px;font-size:12.5px;color:#1e293b;flex-shrink:0;text-align:right;}
.st-bar-track{flex:1;height:16px;background:#eef2f6;border-radius:8px;overflow:hidden;}
.st-bar-fill{height:100%;border-radius:8px;background:linear-gradient(90deg,#1a7fc1,#0d3b5e);min-width:2px;transition:width .5s ease;}
.st-bar-val{width:30px;font-size:12.5px;font-weight:700;color:#0d3b5e;text-align:left;flex-shrink:0;}

.st-cols{display:flex;align-items:flex-end;gap:5px;height:168px;padding-top:6px;}
.st-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;}
.st-col-val{font-size:10.5px;font-weight:700;color:#0d3b5e;min-height:13px;}
.st-col-barwrap{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center;}
.st-col-bar{width:62%;min-width:8px;border-radius:5px 5px 0 0;background:linear-gradient(180deg,#1a7fc1,#0d3b5e);transition:height .5s ease;}
.st-col-label{font-size:9.5px;color:#94a3b8;text-align:center;line-height:1.25;}

@media (max-width:640px){
  .st-grid2{grid-template-columns:1fr;}
  .st-tile{min-width:84px;}
}`;
document.head.appendChild(s);

// ── כפתור צף (FAB) ────────────────────────────────────────────────────────────
var mw = document.getElementById('map-wrap');
if (mw) {
  var fab = document.createElement('button');
  fab.id = 'stats-fab';
  fab.title = 'לוח סטטיסטיקה';
  fab.innerHTML = '📊';
  fab.onclick = openStatsModal;
  mw.appendChild(fab);
}

// ── שלד המודאל ────────────────────────────────────────────────────────────────
var bg = document.createElement('div');
bg.className = 'st-bg';
bg.innerHTML =
  '<div class="st-mod">' +
    '<div class="st-head">' +
      '<div class="st-title">📊 לוח סטטיסטיקה — תקלות</div>' +
      '<div class="st-head-acts">' +
        '<button class="st-icon-btn" id="st-refresh" title="רענן">↻</button>' +
        '<button class="st-icon-btn" id="st-close" title="סגור">✕</button>' +
      '</div>' +
    '</div>' +
    '<div class="st-body" id="st-body"><div class="st-loading">טוען נתונים…</div></div>' +
  '</div>';
document.body.appendChild(bg);
bg.onclick = function (e) { if (e.target === bg) closeStatsModal(); };
document.getElementById('st-close').onclick = closeStatsModal;
document.getElementById('st-refresh').onclick = loadStats;
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && bg.classList.contains('open')) closeStatsModal();
});

function openStatsModal() { bg.classList.add('open'); loadStats(); }
function closeStatsModal() { bg.classList.remove('open'); }

// ── טעינת נתונים ──────────────────────────────────────────────────────────────
// שאילתה עצמאית — gIncidents מכיל רק פתוחות/בטיפול, וכאן צריך גם סגורות.
function loadStats() {
  var body = document.getElementById('st-body');
  body.innerHTML = '<div class="st-loading">טוען נתונים…</div>';
  gSb.from('incidents')
    .select('created_at,closed_at,village,priority,status')
    .then(function (res) {
      if (res.error) {
        console.error('stats query failed:', res.error);
        body.innerHTML = '<div class="st-err">שגיאה בטעינת נתונים</div>';
        return;
      }
      renderStats(res.data || []);
    });
}

// ── חישוב אגרגציות + רינדור ───────────────────────────────────────────────────
function renderStats(rows) {
  var body = document.getElementById('st-body');
  if (!rows.length) {
    body.innerHTML = '<div class="st-empty">אין עדיין תקלות במערכת</div>';
    return;
  }

  var byStatus   = { open: 0, in_progress: 0, closed: 0 };
  var byPriority = { high: 0, medium: 0, low: 0 };
  var byVillage  = {};
  var resTimes   = [];

  // 12 החודשים האחרונים (כולל הנוכחי)
  var now = new Date();
  var months = [];
  var mIndex = {};
  for (var i = 11; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var key = d.getFullYear() + '-' + (d.getMonth() + 1);
    mIndex[key] = months.length;
    months.push({ m: d.getMonth(), y: d.getFullYear(), count: 0 });
  }

  rows.forEach(function (r) {
    if (byStatus[r.status] != null) byStatus[r.status]++;
    if (byPriority[r.priority] != null) byPriority[r.priority]++;
    if (r.village) byVillage[r.village] = (byVillage[r.village] || 0) + 1;

    if (r.created_at) {
      var cd = new Date(r.created_at);
      var ck = cd.getFullYear() + '-' + (cd.getMonth() + 1);
      if (mIndex[ck] != null) months[mIndex[ck]].count++;
    }
    if (r.status === 'closed' && r.created_at && r.closed_at) {
      var ms = new Date(r.closed_at) - new Date(r.created_at);
      if (ms > 0) resTimes.push(ms);
    }
  });

  var total = rows.length;
  var avgMs = resTimes.length
    ? resTimes.reduce(function (a, b) { return a + b; }, 0) / resTimes.length
    : 0;

  var villageItems = Object.keys(byVillage)
    .map(function (k) { return { label: k, value: byVillage[k] }; })
    .sort(function (a, b) { return b.value - a.value; });

  var statusSegs = ['open', 'in_progress', 'closed'].map(function (k) {
    return { label: STATUS[k].label, color: STATUS[k].color, value: byStatus[k] };
  });
  var prioritySegs = ['high', 'medium', 'low'].map(function (k) {
    return { label: PRIORITY[k].label, color: PRIORITY[k].color, value: byPriority[k] };
  });

  body.innerHTML =
    '<div class="st-tiles">' +
      tile(total, 'כל התקלות', '#0d3b5e') +
      tile(byStatus.open, 'פתוחות', '#ef4444') +
      tile(byStatus.in_progress, 'בטיפול', '#f59e0b') +
      tile(byStatus.closed, 'סגורות', '#22c55e') +
      tile(fmtDur(avgMs), 'זמן טיפול ממוצע', '#1a7fc1', true) +
    '</div>' +
    '<div class="st-grid2">' +
      card('לפי סטטוס', donut(statusSegs)) +
      card('לפי עדיפות', donut(prioritySegs)) +
    '</div>' +
    card('תקלות לפי ישוב', hbars(villageItems)) +
    card('תקלות חדשות לפי חודש (12 חודשים אחרונים)', vbars(months));
}

// ── בוני רכיבים ───────────────────────────────────────────────────────────────
function card(title, inner) {
  return '<div class="st-card"><div class="st-card-title">' + title + '</div>' + inner + '</div>';
}

function tile(value, label, accent, isText) {
  return '<div class="st-tile" style="--ac:' + accent + '">' +
    '<div class="n' + (isText ? ' txt' : '') + '">' + value + '</div>' +
    '<div class="l">' + label + '</div>' +
  '</div>';
}

// טבעת (donut) — קשתות ב-stroke-dasharray, סיבוב מצטבר מ-12 (לפי השעון).
function donut(segments) {
  var total = segments.reduce(function (a, x) { return a + x.value; }, 0);
  var cx = 70, cy = 70, r = 56, sw = 18;
  var circ = 2 * Math.PI * r;
  var arcs = '';
  var startAngle = -90;
  segments.forEach(function (seg) {
    if (total <= 0 || seg.value <= 0) return;
    var frac = seg.value / total;
    var len = frac * circ;
    arcs += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + seg.color +
      '" stroke-width="' + sw + '" stroke-dasharray="' + len + ' ' + (circ - len) +
      '" transform="rotate(' + startAngle + ' ' + cx + ' ' + cy + ')"></circle>';
    startAngle += frac * 360;
  });
  var track = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#eef2f6" stroke-width="' + sw + '"></circle>';
  var center =
    '<text x="' + cx + '" y="' + (cy - 1) + '" text-anchor="middle" font-size="27" font-weight="700" fill="#0d3b5e">' + total + '</text>' +
    '<text x="' + cx + '" y="' + (cy + 17) + '" text-anchor="middle" font-size="11" fill="#94a3b8">סה״כ</text>';
  var svg = '<svg viewBox="0 0 140 140" class="st-donut">' + track + arcs + center + '</svg>';

  var legend = '<div class="st-legend">' + segments.map(function (seg) {
    var pct = total > 0 ? Math.round(seg.value / total * 100) : 0;
    return '<div class="st-leg-row">' +
      '<span class="st-leg-dot" style="background:' + seg.color + '"></span>' +
      '<span class="st-leg-label">' + seg.label + '</span>' +
      '<span class="st-leg-val">' + seg.value + '</span>' +
      '<span class="st-leg-pct">' + pct + '%</span>' +
    '</div>';
  }).join('') + '</div>';

  return '<div class="st-donut-wrap">' + svg + legend + '</div>';
}

// עמודות אופקיות (לפי ישוב)
function hbars(items) {
  if (!items.length) return '<div class="st-empty">אין נתונים</div>';
  var max = Math.max.apply(null, items.map(function (i) { return i.value; }));
  return items.map(function (i) {
    var pct = max > 0 ? i.value / max * 100 : 0;
    return '<div class="st-bar-row">' +
      '<span class="st-bar-label">' + i.label + '</span>' +
      '<div class="st-bar-track"><div class="st-bar-fill" style="width:' + pct + '%"></div></div>' +
      '<span class="st-bar-val">' + i.value + '</span>' +
    '</div>';
  }).join('');
}

// עמודות אנכיות (לפי חודש)
function vbars(months) {
  var max = Math.max.apply(null, months.map(function (m) { return m.count; }));
  if (max <= 0) return '<div class="st-empty">אין תקלות ב-12 החודשים האחרונים</div>';
  return '<div class="st-cols">' + months.map(function (m) {
    var h = m.count > 0 ? Math.max(m.count / max * 100, 3) : 0;
    return '<div class="st-col" title="' + m.count + ' תקלות">' +
      '<div class="st-col-val">' + (m.count || '') + '</div>' +
      '<div class="st-col-barwrap"><div class="st-col-bar" style="height:' + h + '%"></div></div>' +
      '<div class="st-col-label">' + HEB_MONTHS[m.m] + '<br>\'' + String(m.y).slice(-2) + '</div>' +
    '</div>';
  }).join('') + '</div>';
}

// ── עזרי פורמט ────────────────────────────────────────────────────────────────
function fmtDur(ms) {
  if (!ms || ms <= 0) return '—';
  var h = ms / 3600000;
  if (h < 1) return 'פחות משעה';
  if (h < 48) return Math.round(h) + ' שע׳';
  return (Math.round(h / 24 * 10) / 10) + ' ימים';
}

})();
