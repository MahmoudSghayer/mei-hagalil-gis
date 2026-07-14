import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
import { makeFeatures, makeFeature } from '../fixtures/export/generate-features.mjs';

function countTag(xml, tag) {
  const open = (xml.match(new RegExp('<' + tag + '(?:\\s|>)', 'g')) || []).length;
  const close = (xml.match(new RegExp('</' + tag + '>', 'g')) || []).length;
  return { open, close };
}

describe('buildKML', () => {
  const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4 });

  it('produces a well-formed document with balanced Folder/Placemark tags', async () => {
    const kml = await ctx.buildKML(makeFeatures(10), null);
    expect(kml.startsWith('<?xml')).toBe(true);
    const folder = countTag(kml, 'Folder');
    const placemark = countTag(kml, 'Placemark');
    expect(folder.open).toBe(folder.close);
    expect(folder.open).toBeGreaterThan(0);
    expect(placemark.open).toBe(placemark.close);
    expect(placemark.open).toBe(10);
    expect(kml.trim().endsWith('</Document></kml>')).toBe(true);
  });

  it('writes one Folder per category, named from LABELS', async () => {
    const kml = await ctx.buildKML(makeFeatures(8), null); // cycles all 4 fixture categories
    const names = [...kml.matchAll(/<Folder><name>([^<]+)<\/name>/g)].map((m) => m[1]);
    expect(names.length).toBe(4);
    expect(names).toContain('מדי מים');    // LABELS.water_meters
    expect(names).toContain('שוחות ביוב'); // LABELS.sewage_manholes
  });

  it('carries feature attributes in ExtendedData and skips internal _-prefixed keys', async () => {
    const f = makeFeature(0, { category: 'water_meters', properties: { Diameter: '150' } });
    const kml = await ctx.buildKML([f], null);
    expect(kml).toContain('<ExtendedData>');
    expect(kml).toContain('<Data name="Diameter"><value>150</value></Data>');
    expect(kml).not.toContain('name="_category"');
    expect(kml).not.toContain('name="_village"');
  });

  it('escapes XML-special characters in placemark names and data values', async () => {
    const f = makeFeature(0, { properties: { Text: 'A & B <C>', Note: '"quoted"' } });
    const kml = await ctx.buildKML([f], null);
    expect(kml).toContain('<name>A &amp; B &lt;C&gt;</name>');
    expect(kml).toContain('&quot;quoted&quot;');
  });
});
