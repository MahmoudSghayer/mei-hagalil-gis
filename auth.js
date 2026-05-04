// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Shared Auth & Idle Timeout
//  כלול בכל עמוד לפני שאר הסקריפטים
// ════════════════════════════════════════════════════════════════

var SUPABASE_URL  = 'https://hlbogufrdxpviyxlwqtf.supabase.co';
var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhsYm9ndWZyZHhwdml5eGx3cXRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMjcyMzUsImV4cCI6MjA5MjkwMzIzNX0.8AvY5isXAJfa2mYC2keDBTlw4hv9mVwytH0oWxW3vKA';  // ← החלף ב-anon key מ-Supabase Settings → API

var gSb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ── Profile loader (used by all pages) ──
async function getProfile(user, redirectIfMissing) {
  var res = await gSb.from('profiles').select('*').eq('id', user.id).single();
  if (res.error || !res.data) {
    if (redirectIfMissing) {
      console.error('Profile not found:', res.error);
      alert('שגיאה בטעינת פרופיל. אנא התחבר מחדש.');
      await gSb.auth.signOut();
      window.location.replace('login.html');
    }
    return null;
  }
  if (res.data.is_active === false) {
    alert('החשבון שלך הושעה. פנה למנהל המערכת.');
    await gSb.auth.signOut();
    window.location.replace('login.html');
    return null;
  }
  return res.data;
}

async function getUserRole(userId) {
  var res = await gSb.from('profiles').select('role').eq('id', userId).single();
  return res.data ? res.data.role : null;
}

async function logout() {
  await gSb.auth.signOut();
  window.location.replace('login.html');
}

// ════════════════════════════════════════════════════════════════
//  IDLE TIMEOUT — התנתקות אוטומטית לאחר חוסר פעילות
// ════════════════════════════════════════════════════════════════
var IDLE_TIMEOUT_MS = 25 * 60 * 1000;  // 25 דקות
var IDLE_WARNING_MS = 60 * 1000;       // 60 שניות אזהרה

var _idleTimer = null;
var _warningTimer = null;
var _countdownInterval = null;

function startIdleTracker() {
  if (window.location.pathname.indexOf('login') >= 0 ||
      window.location.pathname.indexOf('reset') >= 0) return;
  ['mousemove','keydown','click','scroll','touchstart'].forEach(function(ev) {
    document.addEventListener(ev, resetIdleTimer, { passive: true });
  });
  resetIdleTimer();
}

function resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  if (_warningTimer) clearTimeout(_warningTimer);
  if (_countdownInterval) clearInterval(_countdownInterval);
  hideIdleModal();
  _idleTimer = setTimeout(showIdleWarning, IDLE_TIMEOUT_MS);
}

function showIdleWarning() {
  if (!document.getElementById('idle-modal')) injectIdleModal();
  document.getElementById('idle-modal').style.display = 'flex';
  var seconds = Math.floor(IDLE_WARNING_MS / 1000);
  document.getElementById('idle-countdown').textContent = seconds;
  _countdownInterval = setInterval(function() {
    seconds--;
    document.getElementById('idle-countdown').textContent = seconds;
    if (seconds <= 0) clearInterval(_countdownInterval);
  }, 1000);
  _warningTimer = setTimeout(function() { logout(); }, IDLE_WARNING_MS);
}

function hideIdleModal() {
  var m = document.getElementById('idle-modal');
  if (m) m.style.display = 'none';
}

function continueSession() { resetIdleTimer(); }
window.continueSession = continueSession;

function injectIdleModal() {
  var html = '' +
    '<div id="idle-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;align-items:center;justify-content:center;direction:rtl;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif">' +
      '<div style="background:#fff;border-radius:14px;padding:30px;width:380px;max-width:92vw;box-shadow:0 12px 40px rgba(0,0,0,0.3);text-align:center">' +
        '<div style="font-size:42px;margin-bottom:10px">⏰</div>' +
        '<div style="font-size:18px;font-weight:700;color:#0d3b5e;margin-bottom:8px">עדיין כאן?</div>' +
        '<div style="font-size:13px;color:#64748b;line-height:1.5;margin-bottom:18px">' +
          'לא זוהתה פעילות בדקות האחרונות.<br>' +
          'תתנתק אוטומטית בעוד <span id="idle-countdown" style="font-weight:700;color:#dc2626">60</span> שניות.' +
        '</div>' +
        '<div style="display:flex;gap:10px">' +
          '<button onclick="continueSession()" style="flex:1;padding:11px;border-radius:8px;border:none;background:#0d3b5e;color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">✓ אני כאן, המשך</button>' +
          '<button onclick="logout()" style="padding:11px 18px;border-radius:8px;background:transparent;border:1px solid #e2e8f0;color:#64748b;font-size:13px;cursor:pointer;font-family:inherit">התנתק</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  var div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div.firstChild);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startIdleTracker);
} else {
  startIdleTracker();
}
