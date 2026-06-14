-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — Vector tiles (Mapbox Vector Tiles via ST_AsMVT)
--  Run after schema.sql + extras.sql. Safe to re-run.
--
--  Serves a single XYZ tile of an engine layer as a binary MVT (protobuf).
--  The client (Leaflet.VectorGrid via js/gis-mvt-layer.js) fetches this RPC
--  directly over PostgREST — no extra serverless function needed. The map is
--  read-only, so vector tiles fit cleanly and scale to the 18k-pipe layers
--  without shipping/parsing full GeoJSON or building a Leaflet layer per
--  feature.
--
--  • SECURITY INVOKER → the caller's RLS still applies (read auth unchanged).
--  • Geometry stored in EPSG:4326; ST_TileEnvelope is EPSG:3857, so transform.
--  • bbox prefilter (&&) uses the GIST index; ST_AsMVTGeom clips to the tile.
--  • Exposed MVT feature props: __id, asset_code, and `props` (the full
--    properties jsonb as a JSON string — client JSON.parses it when needed,
--    e.g. to open the attribute panel / derive a label).
--
--  Requires PostGIS ≥ 3.0 (ST_TileEnvelope). Supabase ships PostGIS 3.x.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.features_mvt(
  p_layer_id UUID, p_z INT, p_x INT, p_y INT)
RETURNS BYTEA
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH bounds AS (
    SELECT ST_TileEnvelope(p_z, p_x, p_y) AS env
  ),
  mvtgeom AS (
    SELECT
      ST_AsMVTGeom(ST_Transform(f.geometry, 3857), b.env, 4096, 64, true) AS geom,
      f.id::text       AS __id,
      f.asset_code     AS asset_code,
      f.properties::text AS props
    FROM public.features f, bounds b
    WHERE f.layer_id = p_layer_id
      -- index-friendly prefilter in the layer's own SRID (4326)
      AND f.geometry && ST_Transform(b.env, 4326)
  )
  SELECT COALESCE(ST_AsMVT(mvtgeom, 'features', 4096, 'geom'), ''::bytea)
  FROM mvtgeom
  WHERE geom IS NOT NULL;
$$;

-- PostgREST exposes this to the same roles that can read features. RLS on
-- public.features still governs which rows are returned (SECURITY INVOKER).
GRANT EXECUTE ON FUNCTION public.features_mvt(UUID, INT, INT, INT) TO anon, authenticated;

-- ── How the client calls it ──────────────────────────────────────────────
-- GET {SUPABASE_URL}/rest/v1/rpc/features_mvt?p_layer_id=<uuid>&p_z={z}&p_x={x}&p_y={y}
--   headers: apikey: <anon>, Authorization: Bearer <session jwt>,
--            Accept: application/octet-stream       ← returns raw MVT bytes
-- (PostgREST returns a scalar bytea as raw bytes for that Accept type.)
