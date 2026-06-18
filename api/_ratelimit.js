// ════════════════════════════════════════════════════════════════════════
//  Shared fixed-window rate limiter for the Vercel serverless api/ functions.
//  Backed by Vercel KV (Upstash Redis REST API). The underscore prefix tells
//  Vercel NOT to expose this file as a route.
//
//  Env (provided automatically when you attach a Vercel KV store to the project):
//    KV_REST_API_URL, KV_REST_API_TOKEN
//
//  FAILS OPEN: if KV is unconfigured or unreachable, requests are allowed —
//  a limiter outage must never take the API down. Enforcement turns on the
//  moment the KV_* vars are present.
// ════════════════════════════════════════════════════════════════════════
// Accept either the Vercel KV (KV_REST_API_*) or Upstash (UPSTASH_REDIS_REST_*)
// variable names — both point at the same Upstash Redis REST endpoint.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Best-effort client IP from Vercel's x-forwarded-for (first hop = real client).
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : (xff || '')).split(',')[0].trim();
  return first || (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function kv(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}

// Fixed-window counter. Returns { ok:true } or { ok:false, retryAfter:<seconds> }.
async function check(bucket, id, limit, windowSec) {
  if (!KV_URL || !KV_TOKEN) return { ok: true };
  const key = `rl:${bucket}:${id}`;
  try {
    const n = await kv(['INCR', key]);
    if (n === 1) await kv(['EXPIRE', key, windowSec]);
    if (n > limit) {
      const ttl = await kv(['TTL', key]);
      return { ok: false, retryAfter: ttl > 0 ? ttl : windowSec };
    }
    return { ok: true };
  } catch (e) {
    return { ok: true }; // fail open
  }
}

// Enforce a per-IP budget and, if exceeded, send a 429 (response is finished).
// Returns true if the request may proceed, false if it was rejected.
async function limitByIp(req, res, bucket, limit, windowSec) {
  const r = await check(bucket, clientIp(req), limit, windowSec);
  if (!r.ok) {
    res.setHeader('Retry-After', String(r.retryAfter));
    res.status(429).json({ error: 'rate limit exceeded', retryAfter: r.retryAfter });
    return false;
  }
  return true;
}

module.exports = { check, limitByIp, clientIp };
