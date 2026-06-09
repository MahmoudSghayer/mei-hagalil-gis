-- Example dataset for the GIS Engine. Run AFTER schema.sql. Safe to re-run.
-- Coordinates around Sakhnin / Arraba (northern Israel).

INSERT INTO public.layers (id, name, geometry_type) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Pipes',    'LineString'),
  ('22222222-2222-2222-2222-222222222222', 'Valves',   'Point'),
  ('33333333-3333-3333-3333-333333333333', 'Hydrants', 'Point')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.fields (layer_id, name, type, is_calculated, expression) VALUES
  ('11111111-1111-1111-1111-111111111111', 'diameter',     'int',   false, NULL),
  ('11111111-1111-1111-1111-111111111111', 'material',     'text',  false, NULL),
  ('11111111-1111-1111-1111-111111111111', 'install_year', 'int',   false, NULL),
  ('11111111-1111-1111-1111-111111111111', 'age',          'int',   true,  '2026 - install_year'),
  ('11111111-1111-1111-1111-111111111111', 'risk_score',   'float', true,  'age * 0.5 + diameter * 0.01')
ON CONFLICT (layer_id, name) DO NOTHING;

-- Pipes (length_m + age auto-computed by the trigger)
INSERT INTO public.features (layer_id, asset_code, geometry, properties) VALUES
  ('11111111-1111-1111-1111-111111111111', 'PIPE-1001',
    ST_GeomFromText('LINESTRING(35.2960 32.8650, 35.2985 32.8662)',4326),
    '{"diameter":160,"material":"PVC","install_year":2010}'),
  ('11111111-1111-1111-1111-111111111111', 'PIPE-1002',
    ST_GeomFromText('LINESTRING(35.2985 32.8662, 35.3010 32.8650)',4326),
    '{"diameter":200,"material":"Ductile Iron","install_year":1998}'),
  ('11111111-1111-1111-1111-111111111111', 'PIPE-1003',
    ST_GeomFromText('LINESTRING(35.2960 32.8650, 35.2950 32.8630)',4326),
    '{"diameter":110,"material":"PE","install_year":2019}')
ON CONFLICT (asset_code) DO NOTHING;

INSERT INTO public.features (layer_id, asset_code, geometry, properties) VALUES
  ('22222222-2222-2222-2222-222222222222', 'VALVE-2001',
    ST_SetSRID(ST_MakePoint(35.2985,32.8662),4326), '{"type":"gate","diameter":160,"install_year":2010}'),
  ('22222222-2222-2222-2222-222222222222', 'VALVE-2002',
    ST_SetSRID(ST_MakePoint(35.2960,32.8650),4326), '{"type":"gate","diameter":200,"install_year":1998}')
ON CONFLICT (asset_code) DO NOTHING;

INSERT INTO public.features (layer_id, asset_code, geometry, properties) VALUES
  ('33333333-3333-3333-3333-333333333333', 'HYD-3001',
    ST_SetSRID(ST_MakePoint(35.3010,32.8650),4326), '{"type":"pillar","install_year":2015}')
ON CONFLICT (asset_code) DO NOTHING;

-- Meters (ARad) — linked to pipes via asset_code. ARAD-900002 is an anomaly.
INSERT INTO public.meters
  (arad_meter_id, customer_id, asset_code, geometry, last_reading, consumption, status, install_date, raw_data) VALUES
  ('ARAD-900001','CUST-501','PIPE-1001', ST_SetSRID(ST_MakePoint(35.2970,32.8655),4326), 1543.2, 12.4, 'active','2018-03-01','{"model":"Sonata"}'),
  ('ARAD-900002','CUST-502','PIPE-1002', ST_SetSRID(ST_MakePoint(35.2995,32.8656),4326), 8821.0, 41.9, 'active','2017-06-12','{"model":"Sonata"}'),
  ('ARAD-900003','CUST-503', NULL,       ST_SetSRID(ST_MakePoint(35.2955,32.8640),4326),  402.5,  9.1, 'active','2020-01-20','{"model":"Octave"}')
ON CONFLICT (arad_meter_id) DO NOTHING;
