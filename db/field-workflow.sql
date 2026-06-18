-- ════════════════════════════════════════════════════════════════════════
--  Mei HaGalil GIS — Field Submission & Approval Workflow (F1: DB foundation)
--
--  APPLY ORDER:  run AFTER db/schema.sql and gis-engine/sql/schema.sql.
--  This file is idempotent and is the SOURCE OF TRUTH for the permission model
--  and the submission/approval pipeline. If you ever re-run the base schemas,
--  re-run this file afterward.
--
--  Roles (exactly 3):  viewer = field submitter · engineer = reviewer + GIS edit
--  · admin = everything.  Permissions are DATA-DRIVEN (role_permissions) so new
--  roles need no code change.  One shared pipeline for entities AND issues.
-- ════════════════════════════════════════════════════════════════════════

-- ── 0. Role rename: editor → engineer ───────────────────────────────────────
UPDATE public.profiles SET role = 'engineer' WHERE role = 'editor';
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check CHECK (role IN ('admin', 'engineer', 'viewer'));

-- Signup trigger MUST hard-default role to 'viewer' (a value the CHECK allows).
-- If a stale version defaults to 'user' or reads role from metadata, the post-
-- signup INSERT violates the CHECK and Supabase returns "Database error creating
-- new user" (500) — which broke admin-create-user. Pin it here, authoritatively.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, phone, department)
  VALUES (NEW.id, NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'viewer',
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    COALESCE(NEW.raw_user_meta_data->>'department', ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;

-- ── 1. Data-driven RBAC ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.role_permissions (
  role        TEXT NOT NULL,
  permission  TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

-- Seed the 3 roles. Adding a future role = INSERT rows here, zero code change.
INSERT INTO public.role_permissions (role, permission) VALUES
  ('viewer',   'submit'),
  ('engineer', 'submit'), ('engineer', 'review'), ('engineer', 'edit_production'),
  ('admin',    'submit'), ('admin',    'review'), ('admin',    'edit_production'),
  ('admin',    'manage_layers'), ('admin', 'manage_users'),
  ('admin',    'manage_assignments'), ('admin', 'view_all'), ('admin', 'delete_production')
ON CONFLICT DO NOTHING;

-- Caller has a permission? (joins their profile role → role_permissions)
CREATE OR REPLACE FUNCTION public.has_perm(p_perm TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles pr
    JOIN public.role_permissions rp ON rp.role = pr.role
    WHERE pr.id = auth.uid() AND pr.is_active = true AND rp.permission = p_perm
  );
$$;

-- Re-point the existing edit helpers at the permission model (was role-literal).
CREATE OR REPLACE FUNCTION public.is_editor()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT public.has_perm('edit_production'); $$;
CREATE OR REPLACE FUNCTION public.can_edit_gis()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT public.has_perm('edit_production'); $$;
CREATE OR REPLACE FUNCTION public.can_edit_meters()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT public.has_perm('edit_production'); $$;

-- role_permissions is the public permission matrix (not sensitive): read-only to all.
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "role_permissions: read" ON public.role_permissions;
CREATE POLICY "role_permissions: read" ON public.role_permissions
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Returns the calling user's permission set (client caches it → GIS.can(...)).
CREATE OR REPLACE FUNCTION public.my_permissions()
RETURNS SETOF TEXT LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT rp.permission FROM public.profiles pr
  JOIN public.role_permissions rp ON rp.role = pr.role
  WHERE pr.id = auth.uid() AND pr.is_active = true;
$$;

-- ── 2. Viewer → Engineer assignments (M:N) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.viewer_engineer_assignments (
  viewer_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  engineer_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (viewer_id, engineer_id)
);
CREATE INDEX IF NOT EXISTS idx_vea_viewer   ON public.viewer_engineer_assignments(viewer_id);
CREATE INDEX IF NOT EXISTS idx_vea_engineer ON public.viewer_engineer_assignments(engineer_id);

CREATE OR REPLACE FUNCTION public.is_assigned_engineer(p_viewer UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.viewer_engineer_assignments
                 WHERE viewer_id = p_viewer AND engineer_id = auth.uid());
$$;

ALTER TABLE public.viewer_engineer_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vea: read"   ON public.viewer_engineer_assignments;
DROP POLICY IF EXISTS "vea: manage" ON public.viewer_engineer_assignments;
-- A user can see their own assignments (either side); admins manage them.
CREATE POLICY "vea: read" ON public.viewer_engineer_assignments FOR SELECT
  USING (viewer_id = auth.uid() OR engineer_id = auth.uid() OR public.has_perm('view_all'));
CREATE POLICY "vea: manage" ON public.viewer_engineer_assignments FOR ALL
  USING (public.has_perm('manage_assignments')) WITH CHECK (public.has_perm('manage_assignments'));

-- ── 3. Audit log (append-only, actor-stamped) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT,
  prev_state   JSONB,
  new_state    JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_target  ON public.audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON public.audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON public.audit_log(created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit: admin read"   ON public.audit_log;
DROP POLICY IF EXISTS "audit: no direct ins" ON public.audit_log;
-- Read = admin/view_all only. Insert only via SECURITY DEFINER RPCs (deny direct).
-- No UPDATE/DELETE policy at all → RLS denies both → immutable.
CREATE POLICY "audit: admin read"    ON public.audit_log FOR SELECT USING (public.has_perm('view_all'));
CREATE POLICY "audit: no direct ins" ON public.audit_log FOR INSERT WITH CHECK (false);

-- Internal: write an audit row as the current actor. Called only from DEFINER RPCs.
CREATE OR REPLACE FUNCTION public.write_audit(
  p_action TEXT, p_target_type TEXT, p_target_id TEXT, p_prev JSONB, p_new JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_log (actor_id, actor_role, action, target_type, target_id, prev_state, new_state)
  VALUES (auth.uid(), (SELECT role FROM public.profiles WHERE id = auth.uid()),
          p_action, p_target_type, p_target_id, p_prev, p_new);
END; $$;

-- ── 4. Notifications (in-app; delivered via Supabase Realtime) ───────────────
CREATE TABLE IF NOT EXISTS public.notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  ref_type    TEXT,
  ref_id      TEXT,
  read        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON public.notifications(user_id, read, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notif: own read"   ON public.notifications;
DROP POLICY IF EXISTS "notif: own update" ON public.notifications;
DROP POLICY IF EXISTS "notif: no direct ins" ON public.notifications;
CREATE POLICY "notif: own read"   ON public.notifications FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "notif: own update" ON public.notifications FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "notif: no direct ins" ON public.notifications FOR INSERT WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.notify_user(
  p_user UUID, p_type TEXT, p_title TEXT, p_body TEXT, p_ref_type TEXT, p_ref_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_user IS NULL THEN RETURN; END IF;
  INSERT INTO public.notifications (user_id, type, title, body, ref_type, ref_id)
  VALUES (p_user, p_type, p_title, p_body, p_ref_type, p_ref_id);
END; $$;

-- ── 5. Submissions (the shared queue for entities AND issues) ────────────────
CREATE TABLE IF NOT EXISTS public.submissions (
  id              BIGSERIAL PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('entity', 'issue')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geometry        GEOMETRY(GEOMETRY, 4326),
  target_category TEXT,
  payload         JSONB NOT NULL DEFAULT '{}',
  reviewed_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  was_edited      BOOLEAN NOT NULL DEFAULT false,
  promoted_table  TEXT,
  promoted_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sub_submitter ON public.submissions(submitted_by);
CREATE INDEX IF NOT EXISTS idx_sub_status    ON public.submissions(status);
CREATE INDEX IF NOT EXISTS idx_sub_geom      ON public.submissions USING GIST(geometry);

ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sub: read"      ON public.submissions;
DROP POLICY IF EXISTS "sub: no direct" ON public.submissions;
-- SELECT: own (viewer) OR an assigned engineer of the submitter OR admin (view_all).
CREATE POLICY "sub: read" ON public.submissions FOR SELECT USING (
  submitted_by = auth.uid()
  OR public.is_assigned_engineer(submitted_by)
  OR public.has_perm('view_all')
);
-- No direct INSERT/UPDATE/DELETE — everything goes through the workflow RPCs.
CREATE POLICY "sub: no direct" ON public.submissions FOR INSERT WITH CHECK (false);

CREATE TABLE IF NOT EXISTS public.submission_media (
  id            BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
  storage_path  TEXT NOT NULL,
  captured_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_submedia_sub ON public.submission_media(submission_id);

ALTER TABLE public.submission_media ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "submedia: read"   ON public.submission_media;
DROP POLICY IF EXISTS "submedia: insert" ON public.submission_media;
-- Visible to whoever can see the parent submission.
CREATE POLICY "submedia: read" ON public.submission_media FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.submissions s WHERE s.id = submission_id)
);
-- Submitter attaches media to their own still-pending submission.
CREATE POLICY "submedia: insert" ON public.submission_media FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.submissions s
          WHERE s.id = submission_id AND s.submitted_by = auth.uid() AND s.status = 'pending')
);

-- ── 6. Workflow RPCs (one engine for entities + issues) ──────────────────────
-- Submit: viewer/engineer/admin create a PENDING submission; assigned engineers notified.
CREATE OR REPLACE FUNCTION public.submit_entity(
  p_geometry JSONB, p_target_category TEXT, p_payload JSONB DEFAULT '{}')
RETURNS public.submissions LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.submissions; eng UUID;
BEGIN
  IF NOT public.has_perm('submit') THEN RAISE EXCEPTION 'Not allowed to submit'; END IF;
  INSERT INTO public.submissions (kind, submitted_by, geometry, target_category, payload)
  VALUES ('entity', auth.uid(),
          CASE WHEN p_geometry IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON(p_geometry::text), 4326) END,
          p_target_category, COALESCE(p_payload, '{}'::jsonb))
  RETURNING * INTO s;
  PERFORM public.write_audit('submitted', 'submission', s.id::text, NULL, to_jsonb(s));
  FOR eng IN SELECT engineer_id FROM public.viewer_engineer_assignments WHERE viewer_id = auth.uid() LOOP
    PERFORM public.notify_user(eng, 'submission_new', 'הגשה חדשה לבדיקה', 'התקבלה הגשת ישות חדשה', 'submission', s.id::text);
  END LOOP;
  RETURN s;
END; $$;

CREATE OR REPLACE FUNCTION public.submit_issue(
  p_lng DOUBLE PRECISION, p_lat DOUBLE PRECISION, p_payload JSONB DEFAULT '{}')
RETURNS public.submissions LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.submissions; eng UUID;
BEGIN
  IF NOT public.has_perm('submit') THEN RAISE EXCEPTION 'Not allowed to submit'; END IF;
  INSERT INTO public.submissions (kind, submitted_by, geometry, payload)
  VALUES ('issue', auth.uid(), ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326), COALESCE(p_payload, '{}'::jsonb))
  RETURNING * INTO s;
  PERFORM public.write_audit('submitted', 'submission', s.id::text, NULL, to_jsonb(s));
  FOR eng IN SELECT engineer_id FROM public.viewer_engineer_assignments WHERE viewer_id = auth.uid() LOOP
    PERFORM public.notify_user(eng, 'submission_new', 'תקלה חדשה לבדיקה', 'התקבלה תקלה חדשה', 'submission', s.id::text);
  END LOOP;
  RETURN s;
END; $$;

-- Approve (optionally edit first): promote to production, audit, notify submitter.
CREATE OR REPLACE FUNCTION public.approve_submission(
  p_id BIGINT, p_layer_id UUID DEFAULT NULL,
  p_edited_geometry JSONB DEFAULT NULL, p_edited_payload JSONB DEFAULT NULL)
RETURNS public.submissions LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.submissions; geom GEOMETRY; props JSONB; edited BOOLEAN; new_id TEXT; new_tbl TEXT;
BEGIN
  SELECT * INTO s FROM public.submissions WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission % not found', p_id; END IF;
  IF NOT public.has_perm('review') THEN RAISE EXCEPTION 'Not allowed to review'; END IF;
  IF NOT (public.is_assigned_engineer(s.submitted_by) OR public.has_perm('view_all')) THEN
    RAISE EXCEPTION 'Not an assigned reviewer for this submission'; END IF;
  IF s.status <> 'pending' THEN RAISE EXCEPTION 'Submission already %', s.status; END IF;

  edited := (p_edited_geometry IS NOT NULL OR p_edited_payload IS NOT NULL);
  geom   := CASE WHEN p_edited_geometry IS NOT NULL
                 THEN ST_SetSRID(ST_GeomFromGeoJSON(p_edited_geometry::text), 4326) ELSE s.geometry END;
  props  := COALESCE(p_edited_payload, s.payload);

  IF s.kind = 'entity' THEN
    IF p_layer_id IS NULL THEN RAISE EXCEPTION 'approve_submission(entity) requires p_layer_id'; END IF;
    INSERT INTO public.features (layer_id, asset_code, geometry, properties)
    VALUES (p_layer_id, COALESCE(props->>'asset_code', 'SUB-' || s.id::text), geom, props)
    ON CONFLICT (asset_code) DO UPDATE SET geometry = EXCLUDED.geometry, properties = EXCLUDED.properties
    RETURNING id::text INTO new_id;
    new_tbl := 'features';
  ELSE  -- issue → incidents
    INSERT INTO public.incidents (title, description, village, lat, lng, priority, status)
    VALUES (COALESCE(props->>'title', 'תקלה'), props->>'description',
            COALESCE(props->>'village', ''), ST_Y(geom), ST_X(geom),
            COALESCE(props->>'priority', 'medium'), 'open')
    RETURNING id::text INTO new_id;
    new_tbl := 'incidents';
  END IF;

  UPDATE public.submissions SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = NOW(),
         was_edited = edited, promoted_table = new_tbl, promoted_id = new_id
  WHERE id = p_id RETURNING * INTO s;

  PERFORM public.write_audit(CASE WHEN edited THEN 'approved_edited' ELSE 'approved' END,
                             'submission', s.id::text, NULL, to_jsonb(s));
  PERFORM public.notify_user(s.submitted_by, 'submission_approved',
          CASE WHEN edited THEN 'ההגשה אושרה (עם עריכות)' ELSE 'ההגשה אושרה' END,
          'ההגשה שלך פורסמה', 'submission', s.id::text);
  RETURN s;
END; $$;

-- Review queue: pending submissions with geometry as GeoJSON. SECURITY INVOKER so
-- the submissions RLS scopes it (engineer = assigned viewers only; admin = all).
CREATE OR REPLACE FUNCTION public.review_queue()
RETURNS TABLE (id BIGINT, kind TEXT, submitted_by UUID, submitted_at TIMESTAMPTZ,
               geometry JSONB, target_category TEXT, payload JSONB)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT s.id, s.kind, s.submitted_by, s.submitted_at,
         CASE WHEN s.geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(s.geometry)::jsonb END,
         s.target_category, s.payload
  FROM public.submissions s
  WHERE s.status = 'pending'
  ORDER BY s.submitted_at ASC;
$$;

CREATE OR REPLACE FUNCTION public.reject_submission(p_id BIGINT, p_reason TEXT)
RETURNS public.submissions LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.submissions;
BEGIN
  SELECT * INTO s FROM public.submissions WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission % not found', p_id; END IF;
  IF NOT public.has_perm('review') THEN RAISE EXCEPTION 'Not allowed to review'; END IF;
  IF NOT (public.is_assigned_engineer(s.submitted_by) OR public.has_perm('view_all')) THEN
    RAISE EXCEPTION 'Not an assigned reviewer for this submission'; END IF;
  IF s.status <> 'pending' THEN RAISE EXCEPTION 'Submission already %', s.status; END IF;

  UPDATE public.submissions SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = NOW(),
         rejection_reason = p_reason WHERE id = p_id RETURNING * INTO s;
  PERFORM public.write_audit('rejected', 'submission', s.id::text, NULL, to_jsonb(s));
  PERFORM public.notify_user(s.submitted_by, 'submission_rejected', 'ההגשה נדחתה',
          COALESCE(p_reason, ''), 'submission', s.id::text);
  RETURN s;
END; $$;

-- ── 7. Realtime: broadcast submissions + notifications to connected clients ──
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.submissions;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ════════════════════════════════════════════════════════════════════════
--  STORAGE — bucket "submissions" (P1-3). Holds field-submission media AND
--  field-task completion media — both are PII (resident photos + GPS).
--
--  The bucket MUST be PRIVATE. Create once:
--    Dashboard → Storage → New bucket → name "submissions", Public = OFF.
--  Verify it is private (run in SQL editor — `public` must be false):
--    SELECT id, public FROM storage.buckets WHERE id = 'submissions';
--  If it is public (or unsure), force it private:
--    UPDATE storage.buckets SET public = false WHERE id = 'submissions';
--
--  Object paths use two namespaces:
--    "<submission_id>/<file>"   submission photos/videos
--    "tasks/<task_id>/<file>"   field-task completion photos
--  The client reads media via createSignedUrl(), which requires the SELECT
--  policy below — so these policies are REQUIRED, not optional hardening.
-- ════════════════════════════════════════════════════════════════════════

-- INSERT: only field submitters may write into the bucket.
DROP POLICY IF EXISTS "submissions media insert" ON storage.objects;
CREATE POLICY "submissions media insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'submissions' AND public.has_perm('submit'));

-- SELECT: scoped to whoever may see the PARENT record. The inner EXISTS run under
-- the caller's RLS, so submission media is readable only by the submitter / assigned
-- engineer / admin (submissions RLS), and task media only by the assignee / engineer
-- / admin (field_tasks RLS). A bad/short object name simply matches nothing (no cast
-- errors — we compare id::text, never cast the path to bigint).
DROP POLICY IF EXISTS "submissions media read" ON storage.objects;
CREATE POLICY "submissions media read" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'submissions' AND (
      EXISTS (SELECT 1 FROM public.submissions s
              WHERE s.id::text = split_part(name, '/', 1))
      OR (split_part(name, '/', 1) = 'tasks'
          AND EXISTS (SELECT 1 FROM public.field_tasks t
                      WHERE t.id::text = split_part(name, '/', 2)))
    )
  );
