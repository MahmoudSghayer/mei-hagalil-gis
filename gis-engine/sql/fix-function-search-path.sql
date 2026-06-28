-- ════════════════════════════════════════════════════════════════════════
--  Pin search_path = public on every SECURITY DEFINER function we OWN in
--  `public` that doesn't already set it. Clears Supabase's "Function Search
--  Path Mutable" advisor and is defence-in-depth against search_path hijacking.
--
--  Skips functions installed by extensions (PostGIS et al.) — they live in
--  `public` but are owned by a superuser, so ALTER would fail with 42501. The
--  inner EXCEPTION handler also skips any other function we don't own, so the
--  block never aborts partway.
--
--  Non-destructive: ALTER FUNCTION ... SET only changes the function's config,
--  never its body. Idempotent — re-running skips already-pinned functions. Run
--  this LAST, after schema.sql / db/field-workflow.sql / the other
--  gis-engine/sql/*.sql files, so it catches every definition.
--
--  How to apply: Supabase → SQL Editor → paste this file → Run.
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef                                              -- SECURITY DEFINER only
      AND NOT EXISTS (                                             -- not already pinned
        SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
        WHERE c LIKE 'search_path=%'
      )
      AND NOT EXISTS (                                             -- skip extension-owned (PostGIS)
        SELECT 1 FROM pg_depend d
        WHERE d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public', r.sig);
      RAISE NOTICE 'pinned search_path on %', r.sig;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'skipped (not owner): %', r.sig;                -- belt-and-suspenders
    END;
  END LOOP;
END $$;
