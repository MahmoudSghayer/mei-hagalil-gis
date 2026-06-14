// ════════════════════════════════════════════════════════════════════════
//  Vercel serverless — admin-only user creation via the Supabase Admin API.
//
//  Purpose: lets us DISABLE public sign-ups in Supabase while admins can still
//  create accounts. The browser must NOT use the service-role key, so this runs
//  server-side. The caller proves they are an active admin with their Supabase
//  session JWT; only then do we create the new user with the service-role key.
//
//  Required Vercel env vars (already used by /api/tiles):
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
//
//  POST body: { email, password, full_name?, role?, phone?, department? }
//  Headers:   Authorization: Bearer <caller's Supabase access_token>
// ════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

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
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const role = ['admin', 'editor', 'viewer'].includes(b.role) ? b.role : 'viewer';
  const full_name = String(b.full_name || '').slice(0, 200);
  const phone = String(b.phone || '').slice(0, 50);
  const department = String(b.department || '').slice(0, 100);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

  // ── 4. Create the (email-confirmed) auth user via the Admin API ─────────
  let created;
  try {
    const cR = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { ...svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, password, email_confirm: true,
        user_metadata: { full_name, phone, department },
      }),
    });
    created = await cR.json();
    if (!cR.ok) {
      return res.status(cR.status).json({ error: created.msg || created.error_description || created.error || 'create failed' });
    }
  } catch (e) {
    return res.status(502).json({ error: 'admin createUser failed' });
  }

  // ── 5. Set profile fields + role (the signup trigger created it as 'user') ─
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(created.id)}`, {
      method: 'PATCH',
      headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ full_name, role, phone, department, is_active: true }),
    });
  } catch (e) {
    // User exists but profile patch failed — report so the admin can fix the role.
    return res.status(207).json({ ok: true, id: created.id, warning: 'user created but profile update failed; set role manually' });
  }

  return res.status(200).json({ ok: true, id: created.id });
};
