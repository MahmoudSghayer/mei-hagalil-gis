-- ════════════════════════════════════════════════════════════════════════
--  SECURITY — enforce admin-only meter import IN THE DATABASE (Gate 1)
--  ──────────────────────────────────────────────────────────────────────
--  Finding (W1.4 security sweep): the intended policy is that BULK METER
--  IMPORT is admin-only while meter connect/update is admin|engineer. The
--  client enforces this (gis-engine/meters.js gates importMeters on the
--  admin role), but the import_meters RPC itself had no role check — it was
--  covered only by the generic "meters write" RLS policy (can_edit_meters()
--  = admin|engineer). An engineer holding a raw session token could
--  therefore call the RPC directly and bypass the admin-only restriction.
--
--  Fix: re-create import_meters with an explicit is_admin() guard at the
--  top (and pin search_path, matching fix-function-search-path.sql). The
--  function body is otherwise IDENTICAL to gis-engine/sql/schema.sql —
--  keep the two in sync if the import logic ever changes.
--
--  Apply: Supabase → SQL Editor → paste this file → Run. Idempotent
--  (CREATE OR REPLACE). Verify afterwards as an ENGINEER session:
--    SELECT public.import_meters('[]'::jsonb);
--  → expect: ERROR ייבוא מדים מותר למנהל בלבד (admin only)
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.import_meters(p_meters JSONB, p_source TEXT DEFAULT 'import')
RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE m JSONB; ins INT := 0; upd INT := 0; before BIGINT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ייבוא מדים מותר למנהל בלבד (admin only)';
  END IF;

  FOR m IN SELECT * FROM jsonb_array_elements(p_meters) LOOP
    SELECT count(*) INTO before FROM public.meters WHERE arad_meter_id = m->>'arad_meter_id';
    INSERT INTO public.meters AS t
      (arad_meter_id, customer_id, asset_code, geometry, last_reading, consumption, status, install_date, raw_data, updated_at)
    VALUES (
      m->>'arad_meter_id', m->>'customer_id', m->>'asset_code',
      CASE WHEN (m ? 'lng') AND (m ? 'lat')
           THEN ST_SetSRID(ST_MakePoint((m->>'lng')::float, (m->>'lat')::float),4326) END,
      NULLIF(m->>'last_reading','')::numeric, NULLIF(m->>'consumption','')::numeric,
      COALESCE(m->>'status','active'), NULLIF(m->>'install_date','')::date,
      COALESCE(m->'raw_data','{}'::jsonb), NOW())
    ON CONFLICT (arad_meter_id) DO UPDATE SET
      customer_id  = COALESCE(EXCLUDED.customer_id, t.customer_id),
      asset_code   = COALESCE(EXCLUDED.asset_code, t.asset_code),
      geometry     = COALESCE(EXCLUDED.geometry, t.geometry),
      last_reading = COALESCE(EXCLUDED.last_reading, t.last_reading),
      consumption  = COALESCE(EXCLUDED.consumption, t.consumption),
      status       = COALESCE(EXCLUDED.status, t.status),
      install_date = COALESCE(EXCLUDED.install_date, t.install_date),
      raw_data     = t.raw_data || EXCLUDED.raw_data,
      updated_at   = NOW();
    IF before = 0 THEN ins := ins + 1; ELSE upd := upd + 1; END IF;
  END LOOP;

  INSERT INTO public.sync_logs (source, status, payload)
  VALUES (p_source, 'success', jsonb_build_object('inserted',ins,'updated',upd,'total',ins+upd));
  RETURN jsonb_build_object('inserted',ins,'updated',upd,'total',ins+upd);
END; $$;

NOTIFY pgrst, 'reload schema';
