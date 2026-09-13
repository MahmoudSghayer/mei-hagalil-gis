// Unit tests for the "✏️ ערוך גאומטריה" footer button js/gis-attribute-panel.js
// added for Edit Mode (js/gis-edit.js) — GISEdit.beginEditFeature(feature,
// layerId), gated the same way as the rest of the panel's edit affordances
// (GIS.permissions.canEditGis(role)).
//
// gis-attribute-panel.js is a plain browser-global IIFE that runs a fair
// amount of code at load time (style injection, building its own panel DOM,
// and — critically — `document.getElementById('gp-x').onclick = close`
// synchronously), so it needs the same "lenient auto-vivifying document"
// stub precedent as test/gis/gis-feature-table.test.js (a strict stub
// returning null for an unqueried id would throw at load time).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function stubElement(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], childNodes: [], style: {}, dataset: {}, attributes: {},
    className: '', id: '', innerHTML: '', textContent: '', value: '', disabled: false,
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getElementsByTagName() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    click() { if (this.onclick) this.onclick({ target: this }); },
    focus() {}, blur() {}, remove() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
}
function makeLenientDocument() {
  const registry = new Map();
  return {
    createElement: (t) => stubElement(t),
    createTextNode: (t) => ({ textContent: String(t) }),
    createDocumentFragment: () => stubElement('fragment'),
    getElementById: (id) => {
      if (!registry.has(id)) registry.set(id, stubElement('div'));
      return registry.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    body: stubElement('body'),
    head: stubElement('head'),
    documentElement: stubElement('html'),
  };
}

function makeGIS(role) {
  return {
    currentRole: vi.fn(async () => role),
    permissions: { canEditGis: (r) => r === 'admin' || r === 'engineer' },
    fields: { getFields: vi.fn(async () => []) },
    meters: {
      getForPipe: vi.fn(async () => []),
      getForAsset: vi.fn(async () => []),
      getAnomalies: vi.fn(async () => []),
    },
    spatial: { geometryLength: vi.fn(() => 0) },
  };
}

function load(role) {
  const document = makeLenientDocument();
  const GIS = makeGIS(role);
  const GISEdit = { beginEditFeature: vi.fn() };
  const esc = (v) => String(v == null ? '' : v);
  const ctx = loadBrowserGlobals(['js/gis-attribute-panel.js'], { document, GIS, GISEdit, esc });
  return { ctx, document, GIS, GISEdit, GISPanel: ctx.GISPanel };
}

const POINT_FEATURE = {
  id: 'f1',
  properties: { __id: 'f1', __layer_id: 'L9', asset_code: 'PIPE-1' },
  geometry: { type: 'Point', coordinates: [35, 32] },
};

describe('gis-attribute-panel.js — "ערוך גאומטריה" footer button', () => {
  it('loads cleanly and exposes window.GISPanel (module does not early-return when GIS is present)', () => {
    const { GISPanel } = load('engineer');
    expect(GISPanel).toBeTruthy();
    expect(typeof GISPanel.open).toBe('function');
  });

  it('engineer: the footer renders #gp-editgeom, and clicking it calls GISEdit.beginEditFeature(feature, layerId) then closes the panel', async () => {
    const { GISPanel, document, GISEdit } = load('engineer');
    await GISPanel.open(POINT_FEATURE, { layerId: 'L9' });
    const btn = document.getElementById('gp-editgeom');
    expect(btn.onclick).toBeTruthy();
    btn.click();
    expect(GISEdit.beginEditFeature).toHaveBeenCalledTimes(1);
    expect(GISEdit.beginEditFeature.mock.calls[0][0]).toBe(POINT_FEATURE);
    expect(GISEdit.beginEditFeature.mock.calls[0][1]).toBe('L9');
    // close() clears the 'open' class — verified indirectly: it must not throw
    // and GISIdentify.clear() (optional) must not be required to exist.
  });

  it('engineer: falls back to properties.__layer_id when no tableCtx.layerId is given', async () => {
    const { GISPanel, document, GISEdit } = load('engineer');
    await GISPanel.open(POINT_FEATURE); // no opts at all
    document.getElementById('gp-editgeom').click();
    expect(GISEdit.beginEditFeature.mock.calls[0][1]).toBe('L9'); // from properties.__layer_id
  });

  it('admin also gets the button (not engineer-only)', async () => {
    const { GISPanel, document } = load('admin');
    await GISPanel.open(POINT_FEATURE, { layerId: 'L9' });
    // The lenient document stub auto-vivifies ANY id on first getElementById
    // lookup, so a truthy element there proves nothing — the real signal of
    // whether renderFooter() actually emitted the button is the HTML STRING
    // it wrote into #gp-foot.
    expect(document.getElementById('gp-foot').innerHTML).toContain('gp-editgeom');
  });

  it('viewer: the footer does NOT render #gp-editgeom at all (no edit affordance in the emitted HTML)', async () => {
    const { GISPanel, document } = load('viewer');
    await GISPanel.open(POINT_FEATURE, { layerId: 'L9' });
    expect(document.getElementById('gp-foot').innerHTML).not.toContain('gp-editgeom');
  });

  it('viewer: sees the read-only note instead of any edit affordance', async () => {
    const { GISPanel, document } = load('viewer');
    await GISPanel.open(POINT_FEATURE, { layerId: 'L9' });
    const foot = document.getElementById('gp-foot');
    expect(foot.innerHTML).toMatch(/תצוגה בלבד/);
  });

  it('GISEdit not loaded at all: the button is not rendered even for an engineer (canEditGeom guards on GISEdit.beginEditFeature existing)', async () => {
    const document = makeLenientDocument();
    const GIS = makeGIS('engineer');
    const esc = (v) => String(v == null ? '' : v);
    // no GISEdit global at all this time
    const ctx = loadBrowserGlobals(['js/gis-attribute-panel.js'], { document, GIS, esc });
    await ctx.GISPanel.open(POINT_FEATURE, { layerId: 'L9' });
    expect(document.getElementById('gp-foot').innerHTML).not.toContain('gp-editgeom');
  });
});
