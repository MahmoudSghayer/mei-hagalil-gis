import { describe, it, expect, vi } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
import { makeAppDocument } from '../fixtures/export/stub-dom.mjs';
import { makeFeatures } from '../fixtures/export/generate-features.mjs';

// _exportDXF (js/export-feature.js) wires window.exportDXFSmart
// (js/backend-client.js) into the wizard's DXF branch. Contract under test:
//   • resolves Blob → download the server blob, buildDXF NOT called
//   • resolves null → buildDXF fallback + one-time Hebrew notice toast
//   • rejects       → rejection propagates (wizard error path), NO fallback
//   • global absent → buildDXF fallback (backend-client.js is lazy-loaded)
//
// backend-client.js itself is NOT loaded — exportDXFSmart is stubbed per test,
// exactly at the feature-detected seam _exportDXF uses.
function makeCtx(extra = {}) {
  const created = [];   // blobs handed to URL.createObjectURL by triggerDownload
  const anchors = [];   // <a> elements created for downloads (to read .download)
  const doc = makeAppDocument();
  const origCreate = doc.createElement;
  doc.createElement = (tag) => {
    const el = origCreate(tag);
    if (String(tag).toLowerCase() === 'a') anchors.push(el);
    return el;
  };
  const ctx = loadBrowserGlobals(['js/export-formats.js', 'js/export-feature.js'], {
    proj4,
    document: doc,
    URL: { createObjectURL: (b) => { created.push(b); return 'blob:fake'; }, revokeObjectURL: () => {} },
    ...extra,
  });
  return { ctx, created, anchors };
}

const NOTICE = 'נוצר DXF בסיסי (R12) — שירות ההמרה המתקדם אינו זמין כרגע';

describe('_exportDXF — server blob path (exportDXFSmart resolves a Blob)', () => {
  it('downloads the server blob as <filename>.dxf and never calls buildDXF', async () => {
    const { ctx, created, anchors } = makeCtx();
    const serverBlob = { __serverDXF: true };   // _exportDXF only truthiness-checks; identity is what matters
    const smart = vi.fn(async () => serverBlob);
    const clientBuild = vi.fn(async () => 'CLIENT_DXF');
    ctx.exportDXFSmart = smart;                 // ctx IS the vm window/global
    ctx.buildDXF = clientBuild;
    const toast = vi.fn();
    ctx.showToast = toast;

    await ctx.__exportTestHooks._exportDXF(makeFeatures(3), 'test-export', null);

    expect(smart).toHaveBeenCalledTimes(1);
    const [feats, fname, onProgress] = smart.mock.calls[0];
    expect(feats).toHaveLength(3);
    expect(fname).toBe('test-export');
    expect(typeof onProgress).toBe('function');
    expect(() => onProgress('process', 40, 'בונה DXF בשרת...')).not.toThrow(); // (stage,pct,msg) adapter

    expect(clientBuild).not.toHaveBeenCalled();
    expect(created).toEqual([serverBlob]);            // the SERVER blob, not a re-wrapped one
    expect(anchors[0].download).toBe('test-export.dxf');
    expect(toast).not.toHaveBeenCalled();             // no fallback notice on the happy path
  });
});

describe('_exportDXF — unavailable path (exportDXFSmart resolves null)', () => {
  it('falls back to the client buildDXF and shows the Hebrew notice toast', async () => {
    const { ctx, created, anchors } = makeCtx();
    ctx.exportDXFSmart = vi.fn(async () => null);
    const clientBuild = vi.fn(async () => 'CLIENT_DXF');
    ctx.buildDXF = clientBuild;
    const toast = vi.fn();
    ctx.showToast = toast;

    const onProg = vi.fn();
    await ctx.__exportTestHooks._exportDXF(makeFeatures(2), 'test-export', onProg);

    expect(clientBuild).toHaveBeenCalledTimes(1);
    expect(clientBuild.mock.calls[0][1]).toBe(onProg); // the wizard's (done,total) callback goes to the CLIENT builder
    expect(created).toHaveLength(1);
    expect(await created[0].text()).toBe('CLIENT_DXF'); // wrapped client output, not a server blob
    expect(anchors[0].download).toBe('test-export.dxf');
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(NOTICE);
  });

  it('shows the notice only ONCE per session across repeated fallback exports', async () => {
    const { ctx } = makeCtx();
    ctx.exportDXFSmart = vi.fn(async () => null);
    ctx.buildDXF = vi.fn(async () => 'CLIENT_DXF');
    const toast = vi.fn();
    ctx.showToast = toast;

    await ctx.__exportTestHooks._exportDXF(makeFeatures(1), 'a', null);
    await ctx.__exportTestHooks._exportDXF(makeFeatures(1), 'b', null);

    expect(ctx.buildDXF).toHaveBeenCalledTimes(2);    // fallback still runs every time
    expect(toast).toHaveBeenCalledTimes(1);           // notice does not
  });

  it('does not explode when showToast is absent (feature-detected)', async () => {
    const { ctx, created } = makeCtx();               // no showToast in this ctx
    ctx.exportDXFSmart = vi.fn(async () => null);
    ctx.buildDXF = vi.fn(async () => 'CLIENT_DXF');

    await ctx.__exportTestHooks._exportDXF(makeFeatures(1), 'test-export', null);
    expect(created).toHaveLength(1);
  });
});

describe('_exportDXF — real-error path (exportDXFSmart rejects)', () => {
  it('propagates the rejection (wizard error handling), no fallback, no download, no notice', async () => {
    const { ctx, created } = makeCtx();
    const err = new Error('שגיאת שרת ביצוא DXF (500): boom');
    ctx.exportDXFSmart = vi.fn(async () => { throw err; });
    const clientBuild = vi.fn(async () => 'CLIENT_DXF');
    ctx.buildDXF = clientBuild;
    const toast = vi.fn();
    ctx.showToast = toast;

    await expect(ctx.__exportTestHooks._exportDXF(makeFeatures(2), 'test-export', null))
      .rejects.toThrow('שגיאת שרת ביצוא DXF (500)');

    // generateAndDownload's existing try/catch turns this rejection into
    // finishGen(false, msg) — the same error surface every other format uses.
    expect(clientBuild).not.toHaveBeenCalled();       // NO silent fallback on a post-ping error
    expect(created).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('_exportDXF — feature detection (backend-client.js not loaded)', () => {
  it('goes straight to the client buildDXF when window.exportDXFSmart is absent (no toast — same as today)', async () => {
    const { ctx, created, anchors } = makeCtx();      // exportDXFSmart never defined
    expect(ctx.exportDXFSmart).toBeUndefined();
    const clientBuild = vi.fn(async () => 'CLIENT_DXF');
    ctx.buildDXF = clientBuild;
    const toast = vi.fn();
    ctx.showToast = toast;

    await ctx.__exportTestHooks._exportDXF(makeFeatures(2), 'test-export', null);

    expect(clientBuild).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(anchors[0].download).toBe('test-export.dxf');
    expect(toast).not.toHaveBeenCalled();             // notice is for "service unavailable", not "not loaded yet"
  });
});
