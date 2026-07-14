import { describe, it, expect, vi } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
import { makeAppDocument } from '../fixtures/export/stub-dom.mjs';
import { makeFeatures, makeFeature } from '../fixtures/export/generate-features.mjs';

describe('buildShapefileCollections (pure data prep, chunked)', () => {
  const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4 });

  it('groups features by category and reprojects coordinates to ITM (EPSG:2039)', async () => {
    const byCat = await ctx.buildShapefileCollections(makeFeatures(6), null); // cycles all 4 fixture categories
    expect(Object.keys(byCat).sort()).toEqual(['parcels', 'sewage_manholes', 'water_meters', 'water_pipes'].sort());
    byCat.water_meters.forEach((f) => {
      expect(f.type).toBe('Feature');
      const [x, y] = f.geometry.coordinates;
      expect(x).toBeGreaterThan(100000);
      expect(x).toBeLessThan(400000);
      expect(y).toBeGreaterThan(400000);
      expect(y).toBeLessThan(900000);
    });
  });

  it('flattens attributes and drops internal _-prefixed keys (dbf-safe)', async () => {
    const f = makeFeature(0, { category: 'water_meters', properties: { meta: { a: 1 }, nul: null, empty: undefined } });
    const byCat = await ctx.buildShapefileCollections([f], null);
    const props = byCat.water_meters[0].properties;
    expect(Object.keys(props).some((k) => k.startsWith('_'))).toBe(false);
    expect(typeof props.meta).toBe('string'); // nested objects stringified — dbf can't hold them
    expect(JSON.parse(props.meta)).toEqual({ a: 1 });
    expect('nul' in props).toBe(false);
    expect('empty' in props).toBe(false);
  });

  it('reports cumulative progress across categories (not reset per category)', async () => {
    const calls = [];
    await ctx.buildShapefileCollections(makeFeatures(12), (done, total) => calls.push([done, total]));
    calls.forEach(([done, total]) => { expect(total).toBe(12); expect(done).toBeLessThanOrEqual(12); });
    expect(calls[calls.length - 1]).toEqual([12, 12]);
  });
});

describe('exportShapefile (integration: export-formats.js + export-feature.js, stub shp-write/JSZip)', () => {
  // Loading BOTH files together (as index.html does) is what regression-tests the
  // cross-file scoping bug this worker fixed: makeToITM/groupByCategory used to be
  // trapped inside export-feature.js's IIFE and invisible to export-formats.js.
  it('passes per-category, ITM-reprojected, flattened FeatureCollections to shp-write, then zips the results', async () => {
    const zipCalls = [];
    const shpwrite = {
      zip: vi.fn((fc, opts) => {
        zipCalls.push({ fc: JSON.parse(JSON.stringify(fc)), opts });
        return { fakeShpZipResult: true }; // non-string → treated as Blob/ArrayBuffer by exportShapefile
      }),
    };
    const filesWritten = [];
    function JSZip() {
      this.file = (path) => filesWritten.push(path);
      this.generateAsync = () => Promise.resolve('FINAL_ZIP_BLOB');
    }
    JSZip.loadAsync = () => Promise.resolve({
      files: {
        'sub/out.shp': { dir: false, async: () => Promise.resolve(new Uint8Array([1, 2, 3])) },
        'sub/': { dir: true },
      },
    });

    const created = [];
    const ctx = loadBrowserGlobals(['js/export-formats.js', 'js/export-feature.js'], {
      proj4,
      document: makeAppDocument(),
      shpwrite,
      JSZip,
      URL: { createObjectURL: (b) => { created.push(b); return 'blob:fake'; }, revokeObjectURL: () => {} },
    });

    await ctx.__exportTestHooks.exportShapefile(makeFeatures(5), 'test-export'); // 4 categories

    expect(shpwrite.zip).toHaveBeenCalledTimes(4);
    const catsSeen = zipCalls.map((c) => c.opts.types.point);
    expect(new Set(catsSeen)).toEqual(new Set(['water_meters', 'sewage_manholes', 'water_pipes', 'parcels']));

    const wm = zipCalls.find((c) => c.opts.types.point === 'water_meters');
    expect(wm.fc.type).toBe('FeatureCollection');
    wm.fc.features.forEach((f) => {
      expect(Object.keys(f.properties).some((k) => k.startsWith('_'))).toBe(false);
      expect(f.geometry.coordinates[0]).toBeGreaterThan(100000); // ITM easting, not WGS84 lon
    });
    expect(wm.opts.prj).toContain('Israel 1993');

    expect(filesWritten.length).toBeGreaterThan(0);
    expect(created.length).toBe(1); // final ZIP downloaded once
  });
});
