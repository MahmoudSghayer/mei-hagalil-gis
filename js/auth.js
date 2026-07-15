// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Shared Auth & Idle Timeout
//  כלול בכל עמוד לפני שאר הסקריפטים
// ════════════════════════════════════════════════════════════════

var SUPABASE_URL  = 'https://hlbogufrdxpviyxlwqtf.supabase.co';
var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhsYm9ndWZyZHhwdml5eGx3cXRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMjcyMzUsImV4cCI6MjA5MjkwMzIzNX0.8AvY5isXAJfa2mYC2keDBTlw4hv9mVwytH0oWxW3vKA';  // ← החלף ב-anon key מ-Supabase Settings → API

var gSb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// ── Shared HTML escaper — single source of truth ──
// auth.js loads first on every page, so every later script can call the global
// esc()/escHtml() instead of redefining its own. Escapes & < > " AND ' so the
// output is safe in both single- and double-quoted attribute contexts.
function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
window.escHtml = escHtml;
window.esc = escHtml;

function getLoginPath() {
  // index.html lives at repo root, other pages are under /pages/
  // So we need a redirect that works from both locations.
  return window.location.pathname.indexOf('/pages/') >= 0 ? 'login.html' : 'pages/login.html';
}

// Shared page-exclusion test — login/reset pages must never be idle-timed-out
// or session-guard-redirected (that would just loop back to themselves).
function isAuthExcludedPage() {
  return window.location.pathname.indexOf('login') >= 0 ||
      window.location.pathname.indexOf('reset') >= 0;
}

// ── Profile loader (used by all pages) ──
async function getProfile(user, redirectIfMissing) {
  var res = await gSb.from('profiles').select('*').eq('id', user.id).single();
  if (res.error || !res.data) {
    if (redirectIfMissing) {
      console.error('Profile not found:', res.error);
      alert('שגיאה בטעינת פרופיל. אנא התחבר מחדש.');
      await gSb.auth.signOut();
      window.location.replace(getLoginPath());
    }
    return null;
  }
  if (res.data.is_active === false) {
    alert('החשבון שלך הושעה. פנה למנהל המערכת.');
    await gSb.auth.signOut();
    window.location.replace(getLoginPath());
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
  window.location.replace(getLoginPath());
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
  if (isAuthExcludedPage()) return;
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

// ════════════════════════════════════════════════════════════════
//  SESSION GUARD — מזהה "סשן זומבי" (טוקן מת שנשאר בלוקאל־סטורג')
//  ה-getSession() המקומי תמיד "מצליח" גם כשהטוקן כבר לא תקף בשרת,
//  אז כל עמוד עלול להיראות מחובר בזמן שכל שאילתה מוגנת חוזרת ריקה.
//  השומר הזה מאמת מול השרת (getUser) ומנתק+מפנה להתחברות אם הטוקן מת.
//  לא חוסם את טעינת העמוד — רץ ברקע (fire-and-forget).
// ════════════════════════════════════════════════════════════════
var SESSION_FOCUS_THROTTLE_MS = 2 * 60 * 1000;  // בדיקה חוזרת ב-focus: לכל היותר פעם ב-2 דקות
var _sessionRedirectDone = false;               // דגל חד-פעמי — מונע לולאת הפניות
var _lastFocusValidation = 0;

// true רק עבור דחייה אמיתית של השרת (4xx — טוקן לא תקף/פג תוקף).
// לעולם לא עבור תקלת רשת/שרת (fetch נכשל, 5xx, timeout) — כדי שחיבור
// לא יציב לא ינתק משתמש לגיטימי.
function isDeadSessionError(err) {
  var status = err && err.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

// מבצע את ההפניה להתחברות פעם אחת בלבד — מי שתופס ראשון "זוכה" לקבוע
// אם מוצג ההודעה "פג תוקף" (מונע מרוץ מול onAuthStateChange כשאנחנו
// עצמנו קוראים ל-signOut, שגם הוא מפעיל SIGNED_OUT).
function claimSessionRedirect() {
  if (_sessionRedirectDone) return false;
  _sessionRedirectDone = true;
  return true;
}

function goToLoginAfterRedirectClaim(expired) {
  if (isAuthExcludedPage()) return;
  window.location.replace(getLoginPath() + (expired ? '?expired=1' : ''));
}

async function validateSession() {
  if (isAuthExcludedPage() || _sessionRedirectDone) return;

  var sessRes;
  try {
    sessRes = await gSb.auth.getSession();
  } catch (e) {
    return;  // תקלה מקומית/רשת — לא פועלים על בסיסה
  }
  if (!sessRes || sessRes.error || !sessRes.data || !sessRes.data.session) {
    // אין סשן מקומי בכלל — הבדיקה של כל עמוד כבר מטפלת בהפניה, לא כפילות.
    return;
  }

  var userRes;
  try {
    userRes = await gSb.auth.getUser();
  } catch (e) {
    return;  // כשל רשת באמצע הבדיקה — לא מנתקים משתמש בגלל זה
  }

  if (userRes && userRes.error && isDeadSessionError(userRes.error)) {
    if (!claimSessionRedirect()) return;
    try { await gSb.auth.signOut(); } catch (e) { /* הטוקן כבר מת — ממשיכים בכל מקרה */ }
    goToLoginAfterRedirectClaim(true);
  }
}

function onSessionFocusRevalidate() {
  var now = Date.now();
  if (now - _lastFocusValidation < SESSION_FOCUS_THROTTLE_MS) return;
  _lastFocusValidation = now;
  validateSession();
}

function initSessionGuard() {
  if (isAuthExcludedPage()) return;
  validateSession();  // בדיקה מיידית באתחול העמוד (לא חוסמת)
  window.addEventListener('focus', onSessionFocusRevalidate);
  gSb.auth.onAuthStateChange(function (event) {
    // מכסה התנתקות שבוצעה בטאב אחר — מפנה גם כאן להתחברות.
    if (event === 'SIGNED_OUT') {
      if (!claimSessionRedirect()) return;
      goToLoginAfterRedirectClaim(false);
    }
  });
}

// Hook לבדיקות בלבד — חושף את הפנימיות הדרושות ל-test/auth/session-guard.test.js
// (מריצה ידנית של הבדיקה/ה-focus-handler, קריאת/איפוס מצב הדגל וה-throttle).
window.__authTest = {
  validateSession: validateSession,
  handleFocus: onSessionFocusRevalidate,
  isRedirected: function () { return _sessionRedirectDone; },
  reset: function () {
    _sessionRedirectDone = false;
    _lastFocusValidation = 0;
  },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startIdleTracker);
  document.addEventListener('DOMContentLoaded', initSessionGuard);
} else {
  startIdleTracker();
  initSessionGuard();
}
