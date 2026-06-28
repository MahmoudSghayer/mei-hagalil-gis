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
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND is_active = true
  );
$$;

-- Returns true when the caller can edit production (admin/engineer). Used to gate
-- data-write RLS (incidents, GIS features, meters). Superseded by field-workflow.sql,
-- which redefines this to has_perm('edit_production'). Viewers submit (pending) only.
CREATE OR REPLACE FUNCTION is_editor()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('admin', 'engineer')
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

-- Incidents-specific update handler: stamps updated_at/closed_at and (P1-2)
-- attributes the edit. updated_by is overwritten with the JWT identity
-- (unforgeable) and created_by is pinned to its original value, so creator
-- attribution is immutable after insert.
CREATE OR REPLACE FUNCTION handle_incident_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  NEW.updated_by = auth.uid();
  NEW.edited_at  = NOW();
  NEW.created_by = OLD.created_by;
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    NEW.closed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$;

-- Incidents insert handler (P1-2): stamp the creator server-side. COALESCE lets a
-- server-side promote flow pass the original field submitter; normal client inserts
-- are attributed to the authenticated caller.
CREATE OR REPLACE FUNCTION handle_incident_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_by = COALESCE(NEW.created_by, auth.uid());
  RETURN NEW;
END;
$$;

-- Auto-creates a profiles row when a new Supabase Auth user signs up.
-- Reads full_name / role / phone / department from the user's raw_user_meta_data.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, phone, department)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name',   ''),
    -- SECURITY: never trust a client-supplied role. New users start as 'viewer'
    -- (read-only); admins promote to editor/admin afterwards via an authenticated
    -- UPDATE (see admin.js + the "profiles: admin can update any" policy). Reading
    -- role from raw_user_meta_data here would let anyone self-signup as admin.
    'viewer',
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
  role        TEXT         NOT NULL DEFAULT 'viewer'
                           CHECK (role IN ('admin', 'engineer', 'viewer')),
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

-- SECURITY: the "user can update own" policy lets a user edit their own profile,
-- but its WITH CHECK only verifies id = auth.uid() — it does NOT stop them from
-- setting role='admin' or re-activating a suspended account. This trigger pins the
-- privileged columns for non-admins, so self-promotion is impossible while admins
-- (is_admin()) retain full control via "profiles: admin can update any".
CREATE OR REPLACE FUNCTION public.prevent_privileged_self_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only restrict a LOGGED-IN non-admin editing a profile (self-promotion guard).
  -- Trusted server contexts — the service-role key and SECURITY DEFINER RPCs —
  -- have auth.uid() = NULL and MUST be allowed to set role/is_active (e.g. the
  -- admin-create-user endpoint). A real user always has a non-null auth.uid().
  IF auth.uid() IS NOT NULL AND NOT is_admin() THEN
    NEW.role      := OLD.role;
    NEW.is_active := OLD.is_active;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_priv_self_update ON public.profiles;
CREATE TRIGGER trg_prevent_priv_self_update
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_privileged_self_update();


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

-- Data integrity + lookups for assignee: assigned_to holds a user UUID (set to
-- auth user id by takeIncident) or NULL. Guard against garbage values and index
-- for "incidents assigned to me" queries.
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_assigned_to_uuid_chk;
ALTER TABLE incidents ADD CONSTRAINT incidents_assigned_to_uuid_chk
  CHECK (assigned_to IS NULL OR assigned_to ~ '^[0-9a-fA-F-]{36}$');
CREATE INDEX IF NOT EXISTS idx_incidents_assigned ON incidents(assigned_to);

-- Attribution (P1-2): record who created / last edited each incident so changes to
-- this public-safety dataset are accountable. Stamped server-side by the triggers
-- below; clients cannot forge updated_by, and created_by is immutable after insert.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;

-- Triggers: stamp creator on insert; stamp timestamps + editor on update
DROP TRIGGER IF EXISTS set_incident_created_by ON incidents;
CREATE TRIGGER set_incident_created_by
  BEFORE INSERT ON incidents
  FOR EACH ROW EXECUTE FUNCTION handle_incident_insert();

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
  WITH CHECK (is_editor());

-- UPDATE stays open to any editor/admin by design: incidents are a shared
-- operational queue (any field crew may act on any incident). Accountability is
-- enforced by handle_incident_update() (P1-2), which stamps an unforgeable
-- updated_by + edited_at on every change.
CREATE POLICY "incidents: authenticated can update"
  ON incidents FOR UPDATE
  USING (is_editor())
  WITH CHECK (is_editor());

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
  WITH CHECK (is_editor());

-- SECURITY: the client supplies the action/notes/snapshots, but it must NOT be
-- able to attribute a log entry to another user. This BEFORE INSERT trigger pins
-- the actor (user_id + user_name) to the authenticated caller, so an entry can
-- never be forged as e.g. "admin closed this". Logs are already non-editable
-- (no UPDATE/DELETE policy on incident_logs => RLS denies both).
CREATE OR REPLACE FUNCTION public.stamp_incident_log_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.user_id := auth.uid();
  NEW.user_name := COALESCE(
    (SELECT full_name FROM public.profiles WHERE id = auth.uid()),
    (SELECT email     FROM public.profiles WHERE id = auth.uid()),
    ''
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_incident_log_actor ON public.incident_logs;
CREATE TRIGGER trg_stamp_incident_log_actor
  BEFORE INSERT ON public.incident_logs
  FOR EACH ROW EXECUTE FUNCTION public.stamp_incident_log_actor();


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
--  SAMPLE DATA — intentionally omitted from the production schema.
--  Demo seed incidents live in a separate file so they never land in prod.
--  For a local/demo environment only, run db/seed.sample.sql manually.
-- ════════════════════════════════════════════════════════════════════════
