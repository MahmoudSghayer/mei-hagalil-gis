// Unit tests for the server-side paging rewrite of js/gis-feature-table.js
// (Worker W1.2 — attribute-table backbone).
//
// The module is a plain-browser-global IIFE (no exports), so it's loaded into
// a Node vm context via test/helpers/load-browser-global.mjs and exercised
// through the test-only `GISTable._test` hooks it exposes (getState,
// buildPageParams, pageInfo, pagerLabel, buildBulkPatch, csvEscapeCell,
// buildTableCSV, loadPage, nextPage, prevPage). Those hooks have no runtime
// callers of their own — they just give tests direct access to the pure /
// near-pure pieces of the rewrite without having to drive the real DOM
// (dblclick-to-edit, inline column rename, etc. — those stay exercised
// manually / by the e2e suite).
//
// A minimal "lenient" document stub is used instead of the shared harness's
// stubDocument(): gis-feature-table.js builds most of its UI via innerHTML
// strings and then immediately does document.getElementById('gt-x').onclick=
// for a couple dozen ids — a strict stub that returns null for unknown ids
// would throw. The lenient stub auto-vivifies a generic element for any id on
// first lookup (and returns the SAME element on repeat lookups), which is
// enough for the module to load and for state-machine code paths (loadPage /
// renderEnginePage / renderPager) to run without touching a real DOM tree.
import { describe, it, expect, beforeEach } from 'vitest';
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

// Minimal GIS.* stub — the calls gis-feature-table.js makes, with capture
// arrays so tests can assert on what was sent to the (fake) RPC wrappers.
function makeGisStub() {
  const calls = { featuresPage: [], featuresPageCount: [] };
  let pageResponse = { type: 'FeatureCollection', features: [] };
  let countResponse = 0;
  const GIS = {
    queries: {
      featuresPage: async (layerId, opts) => { calls.featuresPage.push({ layerId, opts }); return pageResponse; },
      featuresPageCount: async (layerId, opts) => { calls.featuresPageCount.push({ layerId, opts }); return countResponse; },
    },
    features: { bulkUpdate: async () => ({ updated: 0 }) },
    fields: { getFields: async () => [] },
    layers: { getLayerById: async () => ({ geometry_type: 'Point' }) },
    currentRole: async () => 'engineer',
    permissions: { canEditGis: () => true, canExport: () => true },
  };
  return {
    GIS, calls,
    setPage(fc) { pageResponse = fc; },
    setCount(n) { countResponse = n; },
  };
}

function load() {
  const stub = makeGisStub();
  const ctx = loadBrowserGlobals(['js/gis-feature-table.js'], {
    document: makeLenientDocument(),
    esc: (v) => (v == null ? '' : String(v)),
    GIS: stub.GIS,
    L: {},
  });
  return { ctx, T: ctx.window.GISTable._test, ...stub };
}

describe('gis-feature-table: buildPageParams (filter/sort/search param builder)', () => {
  it('defaults to page 0, asc sort, empty search, no filters', () => {
    const { T } = load();
    const st = { page: 0, pageSize: 500, sortKey: null, sortDir: 1, search: '', filters: null };
    expect(T.buildPageParams(st)).toEqual({
      filters: { logic: 'and', conditions: [] },
      search: '',
      sortKey: null,
      sortDir: 'asc',
      limit: 500,
      offset: 0,
    });
  });

  it('converts sortDir -1/1 to desc/asc', () => {
    const { T } = load();
    expect(T.buildPageParams({ page: 0, pageSize: 500, sortDir: -1 }).sortDir).toBe('desc');
    expect(T.buildPageParams({ page: 0, pageSize: 500, sortDir: 1 }).sortDir).toBe('asc');
  });

  it('computes offset from page * pageSize', () => {
    const { T } = load();
    expect(T.buildPageParams({ page: 3, pageSize: 500 }).offset).toBe(1500);
    expect(T.buildPageParams({ page: 0, pageSize: 500 }).offset).toBe(0);
  });

  it('passes sortKey and search through, and preserves an already-parsed filter object', () => {
    const { T } = load();
    const filters = { logic: 'or', conditions: [{ field: 'status', op: '=', value: 'active' }] };
    const params = T.buildPageParams({ page: 1, pageSize: 500, sortKey: 'diameter', sortDir: -1, search: 'PVC', filters });
    expect(params.sortKey).toBe('diameter');
    expect(params.search).toBe('PVC');
    expect(params.filters).toBe(filters);
    expect(params.offset).toBe(500);
  });
});

describe('gis-feature-table: pageInfo / pagerLabel (page-state machine)', () => {
  it('an empty layer is page 1 of 1, no prev/next', () => {
    const { T } = load();
    const info = T.pageInfo({ page: 0, pageSize: 500, total: 0 });
    expect(info).toEqual({ current: 1, totalPages: 1, hasPrev: false, hasNext: false });
  });

  it('computes total pages and prev/next from total + pageSize', () => {
    const { T } = load();
    // 1234 rows / 500 per page -> 3 pages
    expect(T.pageInfo({ page: 0, pageSize: 500, total: 1234 })).toEqual({ current: 1, totalPages: 3, hasPrev: false, hasNext: true });
    expect(T.pageInfo({ page: 1, pageSize: 500, total: 1234 })).toEqual({ current: 2, totalPages: 3, hasPrev: true, hasNext: true });
    expect(T.pageInfo({ page: 2, pageSize: 500, total: 1234 })).toEqual({ current: 3, totalPages: 3, hasPrev: true, hasNext: false });
  });

  it('an exact multiple of pageSize does not create a phantom trailing page', () => {
    const { T } = load();
    // 1000 rows / 500 per page -> exactly 2 pages
    expect(T.pageInfo({ page: 1, pageSize: 500, total: 1000 }).totalPages).toBe(2);
    expect(T.pageInfo({ page: 1, pageSize: 500, total: 1000 }).hasNext).toBe(false);
  });

  it('pagerLabel renders the Hebrew "עמוד X מתוך Y" format', () => {
    const { T } = load();
    expect(T.pagerLabel({ page: 0, pageSize: 500, total: 1234 })).toBe('עמוד 1 מתוך 3');
    expect(T.pagerLabel({ page: 2, pageSize: 500, total: 1234 })).toBe('עמוד 3 מתוך 3');
  });
});

describe('gis-feature-table: nextPage/prevPage drive real RPC calls with the right offset', () => {
  let env;
  beforeEach(() => { env = load(); });

  it('nextPage() is a no-op when already on the last page', async () => {
    const { T, calls } = env;
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L1', page: 0, pageSize: 500, total: 3 }); // 1 page total
    await T.nextPage();
    expect(calls.featuresPage.length).toBe(0);
    expect(st.page).toBe(0);
  });

  it('nextPage() advances the page and requests the next offset', async () => {
    const { T, calls, setPage, setCount } = env;
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L1', page: 0, pageSize: 500, total: 1234 });
    setPage({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'f2', geometry: null, properties: { __id: 'f2', asset_code: 'A-2' } }] });
    setCount(1234);

    await T.nextPage();

    expect(st.page).toBe(1);
    expect(calls.featuresPage.length).toBe(1);
    expect(calls.featuresPage[0].layerId).toBe('L1');
    expect(calls.featuresPage[0].opts.offset).toBe(500);
    expect(calls.featuresPage[0].opts.limit).toBe(500);
    expect(st.total).toBe(1234);
    expect(st.all.length).toBe(1);
  });

  it('prevPage() is a no-op on the first page', async () => {
    const { T, calls } = env;
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L1', page: 0, pageSize: 500, total: 1234 });
    await T.prevPage();
    expect(calls.featuresPage.length).toBe(0);
    expect(st.page).toBe(0);
  });

  it('prevPage() steps back and requests the previous offset', async () => {
    const { T, calls, setCount } = env;
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L1', page: 2, pageSize: 500, total: 1234 });
    setCount(1234);

    await T.prevPage();

    expect(st.page).toBe(1);
    expect(calls.featuresPage[0].opts.offset).toBe(500);
  });

  it('page navigation clears any multi-row selection from the previous page', async () => {
    const { T, setCount } = env;
    const st = T.getState();
    Object.assign(st, { source: 'engine', layerId: 'L1', page: 0, pageSize: 500, total: 1234 });
    st.selectedIds.add('f1'); st.selectedIds.add('f2');
    setCount(1234);

    await T.nextPage();

    expect(st.selectedIds.size).toBe(0);
  });

  it('loadPage() is a no-op outside engine mode (village mode keeps its own client-side paging)', async () => {
    const { T, calls } = env;
    const st = T.getState();
    Object.assign(st, { source: 'village', layerId: null });
    await T.loadPage();
    expect(calls.featuresPage.length).toBe(0);
  });
});

describe('gis-feature-table: buildBulkPatch (bulk-edit payload construction)', () => {
  it('coerces an int/float field from the raw input string', () => {
    const { T } = load();
    expect(T.buildBulkPatch('diameter', '150', { type: 'int' }, null)).toEqual({ diameter: 150 });
    expect(T.buildBulkPatch('length_m', '12.5', { type: 'float' }, null)).toEqual({ length_m: 12.5 });
  });

  it('an empty string on a numeric field becomes null (clears the value), not NaN', () => {
    const { T } = load();
    expect(T.buildBulkPatch('diameter', '', { type: 'int' }, null)).toEqual({ diameter: null });
  });

  it('coerces a bool field via the same regex as single-cell edit (true/1/כן/yes)', () => {
    const { T } = load();
    expect(T.buildBulkPatch('active', 'true', { type: 'bool' }, null)).toEqual({ active: true });
    expect(T.buildBulkPatch('active', 'כן', { type: 'bool' }, null)).toEqual({ active: true });
    expect(T.buildBulkPatch('active', 'no', { type: 'bool' }, null)).toEqual({ active: false });
  });

  it('coerces a numeric coded-value domain field even without a registered fieldDef', () => {
    const { T } = load();
    const domains = { has: () => true, numeric: () => true };
    expect(T.buildBulkPatch('Status', '1', null, domains)).toEqual({ Status: 1 });
  });

  it('leaves a plain text field (no fieldDef, no domain) as the raw string', () => {
    const { T } = load();
    expect(T.buildBulkPatch('material', 'PVC', null, null)).toEqual({ material: 'PVC' });
    expect(T.buildBulkPatch('material', 'PVC', undefined, { has: () => false })).toEqual({ material: 'PVC' });
  });
});

describe('gis-feature-table: csvEscapeCell (CSV formula-injection guard)', () => {
  it('quotes a plain value', () => {
    const { T } = load();
    expect(T.csvEscapeCell('PVC')).toBe('"PVC"');
    expect(T.csvEscapeCell(150)).toBe('"150"');
  });

  it('null/undefined become an empty quoted cell', () => {
    const { T } = load();
    expect(T.csvEscapeCell(null)).toBe('""');
    expect(T.csvEscapeCell(undefined)).toBe('""');
  });

  it('prefixes a leading = + - @ TAB or CR with an apostrophe (CWE-1236)', () => {
    const { T } = load();
    expect(T.csvEscapeCell('=SUM(A1:A9)')).toBe('"\'=SUM(A1:A9)"');
    expect(T.csvEscapeCell('+1234')).toBe('"\'+1234"');
    expect(T.csvEscapeCell('-1234')).toBe('"\'-1234"');
    expect(T.csvEscapeCell('@cmd')).toBe('"\'@cmd"');
    expect(T.csvEscapeCell('\tx')).toBe('"\'\tx"');
  });

  it('does not touch a value that merely CONTAINS = elsewhere', () => {
    const { T } = load();
    expect(T.csvEscapeCell('A=B')).toBe('"A=B"');
  });

  it('doubles embedded double-quotes', () => {
    const { T } = load();
    expect(T.csvEscapeCell('12" pipe')).toBe('"12"" pipe"');
  });
});

describe('gis-feature-table: buildTableCSV', () => {
  it('builds a header row of # + columns + audit columns, and numbers rows from 1', () => {
    const { T } = load();
    const rows = [
      { properties: { asset_code: 'A-1', material: 'PVC', __edited_by: 'דנה', __edited_at: null } },
      { properties: { asset_code: 'A-2', material: 'PE', __edited_by: '', __edited_at: null } },
    ];
    const csv = T.buildTableCSV(['asset_code', 'material'], rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('"#","asset_code","material","נערך ע״י","מתי"');
    expect(lines[1]).toBe('"1","A-1","PVC","דנה",""');
    expect(lines[2]).toBe('"2","A-2","PE","",""');
  });

  it('renders coded-value domain fields as their label, mirroring the table cell display', () => {
    const { ctx, T } = load();
    ctx.window.GISDomains = {
      has: (f) => f === 'Status',
      label: (f, v) => (f === 'Status' && String(v) === '1' ? 'קיים / פעיל' : v),
    };
    const rows = [{ properties: { Status: '1' } }];
    const csv = T.buildTableCSV(['Status'], rows);
    expect(csv.split('\r\n')[1]).toBe('"1","קיים / פעיל","",""');
  });

  it('formula-injection-guards a cell value the same way csvEscapeCell does', () => {
    const { T } = load();
    const rows = [{ properties: { note: '=cmd|calc' } }];
    const csv = T.buildTableCSV(['note'], rows);
    expect(csv.split('\r\n')[1]).toBe('"1","\'=cmd|calc","",""');
  });

  it('an empty row set still produces just the header line', () => {
    const { T } = load();
    expect(T.buildTableCSV(['asset_code'], [])).toBe('"#","asset_code","נערך ע״י","מתי"');
  });
});
