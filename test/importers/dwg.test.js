// Unit tests for the DWG importer (js/importers/dwg.js) — a thin wrapper
// around window.dwgToGeoJSON (js/backend-client.js, not touched/loaded here).
import { describe, it, expect, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function load(extra) {
  return loadBrowserGlobals(['js/importers/dwg.js'], extra || {});
}

describe('Importers.dwg (js/importers/dwg.js)', () => {
  it('rejects with a Hebrew message when the backend client script is not loaded', async () => {
    const ctx = load(); // no window.dwgToGeoJSON stub
    await expect(ctx.Importers.dwg.parse({ name: 'x.dwg' })).rejects.toThrow(/שירות/);
  });

  it('forwards file/options/onProgress to window.dwgToGeoJSON and reports detectedCRS "wgs84"', async () => {
    const dwgToGeoJSON = vi.fn((file, opts, onProgress) => {
      onProgress('process', 50, 'ממיר...');
      return Promise.resolve({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [35.3, 32.9] }, properties: {} }] });
    });
    const ctx = load({ dwgToGeoJSON });
    const file = { name: 'plan.dwg' };
    const onProgress = vi.fn();
    const result = await ctx.Importers.dwg.parse(file, { dwgOptions: { sourceCrs: 'EPSG:2039' }, onProgress });

    expect(dwgToGeoJSON).toHaveBeenCalledWith(file, { sourceCrs: 'EPSG:2039' }, onProgress);
    expect(onProgress).toHaveBeenCalledWith('process', 50, 'ממיר...');
    expect(result.detectedCRS).toBe('wgs84');
    expect(result.features).toHaveLength(1);
  });

  it('rejects with a Hebrew message when the conversion returns no features', async () => {
    const dwgToGeoJSON = vi.fn(() => Promise.resolve({ type: 'FeatureCollection', features: [] }));
    const ctx = load({ dwgToGeoJSON });
    await expect(ctx.Importers.dwg.parse({ name: 'empty.dwg' })).rejects.toThrow(/לא נמצאו אובייקטים/);
  });
});
