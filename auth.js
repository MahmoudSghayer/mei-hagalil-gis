// ════════════════════════════════════════
//  auth.js — קובץ משותף לכל הדפים
//  מונע לולאות הפניה
// ════════════════════════════════════════

var SUPABASE_URL  = 'https://hlbogufrdxpviyxlwqtf.supabase.co';
var SUPABASE_ANON = 'YOUR_PUBLISHABLE_KEY'; // ← הכנס את ה-anon key שלך

var gSb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// דף נוכחי
var CURRENT_PAGE = window.location.pathname.split('/').pop() || 'index.html';

// בדיקת auth — קרא לזה בכל דף
async function authGuard(requiredRole) {
  var res = await gSb.auth.getSession();
  var session = res.data && res.data.session;

  // דף login — אם מחובר תפנה החוצה
  if (CURRENT_PAGE === 'login.html' || CURRENT_PAGE === 'reset.html') {
    if (session && CURRENT_PAGE === 'login.html') {
      var role = await getUserRole(session.user.id);
      window.location.replace(role === 'admin' ? 'admin.html' : 'index.html');
    }
    return null;
  }

  // כל שאר הדפים — חייב להיות מחובר
  if (!session) {
    window.location.replace('login.html');
    return null;
  }

  // טען פרופיל
  var profile = await getProfile(session.user, true);
  if (!profile) {
    window.location.replace('login.html');
    return null;
  }

  // בדוק הרשאה נדרשת
  if (requiredRole === 'admin' && profile.role !== 'admin') {
    window.location.replace('index.html');
    return null;
  }

  return { user: session.user, profile: profile };
}

async function getProfile(user, signOutIfInactive) {
  try {
    var res = await gSb.from('profiles').select('*').eq('id', user.id).single();
    if (res.data) {
      if (signOutIfInactive && res.data.is_active === false) {
        await gSb.auth.signOut();
        window.location.replace('login.html');
        return null;
      }
      return res.data;
    }
  } catch(e) {}

  // fallback profile if DB fetch fails
  return {
    id: user.id,
    email: user.email,
    full_name: (user.user_metadata && user.user_metadata.full_name) || user.email.split('@')[0],
    role: 'user',
    is_active: true,
    permissions: {}
  };
}

async function getUserRole(userId) {
  try {
    var res = await gSb.from('profiles').select('role').eq('id', userId).single();
    return res.data ? res.data.role : 'user';
  } catch(e) { return 'user'; }
}

async function logout() {
  await gSb.auth.signOut();
  window.location.replace('login.html');
}
