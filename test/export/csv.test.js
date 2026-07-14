import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
import { makeFeatures, makeFeature } from '../fixtures/export/generate-features.mjs';
import { parseCSV } from '../fixtures/export/csv-parser.mjs';

describe('buildCSV', () => {
  const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4 });

  it('emits a header row and one row per feature', async () => {
    const csv = await ctx.buildCSV(makeFeatures(5), null);
    const rows = parseCSV(csv);
    expect(rows[0]).toEqual(['village', 'category', 'lon', 'lat', 'geometry_type', 'text', 'layer', 'properties_json']);
    expect(rows.length).toBe(6); // header + 5
  });

  it('writes the first coordinate + properties_json for each geometry type', async () => {
    const f = makeFeature(0, { category: 'water_pipes', geometryType: 'LineString' });
    const rows = parseCSV(await ctx.buildCSV([f], null));
    const [, category, lon, lat, geomType, , , propsJson] = rows[1];
    expect(category).toBe('water_pipes');
    expect(Number(lon)).toBeCloseTo(f.geometry.coordinates[0][0], 6);
    expect(Number(lat)).toBeCloseTo(f.geometry.coordinates[0][1], 6);
    expect(geomType).toBe('LineString');
    expect(JSON.parse(propsJson)._category).toBe('water_pipes');
  });

  it('formula-injection regression: cells starting with = + - @ TAB CR get a plain-text prefix (CWE-1236)', async () => {
    for (const bad of ['=cmd()', '+1+1', '-1+1', '@SUM(1)', '\t=1', '\r=1']) {
      const f = makeFeature(0, { properties: { Text: bad } });
      const rows = parseCSV(await ctx.buildCSV([f], null));
      const textCell = rows[1][5]; // 'text' column
      expect(textCell.charAt(0)).toBe("'");
      expect(textCell.slice(1)).toBe(bad);
    }
  });

  it('does not add a geometry_wkt column by default (WKT option defaults OFF)', async () => {
    const rows = parseCSV(await ctx.buildCSV(makeFeatures(2), null));
    expect(rows[0]).not.toContain('geometry_wkt');
  });

  it('adds a geometry_wkt column when opts.wkt is true, and it parses back for every geometry type', async () => {
    const pt = makeFeature(0, { category: 'water_meters', geometryType: 'Point' });
    const line = makeFeature(1, { category: 'water_pipes', geometryType: 'LineString' });
    const poly = makeFeature(2, { category: 'parcels', geometryType: 'Polygon' });
    const rows = parseCSV(await ctx.buildCSV([pt, line, poly], null, { wkt: true }));
    const wktCol = rows[0].indexOf('geometry_wkt');
    expect(wktCol).toBe(rows[0].length - 1);
    expect(rows[1][wktCol]).toBe('POINT (' + pt.geometry.coordinates[0] + ' ' + pt.geometry.coordinates[1] + ')');
    expect(rows[2][wktCol]).toMatch(/^LINESTRING \(/);
    expect(rows[3][wktCol]).toMatch(/^POLYGON \(/);
    // the formula guard never fires on WKT — every WKT string starts with a letter
    expect(rows[1][wktCol].charAt(0)).not.toBe("'");
  });
});
