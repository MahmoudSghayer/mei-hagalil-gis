-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — Realtime prerequisites for public.features   (W2.3)
--  ──────────────────────────────────────────────────────────────────────
--  Purpose: js/gis-realtime.js (window.GISRealtime) opens ONE Supabase
--  Realtime `postgres_changes` channel per open attribute table / active
--  edit session, server-side filtered to `layer_id=eq.<id>`, so map↔table
--  stay in sync live without shipping every client every edit on every
--  layer. Two things are required in Postgres for that to work at all:
--
--    1) public.features must be a member of the `supabase_realtime`
--       publication (Supabase's logical-replication publication that the
--       Realtime server streams from). Without this, postgres_changes
--       never fires for this table, full stop.
--
--    2) REPLICA IDENTITY must expose enough of the OLD row for Realtime
--       to (a) build the `old` payload on UPDATE/DELETE and, critically,
--       (b) evaluate a server-side column filter (`layer_id=eq.<id>`) on
--       a DELETE at all.
--
--  ── REPLICA IDENTITY decision: FULL (not DEFAULT) ──────────────────────
--  DEFAULT (the Postgres default) only logs the PRIMARY KEY columns into
--  the WAL for an UPDATE/DELETE's "old" row — here just `features.id`.
--  That's normally the right, WAL-frugal choice (this app already prefers
--  "refetch by id" over relying on old-row payload data — see
--  js/gis-realtime.js's table integration, which refetches the current
--  page rather than trying to patch a row in place from the payload).
--
--  BUT: Supabase Realtime's server-side `postgres_changes` filter
--  (`layer_id=eq.<id>`) is evaluated against the row data available in the
--  WAL record. For an UPDATE, `layer_id` is on the NEW row, so DEFAULT is
--  fine. For a DELETE, there IS no new row — only the OLD one — and with
--  REPLICA IDENTITY DEFAULT that old row is JUST `id` (no `layer_id`).
--  Supabase Realtime therefore CANNOT evaluate a `layer_id=eq.<id>` filter
--  on a DELETE under DEFAULT, and — per Supabase's own documented
--  behaviour — a filtered channel simply never receives DELETE events for
--  that table in that case. Since the locked design uses exactly ONE
--  layer_id-filtered channel per watched layer (covering INSERT/UPDATE/
--  DELETE together, to stay under the 2-channel cap), silently dropping
--  every DELETE would be a real correctness gap (a feature deleted by one
--  user would never disappear from another open table/map until a manual
--  refresh).
--
--  FULL logs the entire old row, so `layer_id` is always present for the
--  filter regardless of event type. The WAL/replication-slot growth cost
--  of FULL only applies to UPDATE/DELETE on this table (never INSERT —
--  bulk imports are INSERTs and are unaffected), and in practice this
--  table sees interactive edits by a handful of engineers/admins, not
--  machine-speed bulk writes (bulk attribute edits go through
--  features_bulk_update, at most 1000 rows per call, an infrequent manual
--  action) — an acceptable, deliberate tradeoff for correct DELETE
--  delivery. Re-evaluate if features ever gets a high-frequency
--  UPDATE/DELETE write path.
--
--  Apply: Supabase → SQL Editor → paste this file → Run. Idempotent —
--  the publication-membership check guards against the "relation is
--  already member of publication" error a bare ALTER PUBLICATION ... ADD
--  TABLE would raise on a re-run (see db/schema.sql's `incidents` table
--  for the non-idempotent version of that statement); REPLICA IDENTITY is
--  naturally idempotent (re-setting the same value is a no-op).
-- ════════════════════════════════════════════════════════════════════════

-- ── 1) publication membership (idempotent) ────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'features'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.features;
  END IF;
END $$;

-- ── 2) REPLICA IDENTITY FULL — required for the layer_id filter to match
--       DELETE events (see decision above); idempotent by nature.
ALTER TABLE public.features REPLICA IDENTITY FULL;

-- ── verification (run manually after applying) ─────────────────────────────
-- Confirm the table is in the publication:
--   SELECT schemaname, tablename FROM pg_publication_tables
--   WHERE pubname = 'supabase_realtime' AND tablename = 'features';
--
-- Confirm REPLICA IDENTITY is FULL ('f'):
--   SELECT relreplident FROM pg_class WHERE oid = 'public.features'::regclass;
--   -- d = default (PK only), n = nothing, i = index, f = full  → expect 'f'
--
-- Smoke-test from the SQL editor (two tabs, or psql + the dashboard's
-- Realtime "Database" inspector): update a row's properties and confirm a
-- postgres_changes UPDATE event is emitted with `old.layer_id` and
-- `new.layer_id` both populated; delete a row in a layer with a channel
-- open (via the app, two browsers) and confirm the DELETE event actually
-- arrives — that's the specific case this migration fixes.
