import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
import { makeFeatures } from '../fixtures/export/generate-features.mjs';

describe('buildGeoJSON', () => {
  const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4 });

  it('deep-equals the input FeatureCollection modulo stripped internal (_-prefixed) keys', async () => {
    const features = makeFeatures(7);
    const out = JSON.parse(await ctx.buildGeoJSON(features, null));
    expect(out.type).toBe('FeatureCollection');
    expect(out.features.length).toBe(features.length);
    out.features.forEach((f, i) => {
      const src = features[i];
      expect(f.geometry).toEqual(src.geometry);
      const expectedProps = {};
      Object.keys(src.properties).forEach((k) => { if (k.charAt(0) !== '_') expectedProps[k] = src.properties[k]; });
      expect(f.properties).toEqual(expectedProps);
      expect(Object.keys(f.properties).some((k) => k.startsWith('_'))).toBe(false);
    });
  });

  it('does not mutate the input features (clones, does not strip in place)', async () => {
    const features = makeFeatures(3);
    const before = JSON.parse(JSON.stringify(features));
    await ctx.buildGeoJSON(features, null);
    expect(features).toEqual(before);
    expect('_category' in features[0].properties).toBe(true);
  });

  it('reports progress across chunk boundaries, ending at (total, total)', async () => {
    const calls = [];
    await ctx.buildGeoJSON(makeFeatures(20), (done, total) => calls.push([done, total]));
    expect(calls[calls.length - 1]).toEqual([20, 20]);
  });
});
