// Unit tests for the KML/KMZ importer (js/importers/kml.js). Uses
// @xmldom/xmldom's DOMParser as the browser-global DOMParser stand-in (Node
// has no built-in DOMParser) and the real vendored js/vendor/togeojson.js —
// the SAME file the browser loads — so these tests exercise the exact
// production KML→GeoJSON conversion, not a mock of it.
import { describe, it, expect, vi } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const KML_FIXTURE = readFileSync(resolve(REPO_ROOT, 'test/fixtures/import/sample.kml'), 'utf8');

// shapefile.js is loaded alongside kml.js so Importers._checkZipBomb (the
// shared zip-bomb guard KMZ reuses) is present on the shared window.Importers.
function load(extra) {
  return loadBrowserGlobals(
    ['js/vendor/togeojson.js', 'js/importers/shapefile.js', 'js/importers/kml.js'],
    { DOMParser, ...extra }
  );
}

function fakeFile(text) {
  return { text: () => Promise.resolve(text) };
}

// Minimal JSZip-shaped stub — same pattern as test/importers/shapefile.test.js's
// fakeZip(), extended with a real .async('string') resolving to KML text for
// the one entry whose path matches.
function fakeZip(entries) {
  return {
    forEach(cb) { entries.forEach((e) => cb(e.path, e)); },
    file(path) {
      const e = entries.find((x) => x.path === path);
      return e ? { async: e.async || (() => Promise.reject(new Error('not stubbed'))) } : null;
    },
  };
}

describe('Importers.kml (js/importers/kml.js)', () => {
  it('parses the sample.kml fixture: 3 placemarks (incl. a LineString), folder names preserved', async () => {
    const ctx = load();
    const result = await ctx.Importers.kml.parse(fakeFile(KML_FIXTURE));

    expect(result.detectedCRS).toBe('wgs84');
    expect(result.warnings).toEqual([]);
    expect(result.features).toHaveLength(3);
    expect(result.sourceLayers.sort()).toEqual(['מגופים', 'קווי מים'].sort());

    const byName = Object.fromEntries(result.features.map((f) => [f.properties.name, f]));
    expect(byName['מד מים 1'].properties._original_layer).toBe('קווי מים');
    expect(byName['קו הזנה 1'].properties._original_layer).toBe('קווי מים');
    expect(byName['מגוף 1'].properties._original_layer).toBe('מגופים');

    const line = byName['קו הזנה 1'];
    expect(line.geometry.type).toBe('LineString');
    expect(line.geometry.coordinates.length).toBe(3);

    const point = byName['מד מים 1'];
    expect(point.geometry.type).toBe('Point');
    expect(point.geometry.coordinates[0]).toBeCloseTo(35.2978, 4);
    expect(point.geometry.coordinates[1]).toBeCloseTo(32.8650, 4);
  });

  it('rejects malformed XML with a Hebrew error', async () => {
    const ctx = load();
    await expect(ctx.Importers.kml.parse(fakeFile('<kml><Document><Placemark>')))
      .rejects.toThrow(/KML/);
  });

  it('rejects a KML with no placemarks with a Hebrew error', async () => {
    const ctx = load();
    const empty = '<?xml version="1.0"?><kml><Document><name>Empty</name></Document></kml>';
    await expect(ctx.Importers.kml.parse(fakeFile(empty))).rejects.toThrow(/לא נמצאו אובייקטים/);
  });

  it('a top-level placemark with no folder falls back to the "KML" layer name', async () => {
    const ctx = load();
    const kml = '<?xml version="1.0"?><kml><Document>' +
      '<Placemark><name>root pt</name><Point><coordinates>35.3,32.9,0</coordinates></Point></Placemark>' +
      '</Document></kml>';
    const result = await ctx.Importers.kml.parse(fakeFile(kml));
    expect(result.features).toHaveLength(1);
    expect(result.features[0].properties._original_layer).toBe('KML');
    expect(result.sourceLayers).toEqual(['KML']);
  });
});

describe('Importers.kmz (js/importers/kml.js)', () => {
  it('parses a zipped KML (KMZ): finds the first .kml entry and parses it identically to plain KML', async () => {
    const asyncSpy = vi.fn((type) => Promise.resolve(KML_FIXTURE));
    const JSZipStub = {
      loadAsync: () => Promise.resolve(fakeZip([
        { path: 'doc.kml', dir: false, _data: { uncompressedSize: KML_FIXTURE.length }, async: asyncSpy },
      ])),
    };
    const ctx = load({ JSZip: JSZipStub });
    const result = await ctx.Importers.kmz.parse({ name: 'sample.kmz' });

    expect(asyncSpy).toHaveBeenCalledWith('string');
    expect(result.detectedCRS).toBe('wgs84');
    expect(result.features).toHaveLength(3);
    expect(result.sourceLayers.sort()).toEqual(['מגופים', 'קווי מים'].sort());
  });

  it('rejects a KMZ with no .kml entry inside with a Hebrew error', async () => {
    const JSZipStub = {
      loadAsync: () => Promise.resolve(fakeZip([
        { path: 'readme.txt', dir: false, _data: { uncompressedSize: 10 }, async: () => Promise.resolve('hi') },
      ])),
    };
    const ctx = load({ JSZip: JSZipStub });
    await expect(ctx.Importers.kmz.parse({ name: 'nokml.kmz' })).rejects.toThrow(/לא נמצא קובץ KML/);
  });

  it('rejects a zip-bomb KMZ BEFORE extracting any entry (reuses shapefile.js\'s _checkZipBomb)', async () => {
    const asyncSpy = vi.fn(() => Promise.resolve(''));
    const JSZipStub = {
      loadAsync: () => Promise.resolve(fakeZip([
        { path: 'huge.kml', dir: false, _data: { uncompressedSize: 200 * 1024 * 1024 }, async: asyncSpy },
      ])),
    };
    const ctx = load({ JSZip: JSZipStub });
    await expect(ctx.Importers.kmz.parse({ name: 'bomb.kmz' })).rejects.toThrow(/150MB|300MB|פצצת ZIP/);
    expect(asyncSpy).not.toHaveBeenCalled(); // guard ran before any decompression
  });
});
