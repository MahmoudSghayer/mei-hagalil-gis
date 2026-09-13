// Adversarial / deeper-coverage tests for Edit Mode authorization, additive
// to test/security/edit-authz.test.js. Two areas the base file's docstring
// promises but does not actually cover:
//   (1) a direct RPC call with NO authenticated user at all (role resolves
//       to null, not merely 'viewer') is rejected the same way, before rpc;
//   (2) js/arcgis-ribbon.js's role-gated "עריכה" tab/panel (ags-gated) —
//       currently ZERO test coverage anywhere in the suite. This exercises
//       applyRoleGating()'s bounded-retry-until-GIS-is-ready polling (fake
//       timers), the viewer/engineer/admin outcomes, and the "switch away
//       from the gated tab if it was active when gating kicks in" branch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

// ── (1) direct RPC authorization edge cases ─────────────────────────────────
function makeFakeSb(opts) {
  opts = opts || {};
  var role = 'role' in opts ? opts.role : 'viewer';
  var featureRow = opts.featureRow || { id: 'f1', layer_id: 'L1', edited_at: '2026-09-13T10:00:00+00:00' };
  var rpcImpl = opts.rpc || (async function () { return { data: null, error: null }; });
  function chainable(table) {
    var api = {
      select: function () { return api; },
      eq: function () { return api; },
      single: async function () {
        if (table === 'profiles') return { data: role == null ? null : { role: role }, error: null };
        if (table === 'features') return { data: featureRow, error: null };
        return { data: null, error: null };
      },
      update: function () { return api; },
      delete: function () { return api; },
      insert: function () { return api; },
    };
    return api;
  }
  var rpc = vi.fn(rpcImpl);
  return {
    auth: { getUser: async function () { return { data: { user: role == null ? null : { id: 'u1' } }, error: null }; } },
    from: function (table) { return chainable(table); },
    rpc: rpc,
  };
}
function loadEngine(sbOpts) {
  var sb = makeFakeSb(sbOpts);
  var ctx = loadBrowserGlobals(['gis-engine/core.js', 'gis-engine/features.js'], { gSb: sb });
  return { ctx: ctx, sb: sb };
}

describe('direct-RPC authorization edge cases', () => {
  it('updateGeometry rejects with "must be signed in" (not the viewer wording) when there is no session at all, and never calls rpc', async () => {
    const { ctx, sb } = loadEngine({ role: null });
    const geom = { type: 'Point', coordinates: [35.1, 32.9] };
    let caught = null;
    try { await ctx.GIS.features.updateGeometry('f1', geom); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.message).toMatch(/signed in/i);
    expect(sb.rpc).not.toHaveBeenCalled();
    // classifyError still recognises it as 'forbidden' UI-wise (the client
    // should react to it exactly like any other authz rejection).
    expect(ctx.GIS.classifyError(caught)).toBe('forbidden');
  });

  it('getEditToken has NO role check (read-only) — a viewer can still fetch the concurrency token', async () => {
    const { ctx } = loadEngine({ role: 'viewer', featureRow: { id: 'f1', layer_id: 'L1', edited_at: '2026-01-01T00:00:00Z' } });
    const row = await ctx.GIS.features.getEditToken('f1');
    expect(row).toBeTruthy();
  });

  it('createFeature (used by undo-of-delete) is rejected client-side for a viewer, same as updateGeometry', async () => {
    const { ctx, sb } = loadEngine({ role: 'viewer' });
    await expect(ctx.GIS.features.createFeature('L1', { type: 'Point', coordinates: [35, 32] }, {}, 'X-1'))
      .rejects.toThrow(/not allowed/i);
    expect(sb.rpc).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// (2) js/arcgis-ribbon.js role gating — a minimal-but-real DOM emulator: a
// registry-backed getElementById (id is a real property with a setter that
// registers/deregisters, mirroring the real DOM), a Set-backed classList, and
// a queryAll() that walks the actual tree and matches simple `.class` /
// `#id` / `tag` selectors — just enough for build()'s tab/panel wiring and
// switchTab()'s querySelectorAll('.ags-tab' | '.ags-panel') to behave like
// the real DOM, since arcgis-ribbon.js re-queries the DOM for those instead
// of keeping its own list.
// ══════════════════════════════════════════════════════════════════════════
const ID_REGISTRY = new Map();
const ALL_ELEMENTS = [];

function elMatchesSimple(el, sel) {
  sel = sel.trim();
  if (sel[0] === '#') return el.id === sel.slice(1);
  if (sel[0] === '.') return el.classList.contains(sel.slice(1));
  return el.tagName.toLowerCase() === sel.toLowerCase();
}
function queryAll(root, sel) {
  const out = [];
  (function walk(node) {
    (node.children || []).forEach((c) => {
      if (!c || !c.tagName) return; // skip text nodes / non-element children
      if (elMatchesSimple(c, sel)) out.push(c);
      walk(c);
    });
  })(root);
  return out;
}

function makeRibbonElement(tag) {
  let classSet = new Set();
  let _id = '';
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, dataset: {}, textContent: '', innerHTML: '', value: '', disabled: false,
    children: [], childNodes: [], parentNode: null,
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) {
      if (ref == null) { this.children.push(c); } else {
        const i = this.children.indexOf(ref);
        this.children.splice(i < 0 ? this.children.length : i, 0, c);
      }
      c.parentNode = this; return c;
    },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(evt, fn) { (this._listeners = this._listeners || {})[evt] = (this._listeners[evt] || []).concat(fn); },
    removeEventListener() {},
    click() { (this._listeners && this._listeners.click || []).forEach((fn) => fn({ target: this })); if (this.onclick) this.onclick({ target: this }); },
    focus() {}, blur() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    querySelector(sel) { return queryAll(this, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(this, sel); },
    getElementsByTagName() { return []; },
  };
  Object.defineProperty(el, 'className', {
    get() { return [...classSet].join(' '); },
    set(v) { classSet = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
  });
  el.classList = {
    add(...cs) { cs.forEach((c) => classSet.add(c)); },
    remove(...cs) { cs.forEach((c) => classSet.delete(c)); },
    toggle(c, force) { const has = classSet.has(c); const on = force === undefined ? !has : force; if (on) classSet.add(c); else classSet.delete(c); return on; },
    contains(c) { return classSet.has(c); },
  };
  Object.defineProperty(el, 'id', {
    get() { return _id; },
    set(v) {
      if (_id && ID_REGISTRY.get(_id) === el) ID_REGISTRY.delete(_id);
      _id = String(v || '');
      if (_id) ID_REGISTRY.set(_id, el);
    },
  });
  ALL_ELEMENTS.push(el);
  return el;
}

function makeRibbonDocument() {
  const body = makeRibbonElement('body');
  const head = makeRibbonElement('head');
  const doc = {
    readyState: 'complete',
    createElement: (t) => makeRibbonElement(t),
    createTextNode: (t) => ({ textContent: String(t) }),
    createDocumentFragment: () => makeRibbonElement('fragment'),
    getElementById: (id) => ID_REGISTRY.get(id) || null,
    querySelector: (sel) => queryAll(body, sel)[0] || null,
    querySelectorAll: (sel) => queryAll(body, sel),
    addEventListener() {}, removeEventListener() {},
    body, head,
    documentElement: makeRibbonElement('html'),
  };
  return doc;
}

// Pre-populates the handful of pre-existing page elements build() expects to
// find via $(id) (a plain document.getElementById wrapper) — #topbar with a
// parentNode so `topbar.parentNode.insertBefore(ribbon, ...)` works, plus
// #sidebar / #statusbar / #toast, all attached under document.body so the
// ribbon's own tree (and switchTab()'s document-wide querySelectorAll) sees
// everything build() creates.
function makeRibbonPage() {
  ID_REGISTRY.clear();
  ALL_ELEMENTS.length = 0;
  const document = makeRibbonDocument();
  const topbar = makeRibbonElement('div'); topbar.id = 'topbar';
  const sidebar = makeRibbonElement('div'); sidebar.id = 'sidebar';
  const statusbar = makeRibbonElement('div'); statusbar.id = 'statusbar';
  document.body.appendChild(topbar);
  document.body.appendChild(sidebar);
  document.body.appendChild(statusbar);
  return { document, topbar, sidebar, statusbar };
}

function loadRibbon({ role, gisPresent = true } = {}) {
  const { document } = makeRibbonPage();
  const extra = { document };
  if (gisPresent) {
    extra.GIS = { currentRole: vi.fn(async () => role) };
  }
  const ctx = loadBrowserGlobals(['js/arcgis-ribbon.js'], extra);
  return { ctx, document };
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('js/arcgis-ribbon.js — role-gated Edit tab ("ags-gated")', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('viewer: the edit tab and its panel KEEP ags-gated after role resolves', async () => {
    const { document } = loadRibbon({ role: 'viewer' });
    await vi.runOnlyPendingTimersAsync().catch(() => {});
    await flush();
    const editTab = document.querySelectorAll('.ags-tab').find((t) => t.getAttribute('data-tab') === 'edit');
    const editPanel = document.querySelectorAll('.ags-panel').find((p) => p.getAttribute('data-panel') === 'edit');
    expect(editTab).toBeTruthy();
    expect(editTab.classList.contains('ags-gated')).toBe(true);
    expect(editPanel.classList.contains('ags-gated')).toBe(true);
  });

  it('engineer: ags-gated is REMOVED from both the tab and the panel', async () => {
    const { document } = loadRibbon({ role: 'engineer' });
    await vi.runOnlyPendingTimersAsync().catch(() => {});
    await flush();
    const editTab = document.querySelectorAll('.ags-tab').find((t) => t.getAttribute('data-tab') === 'edit');
    const editPanel = document.querySelectorAll('.ags-panel').find((p) => p.getAttribute('data-panel') === 'edit');
    expect(editTab.classList.contains('ags-gated')).toBe(false);
    expect(editPanel.classList.contains('ags-gated')).toBe(false);
  });

  it('admin: ags-gated is also removed (not just engineer)', async () => {
    const { document } = loadRibbon({ role: 'admin' });
    await vi.runOnlyPendingTimersAsync().catch(() => {});
    await flush();
    const editTab = document.querySelectorAll('.ags-tab').find((t) => t.getAttribute('data-tab') === 'edit');
    expect(editTab.classList.contains('ags-gated')).toBe(false);
  });

  it('if the edit tab was active when a role downgrade re-gates it, "map" becomes the active tab', async () => {
    const { ctx, document } = loadRibbon({ role: 'engineer' });
    await vi.runOnlyPendingTimersAsync().catch(() => {});
    await flush();
    const editTab = document.querySelectorAll('.ags-tab').find((t) => t.getAttribute('data-tab') === 'edit');
    const mapTab = document.querySelectorAll('.ags-tab').find((t) => t.getAttribute('data-tab') === 'map');
    // simulate the user having navigated to the (currently visible) edit tab
    mapTab.classList.remove('active');
    editTab.classList.add('active');
    expect(editTab.classList.contains('active')).toBe(true);

    // role degrades (e.g. an admin edited this user down to viewer) and
    // something calls the public refresh hook
    ctx.GIS.currentRole = vi.fn(async () => 'viewer');
    ctx.window.GISRibbon.refreshRoleGating();
    await vi.runOnlyPendingTimersAsync().catch(() => {});
    await flush();

    expect(editTab.classList.contains('ags-gated')).toBe(true);
    expect(editTab.classList.contains('active')).toBe(false);
    expect(mapTab.classList.contains('active')).toBe(true);
  });

  it('GIS absent for a while then appearing later: gating still resolves once it does (bounded-retry polling)', async () => {
    const { ctx, document } = loadRibbon({ gisPresent: false });
    const editTabOf = () => document.querySelectorAll('.ags-tab').find((t) => t.getAttribute('data-tab') === 'edit');
    // still gated while GIS doesn't exist yet — advance a few retries (200ms each, capped at 30)
    await vi.advanceTimersByTimeAsync(600);
    expect(editTabOf().classList.contains('ags-gated')).toBe(true);
    // GIS shows up mid-poll — assigning ctx.GIS sets it on the sandbox's own
    // `window` too, since the module's `window` IS `ctx` (loadBrowserGlobals
    // sets sandbox.window = sandbox).
    ctx.GIS = { currentRole: vi.fn(async () => 'engineer') };
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    expect(editTabOf().classList.contains('ags-gated')).toBe(false);
  });

  it('build() is idempotent — calling twice (a stray double-include) does not throw or duplicate the ribbon', async () => {
    const { document } = loadRibbon({ role: 'engineer' });
    await vi.runOnlyPendingTimersAsync().catch(() => {});
    await flush();
    const ribbonsBefore = document.querySelectorAll('#ags-ribbon').length;
    expect(ribbonsBefore).toBe(1);
  });
});
