// ════════════════════════════════════════════════════════════════════════
//  Shared admin gate for the admin-* serverless functions. The underscore
//  prefix tells Vercel NOT to expose this file as a route.
//
//  Resolves the server env, verifies the caller's Supabase session JWT, and
//  requires an active admin profile — the identical preamble that
//  admin-create-user and admin-delete-user used to each carry inline.
//
//  On failure it writes the (same) error response and returns null, so callers
//  do `const ctx = await requireActiveAdmin(req, res); if (!ctx) return;`.
//  On success it returns { SUPABASE_URL, SERVICE_KEY, svc, caller }.
// ════════════════════════════════════════════════════════════════════════
async function requireActiveAdmin(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(503).json({ error: 'server not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)' });
    return null;
  }
  const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  // ── 1. Identify the caller from their JWT ──────────────────────────────
  const authz = req.headers['authorization'] || '';
  const jwt = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!jwt) { res.status(401).json({ error: 'missing bearer token' }); return null; }

  let caller;
  try {
    const meR = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!meR.ok) { res.status(401).json({ error: 'invalid session' }); return null; }
    caller = await meR.json();
  } catch (e) {
    res.status(401).json({ error: 'session check failed' });
    return null;
  }
  if (!caller || !caller.id) { res.status(401).json({ error: 'invalid session' }); return null; }

  // ── 2. Caller must be an active admin ──────────────────────────────────
  let prof;
  try {
    const pR = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(caller.id)}&select=role,is_active`,
      { headers: svc }
    );
    prof = (await pR.json())[0];
  } catch (e) {
    res.status(500).json({ error: 'profile lookup failed' });
    return null;
  }
  if (!prof || prof.role !== 'admin' || prof.is_active !== true) {
    res.status(403).json({ error: 'admin only' });
    return null;
  }

  return { SUPABASE_URL, SERVICE_KEY, svc, caller };
}

module.exports = { requireActiveAdmin };
