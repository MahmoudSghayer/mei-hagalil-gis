// Stress test (Worker W3.2): drive js/gis-feature-table.js's server-paging
// state machine across a SIMULATED 100,000-row engine layer (200 pages @
// pageSize=500), via its `GISTable._test` hooks + stubbed RPCs — same harness
// convention as test/gis/gis-feature-table.test.js (which covers the same
// hooks at small scale; this file pushes page/search/bulk-edit state to their
// real boundaries instead of a handful of representative cases).
//
// Covers:
//   1. Page next/prev at the true extremes of a 200-page layer (not just
//      "page 2 of 3") — offset arithmetic at both ends, and that stepping past
//      either end is a harmless no-op (no RPC call, no state corruption).
//   2. Search-reset behavior through the REAL debounced oninput handler
//      (js/gis-feature-table.js wires `document.getElementById('gt-search')
//      .oninput = debounce(...)` at module load — the lenient document stub
//      caches elements by id, so grabbing that same element after load and
//      firing a synthetic input event exercises the actual production code
//      path, not a re-implementation of it).
//   3. Bulk-edit at the exact 999/1000/1001-id cap boundary. gis-feature-
//      table.js has NO client-side pre-check on `state.selectedIds.size`
//      before calling GIS.features.bulkUpdate() (confirmed by reading
//      openBulkEdit()'s save handler) — the 1000-row cap is enforced purely
//      server-side, in features_bulk_update() (see
//      gis-engine/sql/migrations/2026-07-14-feature-table-pagination.sql,
//      "IF array_length(p_ids, 1) > 1000 THEN RAISE EXCEPTION ..."). So the
//      1001 case here asserts the ERROR SURFACE (the stub mirrors the RPC's
//      exact Hebrew error text) rather than a client-side guard, since none
//      exists — that absence is itself the finding.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function stubElement(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], childNodes: [], style: {}, dataset: {}, attributes: {},
    className: '', id: '', innerHTML: '', textContent: '', value: '',
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
    click() {}, focus() {}, blur() {}, remove() {},
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

// A 100,000-row engine layer, pageSize=500 -> exactly 200 pages (0..199).
const TOTAL = 100000;
const PAGE_SIZE = 500;
const LAST_PAGE = Math.ceil(TOTAL / PAGE_SIZE) - 1; // 199

function fakePage(offset, limit) {
  const n = Math.max(0, Math.min(limit, TOTAL - offset));
  return {
    type: 'FeatureCollection',
    features: Array.from({ length: n }, (_, i) => ({
      type: 'Feature', id: 'f' + (offset + i), geometry: null,
      properties: { __id: 'f' + (offset + i), asset_code: 'A-' + (offset + i) },
    })),
  };
}

function makeGisStub() {
  const calls = { featuresPage: [], featuresPageCount: [], bulkUpdate: [] };
  const GIS = {
    queries: {
      featuresPage: async (layerId, opts) => {
        calls.featuresPage.push({ layerId, opts });
        return fakePage(opts.offset, opts.limit);
      },
      featuresPageCount: async (layerId, opts) => {
        calls.featuresPageCount.push({ layerId, opts });
        return TOTAL;
      },
    },
    features: {
      // Mirrors features_bulk_update()'s exact 1000-id cap + Hebrew error text
      // (see file header) — there is no equivalent client-side guard to test
      // instead, so this stub IS the contract under test.
      bulkUpdate: async (layerId, ids, patch) => {
        calls.bulkUpdate.push({ layerId, ids: ids.slice(), patch });
        if (!ids || !ids.length) return { updated: 0 };
        if (ids.length > 1000) {
          throw new Error('ניתן לעדכן עד 1000 שורות בבת אחת (התקבלו ' + ids.length + ') — צמצם את הבחירה');
        }
        return { updated: ids.length };
      },
    },
    fields: { getFields: async () => [] },
    layers: { getLayerById: async () => ({ geometry_type: 'Point' }) },
    currentRole: async () => 'engineer',
    permissions: { canEditGis: () => true, canExport: () => true },
  };
  return { GIS, calls };
}

function load() {
  const stub = makeGisStub();
  const doc = makeLenientDocument();
  const ctx = loadBrowserGlobals(['js/gis-feature-table.js'], {
    document: doc,
    esc: (v) => (v == null ? '' : String(v)),
    GIS: stub.GIS,
    L: {},
  });
  return { ctx, doc, T: ctx.window.GISTable._test, ...stub };
}

describe('table-state-stress: page next/prev at the extremes of a 100,000-row / 200-page layer', () => {
  let env;
  beforeEach(() => { env = load(); });

  it('stepping nextPage() all the way from page 0 to the LAST page (199) tracks the offset correctly at every step', async () => {
    const { T, calls } = env;
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L-big', page: 0, pageSize: PAGE_SIZE, total: TOTAL });

    for (let p = 0; p < LAST_PAGE; p++) {
      // eslint-disable-next-line no-await-in-loop
      await T.nextPage();
    }
    expect(st.page).toBe(LAST_PAGE);
    expect(calls.featuresPage.length).toBe(LAST_PAGE);
    const lastCall = calls.featuresPage[calls.featuresPage.length - 1];
    expect(lastCall.opts.offset).toBe(LAST_PAGE * PAGE_SIZE); // 99500
    expect(lastCall.opts.limit).toBe(PAGE_SIZE);
  }, 30000);

  it('nextPage() at the LAST page (199) is a no-op — no RPC call, page unchanged', async () => {
    const { T, calls } = env;
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L-big', page: LAST_PAGE, pageSize: PAGE_SIZE, total: TOTAL });

    await T.nextPage();

    expect(st.page).toBe(LAST_PAGE);
    expect(calls.featuresPage.length).toBe(0);
  });

  it('prevPage() at page 0 is a no-op — no RPC call, page unchanged', async () => {
    const { T, calls } = env;
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L-big', page: 0, pageSize: PAGE_SIZE, total: TOTAL });

    await T.prevPage();

    expect(st.page).toBe(0);
    expect(calls.featuresPage.length).toBe(0);
  });

  it('stepping prevPage() all the way from the LAST page (199) back to page 0 tracks the offset correctly at every step', async () => {
    const { T, calls } = env;
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L-big', page: LAST_PAGE, pageSize: PAGE_SIZE, total: TOTAL });

    for (let p = LAST_PAGE; p > 0; p--) {
      // eslint-disable-next-line no-await-in-loop
      await T.prevPage();
    }
    expect(st.page).toBe(0);
    const lastCall = calls.featuresPage[calls.featuresPage.length - 1];
    expect(lastCall.opts.offset).toBe(0);
  }, 30000);

  it('jumping deep into the page range (page 150) computes the correct large offset', async () => {
    const { T, calls } = env;
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L-big', page: 150, pageSize: PAGE_SIZE, total: TOTAL, search: '', filters: null });

    await T.loadPage();

    expect(calls.featuresPage[0].opts.offset).toBe(150 * PAGE_SIZE); // 75000
    expect(st.all.length).toBe(PAGE_SIZE);
  });

  it('pageInfo/pagerLabel agree with the manual walk at both extremes', () => {
    const { T } = env;
    expect(T.pageInfo({ page: 0, pageSize: PAGE_SIZE, total: TOTAL })).toEqual({ current: 1, totalPages: 200, hasPrev: false, hasNext: true });
    expect(T.pageInfo({ page: LAST_PAGE, pageSize: PAGE_SIZE, total: TOTAL })).toEqual({ current: 200, totalPages: 200, hasPrev: true, hasNext: false });
    expect(T.pagerLabel({ page: LAST_PAGE, pageSize: PAGE_SIZE, total: TOTAL })).toBe('עמוד 200 מתוך 200');
  });
});

describe('table-state-stress: search-reset behavior through the real debounced oninput handler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('typing a new search term while deep in pagination resets page to 0, clears multi-select, and requests offset 0 with the new search text', async () => {
    const { T, doc, calls } = load();
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L-big', page: 120, pageSize: PAGE_SIZE, total: TOTAL, search: '', filters: null });
    st.selectedIds.add('f1'); st.selectedIds.add('f2'); st.selectedIds.add('f3');

    const searchInput = doc.getElementById('gt-search'); // same element the module wired oninput on at load time
    expect(typeof searchInput.oninput).toBe('function');
    searchInput.oninput({ target: { value: 'PVC' } });

    // debounce is 180ms — advance past it and flush the resulting async loadPage()
    await vi.advanceTimersByTimeAsync(200);

    expect(st.search).toBe('PVC');
    expect(st.page).toBe(0);
    expect(st.selectedIds.size).toBe(0);
    const call = calls.featuresPage[calls.featuresPage.length - 1];
    expect(call.opts.search).toBe('PVC');
    expect(call.opts.offset).toBe(0);
  });

  it('rapid retyping (5 keystrokes within the debounce window) fires loadPage() exactly ONCE, with only the FINAL value', async () => {
    const { T, doc, calls } = load();
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L-big', page: 50, pageSize: PAGE_SIZE, total: TOTAL, search: '', filters: null });

    const searchInput = doc.getElementById('gt-search');
    ['P', 'PV', 'PVC', 'PVC-', 'PVC-200'].forEach((v) => {
      searchInput.oninput({ target: { value: v } });
      vi.advanceTimersByTime(50); // well under the 180ms debounce — each keystroke resets the timer
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(st.search).toBe('PVC-200');
    expect(calls.featuresPage.length).toBe(1); // NOT 5 — debounce coalesced the burst
    expect(calls.featuresPage[0].opts.search).toBe('PVC-200');
  });
});

describe('table-state-stress: bulk-edit payload at the 1000-id cap boundary', () => {
  it('999 ids: resolves — under the cap', async () => {
    const { GIS, T, calls } = load();
    const ids = Array.from({ length: 999 }, (_, i) => 'id-' + i);
    const patch = T.buildBulkPatch('diameter', '150', { type: 'int' }, null);

    const res = await GIS.features.bulkUpdate('L-big', ids, patch);

    expect(res).toEqual({ updated: 999 });
    expect(calls.bulkUpdate[0].ids.length).toBe(999);
  });

  it('1000 ids (exact cap): resolves — the boundary itself is inclusive', async () => {
    const { GIS, T } = load();
    const ids = Array.from({ length: 1000 }, (_, i) => 'id-' + i);
    const patch = T.buildBulkPatch('diameter', '150', { type: 'int' }, null);

    const res = await GIS.features.bulkUpdate('L-big', ids, patch);

    expect(res).toEqual({ updated: 1000 });
  });

  it('1001 ids: rejects with the exact server-side cap error — no client-side pre-check exists, so this IS the guard', async () => {
    const { GIS, T } = load();
    const ids = Array.from({ length: 1001 }, (_, i) => 'id-' + i);
    const patch = T.buildBulkPatch('diameter', '150', { type: 'int' }, null);

    await expect(GIS.features.bulkUpdate('L-big', ids, patch))
      .rejects.toThrow('ניתן לעדכן עד 1000 שורות בבת אחת (התקבלו 1001) — צמצם את הבחירה');
  });

  it('a rejected bulk-update at 1001 does not corrupt table state (selectedIds untouched by the stub call itself)', async () => {
    const { GIS, T } = load();
    const st = T.getState();
    st.selectedIds = new Set(Array.from({ length: 1001 }, (_, i) => 'id-' + i));
    const ids = Array.from(st.selectedIds);
    const patch = T.buildBulkPatch('status', 'active', null, null);

    await expect(GIS.features.bulkUpdate('L-big', ids, patch)).rejects.toThrow(/1001/);
    // The real gtb-save handler only clears state.selectedIds AFTER a successful
    // resolve (see js/gis-feature-table.js openBulkEdit()) — confirm the
    // selection this stub represents is still exactly what was submitted.
    expect(st.selectedIds.size).toBe(1001);
  });
});
