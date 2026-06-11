-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — Extras: per-layer colour, extent, viewport loading
--  Run after schema.sql. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════

-- Per-layer display colour (hex). NULL → default by geometry type.
ALTER TABLE public.layers ADD COLUMN IF NOT EXISTS color TEXT;

-- Bounding box over a set of layers → [minLng, minLat, maxLng, maxLat] (or null).
CREATE OR REPLACE FUNCTION public.layers_extent(p_layer_ids UUID[])
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN ext IS NULL THEN NULL
    ELSE jsonb_build_array(ST_XMin(ext), ST_YMin(ext), ST_XMax(ext), ST_YMax(ext)) END
  FROM (SELECT ST_Extent(geometry)::geometry AS ext
        FROM public.features WHERE layer_id = ANY(p_layer_ids)) s;
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

-- ── OPTIONAL: wipe ALL engine data (old seed/test layers) and start clean ──
-- Uncomment and run ONCE to delete every layer + its features + fields.
-- TRUNCATE public.features, public.fields, public.layers RESTART IDENTITY CASCADE;
