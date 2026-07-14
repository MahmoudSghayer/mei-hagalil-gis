-- ════════════════════════════════════════════════════════════════════════
--  REPORTING — management incidents report (W4.2)
--  ──────────────────────────────────────────────────────────────────────
--  Purpose: the June audit's #1-ranked ask — "incidents per village/month,
--  MTTR, CSV export" — a management-facing reporting page (pages/reports.html
--  + js/pages/reports.js). This migration adds ONE aggregate RPC that returns
--  the whole chart/KPI bundle for a filtered date range in a single round
--  trip; the page's raw table rows are fetched separately via a plain
--  supabase-js `.from('incidents').select(...)` (see below — that path is
--  intentionally NOT touched by this migration).
--
--  Table lives in db/schema.sql (app schema), not gis-engine/sql/schema.sql
--  (map/GIS engine schema) — this migration file is kept in the gis-engine
--  migrations folder anyway, per project convention, so all dated migrations
--  live in one place regardless of which base schema they extend.
--
--  ── MTTR derivation (evidence + decision) ────────────────────────────────
--  db/schema.sql's `incidents` table (line ~228) has a nullable `closed_at
--  TIMESTAMPTZ` column, and `handle_incident_update()` (line ~75) stamps it
--  server-side and unconditionally:
--      IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
--        NEW.closed_at = NOW();
--      END IF;
--  So closed_at is always populated at the exact moment an incident's status
--  transitions to 'closed', for every incident ever closed (not just ones
--  logged going forward). This is the authoritative source for MTTR.
--
--  The alternative — deriving close time from incident_logs — was rejected:
--  (1) incident_logs.duration_seconds is populated CLIENT-SIDE by whatever
--  wrote the 'closed' log row (see db/schema.sql's incident_logs table
--  comment "time-to-close (populated when action = 'closed')"), so it is
--  only as reliable as every past client's arithmetic, not server-stamped;
--  (2) incident_logs SELECT is admin-only RLS ("logs: admin can read"),
--  which would need a broader read policy or another DEFINER RPC just to
--  reach the same data closed_at already gives for free; (3) an incident
--  could in principle have been closed with no matching log row (manual DB
--  fix, older data) — closed_at still reflects reality, a log-derived MTTR
--  would silently drop it.
--  MTTR here = avg(EXTRACT(EPOCH FROM (closed_at - created_at)) / 86400.0)
--  in DAYS, over incidents with status = 'closed' AND closed_at IS NOT NULL,
--  within the filtered set.
--
--  ── Access model ──────────────────────────────────────────────────────────
--  incidents RLS ("incidents: authenticated can read", db/schema.sql line
--  ~270) is USING (auth.uid() IS NOT NULL) — ANY signed-in user (including
--  viewer) can already SELECT incidents directly, e.g. for the map. That RLS
--  does NOT gate by role, so a plain SECURITY INVOKER RPC would inherit that
--  same "any authenticated user" exposure — insufficient for a page whose
--  spec requires editor/admin only. incidents_report() is therefore
--  SECURITY DEFINER with an explicit public.is_editor() guard at the top
--  (is_editor() = has_perm('edit_production') = role IN engineer/admin,
--  see db/field-workflow.sql line ~64) — the same gate js/pages/reports.js
--  enforces client-side. The page's raw table rows are fetched by the
--  client directly against `incidents` (existing RLS, unchanged, no new
--  grant needed) — consistent with how other authenticated pages already
--  read incidents today.
--
--  GRANT is TO authenticated only (not anon, unlike several existing map
--  RPCs in this folder that grant anon too) — this endpoint returns
--  aggregated operational/management data with no legitimate anonymous use
--  case, so there is no reason to hand out EXECUTE beyond signed-in users
--  even though the is_editor() guard would reject an anon call anyway
--  (auth.uid() IS NULL there).
--
--  Apply: Supabase → SQL Editor → paste this file → Run. Idempotent
--  (CREATE OR REPLACE). Requires db/schema.sql AND db/field-workflow.sql
--  already applied (public.incidents, public.is_editor()).
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.incidents_report(
  p_from     DATE,
  p_to       DATE,
  p_villages TEXT[] DEFAULT NULL,
  p_status   TEXT   DEFAULT 'all'
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result     JSONB;
  v_from_ts  TIMESTAMPTZ;
  v_to_ts    TIMESTAMPTZ;  -- exclusive upper bound (day AFTER p_to, so p_to is fully included)
BEGIN
  IF NOT public.is_editor() THEN
    RAISE EXCEPTION 'הדוח זמין למהנדסים ומנהלי מערכת בלבד (editor/admin only)';
  END IF;
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'p_from and p_to are required';
  END IF;

  v_from_ts := p_from::timestamptz;
  v_to_ts   := (p_to + 1)::timestamptz;

  WITH filtered AS (
    SELECT i.*
    FROM public.incidents i
    WHERE i.created_at >= v_from_ts
      AND i.created_at <  v_to_ts
      AND (p_villages IS NULL OR array_length(p_villages, 1) IS NULL OR i.village = ANY(p_villages))
      AND (
        p_status IS NULL OR p_status = 'all'
        OR (p_status = 'open'   AND i.status <> 'closed')
        OR (p_status = 'closed' AND i.status =  'closed')
      )
  ),
  monthly AS (
    SELECT
      to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
      count(*)                                  AS total,
      count(*) FILTER (WHERE status <> 'closed') AS open_count,
      count(*) FILTER (WHERE status =  'closed') AS closed_count
    FROM filtered
    GROUP BY 1
  ),
  by_village AS (
    SELECT village, count(*) AS cnt FROM filtered GROUP BY village
  ),
  by_priority AS (
    SELECT priority, count(*) AS cnt FROM filtered GROUP BY priority
  ),
  mttr AS (
    SELECT
      avg(EXTRACT(EPOCH FROM (closed_at - created_at)) / 86400.0) AS avg_days,
      count(*) AS n
    FROM filtered
    WHERE status = 'closed' AND closed_at IS NOT NULL
  )
  SELECT jsonb_build_object(
    'total',       (SELECT count(*) FROM filtered),
    'open',        (SELECT count(*) FROM filtered WHERE status <> 'closed'),
    'closed',      (SELECT count(*) FROM filtered WHERE status =  'closed'),
    'mttr_days',   (SELECT avg_days FROM mttr),
    'mttr_n',      (SELECT n FROM mttr),
    'monthly',     COALESCE((SELECT jsonb_agg(jsonb_build_object(
                      'month', month, 'total', total, 'open', open_count, 'closed', closed_count
                    ) ORDER BY month) FROM monthly), '[]'::jsonb),
    'by_village',  COALESCE((SELECT jsonb_agg(jsonb_build_object(
                      'village', village, 'count', cnt
                    )) FROM by_village), '[]'::jsonb),
    'by_priority', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                      'priority', priority, 'count', cnt
                    )) FROM by_priority), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.incidents_report(DATE, DATE, TEXT[], TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════
--  MANUAL TEST SCRIPT (commented) — paste pieces into the Supabase SQL
--  editor to sanity-check the RPC. Run as different sessions via
--  "Run as" / by testing through the app UI as each role, since the SQL
--  editor itself normally runs as postgres (bypasses is_editor()'s
--  auth.uid() check — use the app or `select set_config(...)` tricks if you
--  need to simulate a specific auth.uid() in a raw SQL session).
-- ════════════════════════════════════════════════════════════════════════

-- 1) Basic call, last 90 days, all villages, all statuses:
-- SELECT public.incidents_report((CURRENT_DATE - INTERVAL '90 days')::date, CURRENT_DATE);

-- 2) Scoped to two villages, closed only:
-- SELECT public.incidents_report('2026-01-01', '2026-07-14',
--   ARRAY['מגד אל-כרום','עראבה'], 'closed');

-- 3) Missing dates should error:
-- SELECT public.incidents_report(NULL, NULL);
-- -- expect: ERROR: p_from and p_to are required

-- 4) As a signed-in VIEWER (role='viewer'), expect a permission error:
-- SELECT public.incidents_report('2026-01-01', '2026-07-14');
-- -- expect: ERROR: הדוח זמין למהנדסים ומנהלי מערכת בלבד (editor/admin only)

-- 5) As a signed-in ENGINEER or ADMIN, expect a JSONB object with keys
--    total/open/closed/mttr_days/mttr_n/monthly/by_village/by_priority, e.g.:
--    {"total":42,"open":9,"closed":33,"mttr_days":2.7,"mttr_n":33,
--     "monthly":[{"month":"2026-05","total":12,"open":2,"closed":10}, ...],
--     "by_village":[{"village":"סחנין","count":15}, ...],
--     "by_priority":[{"priority":"high","count":8}, ...]}

-- 6) A range with zero matching incidents should still return a well-formed
--    object with total=0 and empty arrays (not NULL / not an error):
-- SELECT public.incidents_report('1999-01-01', '1999-01-02');
