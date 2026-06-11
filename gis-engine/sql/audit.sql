-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — Audit trail + "last edited by"
--  Run after schema.sql + editing.sql + extras.sql. Safe to re-run.
--
--  • features gains edited_by / edited_at, set automatically on every write
--    (immutable from the UI — surfaced read-only as __edited_by / __edited_at).
--  • Every feature insert/update/delete and every column add/rename/delete is
--    logged to public.gis_audit by SECURITY DEFINER triggers (cannot be
--    bypassed from the client). Admins read it in the back office.
-- ════════════════════════════════════════════════════════════════════════

-- ── who/when columns ─────────────────────────────────────────────────────
ALTER TABLE public.features ADD COLUMN IF NOT EXISTS edited_by UUID;
ALTER TABLE public.features ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- Re-define the auto-calc trigger to also stamp edited_by/edited_at.
CREATE OR REPLACE FUNCTION public.features_autocalc()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE iy INT;
BEGIN
  NEW.updated_at := NOW();
  NEW.edited_by  := auth.uid();      -- the user making this change
  NEW.edited_at  := NOW();
  IF GeometryType(NEW.geometry) IN ('LINESTRING','MULTILINESTRING') THEN
    NEW.properties := jsonb_set(NEW.properties, '{length_m}',
      to_jsonb(round(ST_Length(NEW.geometry::geography)::numeric, 2)), true);
  END IF;
  IF (NEW.properties ? 'install_year') AND (NEW.properties->>'install_year') ~ '^\d+$' THEN
    iy := (NEW.properties->>'install_year')::int;
    NEW.properties := jsonb_set(NEW.properties, '{age}',
      to_jsonb(EXTRACT(YEAR FROM NOW())::int - iy), true);
  END IF;
  IF NOT (NEW.properties ? 'status') THEN
    NEW.properties := jsonb_set(NEW.properties, '{status}', '"active"', true);
  END IF;
  RETURN NEW;
END; $$;

-- ── audit table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gis_audit (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     UUID,
  user_email  TEXT,
  action      TEXT        NOT NULL,   -- feature_insert|feature_update|feature_delete|field_add|field_rename|field_delete
  layer_id    UUID,
  layer_name  TEXT,
  asset_code  TEXT,
  details     JSONB,                  -- changed fields / column name / old→new
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gis_audit_created ON public.gis_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gis_audit_layer   ON public.gis_audit(layer_id);

ALTER TABLE public.gis_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "gis_audit admin read" ON public.gis_audit;
CREATE POLICY "gis_audit admin read" ON public.gis_audit FOR SELECT USING (public.is_admin());

-- ── feature trigger ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_features()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
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

-- ── field (column) trigger ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_fields()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE uid UUID := auth.uid(); em TEXT; lname TEXT;
BEGIN
  SELECT email INTO em FROM public.profiles WHERE id = uid;
  IF TG_OP = 'INSERT' THEN
    SELECT name INTO lname FROM public.layers WHERE id = NEW.layer_id;
    INSERT INTO public.gis_audit(user_id,user_email,action,layer_id,layer_name,details)
    VALUES (uid, em, 'field_add', NEW.layer_id, lname, jsonb_build_object('field',NEW.name,'type',NEW.type));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT name INTO lname FROM public.layers WHERE id = OLD.layer_id;
    INSERT INTO public.gis_audit(user_id,user_email,action,layer_id,layer_name,details)
    VALUES (uid, em, 'field_delete', OLD.layer_id, lname, jsonb_build_object('field',OLD.name));
    RETURN OLD;
  ELSE
    SELECT name INTO lname FROM public.layers WHERE id = NEW.layer_id;
    INSERT INTO public.gis_audit(user_id,user_email,action,layer_id,layer_name,details)
    VALUES (uid, em, 'field_rename', NEW.layer_id, lname, jsonb_build_object('from',OLD.name,'to',NEW.name));
    RETURN NEW;
  END IF;
END; $$;

DROP TRIGGER IF EXISTS trg_audit_fields ON public.fields;
CREATE TRIGGER trg_audit_fields
  AFTER INSERT OR UPDATE OR DELETE ON public.fields
  FOR EACH ROW EXECUTE FUNCTION public.audit_fields();

-- ── read RPCs now surface __edited_by / __edited_at ──────────────────────
CREATE OR REPLACE FUNCTION public.features_in_bbox(
  p_layer_id UUID, p_minlng FLOAT, p_minlat FLOAT, p_maxlng FLOAT, p_maxlat FLOAT,
  p_limit INT DEFAULT 4000)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('type','FeatureCollection','features',
    COALESCE(jsonb_agg(jsonb_build_object(
      'type','Feature','id',f.id,
      'geometry', ST_AsGeoJSON(f.geometry)::jsonb,
      'properties', f.properties || jsonb_build_object(
        'asset_code',f.asset_code,'__id',f.id,'__layer_id',f.layer_id,
        '__edited_by', COALESCE(p.full_name, p.email), '__edited_at', f.edited_at))), '[]'::jsonb))
  FROM (
    SELECT * FROM public.features
    WHERE layer_id = p_layer_id
      AND geometry && ST_MakeEnvelope(p_minlng, p_minlat, p_maxlng, p_maxlat, 4326)
    LIMIT p_limit
  ) f
  LEFT JOIN public.profiles p ON p.id = f.edited_by;
$$;

CREATE OR REPLACE FUNCTION public.features_geojson(p_layer_id UUID, p_limit INT DEFAULT 5000)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('type','FeatureCollection','features',
    COALESCE(jsonb_agg(jsonb_build_object(
      'type','Feature','id',f.id,
      'geometry', ST_AsGeoJSON(f.geometry)::jsonb,
      'properties', f.properties || jsonb_build_object(
        'asset_code',f.asset_code,'__id',f.id,'__layer_id',f.layer_id,
        '__edited_by', COALESCE(p.full_name, p.email), '__edited_at', f.edited_at))), '[]'::jsonb))
  FROM (SELECT * FROM public.features WHERE layer_id = p_layer_id LIMIT p_limit) f
  LEFT JOIN public.profiles p ON p.id = f.edited_by;
$$;

NOTIFY pgrst, 'reload schema';
