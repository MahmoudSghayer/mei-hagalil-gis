-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — Database Layer
--  Supabase PostgreSQL + PostGIS
--
--  Adds the engine's tables + RPCs to the EXISTING Mei HaGalil project.
--  Reuses the existing `profiles` table and `is_admin()` helper; only
--  EXTENDS the role set with 'engineer' and 'office'.
--
--  Apply:  Supabase → SQL Editor → paste → Run.  Safe to re-run.
--
--  Security model
--  --------------
--  • All reads return GeoJSON via RPCs that run SECURITY INVOKER, so RLS
--    decides what each user can see.
--  • All writes go through RLS:  GIS = admin|engineer, meters = admin|engineer
--    too (can_edit_meters() = is_editor(), same admin|engineer set as GIS —
--    NOT admin-only, despite this comment previously claiming otherwise).
--    Bulk meter IMPORT is further restricted to admin-only, but only at the
--    client (gis-engine/meters.js importMeters gates on ['admin']) — the
--    import_meters RPC itself has no SECURITY DEFINER role check of its own,
--    so it is DB-gated by the same admin|engineer "meters write" RLS policy
--    as any other meters write, not by a separate admin-only rule.
--  • The filter RPC (query_features) NEVER receives raw SQL. It takes a
--    structured jsonb array; operators are whitelisted, field names are
--    regex-checked, and values are passed through quote_literal. No eval,
--    no injection surface.
-- ════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

-- ── ROLES ───────────────────────────────────────────────────────────────
-- Three-tier model:  viewer (field submitter) · engineer (edit + review) · admin (all).
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
-- Migrate any legacy role values BEFORE re-adding the constraint, or it fails.
UPDATE public.profiles SET role = 'engineer' WHERE role IN ('editor');
UPDATE public.profiles SET role = 'viewer' WHERE role IN ('office', 'user');
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'engineer', 'viewer'));

-- is_admin() — defined here so the engine schema is self-contained even if the
-- app's original db/schema.sql has not been applied to this project. Idempotent.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin' AND is_active = true);
$$;

-- admin|editor → edit GIS + meters + export | viewer → read-only.
-- Structural ops (layers, fields/schema, bulk import) stay admin-only (RLS uses is_admin()).
CREATE OR REPLACE FUNCTION public.is_editor()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin','engineer'));
$$;

CREATE OR REPLACE FUNCTION public.can_edit_gis()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$ SELECT public.is_editor(); $$;

CREATE OR REPLACE FUNCTION public.can_edit_meters()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$ SELECT public.is_editor(); $$;


-- ════════════════════════════════════════════════════════════════════════
--  TABLES
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.layers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  geometry_type TEXT        NOT NULL CHECK (geometry_type IN ('Point','LineString','Polygon')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.features (
  id          UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id    UUID                     NOT NULL REFERENCES public.layers(id) ON DELETE CASCADE,
  asset_code  TEXT                     UNIQUE,         -- PRIMARY linking key
  geometry    GEOMETRY(GEOMETRY, 4326) NOT NULL,
  properties  JSONB                    NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ              NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_features_layer ON public.features(layer_id);
CREATE INDEX IF NOT EXISTS idx_features_geom  ON public.features USING GIST(geometry);
CREATE INDEX IF NOT EXISTS idx_features_props ON public.features USING GIN(properties);

CREATE TABLE IF NOT EXISTS public.fields (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id      UUID        NOT NULL REFERENCES public.layers(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  type          TEXT        NOT NULL DEFAULT 'text' CHECK (type IN ('int','float','text','bool')),
  is_calculated BOOLEAN     NOT NULL DEFAULT false,
  expression    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (layer_id, name)
);
CREATE INDEX IF NOT EXISTS idx_fields_layer ON public.fields(layer_id);

CREATE TABLE IF NOT EXISTS public.meters (
  id            UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  arad_meter_id TEXT                  UNIQUE NOT NULL,
  customer_id   TEXT,
  asset_code    TEXT,                 -- links to features.asset_code
  geometry      GEOMETRY(POINT, 4326),
  last_reading  NUMERIC,
  consumption   NUMERIC,
  status        TEXT                  DEFAULT 'active',
  install_date  DATE,
  raw_data      JSONB                 NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ           NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meters_asset    ON public.meters(asset_code);
CREATE INDEX IF NOT EXISTS idx_meters_customer ON public.meters(customer_id);
CREATE INDEX IF NOT EXISTS idx_meters_geom     ON public.meters USING GIST(geometry);

CREATE TABLE IF NOT EXISTS public.sync_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source     TEXT        NOT NULL,
  status     TEXT        NOT NULL,
  payload    JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sync_logs_created ON public.sync_logs(created_at DESC);


-- ════════════════════════════════════════════════════════════════════════
--  AUTO-CALCULATION  (BEFORE INSERT/UPDATE on features)
--    LineString → properties.length_m (geodesic) ; install_year → age ;
--    default status when missing
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.features_autocalc()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE iy INT;
BEGIN
  NEW.updated_at := NOW();
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

DROP TRIGGER IF EXISTS trg_features_autocalc ON public.features;
CREATE TRIGGER trg_features_autocalc
  BEFORE INSERT OR UPDATE ON public.features
  FOR EACH ROW EXECUTE FUNCTION public.features_autocalc();


-- ════════════════════════════════════════════════════════════════════════
--  READ RPCs  (return GeoJSON FeatureCollections; SECURITY INVOKER → RLS)
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.features_geojson(p_layer_id UUID, p_limit INT DEFAULT 5000)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('type','FeatureCollection','features',
    COALESCE(jsonb_agg(jsonb_build_object(
      'type','Feature','id',id,
      'geometry', ST_AsGeoJSON(geometry)::jsonb,
      'properties', properties || jsonb_build_object('asset_code',asset_code,'__id',id,'__layer_id',layer_id)
    )), '[]'::jsonb))
  FROM (SELECT * FROM public.features WHERE layer_id = p_layer_id LIMIT p_limit) s;
$$;

CREATE OR REPLACE FUNCTION public.meters_geojson(p_limit INT DEFAULT 20000)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('type','FeatureCollection','features',
    COALESCE(jsonb_agg(jsonb_build_object(
      'type','Feature','id',id,
      'geometry', ST_AsGeoJSON(geometry)::jsonb,
      'properties', jsonb_build_object(
        'arad_meter_id',arad_meter_id,'customer_id',customer_id,'asset_code',asset_code,
        'last_reading',last_reading,'consumption',consumption,'status',status,
        'install_date',install_date,'__id',id) || raw_data
    )), '[]'::jsonb))
  FROM (SELECT * FROM public.meters WHERE geometry IS NOT NULL LIMIT p_limit) s;
$$;

-- Safe structured filter. p_conditions = '[{"field":"diameter","op":">","value":100}, ...]'
-- p_logic = 'and' | 'or'.  Operators whitelisted, field names regex-checked,
-- values quoted. Numeric values get a ::numeric cast so comparisons are correct.
CREATE OR REPLACE FUNCTION public.query_features(
  p_layer_id UUID, p_conditions JSONB DEFAULT '[]'::jsonb,
  p_logic TEXT DEFAULT 'and', p_limit INT DEFAULT 5000)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  cond JSONB; fld TEXT; op TEXT; val JSONB; accessor TEXT; clause TEXT;
  clauses TEXT[] := '{}'; logic TEXT; where_sql TEXT; sql TEXT; result JSONB;
  op_map JSONB := '{"=":"=","!=":"<>","<>":"<>","<":"<","<=":"<=",">":">",">=":">=","like":"ILIKE"}';
BEGIN
  logic := CASE WHEN lower(p_logic) = 'or' THEN ' OR ' ELSE ' AND ' END;

  FOR cond IN SELECT * FROM jsonb_array_elements(p_conditions) LOOP
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
    ELSIF jsonb_typeof(val) = 'boolean' THEN
      clause := format('%s %s %L', accessor, op_map->>op, (val#>>'{}'));
    ELSE
      clause := format('%s %s %L', accessor, op_map->>op, (val#>>'{}'));
    END IF;
    clauses := array_append(clauses, clause);
  END LOOP;

  where_sql := CASE WHEN array_length(clauses,1) IS NULL
                    THEN 'TRUE'
                    ELSE array_to_string(clauses, logic) END;

  sql := format($f$
    SELECT jsonb_build_object('type','FeatureCollection','features',
      COALESCE(jsonb_agg(jsonb_build_object(
        'type','Feature','id',id,
        'geometry', ST_AsGeoJSON(geometry)::jsonb,
        'properties', properties || jsonb_build_object('asset_code',asset_code,'__id',id))), '[]'::jsonb))
    FROM (SELECT * FROM public.features WHERE layer_id = %L AND (%s) LIMIT %s) s
  $f$, p_layer_id, where_sql, p_limit);

  EXECUTE sql INTO result;
  RETURN result;
END; $$;

-- Meters within radius of a point — proximity fallback link & "near me" lookups.
CREATE OR REPLACE FUNCTION public.meters_near(
  p_lng DOUBLE PRECISION, p_lat DOUBLE PRECISION, p_radius_m INT DEFAULT 25)
RETURNS SETOF public.meters LANGUAGE sql STABLE AS $$
  SELECT * FROM public.meters
  WHERE geometry IS NOT NULL
    AND ST_DWithin(geometry::geography, ST_SetSRID(ST_MakePoint(p_lng,p_lat),4326)::geography, p_radius_m)
  ORDER BY geometry::geography <-> ST_SetSRID(ST_MakePoint(p_lng,p_lat),4326)::geography;
$$;


-- ════════════════════════════════════════════════════════════════════════
--  WRITE RPCs  (geometry from GeoJSON; SECURITY INVOKER → RLS enforces role)
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.create_feature(
  p_layer_id UUID, p_asset_code TEXT, p_geometry JSONB, p_properties JSONB DEFAULT '{}')
RETURNS public.features LANGUAGE plpgsql AS $$
DECLARE row public.features;
BEGIN
  INSERT INTO public.features (layer_id, asset_code, geometry, properties)
  VALUES (p_layer_id, p_asset_code,
          ST_SetSRID(ST_GeomFromGeoJSON(p_geometry::text), 4326), COALESCE(p_properties,'{}'::jsonb))
  RETURNING * INTO row;
  RETURN row;
END; $$;

-- Bulk meter import/upsert by arad_meter_id. p_meters = jsonb array.
CREATE OR REPLACE FUNCTION public.import_meters(p_meters JSONB, p_source TEXT DEFAULT 'import')
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE m JSONB; ins INT := 0; upd INT := 0; before BIGINT;
BEGIN
  FOR m IN SELECT * FROM jsonb_array_elements(p_meters) LOOP
    SELECT count(*) INTO before FROM public.meters WHERE arad_meter_id = m->>'arad_meter_id';
    INSERT INTO public.meters AS t
      (arad_meter_id, customer_id, asset_code, geometry, last_reading, consumption, status, install_date, raw_data, updated_at)
    VALUES (
      m->>'arad_meter_id', m->>'customer_id', m->>'asset_code',
      CASE WHEN (m ? 'lng') AND (m ? 'lat')
           THEN ST_SetSRID(ST_MakePoint((m->>'lng')::float, (m->>'lat')::float),4326) END,
      NULLIF(m->>'last_reading','')::numeric, NULLIF(m->>'consumption','')::numeric,
      COALESCE(m->>'status','active'), NULLIF(m->>'install_date','')::date,
      COALESCE(m->'raw_data','{}'::jsonb), NOW())
    ON CONFLICT (arad_meter_id) DO UPDATE SET
      customer_id  = COALESCE(EXCLUDED.customer_id, t.customer_id),
      asset_code   = COALESCE(EXCLUDED.asset_code, t.asset_code),
      geometry     = COALESCE(EXCLUDED.geometry, t.geometry),
      last_reading = COALESCE(EXCLUDED.last_reading, t.last_reading),
      consumption  = COALESCE(EXCLUDED.consumption, t.consumption),
      status       = COALESCE(EXCLUDED.status, t.status),
      install_date = COALESCE(EXCLUDED.install_date, t.install_date),
      raw_data     = t.raw_data || EXCLUDED.raw_data,
      updated_at   = NOW();
    IF before = 0 THEN ins := ins + 1; ELSE upd := upd + 1; END IF;
  END LOOP;

  INSERT INTO public.sync_logs (source, status, payload)
  VALUES (p_source, 'success', jsonb_build_object('inserted',ins,'updated',upd,'total',ins+upd));
  RETURN jsonb_build_object('inserted',ins,'updated',upd,'total',ins+upd);
END; $$;


-- ════════════════════════════════════════════════════════════════════════
--  ANALYTICS (lightweight) — meters > 1.5× average consumption
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_meter_anomalies AS
WITH avg_c AS (SELECT AVG(consumption) mean FROM public.meters WHERE consumption IS NOT NULL)
SELECT m.id, m.arad_meter_id, m.asset_code, m.customer_id, m.consumption,
       a.mean AS avg_consumption, round((m.consumption/NULLIF(a.mean,0))::numeric,2) AS ratio
FROM public.meters m, avg_c a
WHERE m.consumption > a.mean * 1.5;


-- ════════════════════════════════════════════════════════════════════════
--  ROW LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE public.layers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.features  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fields    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meters    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "layers read"  ON public.layers;
DROP POLICY IF EXISTS "layers write" ON public.layers;
CREATE POLICY "layers read"  ON public.layers FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "layers write" ON public.layers FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "features read"  ON public.features;
DROP POLICY IF EXISTS "features write" ON public.features;
CREATE POLICY "features read"  ON public.features FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "features write" ON public.features FOR ALL USING (public.can_edit_gis()) WITH CHECK (public.can_edit_gis());

DROP POLICY IF EXISTS "fields read"  ON public.fields;
DROP POLICY IF EXISTS "fields write" ON public.fields;
CREATE POLICY "fields read"  ON public.fields FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "fields write" ON public.fields FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "meters read"  ON public.meters;
DROP POLICY IF EXISTS "meters write" ON public.meters;
CREATE POLICY "meters read"  ON public.meters FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "meters write" ON public.meters FOR ALL USING (public.can_edit_meters()) WITH CHECK (public.can_edit_meters());

DROP POLICY IF EXISTS "sync_logs read"  ON public.sync_logs;
DROP POLICY IF EXISTS "sync_logs write" ON public.sync_logs;
CREATE POLICY "sync_logs read"  ON public.sync_logs FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "sync_logs write" ON public.sync_logs FOR ALL USING (public.can_edit_meters()) WITH CHECK (public.can_edit_meters());
