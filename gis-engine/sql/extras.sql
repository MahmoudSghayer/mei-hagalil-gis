-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — Extras: per-layer colour + layer extent  (run after schema.sql)
-- ════════════════════════════════════════════════════════════════════════

-- Per-layer display colour (hex string, e.g. '#1a7fc1'). NULL → default by type.
ALTER TABLE public.layers ADD COLUMN IF NOT EXISTS color TEXT;

-- Bounding box over a set of layers → [minLng, minLat, maxLng, maxLat] (or null).
CREATE OR REPLACE FUNCTION public.layers_extent(p_layer_ids UUID[])
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN ext IS NULL THEN NULL
    ELSE jsonb_build_array(ST_XMin(ext), ST_YMin(ext), ST_XMax(ext), ST_YMax(ext)) END
  FROM (SELECT ST_Extent(geometry)::geometry AS ext
        FROM public.features WHERE layer_id = ANY(p_layer_ids)) s;
$$;
