// Unit tests for window.CRSUtils (js/crs-utils.js) — the single canonical
// EPSG:2039 (Israeli ITM) definition + conversion/detection helpers used by
// the import pipeline. Loads the real browser-global script into a Node vm
// context with the real `proj4` package (devDependency) passed in as the
// global proj4 the script expects to find already loaded via CDN in prod.
import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function load() {
  // Fresh proj4 instance per test file run — CRSUtils.defs() is idempotent
  // (guards with proj4.defs('EPSG:2039') before re-registering) so sharing
  // the imported module instance across tests in this file is fine.
  return loadBrowserGlobals(['js/crs-utils.js'], { proj4: proj4 });
}

// Haversine distance in meters — good enough for the small distances here.
function haversineMeters(lon1, lat1, lon2, lat2) {
  var R = 6371000;
  var toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad;
  var dLon = (lon2 - lon1) * toRad;
  var a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

describe('CRSUtils (js/crs-utils.js)', () => {
  it('exposes the expected API on window.CRSUtils', () => {
    const ctx = load();
    expect(ctx.CRSUtils).toBeTruthy();
    expect(typeof ctx.CRSUtils.itmToWgs84).toBe('function');
    expect(typeof ctx.CRSUtils.wgs84ToItm).toBe('function');
    expect(typeof ctx.CRSUtils.looksLikeITM).toBe('function');
    expect(typeof ctx.CRSUtils.reprojectFeatureCollection).toBe('function');
  });

  it('registers EPSG:2039 with the EXACT 7-param Helmert string used across the app', () => {
    const ctx = load();
    // Must match upload.js / export-feature.js / search-feature.js byte-for-byte
    // (they haven't been migrated to this module yet, but must stay in sync).
    expect(ctx.CRSUtils.EPSG2039_DEF).toBe(
      '+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 ' +
      '+k=1.0000067 +x_0=219529.584 +y_0=626907.39 +ellps=GRS80 ' +
      '+towgs84=23.772,17.49,17.859,-0.3132,-1.85274,1.67299,-5.4262 +units=m +no_defs'
    );
  });

  describe('round trip (ITM -> WGS84 -> ITM)', () => {
    it('the EPSG:2039 projection origin round-trips to well under 1m', () => {
      const ctx = load();
      // Documented EPSG:2039 false easting/northing (= the registered
      // x_0/y_0 params, independently confirmed against the EPSG registry
      // for EPSG:2039 / EPSG:9676 "Israel 1993 to WGS 84 (2)").
      const itmIn = [219529.584, 626907.39];
      const [lng, lat] = ctx.CRSUtils.itmToWgs84(itmIn[0], itmIn[1]);
      const [x2, y2] = ctx.CRSUtils.wgs84ToItm(lng, lat);

      const dx = x2 - itmIn[0], dy = y2 - itmIn[1];
      const errM = Math.sqrt(dx * dx + dy * dy);
      expect(errM).toBeLessThan(1);
    });

    it('round-trips a real village-area point (Sakhnin) to well under 1m', () => {
      const ctx = load();
      const itmIn = [228194.3718743689, 752247.1110639628]; // from test/fixtures/import/itm-points.geojson
      const [lng, lat] = ctx.CRSUtils.itmToWgs84(itmIn[0], itmIn[1]);
      const [x2, y2] = ctx.CRSUtils.wgs84ToItm(lng, lat);
      const errM = Math.sqrt((x2 - itmIn[0]) ** 2 + (y2 - itmIn[1]) ** 2);
      expect(errM).toBeLessThan(1);
    });
  });

  describe('known-point conversion (golden value)', () => {
    // Golden expected value computed once via `proj4` directly against the
    // exact EPSG:9676-registered parameters embedded in CRSUtils (see the
    // "registers EPSG:2039" test above) for the projection's documented
    // false easting/northing origin. This guards against regressions in the
    // itmToWgs84() wrapper itself (wrong axis order, sign flip, wrong CRS
    // swapped in, etc.) — not an independent third-party ground-truth check,
    // which proved unreliable to source at meter precision (see PR notes).
    it('ITM control point (219529.584, 626907.39) converts within ~2m of the documented value', () => {
      const ctx = load();
      const [lng, lat] = ctx.CRSUtils.itmToWgs84(219529.584, 626907.39);
      const expected = { lng: 35.20521378192299, lat: 31.7347630365087 };
      const errM = haversineMeters(lng, lat, expected.lng, expected.lat);
      expect(errM).toBeLessThan(2);
    });
  });

  describe('looksLikeITM', () => {
    it('is true for coordinates within the ITM easting/northing range', () => {
      const ctx = load();
      expect(ctx.CRSUtils.looksLikeITM([219529.584, 626907.39])).toBe(true);
      expect(ctx.CRSUtils.looksLikeITM([228194.37, 752247.11])).toBe(true); // Sakhnin-area ITM
      expect(ctx.CRSUtils.looksLikeITM([120000, 380000])).toBe(true);  // lower bound
      expect(ctx.CRSUtils.looksLikeITM([300000, 800000])).toBe(true);  // upper bound
    });

    it('is false for WGS84-range lon/lat pairs', () => {
      const ctx = load();
      expect(ctx.CRSUtils.looksLikeITM([35.2978, 32.8650])).toBe(false); // Sakhnin WGS84
      expect(ctx.CRSUtils.looksLikeITM([0, 0])).toBe(false);
      expect(ctx.CRSUtils.looksLikeITM([-73.98, 40.75])).toBe(false); // NYC-ish
    });

    it('is false for out-of-range or malformed input', () => {
      const ctx = load();
      expect(ctx.CRSUtils.looksLikeITM([119999, 500000])).toBe(false); // just under X min
      expect(ctx.CRSUtils.looksLikeITM([300001, 500000])).toBe(false); // just over X max
      expect(ctx.CRSUtils.looksLikeITM([200000, 379999])).toBe(false); // just under Y min
      expect(ctx.CRSUtils.looksLikeITM([200000, 800001])).toBe(false); // just over Y max
      expect(ctx.CRSUtils.looksLikeITM(null)).toBe(false);
      expect(ctx.CRSUtils.looksLikeITM([200000])).toBe(false);
      expect(ctx.CRSUtils.looksLikeITM(['200000', '600000'])).toBe(false);
      expect(ctx.CRSUtils.looksLikeITM([NaN, 600000])).toBe(false);
    });
  });

  describe('reprojectFeatureCollection', () => {
    it('reprojects every feature ITM -> WGS84 into the Israel bbox and preserves properties', () => {
      const ctx = load();
      const fc = {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { name: 'a' }, geometry: { type: 'Point', coordinates: [228194.3718743689, 752247.1110639628] } },
          { type: 'Feature', properties: { name: 'b' }, geometry: { type: 'LineString', coordinates: [[228194, 752247], [231575, 750742]] } },
        ],
      };
      const out = ctx.CRSUtils.reprojectFeatureCollection(fc, true);
      expect(out.type).toBe('FeatureCollection');
      expect(out.features).toHaveLength(2);
      expect(out.features[0].properties).toEqual({ name: 'a' });

      const [lng, lat] = out.features[0].geometry.coordinates;
      expect(lng).toBeGreaterThan(34);
      expect(lng).toBeLessThan(37);
      expect(lat).toBeGreaterThan(29);
      expect(lat).toBeLessThan(34);

      const line = out.features[1].geometry.coordinates;
      expect(line).toHaveLength(2);
      line.forEach(([plng, plat]) => {
        expect(plng).toBeGreaterThan(34);
        expect(plng).toBeLessThan(37);
        expect(plat).toBeGreaterThan(29);
        expect(plat).toBeLessThan(34);
      });

      // does not mutate the input
      expect(fc.features[0].geometry.coordinates).toEqual([228194.3718743689, 752247.1110639628]);
    });

    it('features without geometry pass through unchanged', () => {
      const ctx = load();
      const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { x: 1 }, geometry: null }] };
      const out = ctx.CRSUtils.reprojectFeatureCollection(fc, true);
      expect(out.features[0].geometry).toBeNull();
      expect(out.features[0].properties).toEqual({ x: 1 });
    });
  });
});
