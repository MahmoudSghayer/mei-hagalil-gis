-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — Editing & Migration RPCs
--  Run AFTER schema.sql. Safe to re-run.
--
--  Enables: migrating village GeoJSON into the features table, and ArcGIS-style
--  schema editing (add column / delete column) + value editing.
--  All SECURITY INVOKER → RLS applies. Column ops touch `fields` (admin) AND
--  `features` (admin|engineer) → effectively admin-only.
-- ════════════════════════════════════════════════════════════════════════

-- Find-or-create a layer by name (used by migration so re-runs are idempotent).
CREATE OR REPLACE FUNCTION public.ensure_layer(p_name TEXT, p_geometry_type TEXT)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE lid UUID;
BEGIN
  SELECT id INTO lid FROM public.layers WHERE name = p_name LIMIT 1;
  IF lid IS NULL THEN
    INSERT INTO public.layers (name, geometry_type) VALUES (p_name, p_geometry_type)
    RETURNING id INTO lid;
  END IF;
  RETURN lid;
END; $$;

-- Bulk insert/upsert features from a GeoJSON Feature array. Each feature must
-- carry properties.asset_code (synthesised client-side, kept unique). Geometry
-- comes from the GeoJSON. Idempotent via ON CONFLICT (asset_code).
CREATE OR REPLACE FUNCTION public.import_features(p_layer_id UUID, p_features JSONB)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE f JSONB; n INT := 0; ac TEXT;
BEGIN
  FOR f IN SELECT * FROM jsonb_array_elements(p_features) LOOP
    ac := f->'properties'->>'asset_code';
    IF ac IS NULL OR ac = '' THEN CONTINUE; END IF;
    INSERT INTO public.features (layer_id, asset_code, geometry, properties)
    VALUES (
      p_layer_id, ac,
      ST_SetSRID(ST_GeomFromGeoJSON((f->'geometry')::text), 4326),
      COALESCE(f->'properties', '{}'::jsonb)
    )
    ON CONFLICT (asset_code) DO UPDATE SET
      layer_id   = EXCLUDED.layer_id,
      geometry   = EXCLUDED.geometry,
      properties = EXCLUDED.properties,
      updated_at = NOW();
    n := n + 1;
  END LOOP;
  RETURN n;
END; $$;

-- Add a field (column) to a layer and backfill it on every feature.
CREATE OR REPLACE FUNCTION public.add_layer_field(
  p_layer_id UUID, p_name TEXT, p_type TEXT DEFAULT 'text', p_default JSONB DEFAULT 'null'::jsonb)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_name !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN RAISE EXCEPTION 'Invalid field name: %', p_name; END IF;
  INSERT INTO public.fields (layer_id, name, type)
  VALUES (p_layer_id, p_name, COALESCE(p_type, 'text'))
  ON CONFLICT (layer_id, name) DO NOTHING;
  UPDATE public.features
     SET properties = properties || jsonb_build_object(p_name, p_default), updated_at = NOW()
   WHERE layer_id = p_layer_id AND NOT (properties ? p_name);
END; $$;

-- Delete a field (column) from a layer and strip it from every feature.
CREATE OR REPLACE FUNCTION public.delete_layer_field(p_layer_id UUID, p_name TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.fields WHERE layer_id = p_layer_id AND name = p_name;
  UPDATE public.features
     SET properties = properties - p_name, updated_at = NOW()
   WHERE layer_id = p_layer_id AND (properties ? p_name);
END; $$;
