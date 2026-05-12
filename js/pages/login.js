// Check if already logged in — only once, no loop
window.addEventListener('load', async function() {
  var res = await gSb.auth.getSession();
  if (res.data && res.data.session) {
    var role = await getUserRole(res.data.session.user.id);
    window.location.replace(role === 'admin' ? 'admin.html' : '../index.html');
  }
});

async function doLogin() {
  var email = document.getElementById('email').value.trim();
  var pass  = document.getElementById('password').value;
  var btn   = document.getElementById('login-btn');
  var err   = document.getElementById('err');
  err.classList.remove('show');

  if (!email || !pass) { err.textContent='אנא מלא אימייל וסיסמה'; err.classList.add('show'); return; }

  btn.disabled = true;
  btn.innerHTML = 'מתחבר...<span class="spinner"></span>';

  var res = await gSb.auth.signInWithPassword({ email: email, password: pass });

  if (res.error) {
    btn.disabled = false;
    btn.innerHTML = 'כניסה למערכת';
    err.textContent = 'אימייל או סיסמה שגויים';
    err.classList.add('show');
    return;
  }

  // Check if active
  var profile = await getProfile(res.data.user, false);
  if (profile && profile.is_active === false) {
    await gSb.auth.signOut();
    btn.disabled = false;
    btn.innerHTML = 'כניסה למערכת';
    err.textContent = 'החשבון שלך מושהה. פנה למנהל המערכת.';
    err.classList.add('show');
    return;
  }

  var role = profile ? profile.role : 'user';
  window.location.replace(role === 'admin' ? 'admin.html' : '../index.html');
}

function togglePass() {
  var inp = document.getElementById('password'), btn = document.getElementById('eye-btn');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}

function openFP(e) {
  e.preventDefault();
  document.getElementById('fp-email').value = document.getElementById('email').value;
  document.getElementById('fp-overlay').classList.add('open');
}
function closeFP() {
  document.getElementById('fp-overlay').classList.remove('open');
  document.getElementById('fp-ok').classList.remove('show');
}

async function sendReset() {
  var email = document.getElementById('fp-email').value.trim();
  if (!email) return;
  await gSb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/pages/reset.html'
  });
  document.getElementById('fp-ok').classList.add('show');
  setTimeout(closeFP, 3000);
}

