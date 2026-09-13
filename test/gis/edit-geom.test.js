// Unit tests for window.GISEditGeom (js/gis-edit-geom.js) — the pure,
// Leaflet-free GeoJSON geometry engine behind Edit Mode. Loaded into a Node
// vm context (no build step) via test/helpers/load-browser-global.mjs; no
// extra globals are needed since the module touches nothing but plain JS.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function load() {
  return loadBrowserGlobals(['js/gis-edit-geom.js']).GISEditGeom;
}

describe('GISEditGeom (js/gis-edit-geom.js)', () => {
  let G;
  beforeEach(() => { G = load(); });

  it('loads cleanly and exposes exactly the documented API (no stray globals)', () => {
    expect(G).toBeTruthy();
    ['TYPE_FAMILY', 'typeFamily', 'caps', 'deepClone', 'normalize', 'translate',
     'boundsCheck', 'selfIntersects', 'validate', 'nearestPointOnGeometry',
     'appendVertexAtNearestEnd', 'removeVertexAtNearestEnd', 'fromEditable',
     '_partsOf', '_scaleAt'].forEach((k) => expect(typeof G[k]).not.toBe('undefined'));
  });

  describe('typeFamily / caps', () => {
    it('maps every GeoJSON type to its family', () => {
      expect(G.typeFamily('Point')).toBe('Point');
      expect(G.typeFamily('MultiPoint')).toBe('Point');
      expect(G.typeFamily('LineString')).toBe('LineString');
      expect(G.typeFamily('MultiLineString')).toBe('LineString');
      expect(G.typeFamily('Polygon')).toBe('Polygon');
      expect(G.typeFamily('MultiPolygon')).toBe('Polygon');
      expect(G.typeFamily('Bogus')).toBe(null);
    });

    it('Point family: move only, minVertices 1', () => {
      ['Point', 'MultiPoint'].forEach((t) => {
        const c = G.caps(t);
        expect(c).toEqual({ move: true, vertices: false, addVertex: false, removeVertex: false, extend: false, shorten: false, minVertices: 1 });
      });
    });

    it('LineString family: everything on, minVertices 2', () => {
      ['LineString', 'MultiLineString'].forEach((t) => {
        const c = G.caps(t);
        expect(c).toEqual({ move: true, vertices: true, addVertex: true, removeVertex: true, extend: true, shorten: true, minVertices: 2 });
      });
    });

    it('Polygon family: move/vertices/addVertex/removeVertex on, extend/shorten off, minVertices 4', () => {
      ['Polygon', 'MultiPolygon'].forEach((t) => {
        const c = G.caps(t);
        expect(c).toEqual({ move: true, vertices: true, addVertex: true, removeVertex: true, extend: false, shorten: false, minVertices: 4 });
      });
    });
  });

  describe('validate', () => {
    it('rejects a missing/null geometry', () => {
      expect(G.validate(null).ok).toBe(false);
      expect(G.validate(undefined).ok).toBe(false);
      expect(G.validate({}).ok).toBe(false);
    });

    it('rejects a 1-point line (below minVertices)', () => {
      const r = G.validate({ type: 'LineString', coordinates: [[35, 32]] });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/נקודות/);
    });

    it('rejects a self-intersecting (bowtie) polygon', () => {
      const bowtie = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] };
      const r = G.validate(bowtie);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/חוצה/);
    });

    it('rejects out-of-bounds coordinates ([0,0])', () => {
      const r = G.validate({ type: 'LineString', coordinates: [[0, 0], [1, 1]] });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/תחום/);
    });

    it('accepts a valid in-bounds line', () => {
      const r = G.validate({ type: 'LineString', coordinates: [[35.0, 32.0], [35.1, 32.1]] });
      expect(r).toEqual({ ok: true });
    });

    it('accepts a valid closed polygon with 4 points', () => {
      const r = G.validate({ type: 'Polygon', coordinates: [[[35, 32], [35.1, 32], [35.1, 32.1], [35, 32]]] });
      expect(r.ok).toBe(true);
    });
  });

  describe('normalize', () => {
    it('drops consecutive duplicate coordinates', () => {
      const g = { type: 'LineString', coordinates: [[35, 32], [35, 32], [35.1, 32.1]] };
      expect(G.normalize(g).coordinates).toEqual([[35, 32], [35.1, 32.1]]);
    });

    it('closes an open polygon ring', () => {
      const g = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };
      const out = G.normalize(g);
      const ring = out.coordinates[0];
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      expect(ring.length).toBe(5);
    });

    it('never reduces a part below the vertex count it already had at the minimum', () => {
      // a 1-point line is already below the line minimum (2); dedupe must not
      // touch it (there is nothing valid to reduce it to).
      const g = { type: 'LineString', coordinates: [[35, 32]] };
      expect(G.normalize(g).coordinates).toEqual([[35, 32]]);
      // a 2-point line that happens to be a duplicate pair stays as-is —
      // deduping it would leave 1 point, under the minimum of 2.
      const dup = { type: 'LineString', coordinates: [[35, 32], [35, 32]] };
      expect(G.normalize(dup).coordinates).toEqual([[35, 32], [35, 32]]);
    });

    it('does not mutate the input geometry', () => {
      const g = { type: 'LineString', coordinates: [[35, 32], [35, 32], [35.1, 32.1]] };
      const before = JSON.stringify(g);
      G.normalize(g);
      expect(JSON.stringify(g)).toBe(before);
    });
  });

  describe('translate', () => {
    it('shifts every coordinate and does not mutate the input (nested MultiPolygon)', () => {
      const g = { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]] };
      const before = JSON.stringify(g);
      const out = G.translate(g, 1, 2);
      expect(JSON.stringify(g)).toBe(before);               // original untouched
      expect(out.coordinates[0][0][0]).toEqual([1, 2]);
      expect(out.coordinates[0][0][2]).toEqual([2, 3]);
    });
  });

  describe('boundsCheck', () => {
    it('accepts coordinates inside the Israel-ish box', () => {
      expect(G.boundsCheck({ type: 'Point', coordinates: [35.2, 32.9] }).ok).toBe(true);
    });
    it('rejects coordinates outside the box', () => {
      const r = G.boundsCheck({ type: 'Point', coordinates: [0, 0] });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/תחום/);
    });
  });

  describe('selfIntersects', () => {
    it('is always false for Point families', () => {
      expect(G.selfIntersects({ type: 'Point', coordinates: [0, 0] })).toBe(false);
      expect(G.selfIntersects({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] })).toBe(false);
    });
    it('is false for a simple (non-crossing) line', () => {
      const line = { type: 'LineString', coordinates: [[0, 0], [1, 0], [1, 1]] };
      expect(G.selfIntersects(line)).toBe(false);
    });
    it('is true for a self-crossing line', () => {
      const line = { type: 'LineString', coordinates: [[0, 0], [2, 2], [2, 0], [0, 2]] };
      expect(G.selfIntersects(line)).toBe(true);
    });
    it('does not flag adjacent segments or the ring closure as a false positive', () => {
      const square = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
      expect(G.selfIntersects(square)).toBe(false);
    });
    it('is true for a bowtie polygon', () => {
      const bowtie = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] };
      expect(G.selfIntersects(bowtie)).toBe(true);
    });
  });

  describe('nearestPointOnGeometry', () => {
    const line = { type: 'LineString', coordinates: [[35, 32], [35.01, 32]] };

    it('is ~0m for a point exactly on the segment (mid-point)', () => {
      const r = G.nearestPointOnGeometry(line, [35.005, 32]);
      expect(r.distM).toBeLessThan(0.5);
      expect(r.partIndex).toBe(0);
      expect(r.segIndex).toBe(0);
    });

    it('measures perpendicular distance off the segment', () => {
      const onLine = G.nearestPointOnGeometry(line, [35.005, 32]).distM;
      const off = G.nearestPointOnGeometry(line, [35.005, 32.001]).distM;
      expect(off).toBeGreaterThan(onLine);
    });

    it('MultiPoint: distance to the nearest coordinate, with its index', () => {
      const mp = { type: 'MultiPoint', coordinates: [[35, 32], [36, 33]] };
      const r = G.nearestPointOnGeometry(mp, [35.001, 32.001]);
      expect(r.partIndex).toBe(0);
      expect(r.distM).toBeGreaterThan(0);
      const r2 = G.nearestPointOnGeometry(mp, [35.999, 32.999]);
      expect(r2.partIndex).toBe(1);
    });

    it('Point: distance to the single coordinate', () => {
      const r = G.nearestPointOnGeometry({ type: 'Point', coordinates: [35, 32] }, [35, 32]);
      expect(r.distM).toBe(0);
    });
  });

  describe('appendVertexAtNearestEnd / removeVertexAtNearestEnd', () => {
    it('LineString: appends at the nearer end (prepend)', () => {
      const line = { type: 'LineString', coordinates: [[35, 32], [35.01, 32]] };
      const out = G.appendVertexAtNearestEnd(line, [34.99, 32]);
      expect(out.coordinates[0]).toEqual([34.99, 32]);
      expect(out.coordinates.length).toBe(3);
    });

    it('LineString: appends at the nearer end (append)', () => {
      const line = { type: 'LineString', coordinates: [[35, 32], [35.01, 32]] };
      const out = G.appendVertexAtNearestEnd(line, [35.02, 32]);
      expect(out.coordinates[out.coordinates.length - 1]).toEqual([35.02, 32]);
    });

    it('MultiLineString: picks the part whose end is nearest the click', () => {
      const mline = { type: 'MultiLineString', coordinates: [[[35, 32], [35.01, 32]], [[36, 33], [36.01, 33]]] };
      const out = G.appendVertexAtNearestEnd(mline, [35.999, 33]);
      expect(out.coordinates[0]).toEqual(mline.coordinates[0]);      // untouched part
      expect(out.coordinates[1][0]).toEqual([35.999, 33]);            // prepended on the nearer part/end
    });

    it('returns null for non-line geometries', () => {
      expect(G.appendVertexAtNearestEnd({ type: 'Point', coordinates: [0, 0] }, [0, 0])).toBe(null);
      expect(G.appendVertexAtNearestEnd({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, [0, 0])).toBe(null);
    });

    it('does not mutate the input geometry', () => {
      const line = { type: 'LineString', coordinates: [[35, 32], [35.01, 32]] };
      const before = JSON.stringify(line);
      G.appendVertexAtNearestEnd(line, [35.02, 32]);
      expect(JSON.stringify(line)).toBe(before);
    });

    it('removes a vertex from the nearer end', () => {
      const line = { type: 'LineString', coordinates: [[35, 32], [35.005, 32], [35.01, 32]] };
      const r = G.removeVertexAtNearestEnd(line, [35, 32], 2);
      expect(r.ok).toBe(true);
      expect(r.geometry.coordinates).toEqual([[35.005, 32], [35.01, 32]]);
    });

    it('refuses to shorten below the minimum vertex count', () => {
      const line = { type: 'LineString', coordinates: [[35, 32], [35.01, 32]] };
      const r = G.removeVertexAtNearestEnd(line, [35, 32], 2);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/מינימום/);
    });

    it('MultiLineString: refuses to shorten a part already at the minimum, even if another part has slack', () => {
      const mline = { type: 'MultiLineString', coordinates: [[[35, 32], [35.005, 32], [35.01, 32]], [[36, 33], [36.01, 33]]] };
      // click nearest the SHORT part's end (already at minVertices=2)
      const r = G.removeVertexAtNearestEnd(mline, [36, 33], 2);
      expect(r.ok).toBe(false);
    });
  });

  describe('fromEditable', () => {
    it('FeatureGroup (MultiPoint) regression: reassembles ALL marker positions, not just the first', () => {
      const fakeGroup = {
        getLayers: () => [
          { getLatLng: () => ({ lng: 35, lat: 32 }) },
          { getLatLng: () => ({ lng: 35.1, lat: 32.1 }) },
          { getLatLng: () => ({ lng: 35.2, lat: 32.2 }) },
        ],
      };
      const g = G.fromEditable(fakeGroup, 'MultiPoint');
      expect(g.type).toBe('MultiPoint');
      expect(g.coordinates).toEqual([[35, 32], [35.1, 32.1], [35.2, 32.2]]);
    });

    it('LineString layer passthrough via toGeoJSON() Feature wrapper', () => {
      const fakeLayer = { toGeoJSON: () => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[35, 32], [35.01, 32]] } }) };
      const g = G.fromEditable(fakeLayer, 'LineString');
      expect(g).toEqual({ type: 'LineString', coordinates: [[35, 32], [35.01, 32]] });
    });

    it('unwraps a bare FeatureCollection (first feature)', () => {
      const fakeLayer = {
        toGeoJSON: () => ({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[35, 32], [35.1, 32], [35.1, 32.1], [35, 32]]] } }],
        }),
      };
      const g = G.fromEditable(fakeLayer, 'Polygon');
      expect(g.type).toBe('Polygon');
    });
  });
});
