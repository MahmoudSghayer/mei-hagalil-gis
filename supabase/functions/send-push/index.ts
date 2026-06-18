// ════════════════════════════════════════════════════════════════════════
//  send-push — Supabase Edge Function (C4). Sends a Web Push to all of a
//  user's stored subscriptions. Called from the app (supabase.functions.invoke
//  'send-push') on task-assign / submission approve|reject.
//
//  DEPLOY (once, with the Supabase CLI):
//    supabase secrets set VAPID_PUBLIC=<public>  VAPID_PRIVATE=<private>
//    supabase functions deploy send-push
//  (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//  Body: { user_id, title?, body?, url? }
// ════════════════════════════════════════════════════════════════════════
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC') ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:admin@mei-hagalil.example', VAPID_PUBLIC, VAPID_PRIVATE);
}
const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { user_id, title, body, url } = await req.json();
    if (!user_id) return json({ error: 'user_id required' }, 400);

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
    return json({ sent });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
