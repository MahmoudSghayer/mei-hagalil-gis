# 🔄 Handoff — Mei HaGalil GIS

> Continuity doc for resuming on any device. Branch `main`, all work pushed.
> Latest commit at write time: `277f0a7`. (Phase 1 security/RBAC done; Phase 2 hardening in progress; CI + tests landed.)

## Project overview
Web GIS for the Mei HaGalil water/sewage utility (7 villages, N. Israel). Vanilla JS + Leaflet front end, Supabase (Postgres/PostGIS + Auth + RLS), Vercel serverless `api/`, and a Python/FastAPI DWG export microservice on Render. Hebrew RTL UI, ArcGIS-Pro-style ribbon.

## What I'm building right now
Working a production-readiness audit. **Phase 1 (security + 3-role RBAC) is done.** **Phase 2 (hardening) is in progress.** Marquee features (#3 planned-shutoff notifications, #4 NRW dashboard) are queued and need a scoping decision.

## Current state
- **Branch:** `main` — clean (only untracked `Data/` shapefiles, don't commit).
- **Remote:** `github.com/MahmoudSghayer/mei-hagalil-gis`. **Latest:** `277f0a7`.
- **CI:** GitHub Actions on every push/PR — `node --check` all JS, Vitest (API), pytest (DWG auth). 25 tests, green locally.
- **Deploys:** Vercel at **https://mei-hagalil-gis.vercel.app**; Render (DWG service).
- **Audit report + roadmap:** `~/.claude/plans/valiant-stargazing-badger.md` (local to the original machine, not in repo).

## What is working ✅
- 3-role RBAC (viewer/editor/admin) end-to-end: DB RLS + client + admin UI + export service. Confirmed in prod.
- Viewer is fully read-only in the UI (no "+", no take/close, no export, no edit tools).
- DWG export via JWT (remote validation, role-checked). Server-side admin user creation.
- Public signups disabled; priv-esc + self-promotion closed; CORS locked; magic-byte upload checks; tamper-proof audit log.
- Feature table paginates (load-more/all, "showing X of Y") — no more silent 1500-row drop.
- CI + automated tests guarding the security-critical paths.

## What is not finished ⚠️
Phase 2 remaining: error-recovery/retry toasts, onboarding/empty states, accessibility pass, monitoring (needs a Sentry DSN), backup/DR doc. Nothing broken.
**Possible leftover:** 5 demo incidents may still be in the live DB (removed from schema, not DB).

## Recent changes (this session, 13+ commits)
Phase 1 security + RBAC, then: added Vitest + pytest + GitHub Actions CI; `incidents.assigned_to` UUID CHECK + index; feature-table pagination; viewer read-only UI gating (incident buttons); removed disabled "coming soon" ribbon buttons.

## Key decisions
- Roles: viewer (read-only) · editor (edit + meter-connect + export) · admin (everything). layers/fields/import stay admin-only.
- Enforcement is DB-first (RLS via `is_admin()`/`is_editor()`; `can_edit_gis()`/`can_edit_meters()` = `is_editor()`). Client gates are UX hints.
- `incidents` UPDATE left open to any authenticated user — accepted (signups off = vetted staff).
- Audit over-flagged DB indexes; the hot-path ones (features GIN, meters.customer_id) already exist.

## File map (key)
| Path | Purpose |
|---|---|
| `db/schema.sql` | App tables, `is_admin`/`is_editor`, RLS, signup trigger, assigned_to guard |
| `gis-engine/sql/schema.sql` | GIS tables, role constraint+migration, `can_edit_*`, RLS |
| `gis-engine/sql/meter_connect.sql` | Meter-connect RPCs (DEFINER, guarded by `can_edit_meters()`) |
| `gis-engine/core.js` | `GIS.permissions` client role helpers |
| `gis-engine/features.js` / `meters.js` | Client write guards (admin\|editor) |
| `js/backend-client.js` | DWG client (JWT-only) |
| `js/export-feature.js` | Export wizard, gated by `canExport` |
| `js/gis-feature-table.js` | Attribute table (paginated; `state.limit`, default 500) |
| `js/arcgis-ribbon.js` | Ribbon toolbar |
| `js/pages/index.js` | Map shell, role UI gating, incidents |
| `js/pages/admin.js` + `pages/admin.html` | User mgmt + 3-role selector |
| `api/admin-create-user.js` | Server-side admin user creation |
| `api/tiles.js` / `api/parcel.js` | MVT proxy / parcel lookup (CORS-locked) |
| `dwg-export/main.py` | FastAPI export service (remote JWT + role check) |
| `test/` + `dwg-export/tests/` | Vitest + pytest suites |
| `.github/workflows/ci.yml` | CI |

## Active problems / Phase 2 backlog
- Error-recovery: failed requests show a vanishing toast (no retry). **(in progress)**
- UX: no onboarding; some empty states still say "טוען…". **(in progress)**
- A11y: no ARIA/keyboard/focus pass.
- Ops: no monitoring (Sentry) or backup/DR doc.

## Critical context notes
- **Always commit AND push** — verified via Vercel deploy.
- **DB schema files are source-of-truth only** — apply changes manually in the Supabase SQL editor.
- **Env (dashboards, not repo):** Vercel → `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Render DWG → `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `API_TOKEN` blanked.
- **Never put `service_role` in client code.** Anon key in `auth.js` is fine.
- `js/*` CDN-cached up to 1h (`vercel.json`) — hard-refresh after deploy when testing.
- Local Python can't build `pyproj==3.6.1` on Python 3.13 — CI uses 3.11. Use `git commit -F <file>` for multi-line messages.

## Next steps (in order)
1. `git pull` on `main`.
2. Apply the `incidents.assigned_to` SQL (UUID CHECK + index) in Supabase.
3. Confirm CI is green (Actions tab).
4. Decide the next big unit: **#3 planned-shutoff + notifications** (pick channel: list/email/SMS) or **#4 NRW dashboard**. Meanwhile Phase 2 polish (error-recovery, empty states, a11y) continues.

## ▶️ Resume instruction
**To continue: branch `main`. `git pull`, confirm CI green + apply the assigned_to SQL, then either continue Phase 2 polish or pick #3/#4 (and a notification channel for #3).**
