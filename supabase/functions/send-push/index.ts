// ════════════════════════════════════════════════════════════════════════
//  send-push — Supabase Edge Function (C4). Sends a Web Push to all of a
//  user's stored subscriptions. Called from the app (supabase.functions.invoke
//  'send-push') on task-assign / submission approve|reject.
//
//  SECURITY: the caller's JWT is verified and must belong to an active
//  admin/engineer (pushes only ever fire on privileged actions). Anonymous /
//  anon-key / viewer callers are rejected (fail-closed). CORS is allow-listed,
//  not '*'. Keep the platform's verify_jwt = ON for defence in depth.
//
//  DEPLOY (once, with the Supabase CLI):
//    supabase secrets set VAPID_PUBLIC=<public>  VAPID_PRIVATE=<private>
//    supabase functions deploy send-push
//  (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//   Optionally set ALLOWED_ORIGINS=<comma-separated> to override the default.)
//  Body: { user_id, title?, body?, url? }
// ════════════════════════════════════════════════════════════════════════
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://mei-hagalil-gis.vercel.app')
  .split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC') ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:admin@mei-hagalil.example', VAPID_PUBLIC, VAPID_PRIVATE);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

// Verify the caller's bearer JWT and require an active admin/engineer. Fails closed:
// any error, missing token, anon caller, or viewer/suspended account → not authorized.
async function authorizeCaller(authHeader: string | null): Promise<boolean> {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token || !SUPABASE_URL || !SERVICE_ROLE) return false;
  try {
    const meR = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${token}` },
    });
    if (!meR.ok) return false;
    const me = await meR.json();
    if (!me?.id) return false;
    const { data: prof } = await admin
      .from('profiles').select('role,is_active').eq('id', me.id).single();
    return !!prof && prof.is_active === true && (prof.role === 'admin' || prof.role === 'engineer');
  } catch (_e) {
    return false;
  }
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);
  try {
    if (!(await authorizeCaller(req.headers.get('authorization')))) {
      return json({ error: 'forbidden' }, 403, cors);
    }
    const { user_id, title, body, url } = await req.json();
    if (!user_id) return json({ error: 'user_id required' }, 400, cors);

    const { data: subs } = await admin
      .from('push_subscriptions').select('endpoint,subscription').eq('user_id', user_id);

    const payload = JSON.stringify({ title: title || 'מי הגליל GIS', body: body || '', url: url || '/' });
    let sent = 0;
    for (const row of subs ?? []) {
      try { await webpush.sendNotification(row.subscription, payload); sent++; }
      catch (e) {
        const code = (e as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) await admin.from('push_subscriptions').delete().eq('endpoint', row.endpoint);
      }
    }
    return json({ sent }, 200, cors);
  } catch (e) {
    return json({ error: String(e) }, 500, cors);
  }
});

function json(obj: unknown, status = 200, cors: Record<string, string> = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
