// Unit tests for the GeoJSON importer (js/importers/geojson.js) and its
// integration with ImportPipeline's validate/reproject stages — this is the
// path that used to have the ITM auto-reprojection bug (dormant helpers in
// upload.js were defined but never applied to the GeoJSON path).
import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const ITM_FIXTURE_PATH = resolve(REPO_ROOT, 'test/fixtures/import/itm-points.geojson');

function load() {
  return loadBrowserGlobals(
    ['js/crs-utils.js', 'js/import-pipeline.js', 'js/importers/geojson.js'],
    { proj4: proj4 }
  );
}

// A minimal stand-in for a browser File/Blob: geojson.js prefers `.text()`
// (works identically in real browsers and here) over FileReader.
function fakeFile(text) {
  return { text: () => Promise.resolve(text) };
}

describe('Importers.geojson (js/importers/geojson.js)', () => {
  it('rejects invalid JSON', async () => {
    const ctx = load();
    await expect(ctx.Importers.geojson.parse(fakeFile('{not json'))).rejects.toThrow(/JSON/);
  });

  it('rejects valid JSON that is not a GeoJSON FeatureCollection', async () => {
    const ctx = load();
    await expect(ctx.Importers.geojson.parse(fakeFile(JSON.stringify({ type: 'Point', coordinates: [1, 2] }))))
      .rejects.toThrow(/GeoJSON/);
  });

  it('detectCRS: wgs84 for ordinary lon/lat features', () => {
    const ctx = load();
    const features = [
      { geometry: { type: 'Point', coordinates: [35.2978, 32.8650] } },
      { geometry: { type: 'Point', coordinates: [35.3339, 32.8514] } },
    ];
    expect(ctx.Importers.geojson.detectCRS(features)).toBe('wgs84');
  });

  it('detectCRS: itm for projected easting/northing features', () => {
    const ctx = load();
    const features = [
      { geometry: { type: 'Point', coordinates: [228194.37, 752247.11] } },
      { geometry: { type: 'Point', coordinates: [231575.05, 750742.39] } },
    ];
    expect(ctx.Importers.geojson.detectCRS(features)).toBe('itm');
  });

  it('detectCRS: unknown when there is no usable geometry to sample', () => {
    const ctx = load();
    expect(ctx.Importers.geojson.detectCRS([{ geometry: null }])).toBe('unknown');
    expect(ctx.Importers.geojson.detectCRS([])).toBe('unknown');
  });

  describe('end-to-end with the ITM fixture (test/fixtures/import/itm-points.geojson)', () => {
    it('parse() reports detectedCRS "itm"', async () => {
      const ctx = load();
      const text = readFileSync(ITM_FIXTURE_PATH, 'utf8');
      const parsed = await ctx.Importers.geojson.parse(fakeFile(text));
      expect(parsed.detectedCRS).toBe('itm');
      expect(parsed.features).toHaveLength(3);
    });

    it('ImportPipeline.run reprojects the ITM fixture into the Israel bbox (the bug fix)', async () => {
      const ctx = load();
      const text = readFileSync(ITM_FIXTURE_PATH, 'utf8');
      const parsed = await ctx.Importers.geojson.parse(fakeFile(text));
      const validated = ctx.ImportPipeline.validate(parsed);
      const result = ctx.ImportPipeline.reproject(validated);

      expect(result.reprojected).toBe(true);
      expect(result.features).toHaveLength(3);
      result.features.forEach((f) => {
        const [lng, lat] = f.geometry.coordinates;
        // Israel bounding box used elsewhere in the app (upload.js validateCoord)
        expect(lng).toBeGreaterThan(34);
        expect(lng).toBeLessThan(37);
        expect(lat).toBeGreaterThan(29);
        expect(lat).toBeLessThan(34);
      });
      // Sanity: the first fixture point is "sakhnin_center" — should land close
      // to the real village anchor (32.8650, 35.2978) after reprojection.
      const sakhnin = result.features.find((f) => f.properties.name === 'sakhnin_center');
      expect(sakhnin.geometry.coordinates[0]).toBeCloseTo(35.2978, 2);
      expect(sakhnin.geometry.coordinates[1]).toBeCloseTo(32.8650, 2);
    });
  });

  it('a normal WGS84 GeoJSON file is left untouched by the pipeline (no spurious reprojection)', async () => {
    const ctx = load();
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { Layer: 'x' }, geometry: { type: 'Point', coordinates: [35.2978, 32.8650] } },
      ],
    };
    const parsed = await ctx.Importers.geojson.parse(fakeFile(JSON.stringify(fc)));
    expect(parsed.detectedCRS).toBe('wgs84');

    const validated = ctx.ImportPipeline.validate(parsed);
    const result = ctx.ImportPipeline.reproject(validated);
    expect(result.reprojected).toBe(false);
    expect(result.features[0].geometry.coordinates).toEqual([35.2978, 32.8650]);
  });
});
