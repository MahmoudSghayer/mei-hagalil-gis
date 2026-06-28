-- ════════════════════════════════════════════════════════════════════════
--  Pin search_path = public on every SECURITY DEFINER function in `public`
--  that doesn't already set it. Clears Supabase's "Function Search Path
--  Mutable" advisor and is defence-in-depth against search_path hijacking.
--
--  Non-destructive: ALTER FUNCTION ... SET only changes the function's
--  config, never its body. Idempotent — re-running skips functions that are
--  already pinned. Run this LAST, after schema.sql / db/field-workflow.sql /
--  the other gis-engine/sql/*.sql files, so it catches every definition.
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
      AND p.prosecdef                                   -- SECURITY DEFINER only
      AND NOT EXISTS (
        SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
        WHERE c LIKE 'search_path=%'                     -- skip already-pinned
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', r.sig);
    RAISE NOTICE 'pinned search_path on %', r.sig;
  END LOOP;
END $$;
