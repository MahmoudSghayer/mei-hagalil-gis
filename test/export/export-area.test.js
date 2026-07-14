import { describe, it, expect, vi } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
import { makeAppDocument } from '../fixtures/export/stub-dom.mjs';

// Loads export-formats.js (LABELS) + export-feature.js (the area-summary
// internals under test) exactly like the app does, then reaches into
// window.__exportTestHooks — the same pattern test/export/shapefile.test.js
// and excel.test.js use to unit-test pieces of a zero-build IIFE file.
function makeCtx(extra) {
  return loadBrowserGlobals(['js/export-formats.js', 'js/export-feature.js'], {
    proj4,
    document: makeAppDocument(),
    ...extra,
  });
}

describe('geometryTypesLabel (Hebrew geometry-type buckets)', () => {
  const ctx = makeCtx();
  const { geometryTypesLabel } = ctx.__exportTestHooks;

  it('maps POINT/MULTIPOINT to נקודות', () => {
    expect(geometryTypesLabel(['POINT'])).toBe('נקודות');
    expect(geometryTypesLabel(['MULTIPOINT'])).toBe('נקודות');
  });

  it('maps LINESTRING/MULTILINESTRING to קווים (deduped)', () => {
    expect(geometryTypesLabel(['LINESTRING', 'MULTILINESTRING'])).toBe('קווים');
  });

  it('maps POLYGON/MULTIPOLYGON to פוליגונים', () => {
    expect(geometryTypesLabel(['MULTIPOLYGON'])).toBe('פוליגונים');
  });

  it('joins mixed geometry types with the separator', () => {
    const label = geometryTypesLabel(['POINT', 'POLYGON']);
    expect(label).toContain('נקודות');
    expect(label).toContain('פוליגונים');
    expect(label).toContain(' · ');
  });

  it('falls back to em-dash for no/unknown types', () => {
    expect(geometryTypesLabel([])).toBe('—');
    expect(geometryTypesLabel(undefined)).toBe('—');
  });

  it('is case-insensitive (PostGIS GeometryType() is upper-case, but be defensive)', () => {
    expect(geometryTypesLabel(['point'])).toBe('נקודות');
  });
});

describe('estimateBytes / fmtBytes (size-estimate heuristic per format)', () => {
  const ctx = makeCtx();
  const { estimateBytes, fmtBytes } = ctx.__exportTestHooks;

  it('scales linearly with feature count per format tier', () => {
    const shp100 = estimateBytes('shapefile', 100, ['POINT']);
    const shp200 = estimateBytes('shapefile', 200, ['POINT']);
    expect(shp200).toBe(shp100 * 2);
    expect(shp100).toBeGreaterThan(0);
  });

  it('bumps the estimate for line/polygon geometry vs pure points', () => {
    const pts = estimateBytes('dxf', 100, ['POINT']);
    const lines = estimateBytes('dxf', 100, ['LINESTRING']);
    const polys = estimateBytes('dxf', 100, ['POLYGON']);
    expect(lines).toBeGreaterThan(pts);
    expect(polys).toBeGreaterThan(pts);
  });

  it('verbose text formats (dxf/kml/geojson) estimate larger than compact ones (shapefile/csv) for the same count', () => {
    const shp = estimateBytes('shapefile', 1000, ['POINT']);
    const csv = estimateBytes('csv', 1000, ['POINT']);
    const kml = estimateBytes('kml', 1000, ['POINT']);
    const geojson = estimateBytes('geojson', 1000, ['POINT']);
    expect(kml).toBeGreaterThan(shp);
    expect(geojson).toBeGreaterThan(csv);
  });

  it('falls back to a default tier for an unknown format and never goes negative', () => {
    expect(estimateBytes('made_up_format', 10, ['POINT'])).toBeGreaterThan(0);
    expect(estimateBytes('csv', 0, [])).toBe(0);
    expect(estimateBytes('csv', -5, [])).toBe(0);
  });

  it('fmtBytes renders human-readable tiers', () => {
    expect(fmtBytes(500)).toBe('500 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(fmtBytes(0)).toBe('0 B');
  });
});

describe('crsLabelFor (output CRS per format)', () => {
  const ctx = makeCtx();
  const { crsLabelFor } = ctx.__exportTestHooks;

  it('ITM (EPSG:2039) for dxf/dwg/shapefile', () => {
    expect(crsLabelFor('dxf')).toContain('2039');
    expect(crsLabelFor('dwg')).toContain('2039');
    expect(crsLabelFor('shapefile')).toContain('2039');
  });

  it('WGS84 (EPSG:4326) for everything else', () => {
    ['geojson', 'kml', 'csv', 'excel'].forEach((f) => {
      expect(crsLabelFor(f)).toContain('4326');
    });
  });
});

describe('parseLayerName (village · category, with LayerNaming load-order fallback)', () => {
  it('inline fallback parses "village · category" when window.LayerNaming is absent', () => {
    const ctx = makeCtx();
    expect(ctx.window.LayerNaming).toBeUndefined(); // js/layer-naming.js is NOT in this file list — matches
    const { parseLayerName } = ctx.__exportTestHooks; // production load order today (see index.html)
    expect(parseLayerName('כפר טסט · water_meters')).toEqual({ village: 'כפר טסט', category: 'water_meters' });
  });

  it('treats a name with no separator as the whole category (tolerant fallback)', () => {
    const ctx = makeCtx();
    const { parseLayerName } = ctx.__exportTestHooks;
    expect(parseLayerName('water_meters')).toEqual({ village: null, category: 'water_meters' });
  });

  it('prefers window.LayerNaming.parse when present (feature-detected)', () => {
    const parse = vi.fn(() => ({ village: 'STUB_V', category: 'STUB_C' }));
    const ctx = makeCtx({ LayerNaming: { parse } });
    const { parseLayerName } = ctx.__exportTestHooks;
    expect(parseLayerName('anything')).toEqual({ village: 'STUB_V', category: 'STUB_C' });
    expect(parse).toHaveBeenCalledWith('anything');
  });
});

describe('buildAreaSummaryModel / areaSummaryTotals (RPC rows in -> modal model out, incl. exclusions)', () => {
  const ctx = makeCtx();
  const { buildAreaSummaryModel, areaSummaryTotals, AREA_FETCH_CAP } = ctx.__exportTestHooks;

  it('aggregates multiple village layers of the same category into one row', () => {
    const rpcRows = [
      { layer_id: 'l1', name: 'כפר א · water_meters', count: 10, geometry_types: ['POINT'] },
      { layer_id: 'l2', name: 'כפר ב · water_meters', count: 5, geometry_types: ['POINT'] },
    ];
    const model = buildAreaSummaryModel(rpcRows, ['water_meters'], 'geojson');
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ cat: 'water_meters', count: 15, enabled: true, overCap: false, previewPartial: false });
    expect(model.rows[0].geomTypesLabel).toBe('נקודות');
  });

  it('includes every requested category even when the RPC returned nothing for it (0-count row)', () => {
    const model = buildAreaSummaryModel([], ['water_meters', 'hydrants'], 'csv');
    expect(model.rows.map((r) => r.cat).sort()).toEqual(['hydrants', 'water_meters']);
    model.rows.forEach((r) => expect(r.count).toBe(0));
    const totals = areaSummaryTotals(model);
    expect(totals.count).toBe(0);
    expect(totals.empty).toBe(true);
  });

  it('ignores RPC rows for categories that were not requested (defensive)', () => {
    const rpcRows = [{ layer_id: 'l1', name: 'כפר א · parcels', count: 999, geometry_types: ['POLYGON'] }];
    const model = buildAreaSummaryModel(rpcRows, ['water_meters'], 'csv');
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].cat).toBe('water_meters');
    expect(model.rows[0].count).toBe(0);
  });

  it('flags overCap when a category count exceeds AREA_FETCH_CAP', () => {
    const rpcRows = [{ layer_id: 'l1', name: 'כפר א · water_pipes', count: AREA_FETCH_CAP + 1, geometry_types: ['LINESTRING'] }];
    const model = buildAreaSummaryModel(rpcRows, ['water_pipes'], 'dxf');
    expect(model.rows[0].overCap).toBe(true);
    // overCap does not shrink the DISPLAYED count — the warning is informational,
    // truncation only happens later, in the real server bbox fetch.
    expect(model.rows[0].count).toBe(AREA_FETCH_CAP + 1);
  });

  it('areaSummaryTotals recomputes count/size after a row is excluded (unchecked)', () => {
    const rpcRows = [
      { layer_id: 'l1', name: 'כפר א · water_meters', count: 100, geometry_types: ['POINT'] },
      { layer_id: 'l2', name: 'כפר א · hydrants', count: 50, geometry_types: ['POINT'] },
    ];
    const model = buildAreaSummaryModel(rpcRows, ['water_meters', 'hydrants'], 'shapefile');
    const before = areaSummaryTotals(model);
    expect(before.count).toBe(150);

    const hydrantsRow = model.rows.find((r) => r.cat === 'hydrants');
    hydrantsRow.enabled = false; // simulate the user unchecking that category's row

    const after = areaSummaryTotals(model);
    expect(after.count).toBe(100);
    expect(after.sizeBytes).toBeLessThan(before.sizeBytes);
    expect(after.empty).toBe(false);
  });

  it('areaSummaryTotals.empty is true only when every row is excluded (not the same as an empty area)', () => {
    const rpcRows = [{ layer_id: 'l1', name: 'כפר א · water_meters', count: 10, geometry_types: ['POINT'] }];
    const model = buildAreaSummaryModel(rpcRows, ['water_meters'], 'csv');
    model.rows[0].enabled = false;
    expect(areaSummaryTotals(model).empty).toBe(true);
    expect(model.rows[0].count).toBe(10); // the area itself is NOT empty, just deselected
  });
});

describe('leafletBoundsToPlain (duck-typed Leaflet LatLngBounds -> plain bbox)', () => {
  const ctx = makeCtx();
  const { leafletBoundsToPlain } = ctx.__exportTestHooks;

  it('reads getWest/getSouth/getEast/getNorth into {minLng,minLat,maxLng,maxLat}', () => {
    const fakeBounds = { getWest: () => 35.1, getSouth: () => 32.8, getEast: () => 35.3, getNorth: () => 33.0 };
    expect(leafletBoundsToPlain(fakeBounds)).toEqual({ minLng: 35.1, minLat: 32.8, maxLng: 35.3, maxLat: 33.0 });
  });
});

describe('catsJobs / uniqueLayerIds (category -> engine layer mapping)', () => {
  it('produces one job per (category, layer) pair from gExp.layers, skipping unknown categories', () => {
    const ctx = makeCtx();
    const { gExp, catsJobs, uniqueLayerIds } = ctx.__exportTestHooks;
    gExp.layers = {
      water_meters: { layerIds: [{ id: 'L1', village: 'כפר א' }, { id: 'L2', village: 'כפר ב' }] },
      hydrants: { layerIds: [{ id: 'L3', village: 'כפר א' }] },
    };
    const jobs = catsJobs(['water_meters', 'hydrants', 'does_not_exist']);
    expect(jobs).toEqual([
      { cat: 'water_meters', id: 'L1', village: 'כפר א' },
      { cat: 'water_meters', id: 'L2', village: 'כפר ב' },
      { cat: 'hydrants', id: 'L3', village: 'כפר א' },
    ]);
    expect(uniqueLayerIds(jobs)).toEqual(['L1', 'L2', 'L3']);
  });
});

describe('fetchAreaFeaturesServerSide (draw-scope server bbox fetch fan-out)', () => {
  function setupGis(getInBBoxImpl) {
    const calls = [];
    const GIS = {
      features: {
        getInBBox: vi.fn((layerId, bounds, limit) => {
          calls.push({ layerId, bounds, limit });
          return Promise.resolve(getInBBoxImpl(layerId, bounds, limit));
        }),
      },
    };
    return { GIS, calls };
  }

  it('calls GIS.features.getInBBox exactly once per checked layer, with the drawn bounds and the AREA_FETCH_CAP limit', async () => {
    const ctx = makeCtx();
    const { gExp, fetchAreaFeaturesServerSide, AREA_FETCH_CAP } = ctx.__exportTestHooks;
    gExp.layers = {
      water_meters: { layerIds: [{ id: 'L1', village: 'כפר א' }] },
      hydrants: { layerIds: [{ id: 'L2', village: 'כפר א' }] },
    };
    const { GIS, calls } = setupGis((layerId) => ({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [35, 33] }, properties: {} }],
    }));
    ctx.window.GIS = GIS;

    const bounds = { minLng: 35.0, minLat: 32.8, maxLng: 35.5, maxLat: 33.1 };
    const features = await new Promise((resolve) => fetchAreaFeaturesServerSide(['water_meters', 'hydrants'], bounds, resolve));

    expect(calls).toHaveLength(2);
    calls.forEach((c) => { expect(c.bounds).toBe(bounds); expect(c.limit).toBe(AREA_FETCH_CAP); });
    expect(calls.map((c) => c.layerId).sort()).toEqual(['L1', 'L2']);

    expect(features).toHaveLength(2);
    expect(features.every((f) => f.properties._category)).toBe(true);
    expect(features.every((f) => f.properties._village === 'כפר א')).toBe(true);
  });

  it('stamps the correct _category per layer even when categories are fetched concurrently', async () => {
    const ctx = makeCtx();
    const { gExp, fetchAreaFeaturesServerSide } = ctx.__exportTestHooks;
    gExp.layers = {
      water_meters: { layerIds: [{ id: 'L1', village: 'כפר א' }] },
      hydrants: { layerIds: [{ id: 'L2', village: 'כפר א' }] },
    };
    const { GIS } = setupGis((layerId) => ({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [35, 33] }, properties: {} }],
    }));
    ctx.window.GIS = GIS;

    const bounds = { minLng: 0, minLat: 0, maxLng: 1, maxLat: 1 };
    const features = await new Promise((resolve) => fetchAreaFeaturesServerSide(['water_meters', 'hydrants'], bounds, resolve));
    const byCat = Object.fromEntries(features.map((f) => [f.properties._category, f]));
    expect(byCat.water_meters).toBeTruthy();
    expect(byCat.hydrants).toBeTruthy();
  });

  it('over-cap warning path: the fetch still runs (capped at AREA_FETCH_CAP) even when the area-summary count exceeded the cap — no throw, features come back', async () => {
    const ctx = makeCtx();
    const { gExp, fetchAreaFeaturesServerSide, buildAreaSummaryModel, AREA_FETCH_CAP } = ctx.__exportTestHooks;
    gExp.layers = { water_pipes: { layerIds: [{ id: 'L1', village: 'כפר א' }] } };

    // The summary step would have flagged this row as overCap...
    const model = buildAreaSummaryModel(
      [{ layer_id: 'L1', name: 'כפר א · water_pipes', count: AREA_FETCH_CAP + 500, geometry_types: ['LINESTRING'] }],
      ['water_pipes'], 'dxf'
    );
    expect(model.rows[0].overCap).toBe(true);

    // ...and the server itself (features_in_bbox, via the migration's LIMIT clamp) is what
    // actually enforces the cap — the client just requests AREA_FETCH_CAP and trusts it.
    const { GIS, calls } = setupGis(() => ({
      type: 'FeatureCollection',
      features: Array.from({ length: 3 }, (_, i) => ({
        type: 'Feature', geometry: { type: 'LineString', coordinates: [[35, 33], [35.01, 33.01]] }, properties: { i },
      })), // stub server "capped" response — fan-out itself doesn't truncate client-side
    }));
    ctx.window.GIS = GIS;

    const bounds = { minLng: 0, minLat: 0, maxLng: 1, maxLat: 1 };
    const features = await new Promise((resolve) => fetchAreaFeaturesServerSide(['water_pipes'], bounds, resolve));
    expect(calls[0].limit).toBe(AREA_FETCH_CAP); // client asked for exactly the cap, not "unlimited"
    expect(features).toHaveLength(3);
  });

  it('resolves with an empty array when the checked layer has nothing in the bbox (empty-area path)', async () => {
    const ctx = makeCtx();
    const { gExp, fetchAreaFeaturesServerSide } = ctx.__exportTestHooks;
    gExp.layers = { water_meters: { layerIds: [{ id: 'L1', village: 'כפר א' }] } };
    const { GIS } = setupGis(() => ({ type: 'FeatureCollection', features: [] }));
    ctx.window.GIS = GIS;

    const bounds = { minLng: 0, minLat: 0, maxLng: 0.001, maxLat: 0.001 };
    const features = await new Promise((resolve) => fetchAreaFeaturesServerSide(['water_meters'], bounds, resolve));
    expect(features).toEqual([]);
  });
});
