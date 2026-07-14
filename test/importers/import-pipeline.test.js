// Unit tests for ImportPipeline (js/import-pipeline.js) — the
// parse -> validate -> reproject -> mapToLayers -> commit stages that
// js/pages/upload.js now delegates to instead of doing everything inline.
import { describe, it, expect, vi } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function load(extra) {
  return loadBrowserGlobals(['js/crs-utils.js', 'js/import-pipeline.js'], { proj4, ...extra });
}

describe('ImportPipeline.parse — format dispatch', () => {
  it('rejects an unregistered format', async () => {
    const ctx = load();
    await expect(ctx.ImportPipeline.parse('nope', {})).rejects.toThrow(/פורמט/);
  });

  it('delegates to window.Importers[format].parse(file, opts)', async () => {
    const parseSpy = vi.fn(() => Promise.resolve({ features: [], detectedCRS: 'wgs84', warnings: [], sourceLayers: [] }));
    const ctx = load({ Importers: { geojson: { parse: parseSpy } } });
    const file = { name: 'x.geojson' };
    const opts = { onProgress: () => {} };
    await ctx.ImportPipeline.parse('geojson', file, opts);
    expect(parseSpy).toHaveBeenCalledWith(file, opts);
  });
});

describe('ImportPipeline.validate', () => {
  it('drops features with missing/invalid geometry and reports how many', () => {
    const ctx = load();
    const parsed = {
      features: [
        { geometry: { type: 'Point', coordinates: [35.2, 32.8] }, properties: { a: 1 } },
        { geometry: null, properties: { a: 2 } },                                  // no geometry
        { geometry: { type: 'Point', coordinates: [NaN, 32.8] }, properties: {} }, // non-finite coord
        { geometry: { type: 'Bogus', coordinates: [1, 2] }, properties: {} },      // invalid type
        {},                                                                         // missing everything
      ],
      detectedCRS: 'wgs84', warnings: [], sourceLayers: [],
    };
    const out = ctx.ImportPipeline.validate(parsed);
    expect(out.features).toHaveLength(1);
    expect(out.warnings.some((w) => /4/.test(w))).toBe(true); // 4 dropped
  });

  it('trims property keys and preserves values, including underscore-prefixed bookkeeping keys', () => {
    const ctx = load();
    const parsed = {
      features: [{
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { ' Layer ': 'water_pipes', _category: 'water_pipes', material: 'PVC' },
      }],
      detectedCRS: 'wgs84', warnings: [], sourceLayers: [],
    };
    const out = ctx.ImportPipeline.validate(parsed);
    expect(out.features[0].properties).toEqual({ Layer: 'water_pipes', _category: 'water_pipes', material: 'PVC' });
  });

  it('accepts GeometryCollection without requiring .coordinates', () => {
    const ctx = load();
    const parsed = {
      features: [{ geometry: { type: 'GeometryCollection', geometries: [] }, properties: {} }],
      detectedCRS: 'wgs84', warnings: [], sourceLayers: [],
    };
    expect(ctx.ImportPipeline.validate(parsed).features).toHaveLength(1);
  });
});

describe('ImportPipeline.reproject', () => {
  it('reprojects when detectedCRS is "itm"', () => {
    const ctx = load();
    const validated = {
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [228194.37, 752247.11] } }],
      detectedCRS: 'itm', warnings: [], sourceLayers: [],
    };
    const out = ctx.ImportPipeline.reproject(validated);
    expect(out.reprojected).toBe(true);
    expect(out.features[0].geometry.coordinates[0]).toBeCloseTo(35.2978, 2);
  });

  it('reprojects when detectedCRS is "unknown" but coordinates look like ITM', () => {
    const ctx = load();
    const validated = {
      features: Array.from({ length: 10 }, () => ({
        type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [228194.37, 752247.11] },
      })),
      detectedCRS: 'unknown', warnings: [], sourceLayers: [],
    };
    const out = ctx.ImportPipeline.reproject(validated);
    expect(out.reprojected).toBe(true);
  });

  it('does NOT reproject wgs84 data, and passes unknown-non-ITM-looking data through unchanged', () => {
    const ctx = load();
    const wgs84 = ctx.ImportPipeline.reproject({
      features: [{ geometry: { type: 'Point', coordinates: [35.2978, 32.865] } }],
      detectedCRS: 'wgs84', warnings: [], sourceLayers: [],
    });
    expect(wgs84.reprojected).toBe(false);
    expect(wgs84.features[0].geometry.coordinates).toEqual([35.2978, 32.865]);

    const unknown = ctx.ImportPipeline.reproject({
      features: [{ geometry: { type: 'Point', coordinates: [35.2978, 32.865] } }], // WGS84-shaped, not ITM
      detectedCRS: 'unknown', warnings: [], sourceLayers: [],
    });
    expect(unknown.reprojected).toBe(false);
  });
});

describe('ImportPipeline.getLayerName', () => {
  it('prefers Layer, then layer/LAYER, then bookkeeping fields, then UNKNOWN', () => {
    const ctx = load();
    expect(ctx.ImportPipeline.getLayerName({ properties: { Layer: 'A' } })).toBe('A');
    expect(ctx.ImportPipeline.getLayerName({ properties: { layer: 'B' } })).toBe('B');
    expect(ctx.ImportPipeline.getLayerName({ properties: { LAYER: 'C' } })).toBe('C');
    expect(ctx.ImportPipeline.getLayerName({ properties: { _original_layer: 'D' } })).toBe('D');
    expect(ctx.ImportPipeline.getLayerName({ properties: { _category: 'E' } })).toBe('E');
    expect(ctx.ImportPipeline.getLayerName({ properties: {} })).toBe('UNKNOWN');
    expect(ctx.ImportPipeline.getLayerName({ properties: { Layer: '  ' } })).toBe('UNKNOWN');
  });
});

describe('ImportPipeline.mapToLayers', () => {
  const villageA = { name: 'כפר א', slug: 'a' };
  const villageB = { name: 'כפר ב', slug: 'b' };

  it('groups features by detected village, skipping IGNORE-mapped and unmatched layers', () => {
    const ctx = load();
    const features = [
      { properties: { Layer: 'PIPES' }, geometry: {} },   // -> villageA
      { properties: { Layer: 'PIPES' }, geometry: {} },   // -> villageA
      { properties: { Layer: 'SKIP_ME' }, geometry: {} }, // IGNORE-mapped: never reaches detectFeatureVillage
      { properties: { Layer: 'PIPES' }, geometry: {} },   // -> villageB
      { properties: { Layer: 'PIPES' }, geometry: {} },   // -> null (outside every village)
    ];
    const detectFeatureVillage = vi.fn()
      .mockReturnValueOnce(villageA)
      .mockReturnValueOnce(villageA)
      .mockReturnValueOnce(villageB)
      .mockReturnValueOnce(null);
    const out = ctx.ImportPipeline.mapToLayers(features, {
      layerStats: { PIPES: { mapping: 'water_pipes' }, SKIP_ME: { mapping: 'IGNORE' } },
      detectFeatureVillage,
    });
    // Only called for the 4 PIPES features — the IGNORE-mapped layer short-circuits first.
    expect(detectFeatureVillage).toHaveBeenCalledTimes(4);
    expect(Object.keys(out.taggedByVillage).sort()).toEqual(['a', 'b']);
    expect(out.taggedByVillage.a.features).toHaveLength(2);
    expect(out.taggedByVillage.b.features).toHaveLength(1);
    expect(out.taggedByVillage.a.features[0].properties._category).toBe('water_pipes');
    expect(out.taggedByVillage.a.features[0].properties._original_layer).toBe('PIPES');
    expect(out.ignoredCount).toBe(2); // 1 IGNORE-mapped + 1 unmatched village
  });

  it('overrideVillage forces every accepted feature into a single village', () => {
    const ctx = load();
    const features = [{ properties: { Layer: 'PIPES' }, geometry: {} }];
    const out = ctx.ImportPipeline.mapToLayers(features, {
      layerStats: { PIPES: { mapping: 'water_pipes' } },
      overrideVillage: villageB,
      detectFeatureVillage: () => { throw new Error('should not be called when overrideVillage is set'); },
    });
    expect(Object.keys(out.taggedByVillage)).toEqual(['b']);
  });
});

describe('ImportPipeline.commit', () => {
  it('imports each village in sequence via opts.importFeatures and totals the counts', async () => {
    const ctx = load();
    const importFeatures = vi.fn(async (name, slug, features) => ({ total: features.length }));
    const taggedByVillage = {
      a: { village: { name: 'כפר א', slug: 'a' }, features: [{}, {}] },
      b: { village: { name: 'כפר ב', slug: 'b' }, features: [{}] },
    };
    const onVillageStart = vi.fn();
    const onProgress = vi.fn();
    const result = await ctx.ImportPipeline.commit(taggedByVillage, { importFeatures, onVillageStart, onProgress });

    expect(result.totalAdded).toBe(3);
    expect(result.slugs.sort()).toEqual(['a', 'b']);
    expect(importFeatures).toHaveBeenCalledTimes(2);
    expect(importFeatures).toHaveBeenCalledWith('כפר א', 'a', taggedByVillage.a.features, expect.any(Object));
    expect(onVillageStart).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error if opts.importFeatures is missing', async () => {
    const ctx = load();
    await expect(ctx.ImportPipeline.commit({ a: { village: { name: 'x', slug: 'a' }, features: [] } }, {}))
      .rejects.toThrow(/importFeatures/);
  });
});
