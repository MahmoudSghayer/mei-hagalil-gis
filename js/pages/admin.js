var gAdminId = null;
var gAdminProfile = null;
var gUsers = [];
var gEditMode = false;
var gPwdTargetUser = null;
var gDelTargetUser = null;
var gSelectedRole = 'user';
var gAdminSession = null;

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
      : '<span class="role-pill role-user">👤 משתמש</span>';
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
  gSelectedRole = r;
  document.getElementById('role-user').classList.toggle('selected', r==='user');
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
  selectRole('user');
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
  selectRole(u.role || 'user');
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

    var savedAdminSession = (await gSb.auth.getSession()).data.session;

    var signRes = await gSb.auth.signUp({
      email: email,
      password: password,
      options: {
        data: {
          full_name: name,
          role: role,
          phone: phone,
          department: dept
        }
      }
    });

    if (signRes.error) {
      btn.disabled = false; btn.textContent = '💾 שמור';
      showToast('שגיאה: ' + signRes.error.message, 'error');
      if (savedAdminSession) await gSb.auth.setSession({access_token:savedAdminSession.access_token, refresh_token:savedAdminSession.refresh_token});
      return;
    }

    if (savedAdminSession) {
      await gSb.auth.setSession({
        access_token: savedAdminSession.access_token,
        refresh_token: savedAdminSession.refresh_token
      });
    }

    if (signRes.data.user) {
      await gSb.from('profiles').update({
        full_name: name, role: role, phone: phone, department: dept, is_active: true
      }).eq('id', signRes.data.user.id);
    }

    btn.disabled = false; btn.textContent = '💾 שמור';
    showToast('✅ ' + name + ' נוצר בהצלחה', 'success');
    closeModal();
    loadUsers();
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
  var res = await gSb.from('profiles').delete().eq('id', gDelTargetUser.id);
  closeDelModal();
  if (res.error) { showToast('שגיאה: ' + res.error.message, 'error'); return; }
  showToast('🗑️ הפרופיל נמחק. למחיקה מלאה — Supabase Dashboard → Auth → Users', 'success');
  loadUsers();
}

function showToast(msg, type) {
  MotionUtils.showToast(msg, type);
}
