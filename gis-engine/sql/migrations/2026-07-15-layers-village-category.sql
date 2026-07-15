-- ════════════════════════════════════════════════════════════════════════
--  GIS ENGINE — layers.village / layers.category   (W5.2)
--  ──────────────────────────────────────────────────────────────────────
--  Purpose: layer identity has, until now, lived ONLY in the name string
--  "<village> · <category>" (e.g. "סחנין · water_pipes"). Every reader had
--  to re-parse that string (js/layer-naming.js LayerNaming.parse, plus a
--  per-file inline fallback for load-order safety — see
--  test/gis/layer-naming-consolidation.test.js). This migration makes the
--  DB carry the parsed identity as real columns, backfilled and
--  auto-maintained, so the client CAN read layer.village / layer.category
--  directly instead of re-parsing the name on every layer row. The name
--  stays authoritative for uniqueness/display and for ensure_layer's
--  find-or-create lookup (gis-engine/sql/editing.sql) — this migration does
--  not change that contract, it only stops forcing every reader to re-derive
--  village/category from it.
--
--  ── PARITY REQUIREMENT (also documented in js/layer-naming.js) ─────────
--  The split rule below MUST stay byte-for-byte identical to
--  LayerNaming.parse()'s algorithm:
--    • separator = ' · ' (space, middle dot U+00B7, space) — 3 characters.
--    • only the FIRST occurrence of the separator splits the name (a
--      category may itself contain further ' · ' sequences or spaces —
--      those stay inside category untouched).
--    • no separator anywhere in the name → village = NULL, category = the
--      whole name (never '' — mirrors LayerNaming.parse's { village: null,
--      category: name } contract).
--  Postgres `text` position()/substring() operate on CHARACTERS (not bytes)
--  under this project's UTF8 encoding, and JavaScript's String.indexOf/
--  slice operate on UTF-16 code units — the middle dot is a single unit in
--  both, so ' · '.length === 3 in JS and the Postgres offset arithmetic
--  below (+3) line up exactly. If either algorithm ever changes, update
--  both this migration's trigger/backfill AND LayerNaming.parse together.
--
--  What this migration does:
--    1) Adds public.layers.village / public.layers.category (nullable TEXT).
--    2) Backfills every existing row from its name (first-separator split).
--    3) Adds a BEFORE INSERT OR UPDATE trigger that (re-)derives
--       village/category from name whenever they're NULL, or whenever name
--       itself changed on an UPDATE (so a rename keeps the columns in
--       sync). A caller is still free to set village/category directly to
--       a NON-NULL value on an INSERT and have it stick (the trigger only
--       overwrites when they're NULL or the name changed) — nothing in the
--       app does this today, but the escape hatch costs nothing.
--    4) Adds a btree index on each of village/category (cheap; aids
--       grouping/filtering queries like "layers in village X" or "all
--       water_pipes layers across villages", which existing client code —
--       gis-engine-sidebar.js, gis-edit.js pickCategory, gis-analysis.js —
--       currently computes by pulling every layer row and parsing client-side).
--
--  ── ensure_layer decision (documented per the task's binding rule) ─────
--  public.ensure_layer(p_name, p_geometry_type) — gis-engine/sql/editing.sql
--  — is INTENTIONALLY left untouched (no CREATE OR REPLACE in this file).
--  Its INSERT branch does `INSERT INTO public.layers (name, geometry_type)
--  VALUES (...)`, which leaves village/category unset (NULL) on the new
--  row — the BEFORE INSERT trigger added below then fires and derives them
--  from p_name before the row is written, so ensure_layer's find-or-create
--  callers (gis-engine/migrate.js) get fully-populated rows for free. Since
--  the trigger fully covers ensure_layer's only INSERT path, re-declaring
--  ensure_layer here would be a no-op change with needless PostgREST
--  schema-cache churn (NOTIFY pgrst) for zero behavioural gain — skipped.
--
--  Security model: no RLS change. village/category are plain columns on
--  public.layers, covered by the existing "layers read"/"layers write"
--  policies (schema.sql) exactly like name/geometry_type/color already are.
--
--  Apply: Supabase → SQL Editor → paste this file → Run. Idempotent
--  (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, CREATE INDEX IF NOT
--  EXISTS, DROP TRIGGER IF EXISTS + CREATE TRIGGER); safe to re-run.
--  Requires gis-engine/sql/schema.sql to already be applied (public.layers).
-- ════════════════════════════════════════════════════════════════════════

-- ── 1) columns ──────────────────────────────────────────────────────────
ALTER TABLE public.layers ADD COLUMN IF NOT EXISTS village  TEXT;
ALTER TABLE public.layers ADD COLUMN IF NOT EXISTS category TEXT;

-- ── 2) private helpers — the ONE place the first-separator split rule is
--       implemented in SQL (used by the backfill below AND the trigger, so
--       the two can never drift apart from each other). Not meant to be
--       called directly by the client; pure string functions, no table
--       access, so exposing them via PostgREST (default GRANT on public
--       functions) is harmless either way.
CREATE OR REPLACE FUNCTION public._layer_village_from_name(p_name TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN position(' · ' IN p_name) = 0 THEN NULL
              ELSE substring(p_name FROM 1 FOR position(' · ' IN p_name) - 1) END;
$$;

CREATE OR REPLACE FUNCTION public._layer_category_from_name(p_name TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN position(' · ' IN p_name) = 0 THEN p_name
              ELSE substring(p_name FROM position(' · ' IN p_name) + 3) END;
$$;

-- ── 3) backfill existing rows (only where a column is still unset, so a
--       re-run — or a row a caller has already customised — is a no-op) ──
UPDATE public.layers
   SET village  = public._layer_village_from_name(name),
       category = public._layer_category_from_name(name)
 WHERE village IS NULL OR category IS NULL;

-- ── 4) auto-maintain on INSERT/UPDATE ──────────────────────────────────
--    Derives village/category from name whenever they're NULL (the normal
--    ensure_layer / createLayer INSERT path — see decision above) OR when
--    an UPDATE actually changes name (a rename keeps the derived columns
--    truthful instead of going stale). Leaves an explicitly-set non-NULL
--    village/category alone on a plain UPDATE that doesn't touch name.
CREATE OR REPLACE FUNCTION public.layers_derive_village_category()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.village IS NULL OR NEW.category IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.name IS DISTINCT FROM OLD.name) THEN
    NEW.village  := public._layer_village_from_name(NEW.name);
    NEW.category := public._layer_category_from_name(NEW.name);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_layers_derive_village_category ON public.layers;
CREATE TRIGGER trg_layers_derive_village_category
  BEFORE INSERT OR UPDATE ON public.layers
  FOR EACH ROW EXECUTE FUNCTION public.layers_derive_village_category();

-- ── 5) indexes — cheap, aids "layers in village X" / "layers of category Y
--       across villages" queries that today require pulling every layer row
--       client-side and parsing the name. ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_layers_village  ON public.layers(village);
CREATE INDEX IF NOT EXISTS idx_layers_category ON public.layers(category);

NOTIFY pgrst, 'reload schema';


-- ════════════════════════════════════════════════════════════════════════
--  MANUAL TEST SCRIPT (commented) — paste pieces into the Supabase SQL
--  editor, as a signed-in admin, to sanity-check the backfill + trigger.
-- ════════════════════════════════════════════════════════════════════════

-- 1) Backfill spot-check — every existing row should now have village/category
--    consistent with a first-' · '-separator split of its name:
-- SELECT name, village, category FROM public.layers ORDER BY name LIMIT 20;
-- -- e.g. name='סחנין · water_pipes' → village='סחנין', category='water_pipes'

-- 2) No-separator edge case — a layer whose name has no ' · ' at all gets
--    village=NULL, category=the whole name (never an empty string):
-- INSERT INTO public.layers (name, geometry_type) VALUES ('just_a_category', 'Point')
--   RETURNING name, village, category;
-- -- expect: village IS NULL, category = 'just_a_category'

-- 3) Trigger on INSERT (via ensure_layer, the app's normal path) — village/
--    category should be populated automatically, no explicit values passed:
-- SELECT public.ensure_layer('בדיקה · test_category', 'Point');
-- SELECT name, village, category FROM public.layers WHERE name = 'בדיקה · test_category';
-- -- expect: village='בדיקה', category='test_category'

-- 4) Trigger on UPDATE (rename) — changing name re-derives both columns:
-- UPDATE public.layers SET name = 'בדיקה2 · test_category2'
--   WHERE name = 'בדיקה · test_category';
-- SELECT name, village, category FROM public.layers WHERE name = 'בדיקה2 · test_category2';
-- -- expect: village='בדיקה2', category='test_category2'

-- 5) A category that itself contains ' · ' only splits on the FIRST
--    occurrence (mirrors LayerNaming.parse's documented behaviour):
-- SELECT public._layer_village_from_name('כפר · a · b'),   -- expect: 'כפר'
--        public._layer_category_from_name('כפר · a · b');  -- expect: 'a · b'

-- cleanup for the above smoke rows:
-- DELETE FROM public.layers WHERE name IN ('בדיקה2 · test_category2', 'just_a_category');
