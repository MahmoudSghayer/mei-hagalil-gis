-- ════════════════════════════════════════════════════════════════════════
--  FIX: features_in_bbox / features_geojson return HTTP 500
--  ──────────────────────────────────────────────────────────────────────
--  Symptom: POST /rest/v1/rpc/features_in_bbox → 500; on the map some layers
--  don't render (blank/blurry on zoom), feature clicks open nothing, and the
--  app lags as failed tile fetches retry.
--
--  Root cause: these two READ RPCs ran as SECURITY INVOKER, so the `features`
--  RLS policy (auth.uid() IS NOT NULL) was evaluated PER ROW across every
--  candidate in the bbox → on dense layers that blows the statement_timeout,
--  which Supabase/PostgREST surfaces as HTTP 500
--  ("canceling statement due to statement timeout").
--
--  Fix: same proven pattern already used by meters_in_bbox — run as
--  SECURITY DEFINER (skips per-row RLS) with a SINGLE `(SELECT auth.uid())
--  IS NOT NULL` guard evaluated once. Access is identical (any signed-in user
--  may read features), so there is NO security change — only no per-row cost.
--  Also COALESCE(properties,'{}') so a NULL properties row can't null the
--  whole feature.
--
--  Run this ONCE in the Supabase SQL editor. Idempotent (CREATE OR REPLACE).
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.features_in_bbox(
  p_layer_id UUID, p_minlng FLOAT, p_minlat FLOAT, p_maxlng FLOAT, p_maxlat FLOAT,
  p_limit INT DEFAULT 4000)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('type','FeatureCollection','features',
    COALESCE(jsonb_agg(jsonb_build_object(
      'type','Feature','id',f.id,
      'geometry', ST_AsGeoJSON(f.geometry)::jsonb,
      'properties', COALESCE(f.properties,'{}'::jsonb) || jsonb_build_object(
        'asset_code',f.asset_code,'__id',f.id,'__layer_id',f.layer_id,
        '__edited_by', COALESCE(p.full_name, p.email), '__edited_at', f.edited_at))), '[]'::jsonb))
  FROM (
    SELECT * FROM public.features
    WHERE layer_id = p_layer_id
      AND (SELECT auth.uid()) IS NOT NULL   -- one-time auth guard (was per-row RLS → timeout/500)
      AND geometry && ST_MakeEnvelope(p_minlng, p_minlat, p_maxlng, p_maxlat, 4326)
    LIMIT p_limit
  ) f
  LEFT JOIN public.profiles p ON p.id = f.edited_by;
$$;

CREATE OR REPLACE FUNCTION public.features_geojson(p_layer_id UUID, p_limit INT DEFAULT 5000)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('type','FeatureCollection','features',
    COALESCE(jsonb_agg(jsonb_build_object(
      'type','Feature','id',f.id,
      'geometry', ST_AsGeoJSON(f.geometry)::jsonb,
      'properties', COALESCE(f.properties,'{}'::jsonb) || jsonb_build_object(
        'asset_code',f.asset_code,'__id',f.id,'__layer_id',f.layer_id,
        '__edited_by', COALESCE(p.full_name, p.email), '__edited_at', f.edited_at))), '[]'::jsonb))
  FROM (
    SELECT * FROM public.features
    WHERE layer_id = p_layer_id
      AND (SELECT auth.uid()) IS NOT NULL
    LIMIT p_limit
  ) f
  LEFT JOIN public.profiles p ON p.id = f.edited_by;
$$;

GRANT EXECUTE ON FUNCTION public.features_in_bbox(UUID, FLOAT, FLOAT, FLOAT, FLOAT, INT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.features_geojson(UUID, INT) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
