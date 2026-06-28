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
const { limitByIp } = require('./_ratelimit');
const { requireActiveAdmin } = require('./_authcheck');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Anti-abuse: cap per-IP attempts (each call costs 1-2 Supabase round-trips).
  if (!(await limitByIp(req, res, 'admin-create', 20, 60))) return;

  // ── 1+2. Resolve env + require an active-admin caller (shared gate) ─────
  const ctx = await requireActiveAdmin(req, res);
  if (!ctx) return;
  const { SUPABASE_URL, svc } = ctx;

  // ── 3. Validate input ──────────────────────────────────────────────────
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b && typeof b === 'object' ? b : {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const role = ['admin', 'engineer', 'viewer'].includes(b.role) ? b.role : 'viewer';
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
