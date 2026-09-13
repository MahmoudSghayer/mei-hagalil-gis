-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — Edit Mode: authorized, validated, concurrency-safe geometry
--  writes (move / reshape / extend / shorten a feature's geometry on the map)
--  ──────────────────────────────────────────────────────────────────────
--  Purpose (production Edit Mode gaps found in review):
--    • update_feature_geometry had NO permission check of its own — a viewer
--      calling the RPC directly just got a misleading "Feature not found"
--      (RLS silently filtered the UPDATE to 0 rows) instead of a clear
--      permission-denied error.
--    • Neither update_feature_geometry nor create_feature validated the
--      incoming geometry at all — a self-intersecting polygon, an empty/
--      malformed geometry, a geometry of the wrong type for the layer, or
--      coordinates outside Israel (e.g. a lng/lat swap) would be written
--      straight into the table.
--    • update_feature_geometry had no optimistic-concurrency check — two
--      editors moving the same feature was last-write-wins with no warning.
--    • The audit trigger (audit_features()) only diffed `properties` — a
--      pure geometry move (no property change) wrote NO gis_audit row at
--      all, so geometry edits were invisible in the back-office log.
--
--  Fix, this migration:
--    • public.validate_feature_geometry(p_layer_id, p_geometry) — shared
--      STABLE helper: rejects NULL/empty geometry, invalid geometry
--      (ST_IsValid/ST_IsValidReason), a geometry type family that doesn't
--      match the layer's geometry_type (Point/LineString/Polygon vs. their
--      Multi* forms — features.geometry is untyped GEOMETRY(GEOMETRY,4326)
--      so Multi* rows are legal even though layers.geometry_type only
--      records the singular family), too few vertices for the family, and
--      coordinates outside the app's Israel bounding box.
--    • update_feature_geometry(p_id, p_geometry, p_expected_edited_at
--      DEFAULT NULL) is DROPped and re-created with a 3rd optional param:
--      explicit can_edit_gis() guard first (Hebrew message, stable English
--      suffix so gis-engine/core.js can classify it), row locked with
--      SELECT ... FOR UPDATE, existence check, optimistic-concurrency check
--      against p_expected_edited_at (IS DISTINCT FROM — NULL means "skip
--      the check", used by undo/redo and the deliberate "overwrite anyway"
--      path), geometry validated via the helper, then the UPDATE. Stays
--      SECURITY INVOKER (default) so the "features write" RLS policy and
--      the features_autocalc / gis_audit triggers apply exactly as for any
--      other UPDATE — the guard here just gives a clear message before RLS
--      would otherwise silently no-op the write.
--    • create_feature gets the identical can_edit_gis() guard + validation
--      before the INSERT (same signature — no client change needed there).
--    • audit_features() gets an added geometry old/new diff (GeoJSON via
--      ST_AsGeoJSON), merged into the SAME feature_update `details` object
--      under key 'geometry' — js/pages/gis-logs.js's generic before/after
--      renderer already prints whatever keys `details` has, no UI change
--      needed. Re-created SECURITY DEFINER, trigger re-attached.
--
--  Every RAISE EXCEPTION message is Hebrew, ending in one of four stable
--  English suffixes the client matches on (gis-engine/core.js
--  GIS.classifyError): (permission denied) | (not found) | (conflict) |
--  (invalid geometry). Mirrors the guard style of features_bulk_update /
--  import_meters (see the 2026-07-14 migrations in this folder).
--
--  Run AFTER schema.sql, editing.sql, audit.sql, db/field-workflow.sql
--  (needs public.features, public.layers, public.can_edit_gis(),
--  public.gis_audit, public.features_autocalc). Idempotent
--  (CREATE OR REPLACE / DROP ... IF EXISTS); safe to re-run.
--
--  NOTE: gis-engine/sql/editing.sql now carries the same 3-arg
--  update_feature_geometry (and drops the old 2-arg overload) so a re-run
--  of the base files never reintroduces an ambiguous overload pair; still,
--  if you ever re-run schema.sql / audit.sql, RE-APPLY this migration
--  afterwards (they re-create create_feature / audit_features without the
--  guard, validation and geometry diff added here).
--  Apply: Supabase → SQL Editor → paste this file → Run. See the manual
--  verification block at the bottom for post-apply checks.
-- ════════════════════════════════════════════════════════════════════════

-- ── shared geometry validation ───────────────────────────────────────────
-- Israel bounding box: lng 33.5–36.5, lat 29–34 (same box used elsewhere in
-- the app for sanity-checking imported coordinates).
CREATE OR REPLACE FUNCTION public.validate_feature_geometry(p_layer_id UUID, p_geometry GEOMETRY)
RETURNS VOID LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  family TEXT;   -- layers.geometry_type: 'Point' | 'LineString' | 'Polygon'
  gtype  TEXT;   -- GeometryType(p_geometry): POINT/MULTIPOINT/LINESTRING/... etc.
  npts   INT;
BEGIN
  IF p_geometry IS NULL OR ST_IsEmpty(p_geometry) THEN
    RAISE EXCEPTION 'גאומטריה חסרה או ריקה (invalid geometry)';
  END IF;

  IF NOT ST_IsValid(p_geometry) THEN
    RAISE EXCEPTION 'גאומטריה לא תקינה: % (invalid geometry)', ST_IsValidReason(p_geometry);
  END IF;

  SELECT geometry_type INTO family FROM public.layers WHERE id = p_layer_id;
  IF family IS NULL THEN
    RAISE EXCEPTION 'שכבה % לא נמצאה (not found)', p_layer_id;
  END IF;

  gtype := GeometryType(p_geometry);
  IF (family = 'Point'      AND gtype NOT IN ('POINT', 'MULTIPOINT'))
  OR (family = 'LineString' AND gtype NOT IN ('LINESTRING', 'MULTILINESTRING'))
  OR (family = 'Polygon'    AND gtype NOT IN ('POLYGON', 'MULTIPOLYGON')) THEN
    RAISE EXCEPTION 'סוג הגאומטריה (%) אינו תואם לסוג השכבה (%) (invalid geometry)', gtype, family;
  END IF;

  npts := ST_NPoints(p_geometry);
  IF (family = 'LineString' AND npts < 2) OR (family = 'Polygon' AND npts < 4) THEN
    RAISE EXCEPTION 'מספר נקודות לא מספיק בגאומטריה (%) (invalid geometry)', npts;
  END IF;

  IF ST_XMin(p_geometry) < 33.5 OR ST_XMax(p_geometry) > 36.5
  OR ST_YMin(p_geometry) < 29   OR ST_YMax(p_geometry) > 34 THEN
    RAISE EXCEPTION 'הגאומטריה מחוץ לתחום הגיאוגרפי הצפוי (invalid geometry)';
  END IF;
END; $$;

GRANT EXECUTE ON FUNCTION public.validate_feature_geometry(UUID, GEOMETRY) TO authenticated;

-- ── update_feature_geometry — authorized, validated, concurrency-checked ─
-- Old 2-argument overload dropped first so PostgREST resolves to a single
-- unambiguous signature (a stray 2-arg + 3-arg pair would make PostgREST
-- reject calls with "Could not choose the best candidate function").
DROP FUNCTION IF EXISTS public.update_feature_geometry(UUID, JSONB);

-- On-map editing — geometry write (ArcGIS "Edit" tab: move / reshape /
-- extend / shorten). p_expected_edited_at is the client's last-known
-- features.edited_at (the concurrency token, fetched via
-- GIS.features.getEditToken before editing starts): when given, the write
-- is rejected with (conflict) if the row changed since — IS DISTINCT FROM
-- so a NULL stored edited_at still compares correctly. NULL (the default)
-- skips the check entirely: used by undo/redo (an explicit override) and by
-- the client's own "overwrite anyway" confirmation after a conflict.
-- SECURITY INVOKER (default) → the "features write" RLS policy
-- (can_edit_gis()) and the features_autocalc / gis_audit triggers apply
-- exactly as for any other UPDATE; the guard below exists only to turn a
-- silent RLS no-op into a clear, classifiable error.
CREATE OR REPLACE FUNCTION public.update_feature_geometry(
  p_id UUID, p_geometry JSONB, p_expected_edited_at TIMESTAMPTZ DEFAULT NULL
) RETURNS public.features LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  row  public.features;
  geom GEOMETRY;
BEGIN
  IF NOT public.can_edit_gis() THEN
    RAISE EXCEPTION 'אין הרשאה לערוך גאומטריה (permission denied)';
  END IF;

  SELECT * INTO row FROM public.features WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'הישות % לא נמצאה (not found)', p_id;
  END IF;

  IF p_expected_edited_at IS NOT NULL AND row.edited_at IS DISTINCT FROM p_expected_edited_at THEN
    RAISE EXCEPTION 'הישות עודכנה על ידי משתמש אחר בינתיים (conflict)';
  END IF;

  -- Malformed GeoJSON (or a Feature/FeatureCollection instead of a bare
  -- geometry) makes ST_GeomFromGeoJSON raise a raw PostGIS error; wrap it
  -- so the client still gets a classifiable (invalid geometry) message.
  BEGIN
    geom := ST_SetSRID(ST_GeomFromGeoJSON(p_geometry::text), 4326);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'GeoJSON לא תקין: % (invalid geometry)', SQLERRM;
  END;
  PERFORM public.validate_feature_geometry(row.layer_id, geom);

  UPDATE public.features
     SET geometry   = geom,
         updated_at = NOW()
   WHERE id = p_id
  RETURNING * INTO row;

  RETURN row;
END; $$;

GRANT EXECUTE ON FUNCTION public.update_feature_geometry(UUID, JSONB, TIMESTAMPTZ) TO authenticated;

-- ── create_feature — same signature, now guarded + validated ────────────
CREATE OR REPLACE FUNCTION public.create_feature(
  p_layer_id UUID, p_asset_code TEXT, p_geometry JSONB, p_properties JSONB DEFAULT '{}'
) RETURNS public.features LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  row  public.features;
  geom GEOMETRY;
BEGIN
  IF NOT public.can_edit_gis() THEN
    RAISE EXCEPTION 'אין הרשאה ליצור ישות (permission denied)';
  END IF;

  -- Malformed GeoJSON (or a Feature/FeatureCollection instead of a bare
  -- geometry) makes ST_GeomFromGeoJSON raise a raw PostGIS error; wrap it
  -- so the client still gets a classifiable (invalid geometry) message.
  BEGIN
    geom := ST_SetSRID(ST_GeomFromGeoJSON(p_geometry::text), 4326);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'GeoJSON לא תקין: % (invalid geometry)', SQLERRM;
  END;
  PERFORM public.validate_feature_geometry(p_layer_id, geom);

  INSERT INTO public.features (layer_id, asset_code, geometry, properties)
  VALUES (p_layer_id, p_asset_code, geom, COALESCE(p_properties, '{}'::jsonb))
  RETURNING * INTO row;

  RETURN row;
END; $$;

GRANT EXECUTE ON FUNCTION public.create_feature(UUID, TEXT, JSONB, JSONB) TO authenticated;

-- ── audit_features() — add a geometry old/new diff to feature_update ────
-- Action name stays 'feature_update' (js/pages/gis-logs.js's generic
-- before/after renderer prints whatever keys `details` carries, so a pure
-- geometry move now shows up there with no UI change). Properties-diff
-- behaviour is unchanged; a row that changes ONLY geometry (no property
-- diff) now still gets an audit row because of the new `ch IS NULL THEN '{}'`
-- fallback below.
CREATE OR REPLACE FUNCTION public.audit_features()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid UUID := auth.uid(); em TEXT; lname TEXT; ch JSONB;
BEGIN
  SELECT email INTO em FROM public.profiles WHERE id = uid;
  IF TG_OP = 'DELETE' THEN
    SELECT name INTO lname FROM public.layers WHERE id = OLD.layer_id;
    INSERT INTO public.gis_audit(user_id,user_email,action,layer_id,layer_name,asset_code,details)
    VALUES (uid, em, 'feature_delete', OLD.layer_id, lname, OLD.asset_code, OLD.properties);
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT name INTO lname FROM public.layers WHERE id = NEW.layer_id;
    INSERT INTO public.gis_audit(user_id,user_email,action,layer_id,layer_name,asset_code,details)
    VALUES (uid, em, 'feature_insert', NEW.layer_id, lname, NEW.asset_code, NEW.properties);
    RETURN NEW;
  ELSE
    SELECT jsonb_object_agg(k, jsonb_build_object('old', OLD.properties->k, 'new', NEW.properties->k))
      INTO ch
      FROM (SELECT DISTINCT key AS k FROM (
              SELECT jsonb_object_keys(OLD.properties) AS key
              UNION SELECT jsonb_object_keys(NEW.properties)) z) keys
     WHERE (OLD.properties->k) IS DISTINCT FROM (NEW.properties->k)
       AND k NOT IN ('length_m','age');   -- skip noisy auto-derived fields

    IF OLD.geometry IS DISTINCT FROM NEW.geometry THEN
      ch := COALESCE(ch, '{}'::jsonb) || jsonb_build_object('geometry',
        jsonb_build_object(
          'old', ST_AsGeoJSON(OLD.geometry)::jsonb,
          'new', ST_AsGeoJSON(NEW.geometry)::jsonb));
    END IF;

    IF ch IS NOT NULL THEN
      SELECT name INTO lname FROM public.layers WHERE id = NEW.layer_id;
      INSERT INTO public.gis_audit(user_id,user_email,action,layer_id,layer_name,asset_code,details)
      VALUES (uid, em, 'feature_update', NEW.layer_id, lname, NEW.asset_code, ch);
    END IF;
    RETURN NEW;
  END IF;
END; $$;

DROP TRIGGER IF EXISTS trg_audit_features ON public.features;
CREATE TRIGGER trg_audit_features
  AFTER INSERT OR UPDATE OR DELETE ON public.features
  FOR EACH ROW EXECUTE FUNCTION public.audit_features();


-- ════════════════════════════════════════════════════════════════════════
--  MANUAL TEST SCRIPT (commented) — paste pieces into the Supabase SQL
--  editor to sanity-check the new guards/validation/audit. Replace
--  <LAYER_ID> / <FEATURE_ID> with real ids:
--    SELECT id, name, geometry_type FROM public.layers LIMIT 20;
--    SELECT id, layer_id, asset_code, edited_at FROM public.features LIMIT 20;
--
--  1) ENGINEER/ADMIN session — ordinary move (a small lng/lat nudge on a
--     known LineString feature), no concurrency token:
--     SELECT public.update_feature_geometry('<FEATURE_ID>'::uuid,
--       '{"type":"LineString","coordinates":[[35.1,32.9],[35.2,33.0]]}'::jsonb);
--     -- expect: returns the updated row; SELECT * FROM public.gis_audit
--     -- WHERE action='feature_update' ORDER BY created_at DESC LIMIT 1
--     -- shows details.geometry.old/new.
--
--  2) VIEWER session — same call:
--     SELECT public.update_feature_geometry('<FEATURE_ID>'::uuid,
--       '{"type":"LineString","coordinates":[[35.1,32.9],[35.2,33.0]]}'::jsonb);
--     -- expect: ERROR אין הרשאה לערוך גאומטריה (permission denied)
--
--  3) CONCURRENCY conflict — pass a p_expected_edited_at that does not match
--     the row's current edited_at (e.g. an old timestamp captured before
--     another edit landed):
--     SELECT public.update_feature_geometry('<FEATURE_ID>'::uuid,
--       '{"type":"LineString","coordinates":[[35.1,32.9],[35.2,33.0]]}'::jsonb,
--       '2020-01-01T00:00:00Z'::timestamptz);
--     -- expect: ERROR הישות עודכנה על ידי משתמש אחר בינתיים (conflict)
--     -- (then confirm the matching current token succeeds:)
--     SELECT public.update_feature_geometry('<FEATURE_ID>'::uuid,
--       '{"type":"LineString","coordinates":[[35.1,32.9],[35.2,33.0]]}'::jsonb,
--       (SELECT edited_at FROM public.features WHERE id = '<FEATURE_ID>'::uuid));
--
--  4) INVALID geometry — self-intersecting polygon (bowtie) and out-of-bounds
--     point:
--     SELECT public.update_feature_geometry('<FEATURE_ID>'::uuid,
--       '{"type":"Polygon","coordinates":[[[0,0],[1,1],[1,0],[0,1],[0,0]]]}'::jsonb);
--     -- expect: ERROR ...(invalid geometry)
--     SELECT public.create_feature('<LAYER_ID>'::uuid, 'TEST-OOB',
--       '{"type":"Point","coordinates":[0,0]}'::jsonb, '{}'::jsonb);
--     -- expect: ERROR הגאומטריה מחוץ לתחום הגיאוגרפי הצפוי (invalid geometry)
--
--  5) NOT FOUND — a random uuid:
--     SELECT public.update_feature_geometry(gen_random_uuid(),
--       '{"type":"Point","coordinates":[35.1,32.9]}'::jsonb);
--     -- expect: ERROR ...לא נמצאה (not found)
--
--  6) AUDIT — confirm a pure geometry move (no property change) now still
--     writes a gis_audit row (previously it wrote nothing at all):
--     SELECT details->'geometry' FROM public.gis_audit
--       WHERE action = 'feature_update' ORDER BY created_at DESC LIMIT 1;
--
--  7) LEGACY DATA SWEEP (run once, BEFORE relying on undo-of-delete) — rows
--     written before this migration were never validated. create_feature
--     now validates, so restoring (undo) a deleted legacy row whose stored
--     geometry is invalid / out of bounds / wrong family would be refused
--     with (invalid geometry). List such rows and repair them first
--     (ST_MakeValid, or fix the layer's geometry_type):
--     SELECT f.id, f.asset_code, l.name, GeometryType(f.geometry) AS gtype,
--            ST_IsValidReason(f.geometry) AS reason
--       FROM public.features f JOIN public.layers l ON l.id = f.layer_id
--      WHERE NOT ST_IsValid(f.geometry)
--         OR ST_IsEmpty(f.geometry)
--         OR ST_XMin(f.geometry) < 33.5 OR ST_XMax(f.geometry) > 36.5
--         OR ST_YMin(f.geometry) < 29   OR ST_YMax(f.geometry) > 34
--         OR (l.geometry_type = 'Point'      AND GeometryType(f.geometry) NOT IN ('POINT','MULTIPOINT'))
--         OR (l.geometry_type = 'LineString' AND GeometryType(f.geometry) NOT IN ('LINESTRING','MULTILINESTRING'))
--         OR (l.geometry_type = 'Polygon'    AND GeometryType(f.geometry) NOT IN ('POLYGON','MULTIPOLYGON'));
-- ════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';
