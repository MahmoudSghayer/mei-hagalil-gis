// Stress test (Worker W3.2): 50,000 generated mixed features through every
// chunked export builder in js/export-formats.js. Complements
// test/export/chunking-stress.test.js (10,000 features, "output matches an
// unchunked reference run") with three things that test does NOT cover:
//   1. A 5x larger input (50,000 — realistic for a big multi-village export).
//   2. Exact yield-count assertions: _forEachChunked's chunk sizes are fixed
//      per builder (DXF/Shapefile/Excel=2000, CSV/KML/GeoJSON=5000; KML/
//      Shapefile/Excel chunk PER CATEGORY, the others over the whole array),
//      so with a fixture that splits N features evenly across the 4 fixture
//      categories (test/fixtures/export/generate-features.mjs cycles
//      i % CATS.length), the number of _yieldUI() calls — and therefore of
//      spied setTimeout invocations — is exactly predictable. Asserting the
//      exact count (not just ">0") is a real "yields scale with input" proof,
//      not merely "chunking happened at all".
//   3. Rough wall-clock timing, printed (not asserted) so a human can eyeball
//      whether a builder has visibly regressed — never a hard time assertion
//      (flaky on shared/CI hardware), per the wave brief.
import { describe, it, expect, vi } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
import { makeFeatures, CATS } from '../fixtures/export/generate-features.mjs';
import { parseCSV } from '../fixtures/export/csv-parser.mjs';

const N = 50000;
const NUM_CATS = CATS.length; // 4 — makeFeatures cycles i % NUM_CATS
const PER_CAT = N / NUM_CATS; // 12500 — evenly divisible, no remainder-category surprises

// Mirrors _forEachChunked's boundary condition exactly ((i+1) % chunk === 0)
// without re-implementing any builder's per-item transform.
function yieldsFor(len, chunk) { return Math.floor(len / chunk); }

function timed(label, fn) {
  const t0 = performance.now();
  return Promise.resolve(fn()).then((result) => {
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[stress] ${label}: ${ms.toFixed(1)}ms for ${N.toLocaleString()} features`);
    return { result, ms };
  });
}

function freshCtx() {
  const setTimeoutSpy = vi.fn((fn, ms) => setTimeout(fn, ms));
  const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4, setTimeout: setTimeoutSpy });
  return { ctx, setTimeoutSpy };
}

describe('export stress (50,000 mixed features)', () => {
  it('DXF: completes, contains one entity per feature (mixed Point/LineString/Polygon), and yields exactly N/2000 times', async () => {
    const { ctx, setTimeoutSpy } = freshCtx();
    const features = makeFeatures(N); // mixed categories/geometries; unique GlobalID per feature -> no dedup
    const progressCalls = [];
    const { result: dxf, ms } = await timed('DXF 50k', () =>
      ctx.buildDXF(features, (done, total) => progressCalls.push([done, total])));

    expect(typeof dxf).toBe('string');
    expect(dxf).toContain('ENDSEC');
    expect(dxf.endsWith('EOF')).toBe(true);
    // Output-size sanity: a real DXF for 50k features should be substantial but
    // not absurd — a loose band, not a tight byte count (avoids flaking on
    // incidental formatting changes).
    expect(dxf.length).toBeGreaterThan(N * 50);
    expect(dxf.length).toBeLessThan(N * 2000);

    // Fixture geometry split (generate-features.mjs): water_meters/sewage_manholes
    // -> Point (one POINT entity each); water_pipes/parcels -> LineString/Polygon
    // (one POLYLINE entity each, via dxfPolyline). Counting distinct entity-start
    // markers proves "one entity per feature" without re-deriving the DXF grammar.
    const pointEntities = dxf.split('0\r\nPOINT\r\n').length - 1;
    const polylineEntities = dxf.split('0\r\nPOLYLINE\r\n').length - 1;
    expect(pointEntities).toBe(PER_CAT * 2);     // water_meters + sewage_manholes
    expect(polylineEntities).toBe(PER_CAT * 2);  // water_pipes + parcels
    expect(pointEntities + polylineEntities).toBe(N);

    expect(progressCalls[progressCalls.length - 1]).toEqual([N, N]);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(yieldsFor(N, 2000)); // 25
    expect(ms).toBeGreaterThan(0);
  }, 90000);

  it('CSV(+WKT): completes, one row per feature, geometry_wkt column present, yields exactly N/5000 times', async () => {
    const { ctx, setTimeoutSpy } = freshCtx();
    const features = makeFeatures(N);
    const { result: csvText } = await timed('CSV+WKT 50k', () => ctx.buildCSV(features, null, { wkt: true }));

    const rows = parseCSV(csvText);
    expect(rows.length).toBe(N + 1); // header + N
    expect(rows[0]).toContain('geometry_wkt');
    const wktCol = rows[0].indexOf('geometry_wkt');
    // Spot-check a sample spread across the file (not just row 1) — WKT always
    // starts with an uppercase geometry keyword for every fixture geometry type.
    [1, Math.floor(N / 2), N].forEach((i) => {
      expect(rows[i][wktCol]).toMatch(/^(POINT|LINESTRING|POLYGON) \(/);
    });
    expect(csvText.length).toBeGreaterThan(N * 30);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(yieldsFor(N, 5000)); // 10
  }, 90000);

  it('KML: completes, one Placemark per feature, yields exactly per-category N/4/5000 total', async () => {
    const { ctx, setTimeoutSpy } = freshCtx();
    const features = makeFeatures(N);
    const { result: kml } = await timed('KML 50k', () => ctx.buildKML(features, null));

    expect(kml.startsWith('<?xml')).toBe(true);
    expect(kml).toContain('</kml>');
    const placemarks = kml.split('<Placemark>').length - 1;
    expect(placemarks).toBe(N);
    expect(kml.length).toBeGreaterThan(N * 30);
    // buildKML chunks PER CATEGORY (groupByCategory then _forEachChunked per folder),
    // not over the flat array — so total yields = categories * floor(perCat/chunk).
    expect(setTimeoutSpy).toHaveBeenCalledTimes(NUM_CATS * yieldsFor(PER_CAT, 5000)); // 4*2=8
  }, 90000);

  it('GeoJSON: completes, strips internal _-prefixed keys, yields exactly N/5000 times', async () => {
    const { ctx, setTimeoutSpy } = freshCtx();
    const features = makeFeatures(N);
    const { result: geojsonText } = await timed('GeoJSON 50k', () => ctx.buildGeoJSON(features, null));

    const fc = JSON.parse(geojsonText);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features.length).toBe(N);
    expect(Object.keys(fc.features[0].properties).some((k) => k.startsWith('_'))).toBe(false);
    expect(geojsonText.length).toBeGreaterThan(N * 50);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(yieldsFor(N, 5000)); // 10
  }, 90000);

  it('buildShapefileCollections: completes, groups+reprojects all N features, yields exactly per-category N/4/2000 total', async () => {
    const { ctx, setTimeoutSpy } = freshCtx();
    const features = makeFeatures(N);
    const progressCalls = [];
    const { result: byCat } = await timed('Shapefile-prep 50k', () =>
      ctx.buildShapefileCollections(features, (done, total) => progressCalls.push([done, total])));

    expect(Object.keys(byCat).sort()).toEqual([...CATS].sort());
    let total = 0;
    Object.keys(byCat).forEach((c) => {
      expect(byCat[c].length).toBe(PER_CAT);
      total += byCat[c].length;
      // ITM (EPSG:2039) eastings/northings, not WGS84 lon/lat — sanity band.
      const [x, y] = byCat[c][0].geometry.type === 'Point' ? byCat[c][0].geometry.coordinates
        : byCat[c][0].geometry.type === 'LineString' ? byCat[c][0].geometry.coordinates[0]
        : byCat[c][0].geometry.coordinates[0][0];
      expect(x).toBeGreaterThan(100000); expect(x).toBeLessThan(400000);
      expect(y).toBeGreaterThan(400000); expect(y).toBeLessThan(900000);
    });
    expect(total).toBe(N);
    expect(progressCalls[progressCalls.length - 1]).toEqual([N, N]);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(NUM_CATS * yieldsFor(PER_CAT, 2000)); // 4*6=24
  }, 90000);

  it('buildExcelRows: completes, one row per feature across categories, yields exactly per-category N/4/2000 total', async () => {
    const { ctx, setTimeoutSpy } = freshCtx();
    const features = makeFeatures(N);
    const { result: byCat } = await timed('Excel-prep 50k', () => ctx.buildExcelRows(features, null, { wkt: true }));

    expect(Object.keys(byCat).sort()).toEqual([...CATS].sort());
    let total = 0;
    Object.keys(byCat).forEach((c) => {
      expect(byCat[c].length).toBe(PER_CAT);
      total += byCat[c].length;
      expect(byCat[c][0]).toHaveProperty('geometry_wkt');
      expect(byCat[c][0].category).toBe(c);
    });
    expect(total).toBe(N);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(NUM_CATS * yieldsFor(PER_CAT, 2000)); // 4*6=24
  }, 90000);
});
