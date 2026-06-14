-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — Extras: per-layer colour, extent, viewport loading
--  Run after schema.sql. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════

-- Per-layer display colour (hex). NULL → default by geometry type.
ALTER TABLE public.layers ADD COLUMN IF NOT EXISTS color TEXT;

-- Bounding box over a set of layers → [minLng, minLat, maxLng, maxLat] (or null).
-- ST_XMin/ST_YMin/ST_XMax/ST_YMax are overloaded for box2d, so we read the
-- ST_Extent (box2d) directly — no box2d→geometry cast (that cast 500'd on some
-- PostGIS builds). Empty set → no row → PostgREST returns null.
CREATE OR REPLACE FUNCTION public.layers_extent(p_layer_ids UUID[])
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array(ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e))
  FROM (SELECT ST_Extent(geometry) AS e
        FROM public.features WHERE layer_id = ANY(p_layer_ids)) s
  WHERE e IS NOT NULL;
$$;

-- Viewport loading: only features whose geometry intersects the map bbox,
-- capped by p_limit. The `&&` operator uses the GIST index → fast, no timeout.
CREATE OR REPLACE FUNCTION public.features_in_bbox(
  p_layer_id UUID, p_minlng FLOAT, p_minlat FLOAT, p_maxlng FLOAT, p_maxlat FLOAT,
  p_limit INT DEFAULT 4000)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('type','FeatureCollection','features',
    COALESCE(jsonb_agg(jsonb_build_object(
      'type','Feature','id',id,
      'geometry', ST_AsGeoJSON(geometry)::jsonb,
      'properties', properties || jsonb_build_object('asset_code',asset_code,'__id',id,'__layer_id',layer_id))), '[]'::jsonb))
  FROM (
    SELECT * FROM public.features
    WHERE layer_id = p_layer_id
      AND geometry && ST_MakeEnvelope(p_minlng, p_minlat, p_maxlng, p_maxlat, 4326)
    LIMIT p_limit
  ) s;
$$;

-- Viewport / per-village loading for water meters: only meters whose point is
-- in the bbox, capped by p_limit. Uses the GIST index on meters.geometry (`&&`).
-- Needed because meters_geojson over the whole 30k+ fleet hits the statement
-- timeout ("canceling statement due to statement timeout").
--
-- SECURITY DEFINER + a single `(SELECT auth.uid()) IS NOT NULL` guard: the
-- meters table's RLS policy calls auth.uid() PER ROW, which is slow over
-- thousands of meters and itself causes the timeout. Running as DEFINER skips
-- per-row RLS; the guard (evaluated once) preserves "signed-in users only".
CREATE OR REPLACE FUNCTION public.meters_in_bbox(
  p_minlng FLOAT, p_minlat FLOAT, p_maxlng FLOAT, p_maxlat FLOAT,
  p_limit INT DEFAULT 8000)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('type','FeatureCollection','features',
    COALESCE(jsonb_agg(jsonb_build_object(
      'type','Feature','id',id,
      'geometry', ST_AsGeoJSON(geometry)::jsonb,
      'properties', jsonb_build_object(
        'arad_meter_id',arad_meter_id,'customer_id',customer_id,'asset_code',asset_code,
        'last_reading',last_reading,'consumption',consumption,'status',status,
        'install_date',install_date,'__id',id) || raw_data)), '[]'::jsonb))
  FROM (
    SELECT * FROM public.meters
    WHERE (SELECT auth.uid()) IS NOT NULL   -- one-time auth guard (was per-row RLS)
      AND geometry IS NOT NULL
      AND geometry && ST_MakeEnvelope(p_minlng, p_minlat, p_maxlng, p_maxlat, 4326)
    LIMIT p_limit
  ) s;
$$;

-- ── OPTIONAL: wipe ALL engine data (old seed/test layers) and start clean ──
-- Uncomment and run ONCE to delete every layer + its features + fields.
-- TRUNCATE public.features, public.fields, public.layers RESTART IDENTITY CASCADE;
