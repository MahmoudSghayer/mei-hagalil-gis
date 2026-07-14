-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — export-area intelligence (W2.2)
--  ──────────────────────────────────────────────────────────────────────
--  Purpose: the export wizard's "🖱️ סמן אזור על המפה" (draw-scope) flow used
--  to fetch every feature of every selected category via GIS.features.getFeatures
--  (up to 1,000,000 rows per layer!) and filter to the drawn rectangle
--  CLIENT-SIDE (isInBounds in js/export-feature.js) — slow, and it only ever
--  saw features already loaded as map tiles, so a rectangle over an unpanned
--  area silently exported nothing. This migration adds a fast COUNT-only RPC
--  so the wizard can show an area-scoped summary (per layer: feature count +
--  geometry types) BEFORE running the real export, and lets the real export
--  fetch straight from the DB via a bbox query instead of the client filter.
--
--    • export_area_summary(p_min_lng, p_min_lat, p_max_lng, p_max_lat,
--      p_layer_ids) — one row per requested layer_id: layer_id, name, exact
--      feature COUNT inside the bbox (geometry && ST_MakeEnvelope — GIST-backed,
--      idx_features_geom), and the distinct PostGIS geometry types present
--      (array_agg(DISTINCT GeometryType(geometry))). No feature payloads —
--      this is a summary/count call only, safe to run before the user commits
--      to a real export.
--
--  export_features_in_bbox was NOT added as a second RPC. features_in_bbox
--  (gis-engine/sql/fix-features-bbox-timeout.sql) already returns exactly the
--  shape the export needs — full properties (COALESCE(properties,'{}') merged
--  with asset_code/__id/__layer_id) plus the edited_by/edited_at audit join,
--  SECURITY DEFINER with the same one-time auth guard, GIST-backed via the
--  same `&&` operator. The only gap for export use was that its p_limit had
--  no upper bound (a caller could pass p_limit=10000000 and pull an entire
--  layer in one call) — every existing call site in the app passes limits far
--  below 4000 (see js/gis-flow.js MAX_FEATURES=4000, js/gis-edit.js,
--  js/gis-engine-sidebar.js, js/gis-network-trace.js), so a ceiling is a pure
--  safety net, not a behaviour change for any current caller. This migration
--  re-CREATEs features_in_bbox unchanged except for clamping p_limit to
--  <= 20000 (LEAST/GREATEST around the existing LIMIT), which is what the
--  export draw-scope flow now uses as its per-layer fetch cap
--  (AREA_FETCH_CAP in js/export-feature.js). Reusing the existing RPC avoids
--  a near-duplicate function that would need to be kept in sync by hand.
--
--  Security model (matches gis-engine/sql/extras.sql / fix-features-bbox-timeout.sql
--  / 2026-07-14-feature-table-pagination.sql):
--    • export_area_summary runs SECURITY DEFINER with a single
--      `(SELECT auth.uid()) IS NOT NULL` guard (evaluated once, RAISE
--      EXCEPTION if absent) instead of relying on the features RLS policy
--      (auth.uid() per row) — same reasoning as features_page/features_in_bbox:
--      per-row RLS over thousands of candidate rows has caused statement
--      timeouts (500s) before. Access is identical to plain RLS (any signed-in
--      user may read); only the per-row cost changes.
--    • features_in_bbox is re-CREATEd with `SET search_path = public` already
--      pinned (unchanged from the existing fix) and the new p_limit clamp.
--    • Both pin `SET search_path = public` (defence-in-depth against
--      search_path hijacking; mirrors fix-function-search-path.sql).
--
--  Apply: Supabase → SQL Editor → paste this file → Run. Idempotent
--  (CREATE OR REPLACE); safe to re-run. Requires schema.sql and
--  fix-features-bbox-timeout.sql (or extras.sql) to already be applied
--  (public.features, public.layers, public.profiles, idx_features_geom).
-- ════════════════════════════════════════════════════════════════════════

-- ── export_area_summary — fast per-layer COUNT + distinct geometry types for
--    a bbox, no feature payloads. Drives the export wizard's area-summary
--    modal (js/export-feature.js: buildAreaSummaryModel). One row is returned
--    per requested layer_id even when its count is 0, via LEFT JOIN LATERAL,
--    so the UI can show "0 objects" for a selected category with nothing in
--    the drawn area instead of silently omitting it.
CREATE OR REPLACE FUNCTION public.export_area_summary(
  p_min_lng FLOAT, p_min_lat FLOAT, p_max_lng FLOAT, p_max_lat FLOAT,
  p_layer_ids UUID[]
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result JSONB;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_layer_ids IS NULL OR array_length(p_layer_ids, 1) IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'layer_id', l.id,
      'name', l.name,
      'count', COALESCE(s.cnt, 0),
      'geometry_types', COALESCE(s.gtypes, '[]'::jsonb)
    ) ORDER BY l.name), '[]'::jsonb)
    INTO result
  FROM public.layers l
  LEFT JOIN LATERAL (
    SELECT count(*) AS cnt, jsonb_agg(DISTINCT GeometryType(f.geometry)) AS gtypes
    FROM public.features f
    WHERE f.layer_id = l.id
      AND f.geometry && ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326)
  ) s ON true
  WHERE l.id = ANY(p_layer_ids);

  RETURN result;
END; $$;

GRANT EXECUTE ON FUNCTION public.export_area_summary(FLOAT, FLOAT, FLOAT, FLOAT, UUID[]) TO authenticated, anon;


-- ── features_in_bbox — unchanged behaviour, just a p_limit ceiling (<= 20000)
--    so the export draw-scope flow (which now calls this with a much higher
--    limit than the map's tile loader ever does) can't be used to pull an
--    unbounded number of rows in one call. Every existing caller already
--    passes far below 4000 (see header comment), so this is a no-op for them.
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
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 4000), 1), 20000)   -- NEW: hard ceiling for export use
  ) f
  LEFT JOIN public.profiles p ON p.id = f.edited_by;
$$;

GRANT EXECUTE ON FUNCTION public.features_in_bbox(UUID, FLOAT, FLOAT, FLOAT, FLOAT, INT) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════
--  MANUAL TEST SCRIPT (commented) — paste pieces into the Supabase SQL
--  editor, as a signed-in user, to sanity-check the new/changed RPCs.
--  Replace <LAYER_ID_1>/<LAYER_ID_2> with real layers.id values and the bbox
--  with a real extent (e.g. from SELECT public.layers_extent(ARRAY[<LAYER_ID>])):
--    SELECT id, name, geometry_type FROM public.layers LIMIT 20;
-- ════════════════════════════════════════════════════════════════════════

-- 1) Area summary over two layers — expect one row per layer_id, each with a
--    count and a geometry_types array (e.g. ["POINT"] or ["LINESTRING"]):
-- SELECT public.export_area_summary(35.0, 32.8, 35.5, 33.1,
--   ARRAY['<LAYER_ID_1>','<LAYER_ID_2>']::uuid[]);

-- 2) A layer_id with nothing in the bbox still gets a row, count = 0:
-- SELECT public.export_area_summary(0, 0, 0.001, 0.001, ARRAY['<LAYER_ID_1>']::uuid[]);
-- -- expect: [{"layer_id":"<LAYER_ID_1>","name":"...","count":0,"geometry_types":[]}]

-- 3) Empty/NULL layer_ids array short-circuits to an empty array (no error):
-- SELECT public.export_area_summary(35.0, 32.8, 35.5, 33.1, ARRAY[]::uuid[]);
-- SELECT public.export_area_summary(35.0, 32.8, 35.5, 33.1, NULL);
-- -- expect: []

-- 4) features_in_bbox still works exactly as before under the old default cap:
-- SELECT jsonb_array_length(public.features_in_bbox('<LAYER_ID_1>'::uuid, 35.0, 32.8, 35.5, 33.1)->'features');

-- 5) features_in_bbox now clamps an oversized p_limit instead of returning
--    everything requested:
-- SELECT jsonb_array_length(public.features_in_bbox('<LAYER_ID_1>'::uuid, 35.0, 32.8, 35.5, 33.1, 999999)->'features');
-- -- expect: <= 20000 (and <= the layer's true count in that bbox)

-- 6) As a signed-out (anon, no JWT) session, both calls should fail auth:
-- SELECT public.export_area_summary(35.0, 32.8, 35.5, 33.1, ARRAY['<LAYER_ID_1>']::uuid[]);
-- -- expect: ERROR: Not authenticated
