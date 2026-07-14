import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
import { makeFeatures, makeFeature } from '../fixtures/export/generate-features.mjs';

// DXF group codes: buildDXF() joins the flat [code, value, code, value, ...]
// array with \r\n, so every even index is a group code and every odd index
// is its value.
function parseDXFRecords(text) {
  var toks = text.split('\r\n');
  var recs = [];
  for (var i = 0; i + 1 < toks.length; i += 2) recs.push([toks[i], toks[i + 1]]);
  return recs;
}

describe('buildDXF', () => {
  const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4 });

  it('emits HEADER/TABLES/ENTITIES sections and a valid EOF', async () => {
    const out = await ctx.buildDXF(makeFeatures(6), null);
    expect(out).toContain('$ACADVER');
    expect(out).toContain('SECTION\r\n2\r\nHEADER');
    expect(out).toContain('SECTION\r\n2\r\nTABLES');
    expect(out).toContain('SECTION\r\n2\r\nENTITIES');
    expect(out.trim().endsWith('0\r\nENDSEC\r\n0\r\nEOF')).toBe(true);
  });

  it('writes one LAYER per category present in the input, plus mandatory 0 and ATTR layers', async () => {
    const out = await ctx.buildDXF(makeFeatures(8), null); // cycles all 4 fixture categories
    const recs = parseDXFRecords(out);
    const layers = new Set();
    for (let i = 0; i < recs.length; i++) {
      if (recs[i][0] === '0' && recs[i][1] === 'LAYER') layers.add(recs[i + 1][1]);
    }
    expect(layers.has('0')).toBe(true);
    expect(layers.has('ATTR')).toBe(true);
    expect(layers.has('water_meters')).toBe(true);
    expect(layers.has('sewage_manholes')).toBe(true);
    expect(layers.has('water_pipes')).toBe(true);
    expect(layers.has('parcels')).toBe(true);
  });

  it('attaches feature attributes as MGIS XDATA on point entities', async () => {
    const out = await ctx.buildDXF(makeFeatures(2, { category: 'water_meters', geometryType: 'Point' }), null);
    expect(out).toContain('1001\r\nMGIS');
    expect(out).toContain('1000\r\nOBJECTID=0');
    expect(out).toContain('1000\r\nOBJECTID=1');
  });

  it('reprojects WGS84 coordinates into the ITM (EPSG:2039) numeric range', async () => {
    const out = await ctx.buildDXF(makeFeatures(5, { category: 'water_meters', geometryType: 'Point' }), null);
    const pts = [...out.matchAll(/0\r\nPOINT\r\n8\r\n[^\r\n]+\r\n10\r\n([^\r\n]+)\r\n20\r\n([^\r\n]+)\r\n30\r\n0/g)];
    expect(pts.length).toBe(5);
    for (const [, x, y] of pts) {
      expect(Number(x)).toBeGreaterThan(100000);
      expect(Number(x)).toBeLessThan(400000);
      expect(Number(y)).toBeGreaterThan(400000);
      expect(Number(y)).toBeLessThan(900000);
    }
  });

  it('writes MH/TL/Depth attribute labels for manholes but not for unrelated categories', async () => {
    const mh = makeFeature(0, { category: 'sewage_manholes' });
    const wm = makeFeature(1, { category: 'water_meters' }); // no label expected for this category
    const out = await ctx.buildDXF([mh, wm], null);
    expect((out.match(/MH: MH-0/g) || []).length).toBe(1);
    expect(out).toContain('TL: 123.45');
    expect(out).toContain('D: 2.10m');
  });

  it('deduplicates features sharing the same category + GlobalID', async () => {
    const f1 = makeFeature(0, { category: 'water_meters' });
    const f2 = { type: 'Feature', properties: Object.assign({}, f1.properties), geometry: { type: 'Point', coordinates: f1.geometry.coordinates.slice() } };
    const out = await ctx.buildDXF([f1, f2], null);
    const pointCount = (out.match(/0\r\nPOINT\r\n/g) || []).length;
    expect(pointCount).toBe(1);
  });
});
