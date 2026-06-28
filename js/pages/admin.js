var gAdminId = null;
var gAdminProfile = null;
var gUsers = [];
var gEditMode = false;
var gPwdTargetUser = null;
var gDelTargetUser = null;
var gSelectedRole = 'viewer';
var gAdminSession = null;
var gAssignments = [];

// esc() centralized in auth.js (window.escHtml)

window.addEventListener('load', async function() {
  var res = await gSb.auth.getSession();
  if (!res.data || !res.data.session) { window.location.replace('login.html'); return; }
  gAdminId = res.data.session.user.id;
  gAdminSession = res.data.session;

  gAdminProfile = await getProfile(res.data.session.user, true);
  if (!gAdminProfile) return;
  if (gAdminProfile.role !== 'admin') { window.location.replace('../index.html'); return; }

  document.body.classList.add('ready');
  MotionUtils.animatePageIn();
  loadUsers();
});

async function loadUsers() {
  var res = await gSb.from('profiles').select('*').order('created_at', {ascending:false});
  if (res.error) { showToast('שגיאה בטעינה: ' + res.error.message, 'error'); return; }
  gUsers = res.data || [];
  renderUsers();
  renderStats();
  loadAssignments();
  MotionUtils.animateTableRows('#users-table-wrap tbody');
}

function renderStats() {
  var total = gUsers.length;
  var active = gUsers.filter(function(u){return u.is_active;}).length;
  var paused = total - active;
  var admins = gUsers.filter(function(u){return u.role==='admin';}).length;
  document.getElementById('s-total').textContent = total;
  document.getElementById('s-active').textContent = active;
  document.getElementById('s-paused').textContent = paused;
  document.getElementById('s-admins').textContent = admins;
}

// ── Viewer → Engineer assignments ────────────────────────────────────────────
async function loadAssignments() {
  var r = await gSb.from('viewer_engineer_assignments').select('viewer_id,engineer_id');
  if (r.error) { var w = document.getElementById('assign-wrap'); if (w) w.innerHTML = '<div class="empty">שגיאה: ' + esc(r.error.message) + '</div>'; return; }
  gAssignments = r.data || [];
  renderAssignments();
}

function renderAssignments() {
  var wrap = document.getElementById('assign-wrap');
  if (!wrap) return;
  var viewers = gUsers.filter(function (u) { return u.role === 'viewer'; });
  // Admins are a superset of engineers, so they can be reviewers too.
  var reviewers = gUsers.filter(function (u) { return u.role === 'engineer' || u.role === 'admin'; });
  if (!viewers.length || !reviewers.length) {
    wrap.innerHTML = '<div class="empty" style="padding:14px">צריך לפחות צופה אחד ומהנדס/מנהל אחד כדי לשייך.</div>';
    return;
  }
  var on = {};
  gAssignments.forEach(function (a) { on[a.viewer_id + '|' + a.engineer_id] = true; });
  wrap.innerHTML = viewers.map(function (v) {
    var chips = reviewers.map(function (e) {
      var isOn = !!on[v.id + '|' + e.id];
      var tag = e.role === 'admin' ? ' (מנהל)' : '';
      return '<button class="assign-chip' + (isOn ? ' on' : '') + '" onclick="toggleAssignment(\'' + v.id + '\',\'' + e.id + '\',' + isOn + ')">' +
        esc(e.full_name || e.email) + tag + (isOn ? ' ✓' : '') + '</button>';
    }).join('');
    return '<div class="assign-row"><div class="assign-viewer">👁 ' + esc(v.full_name || v.email) + '</div><div class="assign-chips">' + chips + '</div></div>';
  }).join('');
}

async function toggleAssignment(viewerId, engId, isOn) {
  var r = isOn
    ? await gSb.from('viewer_engineer_assignments').delete().eq('viewer_id', viewerId).eq('engineer_id', engId)
    : await gSb.from('viewer_engineer_assignments').insert([{ viewer_id: viewerId, engineer_id: engId }]);
  if (r.error) { showToast('שגיאה: ' + r.error.message, 'error'); return; }
  showToast(isOn ? 'השיוך הוסר' : '✅ שויך', 'success');
  loadAssignments();
}
window.toggleAssignment = toggleAssignment;

function renderUsers() {
  var el = document.getElementById('users-table-wrap');
  if (!gUsers.length) {
    el.innerHTML = '<div class="empty">אין משתמשים. צור את הראשון!</div>';
    return;
  }
  var avatarColors = ['#0d3b5e','#1a7fc1','#0d9488','#7c3aed','#b45309','#dc2626','#059669'];
  var rows = gUsers.map(function(u,i) {
    var name = u.full_name || '—';
    var initials = (name === '—' ? (u.email||'?')[0] : name.split(' ').map(function(w){return w[0]||'';}).join('')).substring(0,2).toUpperCase();
    var col = avatarColors[i % avatarColors.length];
    var roleBadge = u.role === 'admin'
      ? '<span class="role-pill role-admin">👑 מנהל</span>'
      : (u.role === 'engineer'
          ? '<span class="role-pill role-engineer">🛠 מהנדס</span>'
          : '<span class="role-pill role-user">👁 צופה</span>');
    var statusHtml = '<span class="status-dot ' + (u.is_active ? 'active' : 'inactive') + '"></span>' + (u.is_active ? 'פעיל' : 'מושהה');
    var isSelf = (u.id === gAdminId);
    var actions = '';
    actions += '<button class="btn-sm btn-edit" onclick="openEditModal(\''+u.id+'\')">✏️ ערוך</button>';
    actions += '<button class="btn-sm btn-pwd" onclick="openPwdReset(\''+u.id+'\')">🔑 איפוס</button>';
    if (!isSelf) {
      actions += '<button class="btn-sm ' + (u.is_active ? 'btn-pause' : 'btn-resume') + '" onclick="togglePause(\''+u.id+'\','+(!u.is_active)+')">' +
        (u.is_active ? '⏸️ השהה' : '▶️ הפעל') + '</button>';
      actions += '<button class="btn-sm btn-delete" onclick="openDelete(\''+u.id+'\')">🗑️ מחק</button>';
    }
    return '<tr>' +
      '<td><div class="user-cell"><div class="avatar" style="background:'+col+'">'+initials+'</div>' +
        '<div><div class="u-name">'+name+(isSelf?' <span style="color:var(--muted);font-size:11px">(אתה)</span>':'')+'</div><div class="u-email">'+(u.email||'')+'</div></div></div></td>' +
      '<td>'+roleBadge+'</td>' +
      '<td>'+(u.department||'—')+'</td>' +
      '<td>'+(u.phone||'—')+'</td>' +
      '<td>'+statusHtml+'</td>' +
      '<td style="white-space:nowrap">'+actions+'</td>' +
    '</tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr>' +
    '<th>משתמש</th><th>תפקיד</th><th>מחלקה</th><th>טלפון</th><th>סטטוס</th><th>פעולות</th>' +
    '</tr></thead><tbody>'+rows+'</tbody></table>';
}

function selectRole(r) {
  if (r !== 'viewer' && r !== 'engineer' && r !== 'admin') r = 'viewer';
  gSelectedRole = r;
  document.getElementById('role-viewer').classList.toggle('selected', r==='viewer');
  document.getElementById('role-engineer').classList.toggle('selected', r==='engineer');
  document.getElementById('role-admin').classList.toggle('selected', r==='admin');
}

function openCreateModal() {
  gEditMode = false;
  document.getElementById('modal-title').textContent = '➕ משתמש חדש';
  document.getElementById('modal-sub').textContent = 'צור חשבון משתמש חדש';
  document.getElementById('create-alert').style.display = 'block';
  document.getElementById('email-group').style.display = '';
  document.getElementById('password-group').style.display = '';
  document.getElementById('edit-user-id').value = '';
  ['f-name','f-email','f-password','f-phone','f-department'].forEach(function(id){document.getElementById(id).value='';});
  selectRole('viewer');
  document.getElementById('user-modal-bg').classList.add('open');
}

function openEditModal(userId) {
  var u = gUsers.find(function(x){return x.id===userId;});
  if (!u) return;
  gEditMode = true;
  document.getElementById('modal-title').textContent = '✏️ עריכת משתמש';
  document.getElementById('modal-sub').textContent = u.email;
  document.getElementById('create-alert').style.display = 'none';
  document.getElementById('email-group').style.display = 'none';
  document.getElementById('password-group').style.display = 'none';
  document.getElementById('edit-user-id').value = u.id;
  document.getElementById('f-name').value = u.full_name || '';
  document.getElementById('f-phone').value = u.phone || '';
  document.getElementById('f-department').value = u.department || '';
  selectRole(u.role || 'viewer');
  document.getElementById('user-modal-bg').classList.add('open');
}

function closeModal() { document.getElementById('user-modal-bg').classList.remove('open'); }

async function saveUser() {
  var name = document.getElementById('f-name').value.trim();
  var phone = document.getElementById('f-phone').value.trim();
  var dept = document.getElementById('f-department').value.trim();
  var role = gSelectedRole;
  var btn = document.getElementById('save-btn');

  if (!name) { showToast('שם מלא חובה', 'error'); return; }

  if (gEditMode) {
    var id = document.getElementById('edit-user-id').value;
    btn.disabled = true; btn.textContent = '⏳ שומר...';
    var res = await gSb.from('profiles').update({
      full_name: name, role: role, phone: phone, department: dept
    }).eq('id', id);
    btn.disabled = false; btn.textContent = '💾 שמור';
    if (res.error) { showToast('שגיאה: ' + res.error.message, 'error'); return; }
    showToast('✅ עודכן', 'success');
    closeModal();
    loadUsers();
  } else {
    var email = document.getElementById('f-email').value.trim();
    var password = document.getElementById('f-password').value;
    if (!email || !password) { showToast('אימייל וסיסמה חובה', 'error'); return; }
    if (password.length < 8) { showToast('סיסמה לפחות 8 תווים', 'error'); return; }

    btn.disabled = true; btn.textContent = '⏳ יוצר...';

    // Server-side, admin-gated creation via the Supabase Admin API. This keeps
    // the admin logged in (no session juggling) and works even when public
    // sign-ups are DISABLED in Supabase. The endpoint re-verifies that the
    // caller is an active admin before creating anyone.
    try {
      var sess = (await gSb.auth.getSession()).data.session;
      if (!sess) { btn.disabled = false; btn.textContent = '💾 שמור'; showToast('פג תוקף ההתחברות, התחבר מחדש', 'error'); return; }

      var resp = await fetch('/api/admin-create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sess.access_token },
        body: JSON.stringify({ email: email, password: password, full_name: name, role: role, phone: phone, department: dept })
      });
      var data = await resp.json().catch(function(){ return {}; });

      btn.disabled = false; btn.textContent = '💾 שמור';
      if (!resp.ok) { showToast('שגיאה: ' + (data.error || ('HTTP ' + resp.status)), 'error'); return; }
      if (data.warning) showToast('⚠️ ' + data.warning, 'error');

      showToast('✅ ' + name + ' נוצר בהצלחה', 'success');
      closeModal();
      loadUsers();
    } catch (e) {
      btn.disabled = false; btn.textContent = '💾 שמור';
      showToast('שגיאה: ' + e.message, 'error');
    }
  }
}

function openPwdReset(userId) {
  var u = gUsers.find(function(x){return x.id===userId;});
  if (!u) return;
  gPwdTargetUser = u;
  document.getElementById('pwd-target').textContent = (u.full_name || u.email);
  document.getElementById('pwd-modal-bg').classList.add('open');
}
function closePwdModal() { document.getElementById('pwd-modal-bg').classList.remove('open'); }

async function sendPasswordReset() {
  if (!gPwdTargetUser) return;
  var res = await gSb.auth.resetPasswordForEmail(gPwdTargetUser.email, {
    redirectTo: window.location.origin + '/pages/reset.html'
  });
  closePwdModal();
  if (res.error) { showToast('שגיאה: ' + res.error.message, 'error'); return; }
  showToast('✅ קישור איפוס נשלח ל-' + gPwdTargetUser.email, 'success');
}

async function togglePause(userId, newActive) {
  var res = await gSb.from('profiles').update({ is_active: newActive }).eq('id', userId);
  if (res.error) { showToast('שגיאה: ' + res.error.message, 'error'); return; }
  showToast(newActive ? '▶️ הופעל' : '⏸️ הושהה', 'success');
  loadUsers();
}

function openDelete(userId) {
  var u = gUsers.find(function(x){return x.id===userId;});
  if (!u) return;
  gDelTargetUser = u;
  document.getElementById('del-target').textContent = (u.full_name || u.email);
  document.getElementById('del-modal-bg').classList.add('open');
}
function closeDelModal() { document.getElementById('del-modal-bg').classList.remove('open'); }

async function confirmDelete() {
  if (!gDelTargetUser) return;
  // Server-side, admin-gated deletion via the Supabase Admin API. This removes
  // the real auth account (auth.users) — the profile, push subscriptions and
  // field-task links are handled by the DB cascade. A direct browser delete
  // could only touch the profiles row, leaving the login account alive.
  try {
    var sess = (await gSb.auth.getSession()).data.session;
    if (!sess) { showToast('פג תוקף ההתחברות, התחבר מחדש', 'error'); return; }
    var resp = await fetch('/api/admin-delete-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sess.access_token },
      body: JSON.stringify({ id: gDelTargetUser.id })
    });
    var data = await resp.json().catch(function(){ return {}; });
    closeDelModal();
    if (!resp.ok) { showToast('שגיאה: ' + (data.error || ('HTTP ' + resp.status)), 'error'); return; }
    showToast('🗑️ המשתמש נמחק לצמיתות', 'success');
    loadUsers();
  } catch (e) {
    closeDelModal();
    showToast('שגיאה: ' + e.message, 'error');
  }
}

function showToast(msg, type) {
  MotionUtils.showToast(msg, type);
}
