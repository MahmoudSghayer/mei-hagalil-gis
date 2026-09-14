// Unit tests for the Edit Mode authorization contract added to
// gis-engine/core.js (_unwrap fix + GIS.classifyError) and
// gis-engine/features.js (updateGeometry's concurrency token + getEditToken).
//
// These are CLIENT-side defence-in-depth checks — the real boundary is the
// database (see gis-engine/sql/migrations/2026-09-13-edit-mode-geometry.sql):
// a viewer is stopped here before any network call by GIS._requireRole, and
// a forged/stale client role (someone who bypasses that check, e.g. by
// calling GIS.features.updateGeometry after tampering with the cached role)
// is still stopped by the server, whose Hebrew "(permission denied)" message
// must survive GIS._unwrap unmangled so GIS.classifyError can recognise it.
//
// Loads the REAL browser-global files (core.js then features.js, in load
// order) into a fresh vm context per test via loadBrowserGlobals, with a
// fake Supabase client standing in for `gSb` (see GIS.sb() in core.js).
// A fresh context per test avoids any cross-test bleed through
// GIS._roleCache (session-cached by design in currentRole()).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

// A minimal chainable fake mirroring the handful of supabase-js query-builder
// methods the engine actually calls: .select().eq().single() for reads,
// plus .update()/.delete()/.insert() (chainable but unused by these tests —
// present so a future test can extend this fake without a new shape).
function makeFakeSb(opts) {
  opts = opts || {};
  // profiles.role as resolved by GIS.currentRole(); null → "not signed in".
  var role = 'role' in opts ? opts.role : 'viewer';
  // features row returned by getEditToken()'s select('id, layer_id, edited_at').
  var featureRow = opts.featureRow || { id: 'f1', layer_id: 'L1', edited_at: '2026-09-13T10:00:00+00:00' };
  var rpcImpl = opts.rpc || (async function () { return { data: null, error: null }; });

  var fromCalls = [];

  function chainable(table) {
    var state = { table: table, select: null, filters: {} };
    var api = {
      select: function (cols) { state.select = cols; return api; },
      eq: function (col, val) { state.filters[col] = val; return api; },
      single: async function () {
        fromCalls.push({ table: table, select: state.select, filters: Object.assign({}, state.filters) });
        if (table === 'profiles') {
          return { data: role == null ? null : { role: role }, error: null };
        }
        if (table === 'features') {
          return { data: featureRow, error: null };
        }
        return { data: null, error: null };
      },
      update: function (patch) { state.patch = patch; return api; },
      delete: function () { return api; },
      insert: function (row) { state.row = row; return api; },
    };
    return api;
  }

  var rpc = vi.fn(rpcImpl);

  return {
    auth: { getUser: async function () { return { data: { user: role == null ? null : { id: 'u1' } }, error: null }; } },
    from: function (table) { return chainable(table); },
    rpc: rpc,
    _fromCalls: fromCalls,
  };
}

function load(sbOpts) {
  var sb = makeFakeSb(sbOpts);
  var ctx = loadBrowserGlobals(['gis-engine/core.js', 'gis-engine/features.js'], { gSb: sb });
  return { ctx: ctx, sb: sb };
}

describe('Edit Mode authorization (gis-engine/core.js + features.js)', () => {
  describe('(a) viewer is stopped client-side before any RPC', () => {
    it('updateGeometry rejects with a "not allowed" message and never calls rpc', async () => {
      const { ctx, sb } = load({ role: 'viewer' });
      const geom = { type: 'Point', coordinates: [35.1, 32.9] };

      await expect(ctx.GIS.features.updateGeometry('f1', geom)).rejects.toThrow(/not allowed/i);
      expect(sb.rpc).not.toHaveBeenCalled();
    });
  });

  describe('(b) forged/stale client role — server (permission denied) survives to the caller', () => {
    it('rpc error message keeps the (permission denied) suffix and classifies as forbidden', async () => {
      const { ctx, sb } = load({
        role: 'engineer', // client thinks it's allowed...
        rpc: async () => ({
          data: null,
          // ...but the server RPC's own can_edit_gis() guard rejects it.
          error: { message: 'אין הרשאה לערוך גאומטריה (permission denied)' },
        }),
      });
      const geom = { type: 'Point', coordinates: [35.1, 32.9] };

      let caught = null;
      try {
        await ctx.GIS.features.updateGeometry('f1', geom);
      } catch (e) { caught = e; }

      expect(caught).toBeTruthy();
      expect(caught.message).toContain('(permission denied)');
      expect(ctx.GIS.classifyError(caught)).toBe('forbidden');
      expect(sb.rpc).toHaveBeenCalledTimes(1);
    });
  });

  describe('(c) engineer happy path — concurrency token pass-through', () => {
    it('passes p_expected_edited_at from opts.expectedEditedAt when given', async () => {
      const { ctx, sb } = load({
        role: 'engineer',
        rpc: async () => ({ data: { id: 'f1', layer_id: 'L1' }, error: null }),
      });
      const geom = { type: 'Point', coordinates: [35.1, 32.9] };

      await ctx.GIS.features.updateGeometry('f1', geom, { expectedEditedAt: '2026-09-13T10:00:00+00:00' });

      expect(sb.rpc).toHaveBeenCalledWith('update_feature_geometry', {
        p_id: 'f1', p_geometry: geom, p_expected_edited_at: '2026-09-13T10:00:00+00:00',
      });
    });

    it('passes null when opts/expectedEditedAt is omitted', async () => {
      const { ctx, sb } = load({
        role: 'engineer',
        rpc: async () => ({ data: { id: 'f1', layer_id: 'L1' }, error: null }),
      });
      const geom = { type: 'Point', coordinates: [35.1, 32.9] };

      await ctx.GIS.features.updateGeometry('f1', geom);

      expect(sb.rpc).toHaveBeenCalledWith('update_feature_geometry', {
        p_id: 'f1', p_geometry: geom, p_expected_edited_at: null,
      });
    });
  });

  describe('(d) GIS.classifyError', () => {
    it.each([
      ['הישות עודכנה על ידי משתמש אחר בינתיים (conflict)', 'conflict'],
      ['גאומטריה לא תקינה (invalid geometry)', 'invalid'],
      ['הישות abc123 לא נמצאה (not found)', 'not_found'],
      ['TypeError: Failed to fetch', 'network'],
      ['something completely unexpected happened', 'unknown'],
    ])('classifies %j as %s', (message, expected) => {
      const { ctx } = load();
      expect(ctx.GIS.classifyError(new Error(message))).toBe(expected);
    });

    it('classifies a _requireRole rejection as forbidden', async () => {
      const { ctx } = load({ role: 'viewer' });
      let caught = null;
      try {
        await ctx.GIS._requireRole(['admin', 'engineer'], 'edit geometry');
      } catch (e) { caught = e; }
      expect(caught).toBeTruthy();
      expect(ctx.GIS.classifyError(caught)).toBe('forbidden');
    });

    it('handles a plain string/undefined gracefully (unknown, not a throw)', () => {
      const { ctx } = load();
      expect(ctx.GIS.classifyError(undefined)).toBe('unknown');
      expect(ctx.GIS.classifyError({})).toBe('unknown');
    });
  });

  describe('(e) _unwrap regression — classifiable suffixes survive, generic RLS denials still get the friendly rewrite', () => {
    it('keeps our own RPC message (with its permission-denied suffix) intact', () => {
      const { ctx } = load();
      expect(() => ctx.GIS._unwrap(
        { data: null, error: { message: 'אין הרשאה לערוך גאומטריה (permission denied)' } },
        'update geometry'
      )).toThrowError(/\(permission denied\)/);
    });

    it('still rewrites a generic Postgres RLS denial ("permission denied for <object>") into the friendly template', () => {
      const { ctx } = load();
      expect(() => ctx.GIS._unwrap(
        { data: null, error: { message: 'permission denied for table features' } },
        'edit geometry'
      )).toThrowError(/Permission denied: your role is not allowed to edit geometry/);
    });

    it('still rewrites a "violates row-level security policy" denial into the friendly template', () => {
      const { ctx } = load();
      expect(() => ctx.GIS._unwrap(
        { data: null, error: { message: 'new row violates row-level security policy for table "features"' } },
        'edit geometry'
      )).toThrowError(/Permission denied: your role is not allowed to edit geometry/);
    });
  });

  describe('(g) getFeatureById — one row read, geometry included, no whole-layer RPC', () => {
    it('selects the geometry column directly (GeoJSON, crs stripped) and never calls features_geojson', async () => {
      const featureRow = { id: 'f1', layer_id: 'L1', asset_code: 'PIPE-1', properties: { LineDiamet: 110 },
        geometry: { type: 'LineString', crs: { type: 'name', properties: { name: 'EPSG:4326' } }, coordinates: [[35, 32], [35.01, 32]] } };
      const { ctx, sb } = load({ featureRow: featureRow });

      const f = await ctx.GIS.features.getFeatureById('f1');

      expect(sb.rpc).not.toHaveBeenCalled();                       // no features_geojson (whole layer, 5000-row cap)
      const call = sb._fromCalls.find(function (c) { return c.table === 'features'; });
      expect(call.select).toBe('id, layer_id, asset_code, properties, geometry');
      expect(call.filters).toEqual({ id: 'f1' });
      expect(f.type).toBe('Feature');
      expect(f.geometry).toEqual({ type: 'LineString', coordinates: [[35, 32], [35.01, 32]] });
      expect(f.properties).toEqual({ asset_code: 'PIPE-1', __id: 'f1', __layer_id: 'L1', LineDiamet: 110 });
      expect(f.meters).toEqual([]);                                // meters module absent here → empty, never a throw
    });
  });

  describe('(f) getEditToken', () => {
    it('selects id, layer_id, edited_at AND geometry (GeoJSON, crs stripped) and returns the row', async () => {
      const featureRow = { id: 'f1', layer_id: 'L1', edited_at: '2026-09-13T10:00:00+00:00',
        geometry: { type: 'LineString', crs: { type: 'name', properties: { name: 'EPSG:4326' } }, coordinates: [[35, 32], [35.01, 32]] } };
      const { ctx, sb } = load({ featureRow: featureRow });

      const row = await ctx.GIS.features.getEditToken('f1');

      expect(row.id).toBe('f1');
      expect(row.edited_at).toBe(featureRow.edited_at);
      expect(row.geometry).toEqual({ type: 'LineString', coordinates: [[35, 32], [35.01, 32]] });   // PostGIS crs member removed
      const call = sb._fromCalls.find(function (c) { return c.table === 'features'; });
      expect(call).toBeTruthy();
      expect(call.select).toBe('id, layer_id, edited_at, geometry');
      expect(call.filters).toEqual({ id: 'f1' });
    });
  });
});
