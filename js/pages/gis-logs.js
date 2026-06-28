// ════════════════════════════════════════════════════════════════
//  מי הגליל GIS — יומן עריכות (admin) · קורא public.gis_audit
//  RLS: קריאה למנהלי מערכת בלבד. נטען בעמודים מ-50 רשומות.
// ════════════════════════════════════════════════════════════════

var PAGE = 100;
var gRows = [];      // all loaded rows
var gOffset = 0;

var ACT = {
  feature_insert: { label: 'הוספת שורה', cls: 'ins' },
  feature_update: { label: 'עריכת ערך', cls: 'upd' },
  feature_delete: { label: 'מחיקת שורה', cls: 'del' },
  field_add:      { label: 'הוספת עמודה', cls: 'col' },
  field_rename:   { label: 'שינוי שם עמודה', cls: 'col' },
  field_delete:   { label: 'מחיקת עמודה', cls: 'del' }
};

window.addEventListener('load', async function () {
  var res = await gSb.auth.getSession();
  if (!res.data || !res.data.session) { window.location.replace('login.html'); return; }
  var role = await getUserRole(res.data.session.user.id);
  if (role !== 'admin') { window.location.replace('../index.html'); return; }
  document.body.classList.add('ready');
  loadLogs(true);
});

async function loadLogs(reset) {
  if (reset) { gRows = []; gOffset = 0; }
  var action = document.getElementById('gl-filter').value;
  var q = gSb.from('gis_audit').select('*').order('created_at', { ascending: false }).range(gOffset, gOffset + PAGE - 1);
  if (action) q = q.eq('action', action);
  var res = await q;
  if (res.error) { document.getElementById('gl-table').innerHTML = '<tbody><tr><td class="gl-empty" style="color:#dc2626">' + esc(res.error.message) + '</td></tr></tbody>'; return; }
  gRows = gRows.concat(res.data || []);
  gOffset += (res.data || []).length;
  document.getElementById('gl-more').style.display = (res.data && res.data.length === PAGE) ? 'block' : 'none';
  renderRows();
}

function renderRows() {
  var s = (document.getElementById('gl-search').value || '').toLowerCase();
  var rows = gRows.filter(function (r) {
    if (!s) return true;
    return [r.layer_name, r.asset_code, r.user_email].some(function (x) { return String(x || '').toLowerCase().indexOf(s) >= 0; });
  });
  document.getElementById('gl-count').textContent = rows.length + ' רשומות';
  var tbl = document.getElementById('gl-table');
  if (!rows.length) { tbl.innerHTML = '<tbody><tr><td class="gl-empty">אין רשומות</td></tr></tbody>'; return; }

  var head = '<thead><tr><th>מתי</th><th>משתמש</th><th>פעולה</th><th>שכבה</th><th>פיצ\'ר</th><th>פרטים</th></tr></thead>';
  var body = rows.map(function (r) {
    var a = ACT[r.action] || { label: r.action, cls: '' };
    return '<tr>' +
      '<td>' + esc(fmt(r.created_at)) + '</td>' +
      '<td class="gl-user">' + esc(r.user_email || '—') + '</td>' +
      '<td><span class="gl-act ' + a.cls + '">' + esc(a.label) + '</span></td>' +
      '<td>' + esc(r.layer_name || '—') + '</td>' +
      '<td>' + esc(r.asset_code || '—') + '</td>' +
      '<td class="gl-det">' + details(r) + '</td>' +
    '</tr>';
  }).join('');
  tbl.innerHTML = head + '<tbody>' + body + '</tbody>';
}

function details(r) {
  var d = r.details || {};
  if (r.action === 'feature_update') {
    return Object.keys(d).map(function (k) {
      return '<div><b>' + esc(k) + ':</b> <span class="gl-old">' + esc(val(d[k] && d[k].old)) + '</span> → <span class="gl-new">' + esc(val(d[k] && d[k].new)) + '</span></div>';
    }).join('') || '—';
  }
  if (r.action === 'field_add') return 'עמודה <b>' + esc(d.field) + '</b> (' + esc(d.type || 'text') + ')';
  if (r.action === 'field_rename') return '<span class="gl-old">' + esc(d.from) + '</span> → <span class="gl-new">' + esc(d.to) + '</span>';
  if (r.action === 'field_delete') return 'עמודה <b>' + esc(d.field) + '</b>';
  if (r.action === 'feature_insert' || r.action === 'feature_delete') {
    var keys = Object.keys(d).filter(function (k) { return k.indexOf('_') !== 0; }).slice(0, 6);
    return keys.map(function (k) { return '<b>' + esc(k) + ':</b> ' + esc(val(d[k])); }).join(' · ') || '—';
  }
  return '—';
}

function val(v) { if (v === null || v === undefined) return '∅'; if (typeof v === 'object') return JSON.stringify(v); return String(v); }
function fmt(s) { try { var dt = new Date(s); return dt.toLocaleDateString('he-IL') + ' ' + dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return s; } }
// esc() centralized in auth.js (window.escHtml)
