var gAllLogs = [];
var gFilteredLogs = [];
var gPage = 0;
var PAGE_SIZE = 50;
var AV_COLORS = ['#0d3b5e','#1a7fc1','#0d9488','#7c3aed','#b45309','#dc2626','#0891b2','#16a34a'];
var ACTION_LABEL = { created:'🆕 נפתח', taken:'📋 נלקח', closed:'✔ נסגר', reopened:'🔄 נפתח מחדש', updated:'✏️ עודכן' };

window.addEventListener('load', async function() {
  var res = await gSb.auth.getSession();
  if (!res.data || !res.data.session) { window.location.replace('login.html'); return; }
  var role = await getUserRole(res.data.session.user.id);
  if (role !== 'admin') { window.location.replace('../index.html'); return; }
  document.body.classList.add('ready');
  MotionUtils.animatePageIn();
  loadLogs();
});

async function loadLogs() {
  var res = await gSb.from('incident_logs').select('*').order('created_at', {ascending:false}).limit(2000);
  if (res.error) { showToast('שגיאה: ' + res.error.message); return; }
  gAllLogs = res.data || [];
  populateUserFilter();
  updateStats();
  applyFilters();
}

function populateUserFilter() {
  var users = {};
  gAllLogs.forEach(function(l) { if (l.user_name) users[l.user_id] = l.user_name; });
  var sel = document.getElementById('f-user');
  sel.innerHTML = '<option value="">הכל</option>' +
    Object.keys(users).map(function(id) { return '<option value="'+id+'">'+users[id]+'</option>'; }).join('');
}

function updateStats() {
  var total  = gAllLogs.length;
  var closed = gAllLogs.filter(function(l){return l.action==='closed';}).length;
  var taken  = gAllLogs.filter(function(l){return l.action==='taken';}).length;
  var closedLogs = gAllLogs.filter(function(l){return l.action==='closed' && l.duration_seconds;});
  var avgSec = closedLogs.length ? Math.floor(closedLogs.reduce(function(s,l){return s+l.duration_seconds;},0) / closedLogs.length) : 0;
  document.getElementById('s-total').textContent  = total;
  document.getElementById('s-closed').textContent = closed;
  document.getElementById('s-taken').textContent  = taken;
  document.getElementById('s-avg').textContent    = avgSec ? formatDuration(avgSec) : '—';
}

function applyFilters() {
  var fAction  = document.getElementById('f-action').value;
  var fVillage = document.getElementById('f-village').value;
  var fUser    = document.getElementById('f-user').value;
  var fSearch  = document.getElementById('f-search').value.trim().toLowerCase();

  gFilteredLogs = gAllLogs.filter(function(l) {
    if (fAction  && l.action !== fAction) return false;
    if (fVillage && l.incident_village !== fVillage) return false;
    if (fUser    && l.user_id !== fUser) return false;
    if (fSearch) {
      var hay = ((l.incident_title||'')+' '+(l.notes||'')+' '+(l.user_name||'')).toLowerCase();
      if (hay.indexOf(fSearch) === -1) return false;
    }
    return true;
  });
  gPage = 0;
  document.getElementById('filtered-count').textContent = gFilteredLogs.length;
  renderLogs();
}

function clearFilters() {
  document.getElementById('f-action').value  = '';
  document.getElementById('f-village').value = '';
  document.getElementById('f-user').value    = '';
  document.getElementById('f-search').value  = '';
  applyFilters();
}

function renderLogs() {
  var el = document.getElementById('logs-container');
  if (!gFilteredLogs.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📭</div>אין רשומות להצגה</div>';
    document.getElementById('pagination').style.display = 'none';
    return;
  }

  var start = gPage * PAGE_SIZE;
  var end   = Math.min(start + PAGE_SIZE, gFilteredLogs.length);
  var page  = gFilteredLogs.slice(start, end);

  el.innerHTML = '<table class="logs"><thead><tr>' +
    '<th>פעולה</th><th>תקלה</th><th>ישוב</th><th>משתמש</th><th>זמן</th><th>משך טיפול</th><th>הערות</th>' +
    '</tr></thead><tbody>' +
    page.map(function(l, i) {
      var col = AV_COLORS[(start+i) % AV_COLORS.length];
      var initials = (l.user_name || '?').split(' ').map(function(w){return w[0]||'';}).join('').substring(0,2).toUpperCase() || '??';
      var dt = new Date(l.created_at);
      var dateStr = dt.toLocaleDateString('he-IL') + ' ' + dt.toLocaleTimeString('he-IL', {hour:'2-digit',minute:'2-digit'});
      return '<tr>' +
        '<td><span class="action-tag action-'+l.action+'">'+(ACTION_LABEL[l.action]||l.action)+'</span></td>' +
        '<td><div style="font-weight:600">'+(l.incident_title||'—')+'</div>'+
            (l.incident_priority ? '<span class="priority-pill priority-'+l.incident_priority+'">'+priorityLabel(l.incident_priority)+'</span>' : '')+
        '</td>' +
        '<td>'+(l.incident_village||'—')+'</td>' +
        '<td><div class="user-cell"><div class="avatar-sm" style="background:'+col+'">'+initials+'</div><div class="user-cell-name">'+(l.user_name||'—')+'</div></div></td>' +
        '<td><div class="time-cell">'+dateStr+'</div><div class="time-rel">'+timeAgo(l.created_at)+'</div></td>' +
        '<td><div class="duration-cell">'+(l.duration_seconds ? formatDuration(l.duration_seconds) : '—')+'</div></td>' +
        '<td><div class="notes-cell">'+(l.notes ? l.notes : '<span class="notes-empty">—</span>')+'</div></td>' +
      '</tr>';
    }).join('') +
    '</tbody></table>';

  MotionUtils.animateTableRows(document.querySelector('#logs-container tbody'));

  // Pagination
  var totalPages = Math.ceil(gFilteredLogs.length / PAGE_SIZE);
  document.getElementById('pagination').style.display = totalPages > 1 ? 'flex' : 'none';
  document.getElementById('page-info').textContent = 'עמוד '+(gPage+1)+' מתוך '+totalPages+' · '+gFilteredLogs.length+' רשומות';
  document.getElementById('prev-btn').disabled = gPage === 0;
  document.getElementById('next-btn').disabled = gPage >= totalPages - 1;
}

function changePage(dir) {
  gPage += dir;
  renderLogs();
  window.scrollTo({top:0, behavior:'smooth'});
}

// ── HELPERS ──
function priorityLabel(p) { return {high:'גבוהה',medium:'בינונית',low:'נמוכה'}[p] || p; }

function timeAgo(iso) {
  if (!iso) return '';
  var d = Math.floor((Date.now()-new Date(iso))/60000);
  if (d < 1) return 'הרגע';
  if (d < 60) return 'לפני '+d+' דקות';
  var h = Math.floor(d/60);
  if (h < 24) return 'לפני '+h+' שעות';
  return 'לפני '+Math.floor(h/24)+' ימים';
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '—';
  var m = Math.floor(seconds/60);
  if (m < 1) return seconds+' שנ׳';
  if (m < 60) return m+' דק׳';
  var h = Math.floor(m/60);
  m = m % 60;
  if (h < 24) return h+'ש׳ '+(m?m+'דק׳':'');
  var d = Math.floor(h/24);
  h = h % 24;
  return d+'י׳ '+(h?h+'ש׳':'');
}

function showToast(msg, type) {
  MotionUtils.showToast(msg, type);
}

