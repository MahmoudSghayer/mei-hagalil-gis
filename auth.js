<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>מי הגליל | ניהול משתמשים</title>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
  <script src="auth.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--blue-dark:#0d3b5e;--blue-mid:#1a7fc1;--blue-light:#5ab8e8;--surface:#f8fafc;--border:#e2e8f0;--text:#1e293b;--muted:#64748b;--red:#dc2626;--green:#16a34a;--amber:#d97706}
    body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;background:var(--surface);color:var(--text);visibility:hidden;min-height:100vh}
    body.ready{visibility:visible}
    #topbar{display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:52px;background:var(--blue-dark);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.3)}
    .logo{font-size:15px;font-weight:600}.logo span{color:var(--blue-light)}
    .topbar-right{display:flex;align-items:center;gap:10px}
    .badge-admin{background:rgba(255,255,255,0.15);border-radius:5px;padding:2px 10px;font-size:11px;color:rgba(255,255,255,0.85)}
    .btn-sm{padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;border:1px solid rgba(255,255,255,0.3);color:#fff;background:transparent;text-decoration:none;display:inline-block}
    .btn-sm:hover{background:rgba(255,255,255,0.1)}
    .btn-map{background:var(--blue-mid);border-color:var(--blue-mid)}
    #content{max-width:1100px;margin:0 auto;padding:28px 20px}
    h1{font-size:22px;font-weight:700;color:var(--blue-dark);margin-bottom:4px}
    .page-sub{font-size:13px;color:var(--muted);margin-bottom:24px}

    /* Stats cards */
    .stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px}
    .stat-card{background:#fff;border:1px solid var(--border);border-radius:10px;padding:16px}
    .stat-num{font-size:24px;font-weight:700;color:var(--blue-dark)}
    .stat-label{font-size:12px;color:var(--muted);margin-top:2px}

    /* Card */
    .card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px}
    .card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
    .card-title{font-size:15px;font-weight:600;color:var(--blue-dark)}
    .btn-add{padding:8px 16px;border-radius:7px;border:none;cursor:pointer;background:var(--blue-dark);color:#fff;font-size:13px;font-weight:600;font-family:inherit}
    .btn-add:hover{background:var(--blue-mid)}

    /* Users table */
    .users-table{width:100%;border-collapse:collapse}
    .users-table th{text-align:right;padding:10px 12px;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;border-bottom:2px solid var(--border);background:var(--surface)}
    .users-table td{padding:12px;font-size:13px;border-bottom:1px solid var(--border);vertical-align:middle}
    .users-table tr:hover td{background:#f8fafc}
    .role-badge{display:inline-block;padding:3px 10px;border-radius:5px;font-size:11px;font-weight:600}
    .role-admin{background:#fef3c7;color:#92400e}
    .role-user{background:#eff6ff;color:#1e40af}
    .user-info{display:flex;align-items:center;gap:10px}
    .avatar{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0}
    .u-name{font-weight:600}.u-email{font-size:11px;color:var(--muted);direction:ltr;text-align:right}
    .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-left:5px}
    .dot-on{background:#22c55e}.dot-off{background:#94a3b8}
    .actions-cell{white-space:nowrap}
    .actions-cell .btn{margin-left:4px}
    .btn{padding:5px 12px;border-radius:6px;border:none;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit}
    .btn-edit{background:#eff6ff;color:var(--blue-mid);border:1px solid #bfdbfe}.btn-edit:hover{background:#dbeafe}
    .btn-pass{background:#fef3c7;color:var(--amber);border:1px solid #fde68a}.btn-pass:hover{background:#fde68a}
    .btn-toggle{background:#fee2e2;color:var(--red);border:1px solid #fca5a5}.btn-toggle:hover{background:#fecaca}
    .btn-toggle.activate{background:#dcfce7;color:var(--green);border-color:#86efac}.btn-toggle.activate:hover{background:#bbf7d0}

    /* Modal */
    #modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1000;align-items:center;justify-content:center}
    #modal-bg.open{display:flex}
    .modal{background:#fff;border-radius:12px;padding:28px;width:480px;max-width:95vw;direction:rtl;box-shadow:0 8px 32px rgba(0,0,0,0.2);max-height:90vh;overflow-y:auto}
    .modal-title{font-size:17px;font-weight:700;color:var(--blue-dark);margin-bottom:6px}
    .modal-sub{font-size:12px;color:var(--muted);margin-bottom:20px}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .form-group{margin-bottom:14px}
    .form-group.full{grid-column:span 2}
    label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:5px}
    input,select{width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;color:var(--text);font-family:inherit;background:#fff;transition:border-color 0.15s}
    input:focus,select:focus{outline:none;border-color:var(--blue-mid)}
    input[type="email"]{direction:ltr;text-align:left}
    .role-options{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}
    .role-opt{padding:14px;border:2px solid var(--border);border-radius:10px;cursor:pointer;text-align:center;transition:all 0.15s}
    .role-opt:hover{border-color:var(--blue-mid)}
    .role-opt.selected{border-color:var(--blue-mid);background:#eff6ff}
    .role-opt-icon{font-size:22px;margin-bottom:4px}
    .role-opt-title{font-size:13px;font-weight:700;color:var(--text);margin-bottom:2px}
    .role-opt-desc{font-size:11px;color:var(--muted);line-height:1.3}
    .modal-btns{display:flex;gap:10px;margin-top:18px}
    .btn-primary{flex:1;padding:10px;border-radius:7px;border:none;cursor:pointer;background:var(--blue-dark);color:#fff;font-size:14px;font-weight:600;font-family:inherit}
    .btn-primary:hover{background:var(--blue-mid)}
    .btn-secondary{padding:10px 20px;border-radius:7px;cursor:pointer;background:transparent;color:var(--muted);font-size:13px;border:1px solid var(--border);font-family:inherit}

    #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--blue-dark);color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;z-index:2000;transition:transform 0.3s;white-space:nowrap}
    #toast.show{transform:translateX(-50%) translateY(0)}
    #toast.error{background:var(--red)}
    .empty-state{text-align:center;padding:50px 20px;color:var(--muted)}
    .empty-state .icon{font-size:36px;margin-bottom:8px}

    .help-text{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;font-size:12px;color:#1e40af;margin-bottom:16px;line-height:1.5}
    .help-text strong{color:#1e3a8a}
  </style>
</head>
<body>
<div id="topbar">
  <div class="logo">💧 מי <span>הגליל</span> | ניהול מערכת</div>
  <div class="topbar-right">
    <span class="badge-admin">👑 מנהל מערכת</span>
    <a href="index.html" class="btn-sm btn-map">🗺️ למפה</a>
    <button class="btn-sm" onclick="logout()">התנתק</button>
  </div>
</div>

<div id="content">
  <h1>👥 ניהול משתמשים</h1>
  <p class="page-sub">צור חשבונות חדשים, ערוך פרטים ושנה הרשאות</p>

  <!-- Stats -->
  <div class="stats-row">
    <div class="stat-card"><div class="stat-num" id="s-total">—</div><div class="stat-label">סה"כ משתמשים</div></div>
    <div class="stat-card"><div class="stat-num" id="s-admins">—</div><div class="stat-label">מנהלים</div></div>
    <div class="stat-card"><div class="stat-num" id="s-active">—</div><div class="stat-label">חשבונות פעילים</div></div>
  </div>

  <!-- Users table -->
  <div class="card">
    <div class="card-header">
      <div class="card-title">📋 כל המשתמשים</div>
      <button class="btn-add" onclick="openCreate()">➕ הוסף משתמש</button>
    </div>
    <div id="users-list"><div class="empty-state"><div class="icon">⏳</div>טוען...</div></div>
  </div>

  <div class="help-text">
    💡 <strong>הסבר על תפקידים:</strong><br>
    <strong>👤 משתמש</strong> — צופה במפה, מפעיל/מכבה שכבות, פותח תקלות חדשות<br>
    <strong>👑 מנהל</strong> — כל מה שמשתמש יכול + יצירה/עריכה/השעיה של חשבונות
  </div>
</div>

<!-- Create/Edit Modal -->
<div id="modal-bg" onclick="if(event.target.id==='modal-bg')closeModal()">
  <div class="modal">
    <div class="modal-title" id="modal-title">➕ יצירת משתמש חדש</div>
    <div class="modal-sub" id="modal-sub">הכנס פרטים ובחר תפקיד</div>

    <input type="hidden" id="edit-id"/>
    <div class="form-grid">
      <div class="form-group full">
        <label>שם מלא *</label>
        <input type="text" id="m-name" placeholder="ישראל ישראלי"/>
      </div>
      <div class="form-group full">
        <label>כתובת אימייל *</label>
        <input type="email" id="m-email" placeholder="user@example.com"/>
      </div>
      <div class="form-group full" id="pass-group">
        <label>סיסמה ראשונית *</label>
        <input type="text" id="m-pass" placeholder="לפחות 8 תווים"/>
      </div>
      <div class="form-group">
        <label>טלפון</label>
        <input type="tel" id="m-phone" placeholder="050-0000000"/>
      </div>
      <div class="form-group">
        <label>מחלקה</label>
        <input type="text" id="m-dept" placeholder="תשתיות"/>
      </div>
      <div class="form-group full">
        <label>תפקיד *</label>
        <div class="role-options">
          <div class="role-opt selected" id="role-user" onclick="selectRole('user')">
            <div class="role-opt-icon">👤</div>
            <div class="role-opt-title">משתמש</div>
            <div class="role-opt-desc">צפייה במפה ופתיחת תקלות</div>
          </div>
          <div class="role-opt" id="role-admin" onclick="selectRole('admin')">
            <div class="role-opt-icon">👑</div>
            <div class="role-opt-title">מנהל</div>
            <div class="role-opt-desc">כולל ניהול משתמשים</div>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-btns">
      <button class="btn-primary" id="m-save" onclick="saveUser()">✅ צור משתמש</button>
      <button class="btn-secondary" onclick="closeModal()">ביטול</button>
    </div>
  </div>
</div>

<!-- Change password modal -->
<div id="pass-modal-bg" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1000;align-items:center;justify-content:center" onclick="if(event.target.id==='pass-modal-bg')closePassModal()">
  <div class="modal" style="width:380px">
    <div class="modal-title">🔑 איפוס סיסמה</div>
    <div class="modal-sub" id="pass-user-name">—</div>
    <div class="form-group">
      <label>סיסמה חדשה</label>
      <input type="text" id="pass-new" placeholder="לפחות 8 תווים"/>
    </div>
    <div class="help-text" style="margin:0 0 16px;font-size:11px">
      💡 העתק את הסיסמה ושלח למשתמש בצורה מאובטחת. הוא יוכל לשנות אותה אחרי הכניסה הראשונה.
    </div>
    <div class="modal-btns">
      <button class="btn-primary" onclick="resetUserPassword()">עדכן סיסמה</button>
      <button class="btn-secondary" onclick="closePassModal()">ביטול</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
var gUsers=[], gAdminId=null, gEditingId=null, gSelectedRole='user', gPassUserId=null;
var AV_COLORS=['#0d3b5e','#1a7fc1','#0d9488','#7c3aed','#b45309','#dc2626','#0891b2','#16a34a'];

// ── INIT ──
window.addEventListener('load', async function() {
  var res = await gSb.auth.getSession();
  if (!res.data || !res.data.session) { window.location.replace('login.html'); return; }
  var role = await getUserRole(res.data.session.user.id);
  if (role !== 'admin') { window.location.replace('index.html'); return; }
  gAdminId = res.data.session.user.id;
  document.body.classList.add('ready');
  loadUsers();
});

async function loadUsers() {
  var res = await gSb.from('profiles').select('*').order('created_at',{ascending:false});
  if (res.error) { showToast('שגיאה: '+res.error.message,true); return; }
  gUsers = res.data || [];
  renderTable();
  updateStats();
}

function updateStats() {
  document.getElementById('s-total').textContent  = gUsers.length;
  document.getElementById('s-admins').textContent = gUsers.filter(function(u){return u.role==='admin';}).length;
  document.getElementById('s-active').textContent = gUsers.filter(function(u){return u.is_active;}).length;
}

function renderTable() {
  var el = document.getElementById('users-list');
  if (!gUsers.length) { el.innerHTML='<div class="empty-state"><div class="icon">👥</div>אין משתמשים עדיין</div>'; return; }
  el.innerHTML='<table class="users-table"><thead><tr><th>משתמש</th><th>תפקיד</th><th>טלפון</th><th>מחלקה</th><th>סטטוס</th><th>פעולות</th></tr></thead><tbody>'+
    gUsers.map(function(u,i){
      var initials=((u.full_name||u.email||'?').split(' ').map(function(w){return w[0]||'';}).join('').substring(0,2)||'??').toUpperCase();
      var col=AV_COLORS[i%AV_COLORS.length];
      var roleClass=u.role==='admin'?'role-admin':'role-user';
      var roleLabel=u.role==='admin'?'👑 מנהל':'👤 משתמש';
      var isMe = u.id === gAdminId;
      return '<tr><td><div class="user-info"><div class="avatar" style="background:'+col+'">'+initials+'</div>'+
        '<div><div class="u-name">'+(u.full_name||'—')+(isMe?' <span style="font-size:10px;color:var(--blue-mid);font-weight:600">(אני)</span>':'')+'</div><div class="u-email">'+(u.email||'')+'</div></div></div></td>'+
        '<td><span class="role-badge '+roleClass+'">'+roleLabel+'</span></td>'+
        '<td>'+(u.phone||'—')+'</td>'+
        '<td>'+(u.department||'—')+'</td>'+
        '<td><span class="dot '+(u.is_active?'dot-on':'dot-off')+'"></span>'+(u.is_active?'פעיל':'מושהה')+'</td>'+
        '<td class="actions-cell">'+
          '<button class="btn btn-edit" onclick="openEdit(\''+u.id+'\')">✏️ ערוך</button>'+
          (isMe?'':'<button class="btn btn-pass" onclick="openPassModal(\''+u.id+'\')">🔑 סיסמה</button>'+
          '<button class="btn btn-toggle '+(u.is_active?'':'activate')+'" onclick="toggleActive(\''+u.id+'\','+(u.is_active?'false':'true')+')">'+(u.is_active?'🔒 השהה':'✅ הפעל')+'</button>')+
        '</td></tr>';
    }).join('')+'</tbody></table>';
}

// ── CREATE / EDIT MODAL ──
function openCreate() {
  gEditingId = null;
  document.getElementById('modal-title').textContent = '➕ יצירת משתמש חדש';
  document.getElementById('modal-sub').textContent = 'הכנס פרטים ובחר תפקיד';
  document.getElementById('m-save').textContent = '✅ צור משתמש';
  document.getElementById('pass-group').style.display='block';
  document.getElementById('m-email').disabled = false;
  ['m-name','m-email','m-pass','m-phone','m-dept'].forEach(function(id){document.getElementById(id).value='';});
  selectRole('user');
  document.getElementById('modal-bg').classList.add('open');
}

function openEdit(userId) {
  var u = gUsers.find(function(x){return x.id===userId;}); if(!u)return;
  gEditingId = userId;
  document.getElementById('modal-title').textContent = '✏️ עריכת משתמש';
  document.getElementById('modal-sub').textContent = u.email;
  document.getElementById('m-save').textContent = '💾 שמור שינויים';
  document.getElementById('pass-group').style.display='none';
  document.getElementById('m-name').value  = u.full_name||'';
  document.getElementById('m-email').value = u.email||'';
  document.getElementById('m-email').disabled = true;
  document.getElementById('m-phone').value = u.phone||'';
  document.getElementById('m-dept').value  = u.department||'';
  selectRole(u.role||'user');
  document.getElementById('modal-bg').classList.add('open');
}

function selectRole(role) {
  gSelectedRole = role;
  document.getElementById('role-user').classList.toggle('selected', role==='user');
  document.getElementById('role-admin').classList.toggle('selected', role==='admin');
}

function closeModal() { document.getElementById('modal-bg').classList.remove('open'); }

async function saveUser() {
  var name  = document.getElementById('m-name').value.trim();
  var email = document.getElementById('m-email').value.trim();
  var phone = document.getElementById('m-phone').value.trim();
  var dept  = document.getElementById('m-dept').value.trim();

  if (!name) { showToast('שם הוא שדה חובה',true); return; }
  if (!email) { showToast('אימייל הוא שדה חובה',true); return; }

  if (gEditingId) {
    // Update existing user
    var res = await gSb.from('profiles').update({
      full_name: name, role: gSelectedRole, phone: phone, department: dept
    }).eq('id', gEditingId);
    if (res.error) { showToast('שגיאה: '+res.error.message,true); return; }
    showToast('✅ הפרטים עודכנו');
  } else {
    // Create new user
    var pass = document.getElementById('m-pass').value.trim();
    if (pass.length < 8) { showToast('סיסמה חייבת להיות לפחות 8 תווים',true); return; }

    var authRes = await gSb.auth.signUp({
      email: email, password: pass,
      options: { data: { full_name: name } }
    });
    if (authRes.error) { showToast('שגיאה: '+authRes.error.message,true); return; }

    var uid = authRes.data.user.id;
    await gSb.from('profiles').upsert({
      id: uid, email: email, full_name: name, role: gSelectedRole,
      phone: phone, department: dept, is_active: true,
      permissions: {}, created_by: gAdminId
    });
    showToast('✅ '+name+' נוצר בהצלחה');
  }

  closeModal();
  loadUsers();
}

// ── PASSWORD RESET (admin) ──
function openPassModal(userId) {
  var u = gUsers.find(function(x){return x.id===userId;}); if(!u)return;
  gPassUserId = userId;
  document.getElementById('pass-user-name').textContent = u.full_name+' ('+u.email+')';
  document.getElementById('pass-new').value = '';
  document.getElementById('pass-modal-bg').style.display='flex';
}
function closePassModal() { document.getElementById('pass-modal-bg').style.display='none'; }

async function resetUserPassword() {
  var newPass = document.getElementById('pass-new').value.trim();
  if (newPass.length < 8) { showToast('סיסמה חייבת להיות לפחות 8 תווים',true); return; }
  // Note: This requires service_role key for admin password reset
  // For now we show instructions — in production use a Supabase Edge Function
  var u = gUsers.find(function(x){return x.id===gPassUserId;});
  showToast('⚠️ לאיפוס סיסמה הרץ ב-SQL Editor ב-Supabase');
  // Show SQL command in alert
  prompt('העתק והרץ ב-Supabase SQL Editor:',
    "UPDATE auth.users SET encrypted_password = crypt('"+newPass+"', gen_salt('bf')) WHERE email = '"+u.email+"';"
  );
  closePassModal();
}

// ── TOGGLE ACTIVE ──
async function toggleActive(userId, val) {
  var res = await gSb.from('profiles').update({is_active:val}).eq('id',userId);
  if (res.error) { showToast('שגיאה: '+res.error.message,true); return; }
  showToast(val?'✅ משתמש הופעל':'🔒 משתמש הושהה');
  loadUsers();
}

function showToast(msg, isError) {
  var t=document.getElementById('toast');
  t.textContent=msg;
  t.classList.remove('error');
  if (isError) t.classList.add('error');
  t.classList.add('show');
  setTimeout(function(){t.classList.remove('show');},3000);
}
</script>
</body>
</html>
