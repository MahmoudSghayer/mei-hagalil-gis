-- ════════════════════════════════════════════════════════════════════════
--  מי הגליל GIS — Complete Database Schema
--  Supabase PostgreSQL (with PostGIS)
--
--  Tables:
--    1. profiles           — user accounts (mirrors auth.users)
--    2. incidents          — field incident tickets
--    3. incident_logs      — full audit trail of incident actions
--    4. village_layers     — uploaded GeoJSON layer metadata
--    5. layer_mapping_rules — AutoCAD → category classification rules
--    6. infrastructure     — future structured asset table (PostGIS)
--
--  How to apply:
--    Supabase → SQL Editor → paste this file → Run
--    (safe to re-run — uses CREATE IF NOT EXISTS + DROP IF EXISTS on triggers)
-- ════════════════════════════════════════════════════════════════════════


-- ── EXTENSIONS ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS postgis;


-- ── HELPER FUNCTIONS ──────────────────────────────────────────────────────────

-- Returns true when the calling user has role = 'admin' and is active.
-- Used by RLS policies on every table.
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND is_active = true
  );
$$;

-- Generic updated_at stamper (used by layer_mapping_rules).
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Incidents-specific update handler: stamps updated_at and sets closed_at.
CREATE OR REPLACE FUNCTION handle_incident_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    NEW.closed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$;

-- Auto-creates a profiles row when a new Supabase Auth user signs up.
-- Reads full_name / role / phone / department from the user's raw_user_meta_data.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, phone, department)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name',   ''),
    COALESCE(NEW.raw_user_meta_data->>'role',        'user'),
    COALESCE(NEW.raw_user_meta_data->>'phone',       ''),
    COALESCE(NEW.raw_user_meta_data->>'department',  '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;


-- ════════════════════════════════════════════════════════════════════════
--  1. PROFILES
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS profiles (
  id          UUID         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT         NOT NULL,
  full_name   TEXT         NOT NULL DEFAULT '',
  role        TEXT         NOT NULL DEFAULT 'user'
                           CHECK (role IN ('admin', 'user')),
  phone       TEXT,
  department  TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_role      ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_is_active ON profiles(is_active);

-- Trigger: auto-create profile on signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles: authenticated can read"  ON profiles;
DROP POLICY IF EXISTS "profiles: user can update own"     ON profiles;
DROP POLICY IF EXISTS "profiles: admin can update any"    ON profiles;
DROP POLICY IF EXISTS "profiles: admin can delete"        ON profiles;

CREATE POLICY "profiles: authenticated can read"
  ON profiles FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "profiles: user can update own"
  ON profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles: admin can update any"
  ON profiles FOR UPDATE
  USING (is_admin());

CREATE POLICY "profiles: admin can delete"
  ON profiles FOR DELETE
  USING (is_admin());


-- ════════════════════════════════════════════════════════════════════════
--  2. INCIDENTS
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS incidents (
  id           BIGSERIAL        PRIMARY KEY,
  title        TEXT             NOT NULL,
  description  TEXT,
  village      TEXT             NOT NULL,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  priority     TEXT             NOT NULL DEFAULT 'medium'
                                CHECK (priority IN ('high', 'medium', 'low')),
  status       TEXT             NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'in_progress', 'closed')),
  assigned_to  TEXT,
  created_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  closed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_incidents_status   ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_village  ON incidents(village);
CREATE INDEX IF NOT EXISTS idx_incidents_priority ON incidents(priority);
CREATE INDEX IF NOT EXISTS idx_incidents_created  ON incidents(created_at DESC);

-- Trigger: auto-update timestamps on edit
DROP TRIGGER IF EXISTS set_incidents_updated_at ON incidents;
CREATE TRIGGER set_incidents_updated_at
  BEFORE UPDATE ON incidents
  FOR EACH ROW EXECUTE FUNCTION handle_incident_update();

-- RLS
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "incidents: authenticated can read"   ON incidents;
DROP POLICY IF EXISTS "incidents: authenticated can insert" ON incidents;
DROP POLICY IF EXISTS "incidents: authenticated can update" ON incidents;
DROP POLICY IF EXISTS "incidents: admin can delete"         ON incidents;

CREATE POLICY "incidents: authenticated can read"
  ON incidents FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "incidents: authenticated can insert"
  ON incidents FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "incidents: authenticated can update"
  ON incidents FOR UPDATE
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "incidents: admin can delete"
  ON incidents FOR DELETE
  USING (is_admin());

-- Realtime: broadcast live incident changes to all connected clients
ALTER PUBLICATION supabase_realtime ADD TABLE incidents;


-- ════════════════════════════════════════════════════════════════════════
--  3. INCIDENT_LOGS  (full audit trail)
-- ════════════════════════════════════════════════════════════════════════
--
--  Snapshots of title/village/priority are stored alongside each log
--  entry so the audit trail remains accurate even if the incident is
--  later edited or deleted.
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS incident_logs (
  id                BIGSERIAL    PRIMARY KEY,

  -- incident reference (cascade-delete keeps audit clean)
  incident_id       BIGINT       NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  incident_title    TEXT         NOT NULL,
  incident_village  TEXT         NOT NULL,
  incident_priority TEXT         NOT NULL
                    CHECK (incident_priority IN ('high', 'medium', 'low')),

  -- user snapshot (SET NULL preserves log row if user is deleted)
  user_id           UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  user_name         TEXT         NOT NULL DEFAULT '',

  -- what happened
  action            TEXT         NOT NULL
                    CHECK (action IN ('created', 'taken', 'closed', 'reopened', 'updated')),
  notes             TEXT,

  -- time-to-close (populated when action = 'closed')
  duration_seconds  INTEGER,

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_incident ON incident_logs(incident_id);
CREATE INDEX IF NOT EXISTS idx_logs_user     ON incident_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_action   ON incident_logs(action);
CREATE INDEX IF NOT EXISTS idx_logs_created  ON incident_logs(created_at DESC);

-- RLS
ALTER TABLE incident_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "logs: admin can read"          ON incident_logs;
DROP POLICY IF EXISTS "logs: authenticated can insert" ON incident_logs;

CREATE POLICY "logs: admin can read"
  ON incident_logs FOR SELECT
  USING (is_admin());

CREATE POLICY "logs: authenticated can insert"
  ON incident_logs FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);


-- ════════════════════════════════════════════════════════════════════════
--  4. VILLAGE_LAYERS  (uploaded GeoJSON metadata)
-- ════════════════════════════════════════════════════════════════════════
--
--  The actual GeoJSON is stored in Supabase Storage (bucket: village-layers).
--  This table holds the metadata needed for the map to fetch and render it.
--
--  village_id format: <slug>_<timestamp>[_<index>]
--    e.g. "majd_1715000000000", "majd_1715000000000_0"
--  Only one row per slug should have is_active = true (enforced by the
--  upload logic which deactivates previous rows before upserting).
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS village_layers (
  village_id     TEXT         PRIMARY KEY,
  village_name   TEXT         NOT NULL,
  icon           TEXT         NOT NULL DEFAULT '🏘️',
  file_path      TEXT         NOT NULL UNIQUE,
  feature_count  INTEGER      NOT NULL DEFAULT 0,
  uploaded_by    UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_active      BOOLEAN      NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_village_layers_active     ON village_layers(is_active);
CREATE INDEX IF NOT EXISTS idx_village_layers_uploaded   ON village_layers(uploaded_at DESC);

-- RLS
ALTER TABLE village_layers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "village_layers: authenticated can read" ON village_layers;
DROP POLICY IF EXISTS "village_layers: admin can write"        ON village_layers;

CREATE POLICY "village_layers: authenticated can read"
  ON village_layers FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "village_layers: admin can write"
  ON village_layers FOR ALL
  USING (is_admin());


-- ════════════════════════════════════════════════════════════════════════
--  5. LAYER_MAPPING_RULES  (AutoCAD layer → GIS category rules)
-- ════════════════════════════════════════════════════════════════════════
--
--  Rules are evaluated in ascending priority order (lower number = checked
--  first).  The first matching rule wins.  IGNORE category means the layer
--  is skipped on upload.
--
--  Supported categories (as of v8):
--    IGNORE, water_pipes, water_meters, hydrants, valves, control_valves,
--    connection_points, reservoirs, pump_stations, sampling_points,
--    sewage_pipes, sewage_manholes, main_sewer, supply_pipe,
--    sewage_cascade, fittings, annotation_points, sewer_exit,
--    annotation_polygons, annotation_lines, valve_chamber, block,
--    buildings, parcels, sleeve, pipe_label, elevation_label,
--    attribute_label, distance_label, other
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS layer_mapping_rules (
  id               BIGSERIAL    PRIMARY KEY,
  pattern          TEXT         NOT NULL,
  match_type       TEXT         NOT NULL
                   CHECK (match_type IN ('contains', 'exact', 'starts_with', 'regex')),
  category         TEXT         NOT NULL,
  priority         INTEGER      NOT NULL DEFAULT 100,
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  notes            TEXT,
  match_count      INTEGER      NOT NULL DEFAULT 0,
  created_by       UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name  TEXT         NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (pattern, match_type)
);

CREATE INDEX IF NOT EXISTS idx_rules_priority  ON layer_mapping_rules(priority ASC);
CREATE INDEX IF NOT EXISTS idx_rules_active    ON layer_mapping_rules(is_active);
CREATE INDEX IF NOT EXISTS idx_rules_category  ON layer_mapping_rules(category);

-- Trigger: auto-stamp updated_at on rule edits
DROP TRIGGER IF EXISTS set_rules_updated_at ON layer_mapping_rules;
CREATE TRIGGER set_rules_updated_at
  BEFORE UPDATE ON layer_mapping_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE layer_mapping_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rules: authenticated can read" ON layer_mapping_rules;
DROP POLICY IF EXISTS "rules: admin can write"        ON layer_mapping_rules;

CREATE POLICY "rules: authenticated can read"
  ON layer_mapping_rules FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "rules: admin can write"
  ON layer_mapping_rules FOR ALL
  USING (is_admin());


-- ════════════════════════════════════════════════════════════════════════
--  6. INFRASTRUCTURE  (future use — structured PostGIS asset store)
-- ════════════════════════════════════════════════════════════════════════
--
--  Reserved for a future migration away from flat GeoJSON files toward
--  per-feature rows with proper spatial indexing and edit history.
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS infrastructure (
  id          BIGSERIAL    PRIMARY KEY,
  type        TEXT         NOT NULL
              CHECK (type IN (
                'water_pipe', 'sewage_pipe', 'pump_station', 'reservoir', 'meter'
              )),
  name        TEXT,
  village     TEXT,
  diameter_mm INTEGER,
  material    TEXT,
  year_laid   INTEGER,
  status      TEXT         NOT NULL DEFAULT 'active',
  geom        GEOMETRY(GEOMETRY, 4326),
  properties  JSONB        NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_infra_type    ON infrastructure(type);
CREATE INDEX IF NOT EXISTS idx_infra_village ON infrastructure(village);
CREATE INDEX IF NOT EXISTS idx_infra_geom    ON infrastructure USING GIST(geom);

-- RLS
ALTER TABLE infrastructure ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "infra: authenticated can read" ON infrastructure;
DROP POLICY IF EXISTS "infra: admin can write"        ON infrastructure;

CREATE POLICY "infra: authenticated can read"
  ON infrastructure FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "infra: admin can write"
  ON infrastructure FOR ALL
  USING (is_admin());


-- ════════════════════════════════════════════════════════════════════════
--  SAMPLE DATA  (5 seed incidents — remove before production)
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO incidents (title, description, village, lat, lng, priority, status) VALUES
  ('נזילה בצנרת ראשית',       'נזילה גדולה ברחוב הראשי, נדרש תיקון דחוף',          'מגד אל-כרום', 32.9250, 35.1580, 'high',   'open'),
  ('לחץ מים נמוך',             'תושבים מדווחים על לחץ נמוך בשכונה המזרחית',         'סחנין',        32.8620, 35.2040, 'medium', 'in_progress'),
  ('תקלת מד מים',              'מד מים לא מציג קריאה תקינה',                        'עראבה',        32.8490, 35.3300, 'low',    'open'),
  ('חסימה בקו ביוב',           'קו ביוב חסום ברחוב הגפן',                           'נחף',          32.9780, 35.1920, 'high',   'open'),
  ('תחנת שאיבה בתחזוקה',      'תחנת השאיבה יצאה לתחזוקה מתוכננת',                 'דיר חנא',      32.9228, 35.2083, 'medium', 'in_progress')
ON CONFLICT DO NOTHING;
