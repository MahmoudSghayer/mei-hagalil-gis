// Adversarial / edge-case tests for window.GISEditGeom (js/gis-edit-geom.js),
// additive to test/gis/edit-geom.test.js (which already covers the
// documented happy-path + first-line edge cases). This file digs into the
// corners the plan's test list calls out specifically: degenerate/duplicate
// geometry, unclosed rings, bounds-edge coordinates, zero-length segments,
// tie-break behaviour at equidistant clicks, and fromEditable() with odd
// GeoJSON shapes.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function load() {
  return loadBrowserGlobals(['js/gis-edit-geom.js']).GISEditGeom;
}

describe('GISEditGeom adversarial cases', () => {
  let G;
  beforeEach(() => { G = load(); });

  describe('degenerate / duplicate-point geometry', () => {
    it('a 2-point LineString whose points are identical (zero-length) is NOT flagged by validate() as self-intersecting and passes the min-vertex check as raw coordinate count', () => {
      const g = { type: 'LineString', coordinates: [[35, 32], [35, 32]] };
      // countPoints()/minVertices only counts raw coordinates (2 >= 2) — a
      // zero-length line is a real geometry (PostGIS treats it as valid,
      // non-empty), so this documents that GISEditGeom.validate() does not
      // independently reject it; the shape is degenerate but not "invalid"
      // by any rule this module encodes.
      const r = G.validate(g);
      expect(r.ok).toBe(true);
    });

    it('normalize() collapses a fully-degenerate line to its single duplicate point only when it stays at/above minVertices, otherwise leaves it untouched', () => {
      // 3 identical points → dedupe to 1, but 1 < minVertices(2) → back off,
      // keep the original 3 (per the documented normalize() guard).
      const g3 = { type: 'LineString', coordinates: [[35, 32], [35, 32], [35, 32]] };
      expect(G.normalize(g3).coordinates).toEqual([[35, 32], [35, 32], [35, 32]]);
    });

    it('a MultiPoint with duplicate consecutive coordinates dedupes down to unique points', () => {
      const g = { type: 'MultiPoint', coordinates: [[35, 32], [35, 32], [35.1, 32.1]] };
      expect(G.normalize(g).coordinates).toEqual([[35, 32], [35.1, 32.1]]);
    });
  });

  describe('unclosed polygon ring', () => {
    it('validate() does not itself require the ring to already be closed (self-intersection test treats it as implicitly closed)', () => {
      // 4 distinct points (meets Polygon's minVertices=4), ring NOT closed
      // (no repeated first/last coordinate) — the real save path always runs
      // fromEditable() → normalize() → closeRing() before validate() ever
      // sees it, so validate() alone being lenient here is intentional, not
      // a bypass of the DB's stricter (ST_IsValid) check.
      const unclosed = { type: 'Polygon', coordinates: [[[35, 32], [35.1, 32], [35.1, 32.1], [35, 32.1]]] };
      expect(unclosed.coordinates[0][0]).not.toEqual(unclosed.coordinates[0][unclosed.coordinates[0].length - 1]);
      expect(G.validate(unclosed).ok).toBe(true);
    });

    it('normalize() always closes an unclosed ring, appending a fresh copy of the first point (not a shared reference)', () => {
      const g = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };
      const out = G.normalize(g);
      const ring = out.coordinates[0];
      expect(ring[ring.length - 1]).toEqual([0, 0]);
      expect(ring[ring.length - 1]).not.toBe(ring[0]); // distinct array instances
    });

    it('normalize() leaves an already-closed ring alone (no duplicate closing point added)', () => {
      const g = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
      expect(G.normalize(g).coordinates[0].length).toBe(5);
    });
  });

  describe('bounds edge cases (inclusive box)', () => {
    it('accepts coordinates exactly ON the bounds edges (min/max are inclusive, not exclusive)', () => {
      expect(G.boundsCheck({ type: 'Point', coordinates: [33.5, 29] }).ok).toBe(true);
      expect(G.boundsCheck({ type: 'Point', coordinates: [36.5, 34] }).ok).toBe(true);
    });
    it('rejects coordinates one ulp-equivalent step outside the box', () => {
      expect(G.boundsCheck({ type: 'Point', coordinates: [33.499999, 32] }).ok).toBe(false);
      expect(G.boundsCheck({ type: 'Point', coordinates: [36.500001, 32] }).ok).toBe(false);
      expect(G.boundsCheck({ type: 'Point', coordinates: [35, 28.999999] }).ok).toBe(false);
      expect(G.boundsCheck({ type: 'Point', coordinates: [35, 34.000001] }).ok).toBe(false);
    });
  });

  describe('nearestPointOnGeometry on a zero-length segment', () => {
    it('does not divide by zero / return NaN when two consecutive vertices coincide', () => {
      const line = { type: 'LineString', coordinates: [[35, 32], [35, 32], [35.01, 32]] };
      const r = G.nearestPointOnGeometry(line, [35, 32]);
      expect(Number.isNaN(r.distM)).toBe(false);
      expect(r.distM).toBeLessThan(0.001);
    });
    it('a LineString made ENTIRELY of one repeated point still returns a finite distance to that point', () => {
      const line = { type: 'LineString', coordinates: [[35, 32], [35, 32]] };
      const r = G.nearestPointOnGeometry(line, [35.0001, 32]);
      expect(Number.isFinite(r.distM)).toBe(true);
      expect(r.distM).toBeGreaterThan(0);
    });
  });

  describe('tie-break when the click is equidistant from both ends', () => {
    it('appendVertexAtNearestEnd prepends (start wins ties) when distances are exactly equal', () => {
      const line = { type: 'LineString', coordinates: [[35, 32], [35.02, 32]] };
      const midpoint = [35.01, 32]; // exactly equidistant from both ends
      const out = G.appendVertexAtNearestEnd(line, midpoint);
      expect(out.coordinates[0]).toEqual(midpoint);
      expect(out.coordinates.length).toBe(3);
    });
    it('removeVertexAtNearestEnd shifts (start wins ties) when distances are exactly equal', () => {
      const line = { type: 'LineString', coordinates: [[35, 32], [35.01, 32], [35.02, 32]] };
      // click exactly between the two *end* vertices' would-be distances:
      // use the actual midpoint of the whole line, which is equidistant from
      // coords[0] and coords[2].
      const r = G.removeVertexAtNearestEnd(line, [35.01, 32], 2);
      expect(r.ok).toBe(true);
      // start ([35,32]) shifted off, since dStart<=dEnd ties toward start
      expect(r.geometry.coordinates).toEqual([[35.01, 32], [35.02, 32]]);
    });
  });

  describe('fromEditable — odd GeoJSON shapes', () => {
    it('returns null for an empty FeatureCollection (no features)', () => {
      const fakeLayer = { toGeoJSON: () => ({ type: 'FeatureCollection', features: [] }) };
      expect(G.fromEditable(fakeLayer, 'LineString')).toBe(null);
    });
    it('returns null when the layer exposes neither getLayers() nor toGeoJSON()', () => {
      expect(G.fromEditable({}, 'Point')).toBe(null);
      expect(G.fromEditable(null, 'Point')).toBe(null);
    });
    it('a FeatureGroup with zero children produces an empty (but well-typed) MultiPoint', () => {
      const emptyGroup = { getLayers: () => [] };
      const g = G.fromEditable(emptyGroup, 'MultiPoint');
      expect(g.type).toBe('MultiPoint');
      expect(g.coordinates).toEqual([]);
    });
    it('normalizes the result of fromEditable (dedupes consecutive duplicate points from a sloppy layer)', () => {
      const fakeLayer = {
        toGeoJSON: () => ({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[35, 32], [35, 32], [35.01, 32]] },
        }),
      };
      const g = G.fromEditable(fakeLayer, 'LineString');
      expect(g.coordinates).toEqual([[35, 32], [35.01, 32]]);
    });
  });

  describe('MultiPolygon translate + validate', () => {
    it('translates every ring of every polygon part, holes included', () => {
      const g = {
        type: 'MultiPolygon',
        coordinates: [
          [ // polygon 1: outer + hole
            [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
            [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]],
          ],
          [ // polygon 2: outer only
            [[10, 10], [11, 10], [11, 11], [10, 10]],
          ],
        ],
      };
      const out = G.translate(g, 25, 32); // land the whole thing inside the Israel-ish box
      // every leaf coordinate shifted by the same delta
      expect(out.coordinates[0][1][3]).toEqual([27, 33]); // hole vertex [2,1] shifted
      expect(out.coordinates[1][0][0]).toEqual([35, 42]); // second polygon's first vertex
    });

    it('a MultiPolygon whose second part self-intersects is still caught by validate()', () => {
      const g = {
        type: 'MultiPolygon',
        coordinates: [
          [[[35, 32], [35.1, 32], [35.1, 32.1], [35, 32.1], [35, 32]]], // fine
          [[[35.2, 32], [35.3, 32.1], [35.3, 32], [35.2, 32.1], [35.2, 32]]], // bowtie
        ],
      };
      const r = G.validate(g);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/חוצה/);
    });
  });

  describe('appendVertexAtNearestEnd / removeVertexAtNearestEnd on MultiLineString — malformed part', () => {
    it('appendVertexAtNearestEnd handles an empty part list gracefully (returns null, not a throw)', () => {
      const g = { type: 'MultiLineString', coordinates: [] };
      expect(G.appendVertexAtNearestEnd(g, [35, 32])).toBe(null);
    });
    it('removeVertexAtNearestEnd refuses when the geometry has no parts', () => {
      const g = { type: 'MultiLineString', coordinates: [] };
      const r = G.removeVertexAtNearestEnd(g, [35, 32], 2);
      expect(r.ok).toBe(false);
    });
  });
});
