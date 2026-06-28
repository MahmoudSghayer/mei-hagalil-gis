// ════════════════════════════════════════════════════════════════════════
//  Vercel serverless — admin-only user deletion via the Supabase Admin API.
//
//  Purpose: a "delete user" in the admin panel must remove the real auth
//  account (auth.users), not just the profiles row. The browser must NOT hold
//  the service-role key, so this runs server-side. The caller proves they are an
//  active admin with their Supabase session JWT; only then do we delete the
//  target user with the service-role key.
//
//  Deleting auth.users cascades to profiles (ON DELETE CASCADE), which in turn
//  cascade-deletes push_subscriptions and NULLs field_tasks links — see
//  gis-engine/sql/fix-user-delete-fks.sql (must be applied for the cascade to
//  succeed; otherwise the delete is blocked by RESTRICT foreign keys).
//
//  Required Vercel env vars (already used by /api/admin-create-user, /api/tiles):
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
//
//  POST body: { id }   (the target user's uuid)
//  Headers:   Authorization: Bearer <caller's Supabase access_token>
// ════════════════════════════════════════════════════════════════════════
const { limitByIp } = require('./_ratelimit');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Anti-abuse: cap per-IP attempts (each call costs 1-2 Supabase round-trips).
  if (!(await limitByIp(req, res, 'admin-delete', 20, 60))) return;

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(503).json({ error: 'server not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)' });
  }
  const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  // ── 1. Identify the caller from their JWT ──────────────────────────────
  const authz = req.headers['authorization'] || '';
  const jwt = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: 'missing bearer token' });

  let caller;
  try {
    const meR = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!meR.ok) return res.status(401).json({ error: 'invalid session' });
    caller = await meR.json();
  } catch (e) {
    return res.status(401).json({ error: 'session check failed' });
  }
  if (!caller || !caller.id) return res.status(401).json({ error: 'invalid session' });

  // ── 2. Caller must be an active admin ──────────────────────────────────
  let prof;
  try {
    const pR = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(caller.id)}&select=role,is_active`,
      { headers: svc }
    );
    prof = (await pR.json())[0];
  } catch (e) {
    return res.status(500).json({ error: 'profile lookup failed' });
  }
  if (!prof || prof.role !== 'admin' || prof.is_active !== true) {
    return res.status(403).json({ error: 'admin only' });
  }

  // ── 3. Validate input ──────────────────────────────────────────────────
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b && typeof b === 'object' ? b : {};
  const id = String(b.id || '').trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: 'invalid user id' });

  // ── 4. Guard: an admin cannot delete their own account ─────────────────
  if (id === caller.id) return res.status(400).json({ error: 'cannot delete yourself' });

  // ── 5. Delete the auth user (cascades to profile + push subs; nulls tasks) ─
  let delR;
  try {
    delR = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: svc,
    });
  } catch (e) {
    return res.status(502).json({ error: 'admin deleteUser failed' });
  }

  if (delR.ok) return res.status(200).json({ ok: true });

  // ── 6. Fallback: auth account already gone (e.g. legacy profile-only orphan).
  //       Clean up the dangling profiles row so the admin isn't stuck. ────────
  if (delR.status === 404) {
    try {
      const pDel = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { ...svc, Prefer: 'return=minimal' },
      });
      if (!pDel.ok) {
        const t = await pDel.text().catch(() => '');
        return res.status(pDel.status).json({ error: t || 'profile delete failed' });
      }
    } catch (e) {
      return res.status(502).json({ error: 'profile cleanup failed' });
    }
    return res.status(200).json({ ok: true });
  }

  // Surface the real reason. GoTrue/Supabase variously use msg | message |
  // error_description | error; a DB-level cascade block (e.g. an un-migrated
  // RESTRICT foreign key) shows up here as a 500 "Database error deleting user".
  const raw = await delR.text().catch(() => '');
  let errJson = {};
  try { errJson = raw ? JSON.parse(raw) : {}; } catch (e) { /* non-JSON body */ }
  const detail = errJson.msg || errJson.message || errJson.error_description || errJson.error || raw || 'delete failed';
  const hint = delR.status >= 500
    ? ' — אם זו שגיאת מסד נתונים, ודא שהרצת את gis-engine/sql/fix-user-delete-fks.sql ב-Supabase'
    : '';
  return res.status(delR.status).json({ error: `[${delR.status}] ${detail}${hint}` });
};
