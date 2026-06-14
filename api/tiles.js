// ════════════════════════════════════════════════════════════════════════
//  Vercel serverless — edge-cached MVT tile endpoint
//  GET /api/tiles?layer=<uuid>&z={z}&x={x}&y={y}[&v=<ver>]
//
//  Proxies the PostGIS `features_mvt` RPC and returns raw Mapbox Vector Tile
//  bytes with CDN cache headers, so repeat views (and other users viewing the
//  same area) become Vercel edge-cache hits instead of DB round-trips. Read-
//  only map data → ideal cache candidate.
//
//  Also the robust path: it decodes PostgREST's bytea (hex) to binary itself,
//  sidestepping any Accept/octet-stream quirks of fetching the RPC from the
//  browser directly.
//
//  Uses the SERVICE-ROLE key (server-side secret) so tiles are identical for
//  everyone → cacheable. The data is internal infrastructure (the village
//  bucket is already public); if you need per-user gating, drop the cache and
//  forward the user's JWT instead.
//
//  Required Vercel env vars:
//    SUPABASE_URL                 e.g. https://xxxx.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY    Supabase → Settings → API → service_role
//  If unset, returns 503 so the client transparently falls back to the direct
//  RPC / GeoJSON tile loader.
// ════════════════════════════════════════════════════════════════════════
// Allowlist of origins permitted to call this endpoint (override via env
// ALLOWED_ORIGINS, comma-separated). Same-origin app calls don't need this;
// it stops other sites from proxying our data / burning Supabase quota.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://mei-hagalil-gis.vercel.app')
  .split(',').map(s => s.trim()).filter(Boolean);

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { z, x, y, layer } = req.query;
  if (z == null || x == null || y == null || !layer ||
      isNaN(+z) || isNaN(+x) || isNaN(+y)) {
    return res.status(400).json({ error: 'need layer + numeric z,x,y' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !KEY) {
    return res.status(503).json({ error: 'tile endpoint not configured (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)' });
  }

  const url = `${SUPABASE_URL}/rest/v1/rpc/features_mvt` +
    `?p_layer_id=${encodeURIComponent(layer)}&p_z=${+z}&p_x=${+x}&p_y=${+y}`;

  try {
    const r = await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    if (!r.ok) {
      const body = await r.text();
      return res.status(502).json({ error: 'features_mvt failed', status: r.status, body: body.slice(0, 300) });
    }

    // PostgREST returns a scalar bytea as a JSON string: "\\x1a2b…" (hex).
    let payload = await r.text();
    try { payload = JSON.parse(payload); } catch (e) { /* already raw */ }
    let hex = typeof payload === 'string' ? payload : '';
    if (hex.startsWith('\\x')) hex = hex.slice(2);
    const buf = Buffer.from(hex, 'hex');

    res.setHeader('Content-Type', 'application/x-protobuf');
    // Browser keeps it 5 min; Vercel edge keeps it 1 h and serves stale while
    // revalidating for a week. Edits bust this via the &v= cache-buster.
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=604800');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(502).json({ error: String(e && e.message || e) });
  }
};
