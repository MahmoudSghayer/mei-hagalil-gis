// Stress test: run 10,000 features through every chunked builder and prove two
// things at once:
//   1. Chunking doesn't change the output. Every builder's per-item transform is
//      pure (depends only on the feature itself, never on neighboring items or
//      chunk position), so a builder run on a SMALL slice — small enough to stay
//      under the builder's chunk size and therefore never actually yield mid-loop
//      — is a legitimate "unchunked reference" for that same prefix of a large,
//      genuinely-chunked run. We assert the two are identical rather than
//      re-implementing each serializer's format in the test (which would just be
//      a second copy of the production logic, drifting silently over time).
//   2. _yieldUI actually fires for a large export (spy on setTimeout, which is
//      the only thing _yieldUI calls) — i.e. the tab really does get a chance to
//      repaint during a big build, which is the whole point of chunking.
import { describe, it, expect, vi } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
import { makeFeatures } from '../fixtures/export/generate-features.mjs';
import { parseCSV } from '../fixtures/export/csv-parser.mjs';

const N = 10000;
const REF = 200; // under every chunk size (2000 and 5000) — the reference run never yields mid-loop

function extractDxfPoints(text) {
  return [...text.matchAll(/0\r\nPOINT\r\n8\r\n[^\r\n]+\r\n10\r\n([^\r\n]+)\r\n20\r\n([^\r\n]+)\r\n30\r\n0/g)].map((m) => [m[1], m[2]]);
}
function extractPlacemarks(kml) {
  return kml.split('<Placemark>').slice(1).map((s) => '<Placemark>' + s.split('</Placemark>')[0] + '</Placemark>');
}

describe('chunking stress (10,000 features)', () => {
  it('DXF: first 200 records match an unchunked reference run', async () => {
    const setTimeoutSpy = vi.fn((fn, ms) => setTimeout(fn, ms));
    const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4, setTimeout: setTimeoutSpy });
    const features = makeFeatures(N, { category: 'stress_cat', geometryType: 'Point' });

    const full = extractDxfPoints(await ctx.buildDXF(features, null));
    const ref = extractDxfPoints(await ctx.buildDXF(features.slice(0, REF), null));
    expect(full.length).toBe(N);
    expect(full.slice(0, REF)).toEqual(ref);
    expect(setTimeoutSpy).toHaveBeenCalled();
  }, 20000);

  it('CSV: first 200 rows match an unchunked reference run', async () => {
    const setTimeoutSpy = vi.fn((fn, ms) => setTimeout(fn, ms));
    const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4, setTimeout: setTimeoutSpy });
    const features = makeFeatures(N, { category: 'stress_cat', geometryType: 'Point' });

    const full = parseCSV(await ctx.buildCSV(features, null));
    const ref = parseCSV(await ctx.buildCSV(features.slice(0, REF), null));
    expect(full.length).toBe(N + 1); // header + N
    expect(full.slice(0, REF + 1)).toEqual(ref); // header + REF rows
    expect(setTimeoutSpy).toHaveBeenCalled();
  }, 20000);

  it('KML: first 200 placemarks match an unchunked reference run', async () => {
    const setTimeoutSpy = vi.fn((fn, ms) => setTimeout(fn, ms));
    const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4, setTimeout: setTimeoutSpy });
    const features = makeFeatures(N, { category: 'stress_cat', geometryType: 'Point' });

    const full = extractPlacemarks(await ctx.buildKML(features, null));
    const ref = extractPlacemarks(await ctx.buildKML(features.slice(0, REF), null));
    expect(full.length).toBe(N);
    expect(full.slice(0, REF)).toEqual(ref);
    expect(setTimeoutSpy).toHaveBeenCalled();
  }, 20000);

  it('GeoJSON: first 200 features match an unchunked reference run', async () => {
    const setTimeoutSpy = vi.fn((fn, ms) => setTimeout(fn, ms));
    const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4, setTimeout: setTimeoutSpy });
    const features = makeFeatures(N, { category: 'stress_cat', geometryType: 'Point' });

    const full = JSON.parse(await ctx.buildGeoJSON(features, null));
    const ref = JSON.parse(await ctx.buildGeoJSON(features.slice(0, REF), null));
    expect(full.features.length).toBe(N);
    expect(full.features.slice(0, REF)).toEqual(ref.features);
    expect(setTimeoutSpy).toHaveBeenCalled();
  }, 20000);

  it('Shapefile prep: first 200 features match an unchunked reference run', async () => {
    const setTimeoutSpy = vi.fn((fn, ms) => setTimeout(fn, ms));
    const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4, setTimeout: setTimeoutSpy });
    const features = makeFeatures(N, { category: 'stress_cat', geometryType: 'Point' });

    const full = await ctx.buildShapefileCollections(features, null);
    const ref = await ctx.buildShapefileCollections(features.slice(0, REF), null);
    expect(full.stress_cat.length).toBe(N);
    expect(full.stress_cat.slice(0, REF)).toEqual(ref.stress_cat);
    expect(setTimeoutSpy).toHaveBeenCalled();
  }, 20000);

  it('Excel prep: first 200 rows match an unchunked reference run', async () => {
    const setTimeoutSpy = vi.fn((fn, ms) => setTimeout(fn, ms));
    const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4, setTimeout: setTimeoutSpy });
    const features = makeFeatures(N, { category: 'stress_cat', geometryType: 'Point' });

    const full = await ctx.buildExcelRows(features, null);
    const ref = await ctx.buildExcelRows(features.slice(0, REF), null);
    expect(full.stress_cat.length).toBe(N);
    expect(full.stress_cat.slice(0, REF)).toEqual(ref.stress_cat);
    expect(setTimeoutSpy).toHaveBeenCalled();
  }, 20000);
});
