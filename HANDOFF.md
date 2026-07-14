# 🔄 Handoff — Mei HaGalil GIS

> Continuity doc for resuming on any device. Branch `main`.
> HEAD commit: `abac31d` (2026-06-28). Everything below "Wave 2" is **uncommitted** —
> a multi-worker wave is in progress directly on the working tree (no per-worker
> commits by design; the orchestrator commits/PRs once the wave gate passes).

## 🌊 Wave 2 — import/export overhaul + GIS-engine hardening (2026-07-14)

**Status:** in progress, uncommitted, on `main`'s working tree. Several workers touched
overlapping areas in parallel this wave (import pipeline, export pipeline, attribute
table, CRS/layer-naming consolidation, DB RPCs) — see `git status` for the live file
list before resuming; it will have grown since this was written.

### What shipped this wave (Wave 1 carry-over + Wave 2, all uncommitted)
- **Multi-format import**: `js/import-pipeline.js` + `js/importers/{geojson,shapefile,dwg,kml,csv}.js` —
  GeoJSON/JSON, Shapefile ZIP, DWG, DXF, KML, KMZ, CSV (lon/lat *or* WKT column). Independently
  vitest-covered under `test/importers/`.
- **Multi-format export**: `js/export-formats.js` gained Shapefile/KML/Excel builders (DXF/DWG/GeoJSON/CSV
  pre-existed); an **export-area summary** (`export_area_summary` RPC) previews per-layer counts before a
  real export runs; large builds are chunked async so the tab doesn't freeze. Covered under `test/export/`.
- **Attribute table**: server-side pagination (`features_page`/`features_page_count` RPCs — replaces
  loading an entire layer client-side), bulk edit, CSV export. See `test/gis/gis-feature-table.test.js`.
- **Undo/redo**: `window.GISEditHistory` in `js/gis-edit.js` — bounded 50-deep stack over create/delete/
  geometry edits. See `test/gis/undo-stack.test.js`.
- **Realtime map↔table sync**: `js/gis-realtime.js` (`window.GISRealtime`) — ref-counted, capped
  Supabase Realtime channels per watched layer, echo-suppressed for the editing client's own writes.
  Not yet wired into `js/gis-feature-table.js` as of this writing — **verify that integration landed**
  before assuming the feature is end-to-end live (the module itself is complete and self-contained).
- **CRS + layer-naming consolidation** (this worker, W2.5): `js/crs-utils.js` (canonical EPSG:2039 proj4
  def) and `js/layer-naming.js` (`"<village> · <category>"` compose/parse) now back
  `js/gis-engine-sidebar.js`, `js/gis-edit.js`, `js/gis-network-trace.js`, `js/gis-analysis.js`,
  `js/gis-symbology.js`, `js/search-feature.js`, `js/export-formats.js` — each with a same-behavior
  inline fallback if the new scripts haven't loaded yet (load-order safety). **`index.html` still needs
  two new `<script>` tags — see "Next steps" below; not yet added on purpose (out of this worker's
  allowed-files list).**
- **Security fix**: `import_meters` RPC now has an explicit `is_admin()` guard in the database (previously
  relied only on the client + the generic meters-write RLS policy) — see
  `gis-engine/sql/migrations/2026-07-14-import-meters-admin-guard.sql`.

### ⚠️ Pending Supabase migrations (NOT yet applied to any environment)
Apply in the Supabase SQL Editor, in this order, **after** the base schema files already listed under
[README → Installation](README.md#-installation) (`db/schema.sql`, `gis-engine/sql/schema.sql`, etc.):
1. `gis-engine/sql/migrations/2026-07-14-feature-table-pagination.sql` (W1.2) — `features_page`,
   `features_page_count`, `features_bulk_update`, `_features_filter_sql`.
2. `gis-engine/sql/migrations/2026-07-14-import-meters-admin-guard.sql` (W1.4, security) — re-creates
   `import_meters` with an `is_admin()` guard. Verify afterwards as an **engineer** session that bulk
   meter import is now rejected (only admin should succeed).
3. `gis-engine/sql/migrations/2026-07-14-export-area-summary.sql` (W2.2) — `export_area_summary`; also
   re-creates `features_in_bbox` with a `p_limit` clamp. **Requires** `fix-features-bbox-timeout.sql` (or
   `extras.sql`) already applied, in addition to the base schema.
4. `gis-engine/sql/migrations/2026-07-14-features-realtime.sql` (W2.3) — adds `public.features` to the
   `supabase_realtime` publication and sets `REPLICA IDENTITY FULL` (needed so a filtered Realtime channel
   receives DELETE events; read the file's header before applying — it explains the FULL-vs-DEFAULT tradeoff).

Check `gis-engine/sql/migrations/` for any **additional** files before you start — other Wave-2 workers
may have landed more since this was written; each filename documents its own purpose/order/idempotency
in its header comment.

## Field Submission & Approval Workflow — BUILT (F1–F6 + L1 + L1c + L2)
3-role model **viewer (field submitter) / engineer (reviewer+editor) / admin**, data-driven RBAC (`role_permissions`+`has_perm`), one shared `submissions` engine (entity|issue) → review → promote to `features`/`incidents`, append-only `audit_log`, in-app `notifications` (Realtime bell), viewer↔engineer assignments. Plus mobile camera + GPS-route capture (L1), installable PWA (L1c), and line styles (L2). Code is done; **needs DB applies + the Storage bucket + end-to-end testing**.

**Apply in Supabase (delta since last apply):**
1. `review_queue()` RPC (Review Center) — in `db/field-workflow.sql`.
2. `prevent_privileged_self_update()` fix (so admins can set engineer/admin roles) — in `db/schema.sql` (commit 418efb4).
3. Create **private Storage bucket `submissions`** + its policies (commented at the bottom of `db/field-workflow.sql`).
Also: Supabase **Email provider must stay ENABLED** (only "Confirm email" + "Allow signups" are OFF) — disabling the provider blocks all logins.

**Key files:** `db/field-workflow.sql` (migration+RPCs), `js/gis-field.js` (viewer field mode + capture), `pages/review.html`+`js/pages/review.js` (Review Center), `js/gis-notifications.js` (bell), `js/pages/admin.js` (assignments UI), `gis-engine/core.js` (`GIS.can`).

**Not built:** L3 = email/SMS/push notifications (needs a provider + keys).

---
### (earlier) Phase 1 security/RBAC + Phase 2 hardening — done; CI + tests landed.

## Project overview
Web GIS for the Mei HaGalil water/sewage utility (7 villages, N. Israel). Vanilla JS + Leaflet front end, Supabase (Postgres/PostGIS + Auth + RLS), Vercel serverless `api/`, and a Python/FastAPI DWG export microservice on Render. Hebrew RTL UI, ArcGIS-Pro-style ribbon.

## What I'm building right now
Working a production-readiness audit. **Phase 1 (security + 3-role RBAC) is done.** **Phase 2 (hardening) is in progress.** Marquee features (#3 planned-shutoff notifications, #4 NRW dashboard) are queued and need a scoping decision.

## Current state
> ⚠️ The bullets in this section (and "What is working" / "Recent changes" right below) describe the
> **pre-Wave-2 baseline** at commit `277f0a7` — kept for historical continuity. **For the actual current
> state of the working tree, see the "🌊 Wave 2" section at the top of this file instead**; it supersedes
> the CI test count, "clean branch" claim, and feature-table-pagination item below (pagination moved
> server-side this wave; the description here is the older client-side load-more version).
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
- Feature table paginates (load-more/all, "showing X of Y") — no more silent 1500-row drop. *(Superseded this
  wave by true server-side pagination — see the Wave 2 section at the top; keeping this line for history.)*
- CI + automated tests guarding the security-critical paths.

## What is not finished ⚠️
Phase 2 remaining: error-recovery/retry toasts, onboarding/empty states, accessibility pass, monitoring (needs a Sentry DSN), backup/DR doc. Nothing broken.
**Possible leftover:** 5 demo incidents may still be in the live DB (removed from schema, not DB).
**Wave 2 in-flight gaps (see the top section for detail):** the four pending SQL migrations are not yet
applied anywhere; `index.html` needs 2 new `<script>` tags (`js/crs-utils.js`, `js/layer-naming.js`) that no
worker in this wave was scoped to add; confirm `js/gis-realtime.js` is actually wired into
`js/gis-feature-table.js` (module exists, call site unverified as of the last check this wave); this wave's
work is entirely **uncommitted** — nothing here has been pushed or deployed yet.

## Recent changes (this session, 13+ commits)
Phase 1 security + RBAC, then: added Vitest + pytest + GitHub Actions CI; `incidents.assigned_to` UUID CHECK + index; feature-table pagination; viewer read-only UI gating (incident buttons); removed disabled "coming soon" ribbon buttons.
*(Historical — predates Wave 2. Wave 2's changes are listed at the top of this file and are uncommitted.)*

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
| `js/import-pipeline.js` + `js/importers/*.js` | Wave 2: multi-format import (parse → validate → reproject → map → commit) |
| `js/crs-utils.js` | Wave 2: canonical EPSG:2039 (ITM) ⇄ WGS84 proj4 definition + helpers |
| `js/layer-naming.js` | Wave 2: `"<village> · <category>"` layer-name compose/parse |
| `js/gis-realtime.js` | Wave 2: realtime map↔table sync (`window.GISRealtime`) |
| `gis-engine/sql/migrations/` | Wave 2: dated, idempotent follow-up SQL — **not yet applied**, see top section |

## Active problems / Phase 2 backlog
- Error-recovery: failed requests show a vanishing toast (no retry). **(in progress)**
- UX: no onboarding; some empty states still say "טוען…". **(in progress)**
- A11y: no ARIA/keyboard/focus pass.
- Ops: no monitoring (Sentry) or backup/DR doc.

## Critical context notes
- **Always commit AND push** — verified via Vercel deploy.
- **DB schema files are source-of-truth only** — apply changes manually in the Supabase SQL editor.
- **Env (dashboards, not repo):** Vercel → `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Render DWG → `SUPABASE_URL`, `SUPABASE_ANON_KEY`. (`API_TOKEN` removed (P1-1) — DWG service is JWT-only; delete it in the Render dashboard.)
- **Never put `service_role` in client code.** Anon key in `auth.js` is fine.
- `js/*` CDN-cached up to 1h (`vercel.json`) — hard-refresh after deploy when testing.
- Local Python can't build `pyproj==3.6.1` on Python 3.13 — CI uses 3.11. Use `git commit -F <file>` for multi-line messages.

## Next steps (in order)

**Wave 2 close-out (do this first — see the top section for full detail):**
1. Re-run `git status` — confirm which Wave-2 workers have landed since this was written, then run
   `npm test` / `node --check` across the full tree (shared, so a late-landing file can break an earlier
   worker's green run) and `pytest -q` in `dwg-export/`.
2. Add the two script tags this worker (W2.5) was scoped NOT to add:
   `<script defer src="js/crs-utils.js?v=1"></script>` and
   `<script defer src="js/layer-naming.js?v=1"></script>` into `index.html`, right after the proj4 CDN
   `<script>` tag (line ~236) and before `js/search-feature.js` (line ~240) — mirrors how
   `pages/upload.html` already loads them (see `pages/upload.html:141-142`).
3. Apply the 4 pending SQL migrations under `gis-engine/sql/migrations/` (order + dependencies in the top
   section) to a Supabase environment; smoke-test each RPC.
4. Confirm `js/gis-realtime.js` is wired into `js/gis-feature-table.js` (its own header comment says it
   should be "this wave's only caller") — if not, that's a loose end, not a regression.
5. Once the tree is green end-to-end, the orchestrator commits/PRs the whole wave (workers do not commit).

**Then, resuming the older backlog (pre-Wave-2, still open):**
6. Apply the `incidents.assigned_to` SQL (UUID CHECK + index) in Supabase, if not already done.
7. Decide the next big unit: **#3 planned-shutoff + notifications** (pick channel: list/email/SMS) or **#4 NRW dashboard**. Meanwhile Phase 2 polish (error-recovery, empty states, a11y) continues.

## ▶️ Resume instruction
**To continue: read the "🌊 Wave 2" section at the top of this file first.** Check `git status` for what's
actually landed, apply the pending migrations, add the two `index.html` script tags, confirm the full test
suite is green, then either close out Wave 2 (steps above) or drop back to the older backlog (#3/#4 +
Phase 2 polish).
