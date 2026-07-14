-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — server-side pagination for the attribute table (W1.2)
--  ──────────────────────────────────────────────────────────────────────
--  Purpose: js/gis-feature-table.js used to load an ENTIRE layer
--  (GIS.features.getFeatures(layerId, 1000000)) and page/sort/filter it
--  client-side. That doesn't scale for big layers (18k+ pipes) and ships
--  the whole table to the browser on every open. This migration adds three
--  RPCs so the attribute table can page, sort, search and bulk-edit on the
--  server instead:
--
--    • features_page(p_layer_id, p_filters, p_search, p_sort_key,
--                     p_sort_dir, p_limit, p_offset)  — one page of
--      features as GeoJSON, same shape as features_geojson/query_features.
--    • features_page_count(p_layer_id, p_filters, p_search) — exact count
--      for the same predicate (drives "X מתוך Y").
--    • features_bulk_update(p_layer_id, p_ids, p_patch) — merges a jsonb
--      patch into properties for up to 1000 feature ids at once (multi-row
--      select + bulk edit in the table).
--
--  Both read RPCs reuse query_features' condition-builder pattern (a
--  private helper, _features_filter_sql, extracted from
--  gis-engine/sql/schema.sql:182-234) — same whitelisted operators,
--  regex-checked field names, quote_literal'd values. query_features
--  itself is left untouched.
--
--  Security model (matches gis-engine/sql/audit.sql + extras.sql):
--    • features_page / features_page_count run SECURITY DEFINER with a
--      single `(SELECT auth.uid()) IS NOT NULL` guard (evaluated once)
--      instead of the features RLS policy (which runs auth.uid() PER ROW
--      and has caused statement-timeout 500s on big layers before — see
--      fix-features-bbox-timeout.sql). Access is identical to plain RLS:
--      any signed-in user may read. No security change, just no per-row
--      cost.
--    • features_bulk_update stays SECURITY INVOKER (default) so the
--      existing "features write" RLS policy and the gis_audit /
--      features_autocalc triggers apply exactly as they do for a normal
--      UPDATE — it also explicitly checks can_edit_gis() up front so
--      unauthorized calls get a clear Hebrew-friendly message instead of a
--      generic RLS-denial error.
--    • Every function pins `SET search_path = public` (defence-in-depth
--      against search_path hijacking; mirrors fix-function-search-path.sql).
--
--  Apply: Supabase → SQL Editor → paste this file → Run. Idempotent
--  (CREATE OR REPLACE); safe to re-run. Requires schema.sql, editing.sql,
--  extras.sql and audit.sql to already be applied (features.edited_by/
--  edited_at, public.profiles, can_edit_gis(), gis_audit trigger).
-- ════════════════════════════════════════════════════════════════════════

-- ── private helper: build a safe WHERE-clause fragment from a structured
--    filter — the same operator whitelist / field regex / quote_literal
--    pattern as query_features (schema.sql), extracted so features_page and
--    features_page_count can share it without duplicating the whitelist.
--    Not meant to be called directly from the client; it never touches a
--    table (pure text-building), so exposing it via PostgREST is harmless.
CREATE OR REPLACE FUNCTION public._features_filter_sql(p_conditions JSONB, p_logic TEXT DEFAULT 'and')
RETURNS TEXT LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  cond JSONB; fld TEXT; op TEXT; val JSONB; accessor TEXT; clause TEXT;
  clauses TEXT[] := '{}'; logic TEXT;
  op_map JSONB := '{"=":"=","!=":"<>","<>":"<>","<":"<","<=":"<=",">":">",">=":">=","like":"ILIKE"}';
BEGIN
  logic := CASE WHEN lower(COALESCE(p_logic,'and')) = 'or' THEN ' OR ' ELSE ' AND ' END;

  FOR cond IN SELECT * FROM jsonb_array_elements(COALESCE(p_conditions, '[]'::jsonb)) LOOP
    fld := cond->>'field';
    op  := lower(cond->>'op');
    val := cond->'value';

    IF fld !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN RAISE EXCEPTION 'Invalid field name: %', fld; END IF;
    IF NOT (op_map ? op) THEN RAISE EXCEPTION 'Operator not allowed: %', op; END IF;

    IF fld = 'asset_code' THEN
      accessor := 'asset_code';
    ELSIF jsonb_typeof(val) = 'number' THEN
      accessor := format('(properties->>%L)::numeric', fld);
    ELSE
      accessor := format('(properties->>%L)', fld);
    END IF;

    IF jsonb_typeof(val) = 'number' THEN
      clause := format('%s %s %s', accessor, op_map->>op, (val#>>'{}'));
    ELSE
      clause := format('%s %s %L', accessor, op_map->>op, (val#>>'{}'));
    END IF;
    clauses := array_append(clauses, clause);
  END LOOP;

  RETURN CASE WHEN array_length(clauses,1) IS NULL THEN 'TRUE' ELSE array_to_string(clauses, logic) END;
END; $$;


-- ── features_page — one page of a layer's features, filtered/searched/sorted
--    server-side. p_filters = { "logic":"and"|"or", "conditions":[{field,op,value}] }
--    (the exact shape GIS.queries.parseFilterToSQL() produces). p_search does a
--    case-insensitive substring match across every property VALUE (not keys) plus
--    asset_code. p_sort_key is whitelisted against the layer's registered fields
--    (public.fields) plus the system columns asset_code/created_at; anything else
--    raises. p_limit is clamped to <= 500 so one page can never be a full-layer dump.
CREATE OR REPLACE FUNCTION public.features_page(
  p_layer_id UUID,
  p_filters  JSONB DEFAULT '{}'::jsonb,
  p_search   TEXT  DEFAULT NULL,
  p_sort_key TEXT  DEFAULT NULL,
  p_sort_dir TEXT  DEFAULT 'asc',
  p_limit    INT   DEFAULT 500,
  p_offset   INT   DEFAULT 0
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  where_sql    TEXT;
  search_sql   TEXT := 'TRUE';
  order_sql    TEXT;
  v_dir        TEXT;
  v_field_type TEXT;
  v_limit      INT;
  v_offset     INT;
  sql          TEXT;
  result       JSONB;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  where_sql := public._features_filter_sql(p_filters->'conditions', p_filters->>'logic');

  IF p_search IS NOT NULL AND btrim(p_search) <> '' THEN
    search_sql := format(
      '(f.asset_code ILIKE %L OR EXISTS (SELECT 1 FROM jsonb_each_text(f.properties) kv WHERE kv.value ILIKE %L))',
      '%' || p_search || '%', '%' || p_search || '%');
  END IF;

  v_dir := CASE WHEN lower(COALESCE(p_sort_dir,'asc')) = 'desc' THEN 'DESC' ELSE 'ASC' END;
  IF p_sort_key IS NULL OR btrim(p_sort_key) = '' THEN
    order_sql := 'f.created_at ASC';
  ELSIF p_sort_key IN ('asset_code','created_at') THEN
    order_sql := format('f.%I %s NULLS LAST', p_sort_key, v_dir);
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.fields WHERE layer_id = p_layer_id AND name = p_sort_key) THEN
      RAISE EXCEPTION 'Invalid sort field: %', p_sort_key;
    END IF;
    SELECT type INTO v_field_type FROM public.fields WHERE layer_id = p_layer_id AND name = p_sort_key;
    IF v_field_type IN ('int','float') THEN
      order_sql := format('NULLIF(f.properties->>%L, '''')::numeric %s NULLS LAST', p_sort_key, v_dir);
    ELSE
      order_sql := format('(f.properties->>%L) %s NULLS LAST', p_sort_key, v_dir);
    END IF;
  END IF;

  v_limit  := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 500);   -- never a full-layer dump
  v_offset := GREATEST(COALESCE(p_offset, 0), 0);

  sql := format($f$
    SELECT jsonb_build_object('type','FeatureCollection','features',
      COALESCE(jsonb_agg(jsonb_build_object(
        'type','Feature','id',x.id,
        'geometry', ST_AsGeoJSON(x.geometry)::jsonb,
        'properties', COALESCE(x.properties,'{}'::jsonb) || jsonb_build_object(
          'asset_code', x.asset_code, '__id', x.id, '__layer_id', x.layer_id,
          '__edited_by', x.edited_by_label, '__edited_at', x.edited_at))), '[]'::jsonb))
    FROM (
      SELECT f.*, COALESCE(p.full_name, p.email) AS edited_by_label
      FROM public.features f
      LEFT JOIN public.profiles p ON p.id = f.edited_by
      WHERE f.layer_id = %L AND (%s) AND (%s)
      ORDER BY %s
      LIMIT %s OFFSET %s
    ) x
  $f$, p_layer_id, where_sql, search_sql, order_sql, v_limit, v_offset);

  EXECUTE sql INTO result;
  RETURN COALESCE(result, jsonb_build_object('type','FeatureCollection','features','[]'::jsonb));
END; $$;

GRANT EXECUTE ON FUNCTION public.features_page(UUID, JSONB, TEXT, TEXT, TEXT, INT, INT) TO authenticated, anon;


-- ── features_page_count — exact row count for the SAME predicate as
--    features_page (filters + search, no sort/paging), so the table can show
--    "עמוד X מתוך Y" / "מציג A–B מתוך Z".
CREATE OR REPLACE FUNCTION public.features_page_count(
  p_layer_id UUID,
  p_filters  JSONB DEFAULT '{}'::jsonb,
  p_search   TEXT  DEFAULT NULL
) RETURNS INT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  where_sql  TEXT;
  search_sql TEXT := 'TRUE';
  sql        TEXT;
  result     INT;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  where_sql := public._features_filter_sql(p_filters->'conditions', p_filters->>'logic');

  IF p_search IS NOT NULL AND btrim(p_search) <> '' THEN
    search_sql := format(
      '(asset_code ILIKE %L OR EXISTS (SELECT 1 FROM jsonb_each_text(properties) kv WHERE kv.value ILIKE %L))',
      '%' || p_search || '%', '%' || p_search || '%');
  END IF;

  sql := format(
    'SELECT count(*) FROM public.features WHERE layer_id = %L AND (%s) AND (%s)',
    p_layer_id, where_sql, search_sql);

  EXECUTE sql INTO result;
  RETURN COALESCE(result, 0);
END; $$;

GRANT EXECUTE ON FUNCTION public.features_page_count(UUID, JSONB, TEXT) TO authenticated, anon;


-- ── features_bulk_update — merge a jsonb patch into properties for up to
--    1000 feature ids at once (attribute table multi-row select + bulk edit).
--    SECURITY INVOKER (default): runs as the calling user, so the existing
--    "features write" RLS policy (can_edit_gis()) and the features_autocalc
--    (BEFORE UPDATE — stamps edited_by/edited_at, recomputes length_m/age)
--    and gis_audit (AFTER UPDATE — logs per-row diffs) triggers apply exactly
--    as they do for any other UPDATE. The can_edit_gis() check up front just
--    gives a clear Hebrew-friendly error instead of a generic RLS denial.
CREATE OR REPLACE FUNCTION public.features_bulk_update(
  p_layer_id UUID, p_ids UUID[], p_patch JSONB
) RETURNS INT LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n INT;
BEGIN
  IF NOT public.can_edit_gis() THEN
    RAISE EXCEPTION 'אין הרשאה לערוך פיצ''רים (permission denied)';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  IF array_length(p_ids, 1) > 1000 THEN
    RAISE EXCEPTION 'ניתן לעדכן עד 1000 שורות בבת אחת (התקבלו %) — צמצם את הבחירה', array_length(p_ids, 1);
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'עדכון לא תקין — נדרש אובייקט JSON';
  END IF;

  UPDATE public.features
     SET properties = properties || p_patch
   WHERE layer_id = p_layer_id AND id = ANY(p_ids);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END; $$;

NOTIFY pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════
--  MANUAL TEST SCRIPT (commented) — paste pieces into the Supabase SQL
--  editor, as a signed-in admin/engineer, to sanity-check the new RPCs.
--  Replace <LAYER_ID> with a real layers.id:
--    SELECT id, name, geometry_type FROM public.layers LIMIT 20;
-- ════════════════════════════════════════════════════════════════════════

-- 1) Page 1, no filter/search/sort, 5 rows (default sort = created_at asc):
-- SELECT public.features_page('<LAYER_ID>'::uuid, '{}'::jsonb, NULL, NULL, 'asc', 5, 0);

-- 2) Exact count with no filter:
-- SELECT public.features_page_count('<LAYER_ID>'::uuid, '{}'::jsonb, NULL);

-- 3) Search across property VALUES + asset_code (e.g. any pipe mentioning "PVC"):
-- SELECT public.features_page('<LAYER_ID>'::uuid, '{}'::jsonb, 'PVC', NULL, 'asc', 10, 0);
-- SELECT public.features_page_count('<LAYER_ID>'::uuid, '{}'::jsonb, 'PVC');

-- 4) Structured filter (same shape GIS.queries.parseFilterToSQL() produces client-side):
-- SELECT public.features_page('<LAYER_ID>'::uuid,
--   '{"logic":"and","conditions":[{"field":"status","op":"=","value":"active"}]}'::jsonb,
--   NULL, NULL, 'asc', 10, 0);

-- 5) Sort by a registered field, descending, page 2 (limit 5, offset 5):
-- SELECT public.features_page('<LAYER_ID>'::uuid, '{}'::jsonb, NULL, 'asset_code', 'desc', 5, 5);

-- 6) Unregistered sort field is rejected:
-- SELECT public.features_page('<LAYER_ID>'::uuid, '{}'::jsonb, NULL, 'not_a_real_field', 'asc', 5, 0);
-- -- expect: ERROR: Invalid sort field: not_a_real_field

-- 7) p_limit is clamped even if a caller asks for more than 500:
-- SELECT jsonb_array_length(public.features_page('<LAYER_ID>'::uuid, '{}'::jsonb, NULL, NULL, 'asc', 999999, 0)->'features');
-- -- expect: <= 500 (and <= the layer's total row count)

-- 8) Bulk-update two features' status (run as an admin/engineer session):
-- SELECT public.features_bulk_update('<LAYER_ID>'::uuid,
--   ARRAY(SELECT id FROM public.features WHERE layer_id = '<LAYER_ID>'::uuid LIMIT 2),
--   '{"status":"inactive"}'::jsonb);
-- -- verify the write:
-- SELECT id, properties->>'status' AS status, edited_by, edited_at FROM public.features
--   WHERE layer_id = '<LAYER_ID>'::uuid ORDER BY edited_at DESC NULLS LAST LIMIT 5;
-- -- verify it went through the audit trigger:
-- SELECT * FROM public.gis_audit WHERE layer_id = '<LAYER_ID>'::uuid
--   AND action = 'feature_update' ORDER BY created_at DESC LIMIT 5;

-- 9) Over the 1000-id cap is rejected:
-- SELECT public.features_bulk_update('<LAYER_ID>'::uuid,
--   ARRAY(SELECT gen_random_uuid() FROM generate_series(1,1001)), '{"status":"x"}'::jsonb);
-- -- expect: ERROR: ניתן לעדכן עד 1000 שורות בבת אחת (התקבלו 1001) — צמצם את הבחירה

-- 10) As a viewer-role session (role gate should block, in SQL, before RLS even runs):
-- SELECT public.features_bulk_update('<LAYER_ID>'::uuid,
--   ARRAY(SELECT id FROM public.features WHERE layer_id = '<LAYER_ID>'::uuid LIMIT 1),
--   '{"status":"x"}'::jsonb);
-- -- expect: ERROR: אין הרשאה לערוך פיצ'רים (permission denied)
