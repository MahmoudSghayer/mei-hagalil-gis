// Unit tests for the pure magic-byte sniff helpers in js/pages/upload.js
// (looksLikeXmlText / looksLikeDxfText), added for the KML and DXF upload
// paths. upload.js is a flat (non-IIFE) page script whose top-level
// var/function declarations become properties of the vm context object (see
// test/helpers/load-browser-global.mjs) — the ONLY thing that would otherwise
// break loading it standalone is the top-level `window.addEventListener('load',
// ...)` call, which we no-op via the `addEventListener` extra below (this file
// never triggers that 'load' callback, so gSb/GIS/etc. are never touched).
import { describe, it, expect } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function load() {
  return loadBrowserGlobals(['js/pages/upload.js'], { addEventListener: () => {} });
}

function hexOf(str) {
  return Buffer.from(str, 'utf8').toString('hex');
}

describe('looksLikeXmlText (js/pages/upload.js) — KML magic sniff', () => {
  it('accepts plain XML starting with "<"', () => {
    const ctx = load();
    expect(ctx.looksLikeXmlText(hexOf('<?xml version="1.0"?><kml>'))).toBe(true);
  });

  it('accepts XML after a UTF-8 BOM', () => {
    const ctx = load();
    const hex = 'efbbbf' + hexOf('<?xml version="1.0"?>');
    expect(ctx.looksLikeXmlText(hex)).toBe(true);
  });

  it('accepts XML after leading whitespace', () => {
    const ctx = load();
    expect(ctx.looksLikeXmlText(hexOf('\n\n  <kml>'))).toBe(true);
  });

  it('rejects JSON text (starts with "{")', () => {
    const ctx = load();
    expect(ctx.looksLikeXmlText(hexOf('{"type":"FeatureCollection"}'))).toBe(false);
  });

  it('rejects binary PNG bytes', () => {
    const ctx = load();
    expect(ctx.looksLikeXmlText('89504e470d0a1a0a')).toBe(false);
  });

  it('rejects an all-whitespace prefix with nothing after it', () => {
    const ctx = load();
    expect(ctx.looksLikeXmlText(hexOf('   '))).toBe(false);
  });
});

describe('looksLikeDxfText (js/pages/upload.js) — DXF magic sniff', () => {
  it('accepts the classic DXF "0\\r\\nSECTION" group-code header', () => {
    const ctx = load();
    expect(ctx.looksLikeDxfText(hexOf('0\r\nSECTION\r\n2\r\nHEADER\r\n'))).toBe(true);
  });

  it('accepts a DXF header padded with leading spaces (some CAD exporters do this)', () => {
    const ctx = load();
    expect(ctx.looksLikeDxfText(hexOf('  0\r\nSECTION\r\n'))).toBe(true);
  });

  it('permissively accepts text starting with a digit even without SECTION nearby', () => {
    const ctx = load();
    expect(ctx.looksLikeDxfText(hexOf('999\r\nsome comment\r\n0\r\nEOF\r\n'))).toBe(true);
  });

  it('rejects binary PNG bytes', () => {
    const ctx = load();
    expect(ctx.looksLikeDxfText('89504e470d0a1a0a')).toBe(false);
  });

  it('rejects a ZIP signature (e.g. a .zip mislabeled as .dxf)', () => {
    const ctx = load();
    expect(ctx.looksLikeDxfText('504b0304' + hexOf('....'))).toBe(false);
  });

  it('rejects a DWG binary signature ("AC10..." — a real DWG mislabeled as .dxf)', () => {
    const ctx = load();
    expect(ctx.looksLikeDxfText(hexOf('AC1027') + '000000')).toBe(false);
  });

  it('rejects arbitrary binary garbage not starting with whitespace/digit', () => {
    const ctx = load();
    expect(ctx.looksLikeDxfText('ff00ff00ff00ff00')).toBe(false);
  });
});

describe('DXF format registration (js/pages/upload.js) — reuses Importers.dwg.parse verbatim', () => {
  it('registers window.Importers.dxf as the SAME function reference as Importers.dwg.parse, without touching js/importers/dwg.js', () => {
    const dwgParse = () => Promise.resolve({ features: [] });
    const ctx = loadBrowserGlobals(['js/pages/upload.js'], {
      addEventListener: () => {},
      Importers: { dwg: { parse: dwgParse } },
    });
    expect(ctx.Importers.dxf).toBeDefined();
    expect(ctx.Importers.dxf.parse).toBe(dwgParse);
  });

  it('does not throw / does not register anything when Importers.dwg is absent (defensive no-op)', () => {
    const ctx = loadBrowserGlobals(['js/pages/upload.js'], { addEventListener: () => {} });
    expect(ctx.Importers).toBeUndefined();
  });
});
