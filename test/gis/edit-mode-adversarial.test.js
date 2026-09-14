// Adversarial / deep-coverage tests for the sticky Edit Mode state machine in
// js/gis-edit.js, additive to test/gis/edit-mode.test.js (which covers the
// documented happy paths). Fixtures (fake L / gMap / GIS / GISEngineSidebar /
// document) are duplicated from that file per the test plan's instruction —
// this file's scenario list goes well beyond the happy path: role gating for
// every entry point, geometry mutation across every geometry family (move,
// vertex drag, extend, shorten, MultiPoint, MultiLineString), the concurrency
// token / conflict-dialog contract, every classifyError() branch's UI
// outcome, listener/DOM leak checks on disarm(), double-arm idempotency, and
// GISEdit.clear() as a hard reset.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

// ── tiny Leaflet-ish event emitter (on/off/once/fire) ───────────────────────
function makeEmitter() {
  const listeners = {};
  const em = {
    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return em; },
    off(evt, fn) {
      if (!listeners[evt]) return em;
      if (!fn) { listeners[evt] = []; return em; }
      listeners[evt] = listeners[evt].filter((f) => f !== fn);
      return em;
    },
    once(evt, fn) {
      const wrap = (...args) => { em.off(evt, wrap); fn(...args); };
      em.on(evt, wrap);
      return em;
    },
    fire(evt, data) { (listeners[evt] || []).slice().forEach((fn) => fn(data)); return em; },
    // test-only introspection — counts currently-registered handlers, used
    // to assert disarm()/teardown never leaks listeners.
    _listenerCount(evt) { return evt ? (listeners[evt] || []).length : Object.values(listeners).reduce((t, a) => t + a.length, 0); },
  };
  return em;
}

function makeElement(tag) {
  let classSet = new Set();
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, dataset: {}, id: '', textContent: '', innerHTML: '', value: '', disabled: false,
    children: [], childNodes: [],
    setAttribute(k, v) { this['_attr_' + k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this, '_attr_' + k) ? this['_attr_' + k] : null; },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {},
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    click() { if (this.onclick) this.onclick({ target: this }); },
    focus() {}, blur() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  Object.defineProperty(el, 'className', {
    get() { return [...classSet].join(' '); },
    set(v) { classSet = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
  });
  el.classList = {
    add(...cs) { cs.forEach((c) => classSet.add(c)); },
    remove(...cs) { cs.forEach((c) => classSet.delete(c)); },
    toggle(c, force) {
      const has = classSet.has(c);
      const on = force === undefined ? !has : force;
      if (on) classSet.add(c); else classSet.delete(c);
      return on;
    },
    contains(c) { return classSet.has(c); },
  };
  return el;
}

function makeDocument() {
  const body = makeElement('body');
  const head = makeElement('head');
  return {
    createElement: (t) => makeElement(t),
    createTextNode: (t) => ({ textContent: String(t) }),
    createDocumentFragment: () => makeElement('fragment'),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    body, head,
    documentElement: makeElement('html'),
  };
}

// ── fake Leaflet (L) ─────────────────────────────────────────────────────────
function coordToLatLng(c) { return { lat: c[1], lng: c[0] }; }
function coordsToLatLngsDeep(coords) {
  if (typeof coords[0] === 'number') return coordToLatLng(coords);
  return coords.map(coordsToLatLngsDeep);
}
function latLngsToCoordsDeep(ll) {
  if (Array.isArray(ll)) return ll.map(latLngsToCoordsDeep);
  return [ll.lng, ll.lat];
}

function makePm() {
  // Mirrors the real Geoman contract that bit production: pm.enable(opts) and
  // pm.setOptions(opts) both merge into pm.options, and enableLayerDrag() is a
  // silent no-op while options.draggable === false (Geoman 2.18.3 Drag mixin).
  const pm = {
    options: { draggable: true },
    _dragEnabled: false,
    enable: vi.fn((opts) => { Object.assign(pm.options, opts || {}); }),
    disable: vi.fn(),
    setOptions: vi.fn((opts) => { Object.assign(pm.options, opts || {}); }),
    enableLayerDrag: vi.fn(() => { if (pm.options.draggable === false) return; pm._dragEnabled = true; }),
    disableLayerDrag: vi.fn(() => { pm._dragEnabled = false; }),
    layerDragEnabled: vi.fn(() => pm._dragEnabled),
  };
  return pm;
}

function makePointLayer(latlng) {
  const em = makeEmitter();
  const layer = Object.assign(em, {
    _latlng: latlng,
    options: {},
    getLatLng() { return this._latlng; },
    setLatLng(ll) { this._latlng = ll; },
    toGeoJSON() { return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [this._latlng.lng, this._latlng.lat] } }; },
    addTo() { return this; },
  });
  layer.pm = makePm();
  return layer;
}

function makeLineLayer(latlngs, geomType) {
  const em = makeEmitter();
  const layer = Object.assign(em, {
    _latlngs: latlngs,
    _geomType: geomType,
    options: {},
    getLatLngs() { return this._latlngs; },
    setLatLngs(ll) { this._latlngs = ll; },
    toGeoJSON() { return { type: 'Feature', properties: {}, geometry: { type: this._geomType, coordinates: latLngsToCoordsDeep(this._latlngs) } }; },
    addTo() { return this; },
  });
  layer.pm = makePm();
  return layer;
}

function makeFeatureGroup(children) {
  const em = makeEmitter();
  const grp = Object.assign(em, {
    _children: children ? children.slice() : [],
    addTo() { return this; },
    eachLayer(fn) { this._children.forEach(fn); },
    getLayers() { return this._children.slice(); },
  });
  return grp;
}

function geometryToLayer(geometry, opts) {
  const t = geometry.type;
  if (t === 'Point') {
    const latlng = coordToLatLng(geometry.coordinates);
    return (opts && opts.pointToLayer) ? opts.pointToLayer({ geometry }, latlng) : makePointLayer(latlng);
  }
  if (t === 'MultiPoint') {
    const markers = geometry.coordinates.map((c) => {
      const latlng = coordToLatLng(c);
      return (opts && opts.pointToLayer) ? opts.pointToLayer({ geometry }, latlng) : makePointLayer(latlng);
    });
    return makeFeatureGroup(markers);
  }
  if (t === 'LineString' || t === 'MultiLineString' || t === 'Polygon' || t === 'MultiPolygon') {
    return makeLineLayer(coordsToLatLngsDeep(geometry.coordinates), t);
  }
  return null;
}

function makeL() {
  const L = {
    geoJSON(feature, opts) {
      const grp = makeFeatureGroup();
      grp.options = opts || {};
      grp.addData = function (gj) {
        const feats = gj.type === 'FeatureCollection' ? gj.features : [gj];
        feats.forEach((f) => { const lyr = geometryToLayer(f.geometry, grp.options); if (lyr) grp._children.push(lyr); });
        return grp;
      };
      if (feature && feature.geometry) grp.addData(feature);
      return grp;
    },
    featureGroup(layers) { return makeFeatureGroup(layers); },
    marker(latlng) { return makePointLayer(latlng); },
    circleMarker(latlng) { return makePointLayer(latlng); },
    polyline(latlngs) { return makeLineLayer(latlngs, 'LineString'); },
    polygon(latlngs) { return makeLineLayer(latlngs, 'Polygon'); },
    latLng(lat, lng) { return { lat, lng }; },
    point(x, y) { return { x, y }; },
    GeoJSON: { coordsToLatLngs: (coords) => coordsToLatLngsDeep(coords) },
  };
  return L;
}

// ── fake gMap ────────────────────────────────────────────────────────────────
function makeGMap() {
  const container = makeElement('div');
  const em = makeEmitter();
  const panes = {};
  const map = Object.assign(em, {
    getContainer: () => container,
    getPane: (n) => panes[n] || null,
    createPane: (n) => { const p = makeElement('div'); panes[n] = p; return p; },
    getBounds: () => ({ getWest: () => 34, getEast: () => 36, getSouth: () => 31, getNorth: () => 33, getCenter: () => ({ lat: 32, lng: 35 }) }),
    dragging: { enable: vi.fn(), disable: vi.fn() },
    pm: { disableDraw: vi.fn(), setGlobalOptions: vi.fn(), enableDraw: vi.fn() },
    removeLayer: vi.fn(),
    addLayer: vi.fn(),
  });
  return map;
}

// ── fake GIS ──────────────────────────────────────────────────────────────────
function classify(e) {
  const m = (e && e.message) || String(e || '');
  if (/\(permission denied\)/.test(m)) return 'forbidden';
  if (/\(conflict\)/.test(m)) return 'conflict';
  if (/\(invalid geometry\)/.test(m)) return 'invalid';
  if (/\(not found\)/.test(m)) return 'not_found';
  if (/network/i.test(m)) return 'network';
  return 'unknown';
}
function makeGIS(role) {
  return {
    currentRole: vi.fn(async () => role),
    classifyError: vi.fn(classify),
    features: {
      getInBBox: vi.fn(async () => ({ type: 'FeatureCollection', features: [] })),
      getEditToken: vi.fn(async (id) => ({ id, layer_id: 'L1', edited_at: '2026-01-01T00:00:00Z' })),
      updateGeometry: vi.fn(async (id, geometry) => ({ id, geometry, layer_id: 'L1' })),
      getFeatureById: vi.fn(async () => null),
    },
    layers: { getLayers: vi.fn(async () => []) },
  };
}
function makeSidebar(layers) {
  return {
    activeLayers: vi.fn(() => layers || []),
    reload: vi.fn(),
    refresh: vi.fn(),
  };
}

function load({ role = 'engineer', activeLayers = [{ id: 'L1', geometry_type: 'LineString' }] } = {}) {
  const L = makeL();
  const gMap = makeGMap();
  const GIS = makeGIS(role);
  const GISEngineSidebar = makeSidebar(activeLayers);
  const document = makeDocument();
  // Real addEventListener/removeEventListener stubs on the sandbox `window`
  // (== the sandbox itself) so setDirty(true)'s installBeforeUnload() guard
  // (`typeof window.addEventListener !== 'function'`) actually installs a
  // handler, and the disarm-cleanliness test below can observe both calls.
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const ctx = loadBrowserGlobals(['js/gis-edit-geom.js', 'js/gis-edit.js'],
    { L, gMap, GIS, GISEngineSidebar, document, addEventListener, removeEventListener });
  return { ctx, L, gMap, GIS, GISEngineSidebar, document, addEventListener, removeEventListener, GISEdit: ctx.GISEdit, GISEditHistory: ctx.GISEditHistory };
}
// Drives a HUD sub-mode button exactly the way a user click would (HUD
// buttons are wired via `.onclick = () => switchSub(key)`, not exposed
// directly on GISEdit._test) — more faithful than reaching into internals.
function clickSub(GISEdit, key) { GISEdit._test.hud().subBtns[key].click(); }

const LINE_FEATURE = {
  id: 'f1',
  properties: { __id: 'f1', __layer_id: 'L1' },
  geometry: { type: 'LineString', coordinates: [[35, 32], [35.01, 32]] },
};
const POLY_FEATURE = {
  id: 'p1',
  properties: { __id: 'p1', __layer_id: 'L2' },
  geometry: { type: 'Polygon', coordinates: [[[35, 32], [35.1, 32], [35.1, 32.1], [35, 32.1], [35, 32]]] },
};
const POINT_FEATURE = {
  id: 'pt1',
  properties: { __id: 'pt1', __layer_id: 'L3' },
  geometry: { type: 'Point', coordinates: [35, 32] },
};
const MULTIPOINT_FEATURE = {
  id: 'mp1',
  properties: { __id: 'mp1', __layer_id: 'L1' },
  geometry: { type: 'MultiPoint', coordinates: [[35, 32], [35.1, 32.1], [35.2, 32.2]] },
};
const MULTILINE_FEATURE = {
  id: 'ml1',
  properties: { __id: 'ml1', __layer_id: 'L1' },
  geometry: { type: 'MultiLineString', coordinates: [[[35, 32], [35.01, 32]], [[35.2, 32.2], [35.21, 32.2]]] },
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const tick2 = async () => { await tick(); await tick(); };

describe('GISEdit Edit Mode — adversarial coverage', () => {
  // ── 1) Authorization across every entry point ───────────────────────────
  describe('authorization', () => {
    it('admin can enter Edit Mode and save', async () => {
      const { GISEdit, GIS } = load({ role: 'admin' });
      const on = await GISEdit.toggleEditMode(true);
      expect(on).toBe(true);
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      await GISEdit._test.save();
      expect(GIS.features.updateGeometry).toHaveBeenCalledTimes(1);
    });

    it('engineer can enter Edit Mode and save', async () => {
      const { GISEdit, GIS } = load({ role: 'engineer' });
      const on = await GISEdit.toggleEditMode(true);
      expect(on).toBe(true);
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      await GISEdit._test.save();
      expect(GIS.features.updateGeometry).toHaveBeenCalledTimes(1);
    });

    it('viewer cannot enter: toggle resolves false, no map class, no click armed, no HUD', async () => {
      const { GISEdit, gMap } = load({ role: 'viewer' });
      const onceSpy = vi.spyOn(gMap, 'once');
      const on = await GISEdit.toggleEditMode(true);
      expect(on).toBe(false);
      expect(gMap.getContainer().classList.contains('gis-edit-mode')).toBe(false);
      expect(onceSpy).not.toHaveBeenCalled();
      expect(GISEdit._test.hud()).toBe(null);
      expect(GISEdit._test.state().mode).toBe('off');
    });

    it('viewer calling GIS.features.updateGeometry directly is rejected before any rpc (real engine, not the fake)', async () => {
      const sb = {
        auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
        from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: { role: 'viewer' }, error: null }) }),
        rpc: vi.fn(async () => ({ data: null, error: null })),
      };
      const ctx = loadBrowserGlobals(['gis-engine/core.js', 'gis-engine/features.js'], { gSb: sb });
      await expect(ctx.GIS.features.updateGeometry('f1', { type: 'Point', coordinates: [35, 32] }))
        .rejects.toThrow(/not allowed/i);
      expect(sb.rpc).not.toHaveBeenCalled();
    });

    it('an unauthenticated (null) role is rejected the same way as a viewer', async () => {
      const { GISEdit, gMap } = load({ role: null });
      const onceSpy = vi.spyOn(gMap, 'once');
      const on = await GISEdit.toggleEditMode(true);
      expect(on).toBe(false);
      expect(onceSpy).not.toHaveBeenCalled();
    });

    it('GISEdit.beginEditFeature as a viewer does nothing (returns false, no editing state)', async () => {
      const { GISEdit, GIS } = load({ role: 'viewer' });
      const ok = await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      expect(ok).toBe(false);
      expect(GISEdit._test.state().mode).toBe('off');
      expect(GIS.features.getEditToken).not.toHaveBeenCalled();
    });
  });

  // ── 2) Geometry through the state machine ───────────────────────────────
  describe('geometry mutation across every family', () => {
    it('moving a LineString via a simulated layer drag (pm:dragend) sends translated coordinates', async () => {
      const { GISEdit, GIS } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      clickSub(GISEdit, 'move'); // pm:dragend is only wired in the 'move' sub-mode
      GISEdit._test.state().editLayer.setLatLngs(coordsToLatLngsDeep([[35.05, 32.05], [35.06, 32.05]]));
      GISEdit._test.state().editLayer.fire('pm:dragend');
      expect(GISEdit._test.state().dirty).toBe(true);
      await GISEdit._test.save();
      const geomSaved = GIS.features.updateGeometry.mock.calls[0][1];
      expect(geomSaved.coordinates).toEqual([[35.05, 32.05], [35.06, 32.05]]);
    });

    it('dragging a single vertex (pm:markerdragend) marks dirty and saves the mutated coordinate', async () => {
      const { GISEdit, GIS } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      const layer = GISEdit._test.state().editLayer;
      layer.setLatLngs(coordsToLatLngsDeep([[35, 32], [35.02, 32.05]])); // moved 2nd vertex
      layer.fire('pm:markerdragend');
      expect(GISEdit._test.state().dirty).toBe(true);
      await GISEdit._test.save();
      const geomSaved = GIS.features.updateGeometry.mock.calls[0][1];
      expect(geomSaved.coordinates[1]).toEqual([35.02, 32.05]);
    });

    it('extend: clicking far past the end appends one coordinate at the correct end', async () => {
      const { GISEdit, GIS, gMap } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      clickSub(GISEdit, 'extend');
      expect(GISEdit._test.state().sub).toBe('extend');
      gMap.fire('click', { latlng: { lng: 35.05, lat: 32 } }); // far past the [35.01,32] end
      expect(GISEdit._test.state().dirty).toBe(true);
      await GISEdit._test.save();
      const geomSaved = GIS.features.updateGeometry.mock.calls[0][1];
      expect(geomSaved.coordinates.length).toBe(3);
      expect(geomSaved.coordinates[geomSaved.coordinates.length - 1]).toEqual([35.05, 32]);
    });

    it('shorten: clicking near an end removes one coordinate', async () => {
      const threePt = {
        id: 'f3', properties: { __id: 'f3', __layer_id: 'L1' },
        geometry: { type: 'LineString', coordinates: [[35, 32], [35.005, 32], [35.01, 32]] },
      };
      const { GISEdit, GIS, gMap } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(threePt, 'L1');
      clickSub(GISEdit, 'shorten');
      gMap.fire('click', { latlng: { lng: 35, lat: 32 } }); // near the start
      expect(GISEdit._test.state().dirty).toBe(true);
      await GISEdit._test.save();
      const geomSaved = GIS.features.updateGeometry.mock.calls[0][1];
      expect(geomSaved.coordinates.length).toBe(2);
      expect(geomSaved.coordinates).toEqual([[35.005, 32], [35.01, 32]]);
    });

    it('shorten refuses below 2 points (stays dirty=false, no save happens from that click alone)', async () => {
      const { GISEdit, GIS, gMap } = load({ role: 'engineer' }); // LINE_FEATURE has exactly 2 points
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      clickSub(GISEdit, 'shorten');
      gMap.fire('click', { latlng: { lng: 35, lat: 32 } });
      // refused — never became dirty from this click
      expect(GISEdit._test.state().dirty).toBe(false);
      expect(GIS.features.updateGeometry).not.toHaveBeenCalled();
    });

    it('moving a Point (whole-feature move via enableLayerDrag) saves the new position', async () => {
      const { GISEdit, GIS } = load({ role: 'engineer', activeLayers: [{ id: 'L3', geometry_type: 'Point' }] });
      await GISEdit.beginEditFeature(POINT_FEATURE, 'L3');
      expect(GISEdit._test.state().sub).toBe('move'); // Points have no vertices sub-mode
      const layer = GISEdit._test.state().editLayer;
      layer.setLatLng({ lat: 32.5, lng: 35.5 });
      layer.fire('pm:dragend');
      expect(GISEdit._test.state().dirty).toBe(true);
      await GISEdit._test.save();
      const geomSaved = GIS.features.updateGeometry.mock.calls[0][1];
      expect(geomSaved.coordinates).toEqual([35.5, 32.5]);
    });

    it('editing a Polygon keeps the ring closed after normalize (vertex move via pm:markerdragend)', async () => {
      const { GISEdit, GIS } = load({ role: 'engineer', activeLayers: [{ id: 'L2', geometry_type: 'Polygon' }] });
      await GISEdit.beginEditFeature(POLY_FEATURE, 'L2');
      const layer = GISEdit._test.state().editLayer;
      // move the second vertex; leave the Leaflet ring NOT re-closed (Leaflet
      // polygons don't repeat the first latlng) — normalize() must still
      // close the GeoJSON ring on save. Polygon latlngs are nested one level
      // (array of rings), matching what fromEditable()'s toGeoJSON() path expects.
      const newLatLngs = coordsToLatLngsDeep([[[35, 32], [35.2, 32], [35.1, 32.1]]]);
      layer.setLatLngs(newLatLngs);
      layer.fire('pm:markerdragend');
      await GISEdit._test.save();
      const geomSaved = GIS.features.updateGeometry.mock.calls[0][1];
      const ring = geomSaved.coordinates[0];
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    });

    it('MultiLineString extend picks the correct part (nearest end across all parts)', async () => {
      const { GISEdit, GIS, gMap } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(MULTILINE_FEATURE, 'L1');
      clickSub(GISEdit, 'extend');
      // click far past the SECOND part's end — nearer to part 1's end than
      // anything on part 0.
      gMap.fire('click', { latlng: { lng: 35.25, lat: 32.2 } });
      await GISEdit._test.save();
      const geomSaved = GIS.features.updateGeometry.mock.calls[0][1];
      expect(geomSaved.coordinates[0]).toEqual(MULTILINE_FEATURE.geometry.coordinates[0]); // untouched part
      expect(geomSaved.coordinates[1][geomSaved.coordinates[1].length - 1]).toEqual([35.25, 32.2]);
    });

    it('MultiPoint move preserves ALL points after a manual translate drag', async () => {
      const { GISEdit, GIS, gMap } = load({ role: 'engineer', activeLayers: [{ id: 'L1', geometry_type: 'Point' }] });
      await GISEdit.beginEditFeature(MULTIPOINT_FEATURE, 'L1');
      expect(GISEdit._test.state().sub).toBe('move');
      // simulate the manual mousedown/mousemove/mouseup drag armMultiPointMove() wires on gMap
      gMap.fire('mousedown', { latlng: { lng: 35, lat: 32 } });
      gMap.fire('mousemove', { latlng: { lng: 35.01, lat: 32.01 } }); // +0.01,+0.01
      gMap.fire('mouseup', {});
      expect(GISEdit._test.state().dirty).toBe(true);
      await GISEdit._test.save();
      const geomSaved = GIS.features.updateGeometry.mock.calls[0][1];
      expect(geomSaved.type).toBe('MultiPoint');
      expect(geomSaved.coordinates).toEqual([[35.01, 32.01], [35.11, 32.11], [35.21, 32.21]]);
    });
  });

  // ── 3) Persistence contract ──────────────────────────────────────────────
  describe('persistence contract', () => {
    it('save() passes {expectedEditedAt} equal to the token from getEditToken', async () => {
      const { GISEdit, GIS } = load({ role: 'engineer' });
      GIS.features.getEditToken.mockResolvedValueOnce({ id: 'f1', layer_id: 'L1', edited_at: '2099-01-01T00:00:00Z' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      await GISEdit._test.save();
      expect(GIS.features.updateGeometry.mock.calls[0][2]).toEqual({ expectedEditedAt: '2099-01-01T00:00:00Z' });
    });

    it('when getEditToken rejects, save still proceeds — expectedEditedAt is null, the write is never blocked', async () => {
      const { GISEdit, GIS } = load({ role: 'engineer' });
      GIS.features.getEditToken.mockRejectedValueOnce(new Error('network down'));
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      expect(GISEdit._test.state().mode).toBe('editing'); // entering editing did NOT fail
      GISEdit._test.setDirty(true);
      await GISEdit._test.save();
      expect(GIS.features.updateGeometry).toHaveBeenCalledTimes(1);
      expect(GIS.features.updateGeometry.mock.calls[0][2]).toEqual({ expectedEditedAt: null });
    });

    it('after a successful save, GISEngineSidebar.reload(layerId) is called', async () => {
      const { GISEdit, GISEngineSidebar } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      await GISEdit._test.save();
      expect(GISEngineSidebar.reload).toHaveBeenCalledWith('L1');
    });

    it('GISEditHistory gets a geometry entry whose before equals the original and after equals the saved geometry', async () => {
      const { GISEdit, GISEditHistory } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      const layer = GISEdit._test.state().editLayer;
      layer.setLatLngs(coordsToLatLngsDeep([[35, 32], [35.02, 32]]));
      layer.fire('pm:markerdragend');
      await GISEdit._test.save();
      const entry = GISEditHistory.peekUndo()[0];
      expect(entry.type).toBe('geometry');
      expect(entry.before).toEqual(LINE_FEATURE.geometry);
      expect(entry.after.coordinates).toEqual([[35, 32], [35.02, 32]]);
    });
  });

  // ── 4) Failure cases ─────────────────────────────────────────────────────
  describe('failure cases', () => {
    it('invalid geometry (out of bounds) blocks the client-side save — updateGeometry never called, mode stays editing+dirty', async () => {
      const oob = { id: 'oob1', properties: { __id: 'oob1', __layer_id: 'L1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } };
      const { GISEdit, GIS } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(oob, 'L1');
      GISEdit._test.setDirty(true);
      await GISEdit._test.save();
      expect(GIS.features.updateGeometry).not.toHaveBeenCalled();
      expect(GISEdit._test.state().mode).toBe('editing');
      expect(GISEdit._test.state().dirty).toBe(true);
    });

    it('server "(invalid geometry)" error: stays editing, shows a toast, does not exit', async () => {
      const { GISEdit, GIS } = load({ role: 'engineer' });
      GIS.features.updateGeometry.mockRejectedValueOnce(new Error('[GIS] update geometry: גאומטריה לא תקינה (invalid geometry)'));
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      await GISEdit._test.save();
      expect(GISEdit._test.state().mode).toBe('editing');
      expect(GISEdit.isEditMode()).toBe(true);
    });

    it('server "(not found)" error: exits the feature back to armed (not stuck in editing)', async () => {
      const { GISEdit, GIS, gMap } = load({ role: 'engineer' });
      GIS.features.updateGeometry.mockRejectedValueOnce(new Error('[GIS] update geometry: הישות לא נמצאה (not found)'));
      const onceSpy = vi.spyOn(gMap, 'once');
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      await GISEdit._test.save();
      expect(GISEdit._test.state().mode).toBe('armed');
      expect(GISEdit._test.state().featureId).toBe(null);
      // re-armed a click listener for the next pick
      expect(onceSpy).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('network error: stays editing with dirty preserved (no data loss)', async () => {
      const { GISEdit, GIS } = load({ role: 'engineer' });
      GIS.features.updateGeometry.mockRejectedValueOnce(new Error('TypeError: Failed to fetch (network)'));
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      await GISEdit._test.save();
      expect(GISEdit._test.state().mode).toBe('editing');
      expect(GISEdit._test.state().dirty).toBe(true);
    });

    it('"(forbidden)" server rejection exits Edit Mode entirely (defence-in-depth even after client passed the gate)', async () => {
      const { GISEdit, GIS, gMap } = load({ role: 'engineer' });
      GIS.features.updateGeometry.mockRejectedValueOnce(new Error('[GIS] update geometry: אין הרשאה (permission denied)'));
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      await GISEdit._test.save();
      expect(GISEdit.isEditMode()).toBe(false);
      expect(gMap.getContainer().classList.contains('gis-edit-mode')).toBe(false);
    });

    it('conflict → overwrite: second confirm calls updateGeometry again WITHOUT expectedEditedAt', async () => {
      const { GISEdit, GIS, document } = load({ role: 'engineer' });
      GIS.features.updateGeometry.mockRejectedValueOnce(new Error('[GIS] update geometry: הישות עודכנה (conflict)'));
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      const savePromise = GISEdit._test.save();
      await tick2();
      // dialog #1: "⚠️ הישות עודכנה" — choose "דרוס בכל זאת" (2nd button, index 1)
      let overlay = document.body.children[document.body.children.length - 1];
      let dlg = overlay.children[0], foot = dlg.children[dlg.children.length - 1];
      foot.children[1].click();
      await tick2();
      // dialog #2: the "are you sure" confirm — click OK (1st button)
      overlay = document.body.children[document.body.children.length - 1];
      dlg = overlay.children[0]; foot = dlg.children[dlg.children.length - 1];
      foot.children[0].click();
      await savePromise;
      expect(GIS.features.updateGeometry).toHaveBeenCalledTimes(2);
      expect(GIS.features.updateGeometry.mock.calls[1][2]).toEqual({});
      expect(GISEdit._test.state().mode).toBe('armed');
    });

    it('conflict → reload: getFeatureById is called and editing is re-entered on the fresh feature', async () => {
      const { GISEdit, GIS, document } = load({ role: 'engineer' });
      const freshFeature = { ...LINE_FEATURE, geometry: { type: 'LineString', coordinates: [[35, 32], [35.05, 32]] } };
      GIS.features.updateGeometry.mockRejectedValueOnce(new Error('[GIS] update geometry: הישות עודכנה (conflict)'));
      GIS.features.getFeatureById.mockResolvedValueOnce(freshFeature);
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      const savePromise = GISEdit._test.save();
      await tick2();
      let overlay = document.body.children[document.body.children.length - 1];
      let dlg = overlay.children[0], foot = dlg.children[dlg.children.length - 1];
      foot.children[0].click(); // "טען מחדש וערוך שוב"
      await savePromise;
      await tick2();
      expect(GIS.features.getFeatureById).toHaveBeenCalledWith('f1');
      expect(GISEdit._test.state().mode).toBe('editing');
      expect(GISEdit._test.state().dirty).toBe(false); // freshly re-entered, not dirty
    });

    it('missing layer (activeLayers empty): a click toasts and re-arms, never crashes', async () => {
      const { GISEdit, gMap } = load({ role: 'engineer', activeLayers: [] });
      const onceSpy = vi.spyOn(gMap, 'once');
      await GISEdit.toggleEditMode(true);
      onceSpy.mockClear();
      gMap.fire('click', { latlng: { lng: 35, lat: 32 } });
      await tick2();
      expect(GISEdit._test.state().mode).toBe('armed'); // never entered editing
      expect(onceSpy).toHaveBeenCalledWith('click', expect.any(Function)); // re-armed
    });

    it('click with no nearby feature re-arms the one-shot click pick', async () => {
      const { GISEdit, gMap, GIS } = load({ role: 'engineer' });
      GIS.features.getInBBox.mockResolvedValueOnce({ type: 'FeatureCollection', features: [] });
      await GISEdit.toggleEditMode(true);
      const onceSpy = vi.spyOn(gMap, 'once');
      gMap.fire('click', { latlng: { lng: 35, lat: 32 } });
      await tick2();
      expect(GISEdit._test.state().mode).toBe('armed');
      expect(onceSpy).toHaveBeenCalledWith('click', expect.any(Function));
    });
  });

  // ── 5) Escape / dirty-confirm semantics ─────────────────────────────────
  describe('Escape / confirm dialogs', () => {
    it('Escape while dirty opens a confirm dialog rather than silently disarming', async () => {
      const { GISEdit, document } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      const handled = GISEdit._test.onEscape();
      expect(handled).toBe(true);
      await tick();
      expect(GISEdit._test.state().mode).toBe('editing'); // still editing — a dialog is up, not disarmed
      const overlay = document.body.children[document.body.children.length - 1];
      expect(overlay.className).toBe('gis-anly-bg');
    });

    it('Escape while clean (not dirty) disarms immediately, no dialog', async () => {
      const { GISEdit, document } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      const dialogsBefore = document.body.children.filter((c) => c.className === 'gis-anly-bg').length;
      expect(dialogsBefore).toBe(0);
      const handled = GISEdit._test.onEscape();
      expect(handled).toBe(true);
      await tick();
      expect(GISEdit._test.state().mode).toBe('armed');
      // no confirm-dialog overlay was ever appended (this fixture's document
      // stub never truly removes elements — remove() is a no-op mirroring
      // edit-mode.test.js's same stub — so we assert on the ABSENCE of a new
      // dialog overlay rather than on the raw body child count, which the
      // banner()/renderEditBanner() re-render churns regardless).
      const dialogsAfter = document.body.children.filter((c) => c.className === 'gis-anly-bg').length;
      expect(dialogsAfter).toBe(0);
    });

    it('toggling Edit Mode off (GISEdit.toggleEditMode()) while dirty prompts a confirm, does NOT silently discard', async () => {
      const { GISEdit, GIS, document } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      const togglePromise = GISEdit.toggleEditMode(); // no arg → toggles off (mode !== 'off')
      await tick2();
      // still on, still editing — the confirm dialog is up, nothing discarded
      expect(GISEdit.isEditMode()).toBe(true);
      expect(GISEdit._test.state().mode).toBe('editing');
      const overlay = document.body.children[document.body.children.length - 1];
      expect(overlay.className).toBe('gis-anly-bg');
      // dismiss via the dialog's X (declines the confirm) — Edit Mode must stay ON
      const dlg = overlay.children[0];
      const head = dlg.children[0];
      const xBtn = head.children[head.children.length - 1];
      xBtn.click();
      const stillOn = await togglePromise;
      expect(stillOn).toBe(true);
      expect(GISEdit.isEditMode()).toBe(true);
      expect(GIS.features.updateGeometry).not.toHaveBeenCalled();
    });

    it('toggling Edit Mode off while dirty, confirmed: discards the edit and turns Edit Mode fully off', async () => {
      const { GISEdit, document } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      const togglePromise = GISEdit.toggleEditMode();
      await tick2();
      const overlay = document.body.children[document.body.children.length - 1];
      const dlg = overlay.children[0];
      const foot = dlg.children[dlg.children.length - 1];
      foot.children[0].click(); // "בטל שינויים" — confirm the discard
      const nowOn = await togglePromise;
      expect(nowOn).toBe(false);
      expect(GISEdit.isEditMode()).toBe(false);
    });
  });

  // ── 6) Listener / DOM leak hygiene on disarm ─────────────────────────────
  describe('disarm() cleanliness', () => {
    it('disarm() on a CLEAN edit tears down synchronously: ALL layer handlers, the beforeunload listener, the map class, and the HUD', async () => {
      const { GISEdit, gMap, document } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      const layer = GISEdit._test.state().editLayer;
      expect(layer._listenerCount()).toBeGreaterThan(0);

      GISEdit.disarm();   // nothing unsaved → no dialog, immediate hard reset

      expect(layer._listenerCount()).toBe(0); // every pm:* handler this module wired was .off()'d
      expect(gMap.getContainer().classList.contains('gis-edit-mode')).toBe(false);
      expect(GISEdit._test.hud()).toBe(null);
      expect(GISEdit.isEditMode()).toBe(false);
      expect(document.body.children.filter((c) => c.className === 'gis-anly-bg').length).toBe(0);
    });

    it('disarm() on a DIRTY edit asks first (data safety) and only tears down after the user confirms — then nothing leaks', async () => {
      const { GISEdit, gMap, document, addEventListener, removeEventListener } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      const layer = GISEdit._test.state().editLayer;
      layer.fire('pm:vertexadded'); // dirty → installs beforeunload
      expect(GISEdit._test.state().dirty).toBe(true);
      expect(addEventListener.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(true);

      GISEdit.disarm();   // ribbon "clear" while dirty
      await tick();
      // still editing — a confirm dialog is up, nothing discarded yet
      expect(GISEdit.isEditMode()).toBe(true);
      expect(GISEdit._test.state().mode).toBe('editing');
      expect(layer._listenerCount()).toBeGreaterThan(0);
      const overlay = document.body.children[document.body.children.length - 1];
      expect(overlay.className).toBe('gis-anly-bg');

      // confirm "בטל שינויים" (first .gad-ok in the footer) → full teardown
      const dlg = overlay.children[0];
      const foot = dlg.children[dlg.children.length - 1];
      foot.children[0].click();
      await tick2();

      expect(layer._listenerCount()).toBe(0);
      expect(gMap.getContainer().classList.contains('gis-edit-mode')).toBe(false);
      expect(GISEdit._test.hud()).toBe(null);
      expect(GISEdit.isEditMode()).toBe(false);
      expect(removeEventListener.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(true);
    });

    it('entering Edit Mode twice in a row does not double-arm (single click listener, idempotent)', async () => {
      const { GISEdit, gMap } = load({ role: 'engineer' });
      await GISEdit.toggleEditMode(true);
      const onceSpy = vi.spyOn(gMap, 'once');
      const on2 = await GISEdit.toggleEditMode(true); // already on — no-op true
      expect(on2).toBe(true);
      expect(onceSpy).not.toHaveBeenCalled(); // did NOT re-arm a second click listener
    });

    it('GISEdit.clear() (== disarm, the traceClearAll-style hard reset) tears down a clean in-progress edit completely', async () => {
      const { GISEdit, gMap } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit.clear();
      expect(GISEdit.isEditMode()).toBe(false);
      expect(GISEdit._test.state().dirty).toBe(false);
      expect(GISEdit._test.state().featureId).toBe(null);
      expect(gMap.getContainer().classList.contains('gis-edit-mode')).toBe(false);
    });

    it('GISEdit.clear() while DIRTY keeps the edit until the user declines/confirms (dismissing the dialog keeps editing)', async () => {
      const { GISEdit, gMap, document } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      GISEdit.clear();
      await tick();
      expect(GISEdit.isEditMode()).toBe(true);
      const overlay = document.body.children[document.body.children.length - 1];
      expect(overlay.className).toBe('gis-anly-bg');
      // dismiss via X → declined → still editing, still dirty
      const dlg = overlay.children[0];
      const head = dlg.children[0];
      head.children[head.children.length - 1].click();
      await tick2();
      expect(GISEdit.isEditMode()).toBe(true);
      expect(GISEdit._test.state().mode).toBe('editing');
      expect(GISEdit._test.state().dirty).toBe(true);
      expect(gMap.getContainer().classList.contains('gis-edit-mode')).toBe(true);
    });
  });

  // ── 9) Orchestrator review fixes — regression guards ─────────────────────
  describe('review fixes: Geoman options, save atomicity, dialog re-entrancy, tool gating', () => {
    it('vertices sub-mode enables Geoman with draggable:false and WITHOUT limitMarkersToCount (a display cap, not a min-vertex guard)', async () => {
      const { GISEdit } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      const layer = GISEdit._test.state().editLayer;
      expect(layer.pm.enable).toHaveBeenCalled();
      const opts = layer.pm.enable.mock.calls[layer.pm.enable.mock.calls.length - 1][0];
      expect(opts.draggable).toBe(false);
      expect(opts).not.toHaveProperty('limitMarkersToCount');
      expect(typeof opts.removeVertexValidation).toBe('function');
      expect(opts.removeVertexOn).toBe('contextmenu');
      // the validation guard refuses a removal that would drop a line below 2 points
      expect(opts.removeVertexValidation({ layer: { getLatLngs: () => [{}, {}] } })).toBe(false);
      expect(opts.removeVertexValidation({ layer: { getLatLngs: () => [{}, {}, {}] } })).toBe(true);
    });

    it('extend rebuilds the layer with the SAME vertex options (draggable:false, no limitMarkersToCount)', async () => {
      const { GISEdit, gMap } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      const layer = GISEdit._test.state().editLayer;
      clickSub(GISEdit, 'extend');
      layer.pm.enable.mockClear();
      gMap.fire('click', { latlng: { lng: 35.02, lat: 32 } });
      const opts = layer.pm.enable.mock.calls[layer.pm.enable.mock.calls.length - 1][0];
      expect(opts.draggable).toBe(false);
      expect(opts).not.toHaveProperty('limitMarkersToCount');
    });

    it('Cancel / Escape / feature-switch are refused while a save is in flight; the save then completes with the right ids', async () => {
      const { GISEdit, GIS, GISEditHistory, document, GISEngineSidebar } = load({ role: 'engineer' });
      let resolveSave;
      GIS.features.updateGeometry.mockImplementation(() => new Promise((r) => { resolveSave = r; }));
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      const savePromise = GISEdit._test.save();
      await tick();
      expect(GISEdit._test.state().mode).toBe('saving');
      expect(GISEdit._test.hud().cancelBtn.disabled).toBe(true);
      expect(GISEdit._test.hud().saveBtn.textContent).toBe('שומר…');

      await GISEdit._test.cancel();                       // refused
      expect(GISEdit._test.onEscape()).toBe(true);        // swallowed
      const switched = await GISEdit.beginEditFeature(POINT_FEATURE, 'L3');
      expect(switched).toBe(false);                       // refused
      expect(GISEdit._test.state().mode).toBe('saving');
      expect(document.body.children.filter((c) => c.className === 'gis-anly-bg').length).toBe(0);

      resolveSave({ id: 'f1', layer_id: 'L1' });
      await savePromise;
      expect(GISEdit._test.state().mode).toBe('armed');
      const entry = GISEditHistory.peekUndo()[0];
      expect(entry.id).toBe('f1');
      expect(entry.layerId).toBe('L1');
      expect(entry.before).toEqual(LINE_FEATURE.geometry);
      expect(GISEngineSidebar.reload).toHaveBeenCalledWith('L1');
    });

    it('a hard disarm while a save is in flight is refused; the late continuation never pushes a null-id history entry', async () => {
      const { GISEdit, GIS, GISEditHistory } = load({ role: 'engineer' });
      let resolveSave;
      GIS.features.updateGeometry.mockImplementation(() => new Promise((r) => { resolveSave = r; }));
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      const savePromise = GISEdit._test.save();
      await tick();
      GISEdit.disarm();                                    // ribbon "clear" mid-flight → refused
      expect(GISEdit._test.state().mode).toBe('saving');
      resolveSave({ id: 'f1', layer_id: 'L1' });
      await savePromise;
      expect(GISEditHistory.peekUndo().every((e) => e.id === 'f1' && e.layerId === 'L1')).toBe(true);
      expect(GISEdit._test.state().mode).toBe('armed');
    });

    it('pressing Escape twice while dirty opens exactly ONE confirm dialog', async () => {
      const { GISEdit, document } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      GISEdit._test.onEscape();
      GISEdit._test.onEscape();
      await tick2();
      expect(document.body.children.filter((c) => c.className === 'gis-anly-bg').length).toBe(1);
      expect(GISEdit._test.state().mode).toBe('editing');
    });

    it('starting the legacy "add" tool while dirty asks first and leaves the edit intact when declined', async () => {
      const { GISEdit, document, GIS } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      GISEdit._test.setDirty(true);
      const layerCallsBefore = GIS.layers.getLayers.mock.calls.length;   // (snap guide already listed layers)
      const p = GISEdit.startAdd();
      await tick();
      const overlay = document.body.children[document.body.children.length - 1];
      expect(overlay.className).toBe('gis-anly-bg');
      const dlg = overlay.children[0];
      const head = dlg.children[0];
      head.children[head.children.length - 1].click();     // X → decline
      await p;
      expect(GISEdit.isEditMode()).toBe(true);
      expect(GISEdit._test.state().dirty).toBe(true);
      expect(GIS.layers.getLayers.mock.calls.length).toBe(layerCallsBefore); // category picker never opened
    });

    it('a pick whose fetch resolves after Edit Mode was turned off does not re-enter editing', async () => {
      const { GISEdit, GIS, gMap } = load({ role: 'engineer' });
      let resolveFetch;
      GIS.features.getInBBox.mockImplementation(() => new Promise((r) => { resolveFetch = r; }));
      await GISEdit.toggleEditMode(true);
      gMap.fire('click', { latlng: { lng: 35, lat: 32 } });
      await tick();
      await GISEdit.toggleEditMode(false);
      resolveFetch({ type: 'FeatureCollection', features: [LINE_FEATURE] });
      await tick2();
      expect(GISEdit.isEditMode()).toBe(false);
      expect(GIS.features.getEditToken).not.toHaveBeenCalled();
    });

    it('REGRESSION: switching vertices → move actually enables Geoman layer drag (draggable was left false by vertex mode)', async () => {
      const { GISEdit } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');          // starts in 'vertices' → draggable:false stored on pm
      const layer = GISEdit._test.state().editLayer;
      expect(layer.pm.options.draggable).toBe(false);
      expect(layer.pm.layerDragEnabled()).toBe(false);
      clickSub(GISEdit, 'move');
      expect(layer.pm.layerDragEnabled()).toBe(true);               // would be false without setOptions({draggable:true})
      expect(layer.pm.setOptions).toHaveBeenCalledWith({ draggable: true });
      clickSub(GISEdit, 'vertices');
      expect(layer.pm.layerDragEnabled()).toBe(false);              // drag torn down, body drag impossible again
      expect(layer.pm.options.draggable).toBe(false);
    });

    it('REGRESSION: vertex handles get their own pane ABOVE the edit copy, configured before Geoman edit is enabled', async () => {
      const { GISEdit, gMap } = load({ role: 'engineer' });
      await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
      const top = gMap.getPane('gisEditTop');
      const vertex = gMap.getPane('gisEditVertex');
      expect(top).toBeTruthy();
      expect(vertex).toBeTruthy();
      expect(Number(vertex.style.zIndex)).toBeGreaterThan(Number(top.style.zIndex));
      // Geoman is told to draw its vertex/midpoint markers in that pane…
      const panesCall = gMap.pm.setGlobalOptions.mock.calls.find((c) => c[0] && c[0].panes);
      expect(panesCall).toBeTruthy();
      expect(panesCall[0].panes.vertexPane).toBe('gisEditVertex');
      expect(panesCall[0].panes.layerPane).toBe('overlayPane');
      expect(panesCall[0].panes.markerPane).toBe('markerPane');
      // …BEFORE the layer's edit mode is enabled (the markers are created on enable)
      const layer = GISEdit._test.state().editLayer;
      const panesOrder = gMap.pm.setGlobalOptions.mock.invocationCallOrder[
        gMap.pm.setGlobalOptions.mock.calls.indexOf(panesCall)];
      expect(panesOrder).toBeLessThan(layer.pm.enable.mock.invocationCallOrder[0]);
    });

    it('click-to-select uses the sidebar\'s LOCAL hit-test first: no bbox query, geometry comes fresh from getEditToken', async () => {
      const { GISEdit, GIS, GISEngineSidebar, gMap } = load({ role: 'engineer' });
      GISEngineSidebar.hitTest = vi.fn(() => ({
        d: 3, slim: true, layer: { id: 'L1' },
        f: { type: 'Feature', id: 'f1', geometry: null, properties: { __id: 'f1', __layer_id: 'L1', asset_code: 'PIPE-1' } },
      }));
      GIS.features.getEditToken.mockImplementation(async (id) => ({
        id, layer_id: 'L1', edited_at: '2026-09-14T06:00:00+00:00',
        geometry: { type: 'LineString', coordinates: [[35.1, 32.1], [35.11, 32.1]] },
      }));
      await GISEdit.toggleEditMode(true);
      gMap.fire('click', { latlng: { lng: 35.1, lat: 32.1 } });
      await tick2(); await tick2();
      expect(GISEngineSidebar.hitTest).toHaveBeenCalled();
      expect(GIS.features.getInBBox).not.toHaveBeenCalled();          // no per-click DB search
      expect(GISEdit._test.state().mode).toBe('editing');
      expect(GISEdit._test.state().featureId).toBe('f1');
      expect(GISEdit._test.state().editToken).toBe('2026-09-14T06:00:00+00:00');
      // the fresh server geometry is the editing baseline, not the (absent) tile geometry
      expect(GISEdit._test.state().before).toEqual({ type: 'LineString', coordinates: [[35.1, 32.1], [35.11, 32.1]] });
    });

    it('click-to-select falls back to the bbox query when the local hit-test finds nothing', async () => {
      const { GISEdit, GIS, GISEngineSidebar, gMap } = load({ role: 'engineer' });
      GISEngineSidebar.hitTest = vi.fn(() => null);
      GIS.features.getInBBox.mockImplementation(async () => ({ type: 'FeatureCollection', features: [LINE_FEATURE] }));
      await GISEdit.toggleEditMode(true);
      gMap.fire('click', { latlng: { lng: 35, lat: 32 } });
      await tick2(); await tick2();
      expect(GIS.features.getInBBox).toHaveBeenCalled();
      expect(GISEdit._test.state().mode).toBe('editing');
    });

    it('the map-click pick is armed at most once (miss → re-arm keeps a single listener)', async () => {
      const { GISEdit, gMap } = load({ role: 'engineer' });
      await GISEdit.toggleEditMode(true);
      expect(gMap._listenerCount('click')).toBe(1);
      GISEdit._test.armPickActive();                       // second arm request → ignored
      expect(gMap._listenerCount('click')).toBe(1);
      gMap.fire('click', { latlng: { lng: 35, lat: 32 } }); // miss (no features) → re-arm
      await tick2();
      expect(gMap._listenerCount('click')).toBe(1);
    });
  });
});
