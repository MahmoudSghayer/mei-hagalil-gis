// Text-level regression tests for the Edit Mode migration
// (gis-engine/sql/migrations/2026-09-13-edit-mode-geometry.sql). This isn't
// a live database, so these assertions can't run the SQL — they check that
// the guards / validation / concurrency check / audit diff the plan requires
// are actually present in the file, and that PostgREST-relevant pieces
// (the DROP of the old 2-arg overload, GRANTs, the final NOTIFY) are there.
// Mirrors the "read the migration text" style already used for the
// feature-table-pagination migration's manual checklist.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION_PATH = resolve(
  REPO_ROOT, 'gis-engine/sql/migrations/2026-09-13-edit-mode-geometry.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf8');

// Split into per-function chunks the same way the file is authored: each
// `CREATE OR REPLACE FUNCTION` starts a new chunk that runs to the next one
// (or EOF). Chunk 0 is whatever precedes the first CREATE OR REPLACE
// FUNCTION (header comments + the DROP FUNCTION line).
const chunks = sql.split('CREATE OR REPLACE FUNCTION');

function chunkFor(nameFragment) {
  return chunks.find((c) => c.startsWith(' ' + nameFragment) || c.trim().startsWith(nameFragment));
}

describe('2026-09-13-edit-mode-geometry.sql', () => {
  it('splits into the expected function chunks', () => {
    // header/DROP chunk + validate_feature_geometry + update_feature_geometry
    // + create_feature + audit_features == 5 pieces.
    expect(chunks.length).toBeGreaterThanOrEqual(5);
  });

  it('guards update_feature_geometry with can_edit_gis()', () => {
    const chunk = chunkFor('public.update_feature_geometry');
    expect(chunk).toBeTruthy();
    expect(chunk).toMatch(/can_edit_gis\(\)/);
  });

  it('guards create_feature with can_edit_gis()', () => {
    const chunk = chunkFor('public.create_feature');
    expect(chunk).toBeTruthy();
    expect(chunk).toMatch(/can_edit_gis\(\)/);
  });

  it('validates geometry with ST_IsValid and ST_IsValidReason', () => {
    expect(sql).toMatch(/ST_IsValid\(/);
    expect(sql).toMatch(/ST_IsValidReason\(/);
  });

  it('update_feature_geometry accepts an optional concurrency token', () => {
    expect(sql).toContain('p_expected_edited_at TIMESTAMPTZ DEFAULT NULL');
  });

  it('drops the old 2-argument overload before re-creating the 3-arg version', () => {
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.update_feature_geometry(UUID, JSONB)');
  });

  it('every stable error suffix is present', () => {
    expect(sql).toContain('(permission denied)');
    expect(sql).toContain('(not found)');
    expect(sql).toContain('(conflict)');
    expect(sql).toContain('(invalid geometry)');
  });

  it('audit_features() merges a geometry old/new GeoJSON diff into feature_update details', () => {
    const chunk = chunkFor('public.audit_features');
    expect(chunk).toBeTruthy();
    expect(chunk).toContain("'geometry'");
    expect(chunk).toMatch(/ST_AsGeoJSON\(/);
    expect(chunk).toContain('IS DISTINCT FROM NEW.geometry');
  });

  it('locks the row with FOR UPDATE before checking/writing it', () => {
    expect(sql).toMatch(/FOR UPDATE/);
  });

  it('ends with NOTIFY pgrst, reload schema', () => {
    expect(sql.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });

  it('validate_feature_geometry takes an optional expected family and never enforces the layer type', () => {
    const chunk = chunkFor('public.validate_feature_geometry');
    expect(chunk).toBeTruthy();
    expect(chunk).toMatch(/p_expected_family TEXT DEFAULT NULL/);
    expect(chunk).toMatch(/p_expected_family IS NOT NULL AND fam <> p_expected_family/);
    // the layer's declared geometry_type must NOT be compared against the
    // geometry (30% of production rows live in a layer of a different type)
    expect(chunk).not.toMatch(/geometry_type/);
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.validate_feature_geometry\(UUID, GEOMETRY\);/);
  });

  it('update_feature_geometry pins the family to the feature\'s CURRENT geometry; create_feature passes NULL', () => {
    const upd = chunkFor('public.update_feature_geometry');
    expect(upd).toMatch(/validate_feature_geometry\(row\.layer_id, geom, public\.geometry_family\(GeometryType\(row\.geometry\)\)\)/);
    const cre = chunkFor('public.create_feature');
    expect(cre).toMatch(/validate_feature_geometry\(p_layer_id, geom, NULL\)/);
    // editing.sql must carry the very same call (base-file re-run safety)
    const editing = readFileSync(resolve(REPO_ROOT, 'gis-engine/sql/editing.sql'), 'utf8');
    expect(editing).toMatch(/validate_feature_geometry\(row\.layer_id, geom, public\.geometry_family\(GeometryType\(row\.geometry\)\)\)/);
    expect(editing).toMatch(/DROP FUNCTION IF EXISTS public\.update_feature_geometry\(UUID, JSONB\);/);
  });

  it('grants EXECUTE on all three RPC functions to authenticated', () => {
    // The three: validate_feature_geometry (shared helper), update_feature_geometry
    // and create_feature. audit_features() is trigger-only and never called
    // directly, so it is not (and should not be) granted.
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.validate_feature_geometry\([^)]*\) TO authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.update_feature_geometry\([^)]*\) TO authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_feature\([^)]*\) TO authenticated/);
    // audit_features() itself stays SECURITY DEFINER + search_path pinned
    // (defence-in-depth, matches audit.sql) but ungranted.
    const auditChunk = chunkFor('public.audit_features');
    expect(auditChunk).toMatch(/SECURITY DEFINER/);
    expect(auditChunk).toMatch(/SET search_path = public/);
  });
});
