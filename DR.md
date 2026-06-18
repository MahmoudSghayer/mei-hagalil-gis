# Backup & Disaster Recovery — Mei HaGalil GIS

> One-page operational runbook. This is a **system of record for a water utility**, so
> backups and a tested restore are non-negotiable. Owner: Mahmoud Sghayer.
> Last reviewed: 2026-06-18.

## Targets
- **RTO (time to restore service): ≤ 4 hours.**
- **RPO (acceptable data loss): ≤ 1 hour.** Project is on **Supabase Pro** (confirmed
  2026-06-18) → daily backups + Point-in-Time Recovery (PITR) available. **Enable PITR**
  (Database → Backups) to reach minute-level RPO; daily-only backups give RPO ≈ 24 h.

## Systems & where state lives
| System | Holds | Backup mechanism |
|---|---|---|
| **Supabase Postgres/PostGIS** | All app data (incidents, features, meters, profiles, audit log, rules) | Managed daily backups; PITR if on Pro |
| **Supabase Storage** | `village-layers` (GeoJSON), `submissions` (field PII: photos + GPS) | **Not covered by DB backups** — needs its own copy (see Gaps) |
| **Supabase Auth** | User accounts / sessions | Part of the Supabase project backup |
| **Supabase Edge fns** | `send-push` + its VAPID secrets | Code in repo; **secrets only in the dashboard** |
| **Vercel** | Static frontend + `api/*` serverless | Code in GitHub; instant redeploy/rollback |
| **Render** | DWG export FastAPI service | Code in repo (`dwg-export/`); redeploy from GitHub |
| **GitHub** (`MahmoudSghayer/mei-hagalil-gis`) | Source of truth for all code + SQL | The Git history itself |

## Backup inventory — verify these exist
1. **DB:** Supabase → Database → Backups. Confirm tier and that **PITR is ON** (Pro).
2. **Storage:** scheduled export of both buckets (see Gaps — not automatic today).
3. **Secrets/env (NOT in any backup — copy to a password manager / secrets vault):**
   - Vercel: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ALLOWED_ORIGINS`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.
   - Render (DWG): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, (`API_TOKEN` blanked), `MAX_DWG_FEATURES`, `ALLOWED_ORIGINS`.
   - Supabase Edge secrets: `VAPID_PUBLIC`, `VAPID_PRIVATE`.
   - The DB schema is reproducible from `db/*.sql` + `gis-engine/sql/*.sql`.

## Restore procedures
- **DB data loss / corruption:** Supabase → Backups → restore the latest backup, or PITR
  to the moment before the incident. If restoring into a *new* project, re-point
  `SUPABASE_URL`/keys in Vercel + Render, then redeploy. Re-apply any schema delta from
  `db/*.sql` if needed.
- **Accidental row deletion (small):** prefer PITR to a timestamp over a full restore.
  The append-only `incident_logs` audit trail helps reconstruct incident state.
- **Storage loss:** re-upload from the last bucket export. `village-layers` can also be
  rebuilt from the source Shapefiles in `Data/` via the upload flow.
- **Frontend / api broken deploy:** Vercel → Deployments → **Promote** the last known-good
  deployment (instant rollback). RTO ≈ minutes.
- **DWG service down:** Render → redeploy `dwg-export/` from `main`; allow for a cold start.
  Export degrades gracefully (DXF fallback) while it's down.
- **Supabase region outage:** no live failover today (single region). Wait for provider
  recovery; communicate via the status page (see Gaps).

## Testing
- **Quarterly restore drill:** restore the latest DB backup into a scratch Supabase
  project, run the app against it, and **record the actual RTO/RPO achieved**. A backup
  that has never been restored is not a backup.

## Gaps to close (tracked from the production-readiness audit, layer 13)
- [x] On **Supabase Pro** (confirmed 2026-06-18). Remaining: **enable PITR** (Database →
      Backups) so RPO is minutes, not 24 h.
- [ ] Add a scheduled **Storage bucket export** (both buckets) to off-Supabase storage.
- [ ] Store all env/edge secrets in a **password manager / vault** (today they live only
      in provider dashboards — a project deletion loses them).
- [ ] Stand up a **status page** + uptime monitor for incident communication.
- [ ] Run the first restore drill and fill in measured RTO/RPO above.
