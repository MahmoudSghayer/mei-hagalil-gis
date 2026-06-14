-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — Water-meter → pipeline auto-connection ("Near" geoprocessing)
--
--  Connects each Arad water meter to its nearest pipe within a configurable
--  metric threshold, PostGIS-side (KNN), and records the link + provenance on
--  the meters row. Mirrors how professional utility GIS (ArcGIS Utility
--  Network "Near"/connectivity) does service-point connectivity.
--
--  Design (confirmed with product owner):
--    • No pipe within threshold  → leave unconnected, FLAG it (connection_type
--      = 'NONE') so it surfaces in a QA list. Never force a far-away pipe.
--    • Auto-detection runs SERVER-SIDE in this SQL (KNN), not in the browser.
--    • Manual overrides are never clobbered by a re-run (connection_type
--      'MANUAL' is preserved).
--
--  Distance is METRIC via ::geography casts — the house style in this schema
--  (see meters_near / features_autocalc), NOT an EPSG:2039 transform.
--  Candidate prefilter uses the GIST index on geometry (`&&` + ST_Expand) so
--  KNN stays fast; ST_DWithin(geography) then does the exact metric cut.
--
--  Apply:  Supabase → SQL Editor → paste → Run.  Safe to re-run.
--  Run AFTER schema.sql + extras.sql.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1) Connection columns on meters ─────────────────────────────────────
ALTER TABLE public.meters
  ADD COLUMN IF NOT EXISTS connected_pipe_id     UUID REFERENCES public.features(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS connection_type       TEXT DEFAULT 'NONE'
                                                 CHECK (connection_type IN ('AUTO','MANUAL','NONE')),
  ADD COLUMN IF NOT EXISTS connection_distance_m NUMERIC,
  ADD COLUMN IF NOT EXISTS connection_point      GEOMETRY(POINT, 4326),  -- snap point ON the pipe
  ADD COLUMN IF NOT EXISTS connection_ambiguous  BOOLEAN DEFAULT false,  -- 2nd-nearest pipe almost as close
  ADD COLUMN IF NOT EXISTS connection_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS connection_updated_by UUID;

CREATE INDEX IF NOT EXISTS idx_meters_conn_pipe ON public.meters(connected_pipe_id);
CREATE INDEX IF NOT EXISTS idx_meters_conn_type ON public.meters(connection_type);

-- 90000 (not 111320) so the degree-box always covers >= threshold metres in BOTH
-- axes at Israeli latitudes (1° lng ≈ 93 km at lat 33). Over-inclusive prefilter
-- is safe — ST_DWithin(geography) applies the exact metric cut afterwards.


-- ── 2) Candidate pipes for ONE meter (top-k nearest within threshold) ────
--  Used by the "change connection" UI so the user can pick among alternatives.
--  SECURITY DEFINER + one-time auth guard (same pattern as meters_in_bbox).
CREATE OR REPLACE FUNCTION public.meter_pipe_candidates(
  p_meter_id    UUID,
  p_layer_ids   UUID[],
  p_threshold_m FLOAT DEFAULT 25,
  p_k           INT   DEFAULT 5)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH m AS (
    SELECT geometry FROM public.meters
    WHERE id = p_meter_id AND geometry IS NOT NULL
      AND (SELECT auth.uid()) IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(c ORDER BY (c->>'distance_m')::numeric), '[]'::jsonb)
  FROM m, LATERAL (
    SELECT jsonb_build_object(
             'pipe_id',    f.id,
             'asset_code', f.asset_code,
             'layer_id',   f.layer_id,
             'layer_name', l.name,
             'distance_m', round(ST_Distance(m.geometry::geography, f.geometry::geography)::numeric, 2),
             'snap',       ST_AsGeoJSON(ST_ClosestPoint(f.geometry, m.geometry))::jsonb
           ) AS c
    FROM public.features f
    JOIN public.layers l ON l.id = f.layer_id
    WHERE f.layer_id = ANY(p_layer_ids)
      AND f.geometry && ST_Expand(m.geometry, p_threshold_m / 90000.0)
      AND ST_DWithin(m.geometry::geography, f.geometry::geography, p_threshold_m)
    ORDER BY ST_Distance(m.geometry::geography, f.geometry::geography)
    LIMIT GREATEST(p_k, 1)
  ) cand;
$$;


-- ── 3) Bulk auto-connect (KNN) ──────────────────────────────────────────
--  For every eligible meter, find its nearest pipe within p_threshold_m and
--  record an AUTO connection; meters with no pipe in range are flagged 'NONE'.
--  MANUAL connections are always preserved. p_only_unset=true touches only
--  meters that are not yet connected (re-run friendly); false re-evaluates all
--  non-MANUAL meters. Optional bbox lets the UI run it per village/viewport so
--  the whole-fleet pass never hits the statement timeout.
--  Admin only (write to meters). SECURITY DEFINER + can_edit_meters() guard.
CREATE OR REPLACE FUNCTION public.autoconnect_meters(
  p_layer_ids   UUID[],
  p_threshold_m FLOAT   DEFAULT 25,
  p_only_unset  BOOLEAN DEFAULT true,
  p_minlng FLOAT DEFAULT NULL, p_minlat FLOAT DEFAULT NULL,
  p_maxlng FLOAT DEFAULT NULL, p_maxlat FLOAT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_targets   INT  := 0;
  v_connected INT  := 0;
  v_unmatched INT  := 0;
  v_ambiguous INT  := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;
  IF NOT public.can_edit_meters() THEN
    RAISE EXCEPTION 'Permission denied: only admin can auto-connect meters.';
  END IF;
  IF p_layer_ids IS NULL OR array_length(p_layer_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No pipe layers given.';
  END IF;

  -- Eligible meters. MANUAL is ALWAYS preserved. p_only_unset restricts to
  -- meters not yet connected (connection_type NONE/NULL).
  CREATE TEMP TABLE _ac_targets ON COMMIT DROP AS
    SELECT id, geometry
    FROM public.meters
    WHERE geometry IS NOT NULL
      AND COALESCE(connection_type, 'NONE') <> 'MANUAL'
      AND (NOT p_only_unset OR COALESCE(connection_type, 'NONE') = 'NONE')
      AND (p_minlng IS NULL
           OR geometry && ST_MakeEnvelope(p_minlng, p_minlat, p_maxlng, p_maxlat, 4326));
  SELECT count(*) INTO v_targets FROM _ac_targets;

  -- Nearest pipe (+ 2nd-nearest distance for the ambiguity flag) per meter.
  CREATE TEMP TABLE _ac_near ON COMMIT DROP AS
    SELECT t.id AS meter_id, c.pipe_id, c.asset_code, c.dist, c.snap, c.dist2
    FROM _ac_targets t
    CROSS JOIN LATERAL (
      SELECT pipe_id, asset_code, dist, snap,
             row_number() OVER (ORDER BY dist) AS rn,
             lead(dist)   OVER (ORDER BY dist) AS dist2
      FROM (
        SELECT f.id AS pipe_id, f.asset_code,
               ST_Distance(t.geometry::geography, f.geometry::geography) AS dist,
               ST_ClosestPoint(f.geometry, t.geometry)                   AS snap
        FROM public.features f
        WHERE f.layer_id = ANY(p_layer_ids)
          AND f.geometry && ST_Expand(t.geometry, p_threshold_m / 90000.0)
          AND ST_DWithin(t.geometry::geography, f.geometry::geography, p_threshold_m)
        ORDER BY ST_Distance(t.geometry::geography, f.geometry::geography)
        LIMIT 2
      ) q
    ) c
    WHERE c.rn = 1;

  -- Matched → AUTO connection.
  UPDATE public.meters m SET
    connected_pipe_id     = n.pipe_id,
    asset_code            = COALESCE(n.asset_code, m.asset_code),
    connection_type       = 'AUTO',
    connection_distance_m = round(n.dist::numeric, 2),
    connection_point      = ST_SetSRID(n.snap, 4326),
    connection_ambiguous  = (n.dist2 IS NOT NULL AND n.dist2 <= n.dist * 1.15 + 0.5),
    connection_updated_at = NOW(),
    connection_updated_by = v_uid,
    updated_at            = NOW()
  FROM _ac_near n
  WHERE m.id = n.meter_id;
  GET DIAGNOSTICS v_connected = ROW_COUNT;

  SELECT count(*) INTO v_ambiguous
  FROM _ac_near WHERE dist2 IS NOT NULL AND dist2 <= dist * 1.15 + 0.5;

  -- Unmatched targets → flag NONE. Only clear asset_code if WE owned it (AUTO).
  UPDATE public.meters m SET
    connection_type       = 'NONE',
    connected_pipe_id     = NULL,
    connection_distance_m = NULL,
    connection_point      = NULL,
    connection_ambiguous  = false,
    asset_code            = CASE WHEN m.connection_type = 'AUTO' THEN NULL ELSE m.asset_code END,
    connection_updated_at = NOW(),
    connection_updated_by = v_uid,
    updated_at            = NOW()
  FROM _ac_targets t
  WHERE m.id = t.id
    AND NOT EXISTS (SELECT 1 FROM _ac_near n WHERE n.meter_id = m.id);
  GET DIAGNOSTICS v_unmatched = ROW_COUNT;

  INSERT INTO public.sync_logs (source, status, payload)
  VALUES ('autoconnect', 'success', jsonb_build_object(
    'targets', v_targets, 'connected', v_connected, 'unmatched', v_unmatched,
    'ambiguous', v_ambiguous, 'threshold_m', p_threshold_m));

  RETURN jsonb_build_object(
    'targets', v_targets, 'connected', v_connected, 'unmatched', v_unmatched,
    'ambiguous', v_ambiguous, 'threshold_m', p_threshold_m);
END; $$;


-- ── 4) Manual override: connect one meter to a chosen pipe ───────────────
CREATE OR REPLACE FUNCTION public.connect_meter(
  p_meter_id UUID, p_pipe_id UUID, p_type TEXT DEFAULT 'MANUAL')
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_dist  NUMERIC;
  v_snap  GEOMETRY;
  v_asset TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;
  IF NOT public.can_edit_meters() THEN
    RAISE EXCEPTION 'Permission denied: only admin can edit meter connections.';
  END IF;
  IF p_type NOT IN ('MANUAL', 'AUTO') THEN
    RAISE EXCEPTION 'Invalid connection type: %', p_type;
  END IF;

  SELECT f.asset_code,
         round(ST_Distance(m.geometry::geography, f.geometry::geography)::numeric, 2),
         ST_ClosestPoint(f.geometry, m.geometry)
    INTO v_asset, v_dist, v_snap
  FROM public.meters m, public.features f
  WHERE m.id = p_meter_id AND f.id = p_pipe_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meter or pipe not found.';
  END IF;

  UPDATE public.meters SET
    connected_pipe_id     = p_pipe_id,
    asset_code            = COALESCE(v_asset, asset_code),
    connection_type       = p_type,
    connection_distance_m = v_dist,
    connection_point      = v_snap,
    connection_ambiguous  = false,
    connection_updated_at = NOW(),
    connection_updated_by  = v_uid,
    updated_at            = NOW()
  WHERE id = p_meter_id;

  RETURN jsonb_build_object('meter_id', p_meter_id, 'pipe_id', p_pipe_id,
    'type', p_type, 'distance_m', v_dist, 'asset_code', v_asset);
END; $$;


-- ── 5) Remove a meter's connection ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.disconnect_meter(p_meter_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;
  IF NOT public.can_edit_meters() THEN
    RAISE EXCEPTION 'Permission denied: only admin can edit meter connections.';
  END IF;

  UPDATE public.meters SET
    connection_type       = 'NONE',
    connected_pipe_id     = NULL,
    connection_distance_m = NULL,
    connection_point      = NULL,
    connection_ambiguous  = false,
    -- clearing a deliberate connection also clears the asset link it created
    asset_code            = CASE WHEN connection_type IN ('AUTO', 'MANUAL') THEN NULL ELSE asset_code END,
    connection_updated_at = NOW(),
    connection_updated_by  = v_uid,
    updated_at            = NOW()
  WHERE id = p_meter_id;

  RETURN jsonb_build_object('meter_id', p_meter_id, 'type', 'NONE');
END; $$;


-- ── 6) Re-expose connection fields in the meter read RPCs ────────────────
--  These SUPERSEDE the definitions in schema.sql / extras.sql: same shape,
--  plus connection_* props so the map/UI can show connection status & draw
--  the meter→pipe connector line (connection_point).
CREATE OR REPLACE FUNCTION public.meters_geojson(p_limit INT DEFAULT 20000)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('type','FeatureCollection','features',
    COALESCE(jsonb_agg(jsonb_build_object(
      'type','Feature','id',id,
      'geometry', ST_AsGeoJSON(geometry)::jsonb,
      'properties', jsonb_build_object(
        'arad_meter_id',arad_meter_id,'customer_id',customer_id,'asset_code',asset_code,
        'last_reading',last_reading,'consumption',consumption,'status',status,
        'install_date',install_date,'__id',id,
        'connection_type',connection_type,'connected_pipe_id',connected_pipe_id,
        'connection_distance_m',connection_distance_m,'connection_ambiguous',connection_ambiguous,
        'connection_point', CASE WHEN connection_point IS NULL THEN NULL
                                 ELSE ST_AsGeoJSON(connection_point)::jsonb END
      ) || raw_data
    )), '[]'::jsonb))
  FROM (SELECT * FROM public.meters WHERE geometry IS NOT NULL LIMIT p_limit) s;
$$;

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
        'install_date',install_date,'__id',id,
        'connection_type',connection_type,'connected_pipe_id',connected_pipe_id,
        'connection_distance_m',connection_distance_m,'connection_ambiguous',connection_ambiguous,
        'connection_point', CASE WHEN connection_point IS NULL THEN NULL
                                 ELSE ST_AsGeoJSON(connection_point)::jsonb END
      ))), '[]'::jsonb))  -- raw_data deliberately NOT spread: it is the full Hebrew
                          -- Arad CSV row per meter, and aggregating ~8000 of them for
                          -- a dense village (עראבה) blows the statement timeout. The
                          -- map popup never reads it — fetch full row on demand.
  FROM (
    SELECT * FROM public.meters
    WHERE (SELECT auth.uid()) IS NOT NULL
      AND geometry IS NOT NULL
      AND geometry && ST_MakeEnvelope(p_minlng, p_minlat, p_maxlng, p_maxlat, 4326)
    LIMIT p_limit
  ) s;
$$;
