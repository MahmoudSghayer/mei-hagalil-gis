// Unit tests for the general CSV importer (js/importers/csv.js): column
// auto-guessing, the needsMapping marker parse() returns, buildFeatures()'s
// WGS84 vs ITM reprojection path (via the real ImportPipeline + CRSUtils, not
// mocked), the WKT parser (round-tripped against export-formats.js's toWKT —
// the function it's the inverse of), and the 50k-row cap.
import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function load(extra) {
  return loadBrowserGlobals(
    ['js/crs-utils.js', 'js/import-pipeline.js', 'js/importers/csv.js'],
    { proj4, ...extra }
  );
}

function fakeFile(text) {
  return { text: () => Promise.resolve(text) };
}

describe('Importers.csv.parse — needsMapping marker + auto-guess', () => {
  it('returns {needsMapping:true, headers, rows, preview, guess} without building features', async () => {
    const ctx = load();
    const csv = 'name,lon,lat\nA,35.30,32.86\nB,35.31,32.87\n';
    const result = await ctx.Importers.csv.parse(fakeFile(csv));
    expect(result.needsMapping).toBe(true);
    expect(result.headers).toEqual(['name', 'lon', 'lat']);
    expect(result.rows).toEqual([
      { name: 'A', lon: '35.30', lat: '32.86' },
      { name: 'B', lon: '35.31', lat: '32.87' },
    ]);
    expect(result.preview).toEqual(result.rows);
  });

  it('auto-guesses lon/lat columns from common English headers', async () => {
    const ctx = load();
    const csv = 'id,longitude,latitude\n1,35.3,32.9\n';
    const result = await ctx.Importers.csv.parse(fakeFile(csv));
    expect(result.guess.lon).toBe(1);
    expect(result.guess.lat).toBe(2);
    expect(result.guess.wkt).toBe(-1);
    expect(result.guess.layer).toBe(-1);
  });

  it('auto-guesses lon/lat from Hebrew headers (קו אורך / קו רוחב) and a layer column', async () => {
    const ctx = load();
    const csv = 'שם,קו אורך,קו רוחב,שכבה\nמד 1,35.3,32.9,מדי מים\n';
    const result = await ctx.Importers.csv.parse(fakeFile(csv));
    expect(result.guess.lon).toBe(1);
    expect(result.guess.lat).toBe(2);
    expect(result.guess.layer).toBe(3);
  });

  it('auto-guesses a WKT/geometry column when present', async () => {
    const ctx = load();
    const csv = 'name,geometry_wkt\nA,"POINT (35.3 32.9)"\n';
    const result = await ctx.Importers.csv.parse(fakeFile(csv));
    expect(result.guess.wkt).toBe(1);
  });

  it('rejects a file with no data rows', async () => {
    const ctx = load();
    await expect(ctx.Importers.csv.parse(fakeFile('name,lon,lat\n'))).rejects.toThrow(/כותרת/);
  });

  it('enforces the 50,000-row cap with a Hebrew error', async () => {
    const ctx = load();
    const lines = ['name,lon,lat'];
    for (let i = 0; i < 50001; i++) lines.push(`p${i},35.3,32.9`);
    await expect(ctx.Importers.csv.parse(fakeFile(lines.join('\n') + '\n')))
      .rejects.toThrow(/50000|50,000/);
  });

  it('accepts exactly 50,000 rows (at the cap, not over it)', async () => {
    const ctx = load();
    const lines = ['name,lon,lat'];
    for (let i = 0; i < 50000; i++) lines.push(`p${i},35.3,32.9`);
    const result = await ctx.Importers.csv.parse(fakeFile(lines.join('\n') + '\n'));
    expect(result.rows).toHaveLength(50000);
  });
});

describe('Importers.csv.buildFeatures — X/Y path + CRS radio', () => {
  it('builds Point features from lon/lat columns, keeps other columns as properties', () => {
    const ctx = load();
    const rows = [
      { name: 'Meter A', lon: '35.2978', lat: '32.8650', extra: 'x' },
      { name: 'Meter B', lon: '35.3339', lat: '32.8514', extra: 'y' },
    ];
    const result = ctx.Importers.csv.buildFeatures(rows, { lonCol: 'lon', latCol: 'lat', crs: 'wgs84' });
    expect(result.detectedCRS).toBe('wgs84');
    expect(result.features).toHaveLength(2);
    expect(result.features[0].geometry).toEqual({ type: 'Point', coordinates: [35.2978, 32.865] });
    expect(result.features[0].properties).toEqual({ name: 'Meter A', extra: 'x', _original_layer: 'CSV' });
    // lon/lat columns themselves are dropped from properties (redundant with geometry)
    expect(result.features[0].properties.lon).toBeUndefined();
  });

  it('WGS84 radio: coordinates pass through unchanged end-to-end via ImportPipeline', () => {
    const ctx = load();
    const rows = [{ name: 'A', lon: '35.2978', lat: '32.8650' }];
    const built = ctx.Importers.csv.buildFeatures(rows, { lonCol: 'lon', latCol: 'lat', crs: 'wgs84' });
    const validated = ctx.ImportPipeline.validate(built);
    const result = ctx.ImportPipeline.reproject(validated);
    expect(result.reprojected).toBe(false);
    expect(result.features[0].geometry.coordinates).toEqual([35.2978, 32.865]);
  });

  it('ITM radio: coordinates are reprojected to WGS84 end-to-end via ImportPipeline + real proj4', () => {
    const ctx = load();
    // Same ITM point used in test/fixtures/import/itm-points.geojson (Sakhnin area)
    const rows = [{ name: 'sakhnin_center', x: '228194.3718743689', y: '752247.1110639628' }];
    const built = ctx.Importers.csv.buildFeatures(rows, { lonCol: 'x', latCol: 'y', crs: 'itm' });
    expect(built.detectedCRS).toBe('itm');

    const validated = ctx.ImportPipeline.validate(built);
    const result = ctx.ImportPipeline.reproject(validated);
    expect(result.reprojected).toBe(true);
    const [lng, lat] = result.features[0].geometry.coordinates;
    expect(lng).toBeCloseTo(35.2978, 2);
    expect(lat).toBeCloseTo(32.8650, 2);
  });

  it('uses a layer column when supplied, else falls back to "CSV"', () => {
    const ctx = load();
    const rows = [
      { name: 'A', lon: '35.3', lat: '32.9', layer: 'מדי מים' },
      { name: 'B', lon: '35.31', lat: '32.91', layer: '' },
    ];
    const result = ctx.Importers.csv.buildFeatures(rows, { lonCol: 'lon', latCol: 'lat', layerCol: 'layer', crs: 'wgs84' });
    expect(result.features[0].properties._original_layer).toBe('מדי מים');
    expect(result.features[1].properties._original_layer).toBe('CSV');
    expect(result.sourceLayers.sort()).toEqual(['CSV', 'מדי מים'].sort());
  });

  it('skips rows with missing/invalid coordinates and reports a Hebrew warning', () => {
    const ctx = load();
    const rows = [
      { name: 'A', lon: '35.3', lat: '32.9' },
      { name: 'B', lon: '', lat: '32.9' },
      { name: 'C', lon: 'not-a-number', lat: '32.9' },
    ];
    const result = ctx.Importers.csv.buildFeatures(rows, { lonCol: 'lon', latCol: 'lat', crs: 'wgs84' });
    expect(result.features).toHaveLength(1);
    expect(result.warnings.some((w) => /דולגו/.test(w))).toBe(true);
  });
});

describe('Importers.csv.buildFeatures — WKT geometry column', () => {
  it('builds geometries from a WKT column instead of X/Y', () => {
    const ctx = load();
    const rows = [
      { name: 'pt', wkt: 'POINT (35.2978 32.865)' },
      { name: 'line', wkt: 'LINESTRING (35.29 32.86, 35.3 32.87)' },
    ];
    const result = ctx.Importers.csv.buildFeatures(rows, { wktCol: 'wkt', crs: 'wgs84' });
    expect(result.features).toHaveLength(2);
    expect(result.features[0].geometry).toEqual({ type: 'Point', coordinates: [35.2978, 32.865] });
    expect(result.features[1].geometry).toEqual({ type: 'LineString', coordinates: [[35.29, 32.86], [35.3, 32.87]] });
    // the WKT column itself is dropped from properties
    expect(result.features[0].properties.wkt).toBeUndefined();
  });
});

describe('Importers.csv.parseWKT — round trip against export-formats.js toWKT (the inverse it targets)', () => {
  function loadWithToWKT() {
    return loadBrowserGlobals(['js/export-formats.js', 'js/importers/csv.js'], { proj4, setTimeout });
  }

  it('POINT round-trips exactly', () => {
    const ctx = loadWithToWKT();
    const geom = { type: 'Point', coordinates: [35.2978, 32.865] };
    const wkt = ctx.toWKT(geom);
    expect(ctx.Importers.csv.parseWKT(wkt)).toEqual(geom);
  });

  it('LINESTRING round-trips exactly', () => {
    const ctx = loadWithToWKT();
    const geom = { type: 'LineString', coordinates: [[35.29, 32.86], [35.30, 32.87], [35.31, 32.88]] };
    const wkt = ctx.toWKT(geom);
    expect(ctx.Importers.csv.parseWKT(wkt)).toEqual(geom);
  });

  it('POLYGON (with a hole) round-trips exactly', () => {
    const ctx = loadWithToWKT();
    const geom = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]],
      ],
    };
    const wkt = ctx.toWKT(geom);
    expect(ctx.Importers.csv.parseWKT(wkt)).toEqual(geom);
  });

  it('rejects an unsupported WKT type (e.g. MULTIPOINT) with a Hebrew error', () => {
    const ctx = load();
    expect(() => ctx.Importers.csv.parseWKT('MULTIPOINT (0 0, 1 1)')).toThrow(/לא נתמך/);
  });

  it('rejects malformed WKT with a Hebrew error', () => {
    const ctx = load();
    expect(() => ctx.Importers.csv.parseWKT('not wkt at all')).toThrow(/לא תקין/);
    expect(() => ctx.Importers.csv.parseWKT('')).toThrow();
    expect(() => ctx.Importers.csv.parseWKT(null)).toThrow();
  });
});
