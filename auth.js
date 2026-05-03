// ════════════════════════════════════════════
//  auth.js — קובץ משותף לכל הדפים
// ════════════════════════════════════════════

var SUPABASE_URL  = 'https://hlbogufrdxpviyxlwqtf.supabase.co';
var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhsYm9ndWZyZHhwdml5eGx3cXRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMjcyMzUsImV4cCI6MjA5MjkwMzIzNX0.8AvY5isXAJfa2mYC2keDBTlw4hv9mVwytH0oWxW3vKA'; // ← הכנס כאן את ה-anon public key שלך

var gSb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// טען את הפרופיל של משתמש מחובר
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

  // fallback אם הקריאה נכשלת
  return {
    id: user.id,
    email: user.email,
    full_name: (user.user_metadata && user.user_metadata.full_name) || user.email.split('@')[0],
    role: 'user',
    is_active: true,
    permissions: {}
  };
}

// קבל רק את התפקיד של המשתמש
async function getUserRole(userId) {
  try {
    var res = await gSb.from('profiles').select('role').eq('id', userId).single();
    return res.data ? res.data.role : 'user';
  } catch(e) { return 'user'; }
}

// פונקציית התנתקות משותפת לכל הדפים
async function logout() {
  await gSb.auth.signOut();
  window.location.replace('login.html');
}
