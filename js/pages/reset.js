window.addEventListener('load', async function() {
  // Supabase handles the hash automatically on load
  var res = await gSb.auth.getSession();
  if (res.data && res.data.session) {
    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('form-section').style.display  = 'block';
  } else {
    // Try exchanging hash for session
    var hash = window.location.hash;
    if (hash && hash.includes('access_token')) {
      setTimeout(async function() {
        var res2 = await gSb.auth.getSession();
        if (res2.data && res2.data.session) {
          document.getElementById('loading-state').style.display = 'none';
          document.getElementById('form-section').style.display  = 'block';
        } else {
          showInvalid();
        }
      }, 800);
    } else {
      showInvalid();
    }
  }
});

function showInvalid() {
  document.getElementById('loading-state').style.display  = 'none';
  document.getElementById('invalid-section').style.display = 'block';
}

function checkStrength(val) {
  var fill = document.getElementById('strength-fill');
  if (!val) { fill.style.width='0'; return; }
  var score=0;
  if(val.length>=8)score++;if(val.length>=12)score++;
  if(/[A-Z]/.test(val))score++;if(/[0-9]/.test(val))score++;if(/[^A-Za-z0-9]/.test(val))score++;
  var map=[{w:'20%',bg:'#dc2626'},{w:'40%',bg:'#f97316'},{w:'60%',bg:'#eab308'},{w:'80%',bg:'#22c55e'},{w:'100%',bg:'#16a34a'}];
  var s=map[Math.min(score-1,4)]||map[0];
  fill.style.width=s.w; fill.style.background=s.bg;
}

async function doReset() {
  var pass    = document.getElementById('new-pass').value;
  var confirm = document.getElementById('confirm-pass').value;
  var btn     = document.getElementById('reset-btn');
  document.getElementById('err-msg').classList.remove('show');
  document.getElementById('ok-msg').classList.remove('show');
  if (pass.length < 8)  { showErr('הסיסמה חייבת להיות לפחות 8 תווים'); return; }
  if (pass !== confirm) { showErr('הסיסמאות אינן תואמות'); return; }
  btn.disabled = true;
  btn.innerHTML = 'מעדכן...<span class="spinner"></span>';
  var res = await gSb.auth.updateUser({ password: pass });
  if (res.error) { btn.disabled=false; btn.innerHTML='עדכן סיסמה'; showErr('שגיאה: '+res.error.message); return; }
  var ok = document.getElementById('ok-msg');
  ok.textContent = '✅ הסיסמה עודכנה! מעביר לדף הכניסה...';
  ok.classList.add('show');
  btn.style.display = 'none';
  await gSb.auth.signOut();
  setTimeout(function() { window.location.replace('login.html'); }, 2500);
}

function showErr(msg) { var el=document.getElementById('err-msg'); el.textContent=msg; el.classList.add('show'); }

