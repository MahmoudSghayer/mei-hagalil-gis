# 🔄 Handoff — Mei HaGalil GIS

> Continuity doc for resuming on any device. Last updated end of the Phase 1 (security + RBAC) session.
> Branch `main`, all work pushed. Latest commit at write time: `6382059`.

## Project overview
Web GIS for the Mei HaGalil water/sewage utility (7 villages, N. Israel). Vanilla JS + Leaflet front end, Supabase (Postgres/PostGIS + Auth + RLS) backend, Vercel serverless `api/`, and a Python/FastAPI DWG export microservice on Render. Hebrew RTL UI, ArcGIS-Pro-style ribbon.

## What I'm building right now
Acting on a full production-readiness audit. **Phase 1 (security + a 3-role RBAC system) is done.** Next is **Phase 2 (production hardening: DB indexes, pagination, a11y, onboarding, monitoring).**

## Current state
- **Branch:** `main` — clean, fully pushed.
- **Remote:** `github.com/MahmoudSghayer/mei-hagalil-gis`
- **Latest commit:** `6382059`. Phase 1 = `d0548b3 → 6382059` (7 commits).
- **Deploys:** Vercel (frontend + `api/`) at temporary domain **https://mei-hagalil-gis.vercel.app**; Render (DWG service).
- **Full audit report + roadmap:** lives at `~/.claude/plans/valiant-stargazing-badger.md` on the *original* machine (local, not in this repo).

## What is currently working ✅
- 3-role RBAC end-to-end (viewer / editor / admin) — confirmed in prod.
- DWG export via JWT auth — confirmed working.
- Server-side admin user creation (`/api/admin-create-user`) — confirmed working.
- Public signups disabled; self-promotion & signup priv-esc closed; CORS locked; magic-byte upload checks; tamper-proof incident audit log.

## What is broken / not finished ⚠️
- Nothing broken. **Not done:** Phase 2 items (below).
- **Possible leftover:** 5 demo incidents may still be in the live DB (removed from schema, not from DB) — delete SQL in Next Steps.
- Retired tokens remain in **git history** (inert — invalidated at Render — but history not scrubbed).

## Recent changes (Phase 1)
1. **Priv-esc fixes** — signup trigger forces `role='viewer'`; BEFORE UPDATE trigger blocks self-promotion via profile update.
2. **JWT-only DWG** — removed static `BACKEND_TOKEN`/`DWG_EXPORT_TOKEN` from client; DWG service validates token **remotely** (`/auth/v1/user`, algorithm-agnostic) and reads role.
3. **Admin user creation** moved server-side (service-role, admin-gated) so signups could be disabled.
4. **3-role RBAC** consolidated from old conflicting sets (`admin/user` vs `admin/engineer/office/user`).
5. **CORS** locked to app origin; **magic-byte** upload validation; **parcel** SQL-injection fix + 12s budget; **snap-guide** parallel fetch; **seed data** moved out of prod schema.

## Key decisions
- Roles: **viewer** (read-only) · **editor** (edit + meter-connect + export) · **admin** (everything). `layers`/`fields`/import stay **admin-only** (structural).
- Enforcement is **DB-first** (RLS via `is_admin()`/`is_editor()`; `can_edit_gis()`/`can_edit_meters()` = `is_editor()`). Client gates are UX hints only.
- `incidents` UPDATE left open to any authenticated user — **accepted** (signups off = vetted staff; locking breaks "take an unassigned incident").
- Supabase **anon key in client is fine** (public by design); the real perimeter is RLS.

## File map (touched / important)
| File | Purpose |
|---|---|
| `db/schema.sql` | App tables (profiles, incidents, incident_logs), `is_admin`/`is_editor`, RLS, signup trigger |
| `gis-engine/sql/schema.sql` | GIS tables (layers/features/fields/meters), role constraint + migration, `can_edit_*`, RLS |
| `gis-engine/sql/meter_connect.sql` | Meter-connect RPCs (SECURITY DEFINER, guarded by `can_edit_meters()`) |
| `gis-engine/core.js` | `GIS.permissions` client role helpers |
| `gis-engine/features.js` / `meters.js` | Client write guards (admin\|editor) |
| `js/backend-client.js` | DWG service client (JWT-only) |
| `js/export-feature.js` | Export wizard; gated by `canExport` |
| `js/pages/admin.js` + `pages/admin.html` | User mgmt + 3-role selector |
| `js/pages/index.js` | Main map shell, role UI gating, incidents |
| `js/pages/upload.js` | File import + magic-byte validation |
| `api/admin-create-user.js` | Server-side admin user creation |
| `api/tiles.js` / `api/parcel.js` | MVT proxy / parcel lookup (CORS-locked) |
| `dwg-export/main.py` | FastAPI export service (remote JWT + role check) |
| `db/seed.sample.sql` | Demo incidents (dev only) |

## Active problems / Phase 2 backlog
- **DB:** missing indexes (JSONB `properties->>'customer_id'`, `incidents.assigned_to`, `layer_mapping_rules.created_by`); no FK/CHECK on `incidents.assigned_to` (free TEXT).
- **Reliability:** feature table silently caps at 1500 rows (no pagination); failed requests show a vanishing toast (no retry).
- **UX:** no onboarding/empty states; disabled "coming soon" ribbon buttons (`js/arcgis-ribbon.js`); viewer still sees take/close incident popup buttons (DB blocks them; UI should hide).
- **A11y:** no ARIA/keyboard/focus pass.
- **Ops:** no error monitoring (Sentry) or documented backup/DR.

## Critical context notes (don't forget)
- **Always commit AND push** — verified via Vercel deploy; never stop at a local commit.
- **DB schema files are source-of-truth only** — changes must be **applied manually in the Supabase SQL editor** to take effect.
- **Env vars (dashboards, not repo):** Vercel → `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Render DWG → `SUPABASE_URL`, `SUPABASE_ANON_KEY` (role enforcement needs these), `API_TOKEN` blanked.
- **Never put `service_role` key in client code** — server/env only. Anon key in `auth.js` is fine.
- `js/*` assets are **CDN-cached up to 1h** (`vercel.json`) — hard-refresh (Ctrl+F5) after deploy when testing.
- Use `git commit -F <file>` for multi-line messages (PowerShell here-strings are fragile here).
- Audit auto-flagged some non-issues (anon key, tiles "service-role exposure") — verify before treating audit claims as fact.

## Next steps (in order)
1. `git pull` on `main`.
2. **Test the 3 roles in prod** (viewer/editor/admin). Negative test: as viewer, `gSb.from('incidents').insert([...])` in console must be RLS-denied.
3. **Clean live DB** if demo incidents present:
   ```sql
   DELETE FROM incidents WHERE title IN ('נזילה בצנרת ראשית','לחץ מים נמוך','תקלת מד מים','חסימה בקו ביוב','תחנת שאיבה בתחזוקה');
   ```
4. **Start Phase 2:** DB indexes + FK on `incidents.assigned_to`, then feature-table pagination.

## ▶️ Resume instruction
**To continue: start from branch `main`. First `git pull`, then verify the 3 roles work in production at https://mei-hagalil-gis.vercel.app. Once confirmed, begin Phase 2 with the DB indexes + `incidents.assigned_to` FK.**
