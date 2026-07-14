// Unit tests for the Shapefile (ZIP) importer (js/importers/shapefile.js):
// the ZIP-bomb decompressed-size guard, the hand-rolled DBF reader (handles
// type F/Float that the shapefile.js CDN lib ignores), and .prj CRS sniffing.
import { describe, it, expect, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function load(extra) {
  return loadBrowserGlobals(['js/importers/shapefile.js'], extra || {});
}

// ── DBF fixture builder ─────────────────────────────────────────────────────
// Minimal xBase (DBF) buffer: 32-byte header + one 32-byte field descriptor
// per field + 0x0D terminator + fixed-width records. Good enough to exercise
// readDbfRecords()'s C/F/L type handling without a real .dbf file on disk.
function buildDbfField(name, type, len) {
  const buf = new Uint8Array(32);
  for (let i = 0; i < Math.min(name.length, 10); i++) buf[i] = name.charCodeAt(i);
  buf[11] = type.charCodeAt(0);
  buf[16] = len;
  buf[17] = 0;
  return buf;
}

function buildDbfBuffer(fields, records) {
  const headerSize = 32 + fields.length * 32 + 1;
  const recSize = 1 + fields.reduce((s, f) => s + f.len, 0);
  const buf = new ArrayBuffer(headerSize + recSize * records.length);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  bytes[0] = 0x03; // dBase III
  bytes[1] = 24; bytes[2] = 1; bytes[3] = 1; // arbitrary last-update date
  view.setUint32(4, records.length, true);
  view.setUint16(8, headerSize, true);
  view.setUint16(10, recSize, true);

  let pos = 32;
  fields.forEach((f) => { bytes.set(buildDbfField(f.name, f.type, f.len), pos); pos += 32; });
  bytes[pos] = 0x0d; pos += 1; // header terminator

  records.forEach((rec) => {
    bytes[pos] = 0x20; pos += 1; // not-deleted flag
    fields.forEach((f) => {
      const raw = String(rec[f.name] == null ? '' : rec[f.name]);
      for (let i = 0; i < f.len; i++) bytes[pos + i] = i < raw.length ? raw.charCodeAt(i) : 0x20;
      pos += f.len;
    });
  });

  return buf;
}

describe('Importers.shapefile — DBF reader (js/importers/shapefile.js)', () => {
  it('reads C (char), F (float), N (numeric) and L (logical) fields correctly', () => {
    const ctx = load();
    const fields = [
      { name: 'NAME', type: 'C', len: 12 },
      { name: 'TL', type: 'F', len: 8 },
      { name: 'DIAM', type: 'N', len: 5 },
      { name: 'ACTIVE', type: 'L', len: 1 },
    ];
    const records = [
      { NAME: 'PIPE-A', TL: '123.45', DIAM: '110', ACTIVE: 'T' },
      { NAME: 'PIPE-B', TL: '-6.7', DIAM: '63', ACTIVE: 'F' },
    ];
    const buf = buildDbfBuffer(fields, records);
    const parsed = ctx.Importers._readDbfRecords(buf);

    expect(parsed).toEqual([
      { NAME: 'PIPE-A', TL: 123.45, DIAM: 110, ACTIVE: true },
      { NAME: 'PIPE-B', TL: -6.7, DIAM: 63, ACTIVE: false },
    ]);
  });

  it('handles zero records', () => {
    const ctx = load();
    const buf = buildDbfBuffer([{ name: 'NAME', type: 'C', len: 10 }], []);
    expect(ctx.Importers._readDbfRecords(buf)).toEqual([]);
  });
});

describe('Importers.shapefile — .prj CRS detection', () => {
  it('detects ITM from the Israel_TM_Grid name', () => {
    const ctx = load();
    expect(ctx.Importers._detectCRSFromPrj('PROJCS["Israel_TM_Grid",...]')).toBe('ITM');
  });

  it('detects ITM from the known false-easting/northing values when the name is absent', () => {
    const ctx = load();
    expect(ctx.Importers._detectCRSFromPrj('PROJCS["Custom",PARAMETER["false_easting",219529.584],PARAMETER["false_northing",626907.39]]')).toBe('ITM');
  });

  it('detects WGS84 geographic (no PROJCS wrapper)', () => {
    const ctx = load();
    expect(ctx.Importers._detectCRSFromPrj('GEOGCS["GCS_WGS_1984",...]')).toBe('WGS84');
  });

  it('returns unknown for an unrecognised or missing .prj', () => {
    const ctx = load();
    expect(ctx.Importers._detectCRSFromPrj('PROJCS["Some_Other_Grid",...]')).toBe('unknown');
    expect(ctx.Importers._detectCRSFromPrj(null)).toBe('unknown');
    expect(ctx.Importers._detectCRSFromPrj('')).toBe('unknown');
  });
});

// ── ZIP-bomb guard ───────────────────────────────────────────────────────────
// Builds a fake JSZip-shaped zip object exposing only what checkZipBomb()
// reads: forEach(relPath, entry) with entry.dir / entry._data.uncompressedSize
// — mirroring JSZip's real internal shape after loadAsync() parses the
// ZIP's local/central-directory headers (no decompression needed to know
// this — which is exactly why the guard can run before any .async() call).
function fakeZip(entries) {
  return {
    forEach(cb) { entries.forEach((e) => cb(e.path, e)); },
    file(path) {
      const e = entries.find((x) => x.path === path);
      return e ? { async: e.async || (() => Promise.reject(new Error('not stubbed'))) } : null;
    },
  };
}

describe('Importers.shapefile — ZIP-bomb guard', () => {
  it('_checkZipBomb rejects a single entry over the 150MB per-entry cap', () => {
    const ctx = load();
    const zip = fakeZip([
      { path: 'huge.shp', dir: false, _data: { uncompressedSize: 151 * 1024 * 1024 } },
    ]);
    expect(() => ctx.Importers._checkZipBomb(zip)).toThrow(/150MB/);
  });

  it('_checkZipBomb rejects when the combined total exceeds the 300MB cap even if no single entry does', () => {
    const ctx = load();
    const zip = fakeZip([
      { path: 'a.shp', dir: false, _data: { uncompressedSize: 120 * 1024 * 1024 } },
      { path: 'b.shp', dir: false, _data: { uncompressedSize: 120 * 1024 * 1024 } },
      { path: 'c.shp', dir: false, _data: { uncompressedSize: 120 * 1024 * 1024 } },
    ]);
    expect(() => ctx.Importers._checkZipBomb(zip)).toThrow(/300MB/);
  });

  it('_checkZipBomb ignores directory entries and passes for a normal small ZIP', () => {
    const ctx = load();
    const zip = fakeZip([
      { path: 'shapes/', dir: true, _data: { uncompressedSize: 999 * 1024 * 1024 } }, // dir entries have no real size
      { path: 'shapes/a.shp', dir: false, _data: { uncompressedSize: 1024 } },
      { path: 'shapes/a.dbf', dir: false, _data: { uncompressedSize: 512 } },
    ]);
    expect(() => ctx.Importers._checkZipBomb(zip)).not.toThrow();
  });

  it('Importers.shapefile.parse() rejects a zip-bomb file end-to-end BEFORE extracting any entry', async () => {
    const asyncSpy = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
    const bombEntries = [
      { path: 'huge.shp', dir: false, _data: { uncompressedSize: 200 * 1024 * 1024 }, async: asyncSpy },
      { path: 'huge.dbf', dir: false, _data: { uncompressedSize: 200 * 1024 * 1024 }, async: asyncSpy },
    ];
    const JSZipStub = { loadAsync: () => Promise.resolve(fakeZip(bombEntries)) };
    const ctx = load({ JSZip: JSZipStub });

    await expect(ctx.Importers.shapefile.parse({ name: 'bomb.zip' })).rejects.toThrow(/150MB|300MB|פצצת ZIP/);
    expect(asyncSpy).not.toHaveBeenCalled(); // guard ran before any decompression
  });
});
