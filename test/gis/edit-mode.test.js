// Unit tests for the sticky Edit Mode state machine added to js/gis-edit.js
// (window.GISEdit.toggleEditMode/isEditMode/beginEditFeature + the internal
// emState machine exposed for tests only via GISEdit._test).
//
// Loads js/gis-edit-geom.js + js/gis-edit.js into one Node vm context (no
// build step) with hand-rolled fakes for L (Leaflet), gMap, GIS and
// GISEngineSidebar — just enough Leaflet-Geoman-ish surface (on/off/once/
// fire event emitters, pm{enable,disable,enableLayerDrag,disableLayerDrag},
// setLatLngs/getLatLngs/toGeoJSON, a real Set-backed classList on the map
// container) to drive the module exactly the way the real browser would,
// without pulling in Leaflet itself. See the plan's "Tests" section for the
// scenario list this suite covers.
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  };
  return em;
}

// ── minimal DOM element: real Set-backed classList kept in sync with
//    .className (both getter/setter over the same Set), plain style object.
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
// coordsToLatLngs / latlngs<->coords conversion is generic (detects a leaf by
// the presence of .lat), so it works for any nesting depth without needing
// the `levelsDeep` argument gis-edit.js passes (mirrors real Leaflet's
// contract closely enough for these tests).
function coordToLatLng(c) { return { lat: c[1], lng: c[0] }; }
function coordsToLatLngsDeep(coords) {
  if (typeof coords[0] === 'number') return coordToLatLng(coords);
  return coords.map(coordsToLatLngsDeep);
}
function latLngsToCoordsDeep(ll) {
  if (Array.isArray(ll)) return ll.map(latLngsToCoordsDeep);
  return [ll.lng, ll.lat];
}

function makePm(target) {
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
  layer.pm = makePm(layer);
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
  layer.pm = makePm(layer);
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
  const ctx = loadBrowserGlobals(['js/gis-edit-geom.js', 'js/gis-edit.js'], { L, gMap, GIS, GISEngineSidebar, document });
  return { ctx, L, gMap, GIS, GISEngineSidebar, document, GISEdit: ctx.GISEdit, GISEditHistory: ctx.GISEditHistory };
}

const LINE_FEATURE = {
  id: 'f1',
  properties: { __id: 'f1', __layer_id: 'L1' },
  geometry: { type: 'LineString', coordinates: [[35, 32], [35.01, 32]] },
};
const MULTIPOINT_FEATURE = {
  id: 'mp1',
  properties: { __id: 'mp1', __layer_id: 'L1' },
  geometry: { type: 'MultiPoint', coordinates: [[35, 32], [35.1, 32.1], [35.2, 32.2]] },
};

describe('GISEdit sticky Edit Mode (js/gis-edit.js)', () => {
  it('viewer: toggleEditMode(true) resolves false, no class added, no click armed', async () => {
    const { GISEdit, gMap } = load({ role: 'viewer' });
    const onceSpy = vi.spyOn(gMap, 'once');
    const on = await GISEdit.toggleEditMode(true);
    expect(on).toBe(false);
    expect(gMap.getContainer().classList.contains('gis-edit-mode')).toBe(false);
    expect(onceSpy).not.toHaveBeenCalled();
    expect(GISEdit.isEditMode()).toBe(false);
  });

  it('engineer: toggleEditMode(true) arms — adds the outline class and arms a one-shot click pick', async () => {
    const { GISEdit, gMap } = load({ role: 'engineer' });
    const onceSpy = vi.spyOn(gMap, 'once');
    const on = await GISEdit.toggleEditMode(true);
    expect(on).toBe(true);
    expect(GISEdit.isEditMode()).toBe(true);
    expect(gMap.getContainer().classList.contains('gis-edit-mode')).toBe(true);
    expect(onceSpy).toHaveBeenCalledWith('click', expect.any(Function));
    expect(GISEdit._test.state().mode).toBe('armed');
  });

  it('a simulated map click picks the nearest feature on an active layer and enters editing', async () => {
    const { GISEdit, gMap, GIS } = load({ role: 'engineer' });
    GIS.features.getInBBox.mockResolvedValueOnce({ type: 'FeatureCollection', features: [LINE_FEATURE] });
    await GISEdit.toggleEditMode(true);
    gMap.fire('click', { latlng: { lng: 35.005, lat: 32 } });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const st = GISEdit._test.state();
    expect(st.mode).toBe('editing');
    expect(st.featureId).toBe('f1');
    expect(GIS.features.getEditToken).toHaveBeenCalledWith('f1');
  });

  it('beginEditFeature enters editing directly, without any click', async () => {
    const { GISEdit } = load({ role: 'engineer' });
    const ok = await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
    expect(ok).toBe(true);
    const st = GISEdit._test.state();
    expect(st.mode).toBe('editing');
    expect(st.featureId).toBe('f1');
    expect(st.layerId).toBe('L1');
    expect(st.originalType).toBe('LineString');
    expect(st.dirty).toBe(false);
  });

  it('pm:vertexadded on the edit layer sets dirty and enables Save', async () => {
    const { GISEdit } = load({ role: 'engineer' });
    await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
    // A LineString's editLayer IS the single Polyline itself (buildEditLayer
    // unwraps L.geoJSON()'s single-child wrapper — see js/gis-edit.js).
    const layer = GISEdit._test.state().editLayer;
    expect(GISEdit._test.hud().saveBtn.disabled).toBe(true);
    layer.fire('pm:vertexadded');
    expect(GISEdit._test.state().dirty).toBe(true);
    expect(GISEdit._test.hud().saveBtn.disabled).toBe(false);
  });

  it('save() calls updateGeometry with {expectedEditedAt}, pushes history, and returns to armed', async () => {
    const { GISEdit, GIS, GISEditHistory } = load({ role: 'engineer' });
    await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
    GISEdit._test.setDirty(true);
    await GISEdit._test.save();
    expect(GIS.features.updateGeometry).toHaveBeenCalledTimes(1);
    const call = GIS.features.updateGeometry.mock.calls[0];
    expect(call[0]).toBe('f1');
    expect(call[2]).toEqual({ expectedEditedAt: '2026-01-01T00:00:00Z' });
    expect(GISEditHistory.size().undo).toBe(1);
    expect(GISEdit._test.state().mode).toBe('armed');
    expect(GISEdit._test.state().dirty).toBe(false);
  });

  it('a conflict error opens the conflict dialog (a .gis-anly-bg overlay appended to document.body)', async () => {
    const { GISEdit, GIS, document } = load({ role: 'engineer' });
    GIS.features.updateGeometry.mockRejectedValueOnce(new Error('[GIS] update geometry: הישות עודכנה על ידי משתמש אחר בינתיים (conflict)'));
    await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
    GISEdit._test.setDirty(true);
    const savePromise = GISEdit._test.save();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const overlay = document.body.children.find((c) => c.className === 'gis-anly-bg');
    expect(overlay).toBeTruthy();
    // close it (X button) so the pending save() promise resolves and the test can finish cleanly
    const dlg = overlay.children[0];
    const head = dlg.children[0];
    const xBtn = head.children[head.children.length - 1];
    xBtn.click();
    await savePromise;
  });

  it('cancel() while dirty opens a confirm dialog and does NOT call updateGeometry until confirmed', async () => {
    const { GISEdit, GIS, document } = load({ role: 'engineer' });
    await GISEdit.beginEditFeature(LINE_FEATURE, 'L1');
    GISEdit._test.setDirty(true);
    const cancelPromise = GISEdit._test.cancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(GIS.features.updateGeometry).not.toHaveBeenCalled();
    expect(GISEdit._test.state().mode).toBe('editing');   // still editing — dialog is up
    const overlay = document.body.children[document.body.children.length - 1];
    expect(overlay.className).toBe('gis-anly-bg');
    // click the "בטל שינויים" (confirm) button — first .gad-ok in the footer
    const dlg = overlay.children[0];
    const foot = dlg.children[dlg.children.length - 1];
    foot.children[0].click();
    await cancelPromise;
    expect(GISEdit._test.state().mode).toBe('armed');
    expect(GIS.features.updateGeometry).not.toHaveBeenCalled();
  });

  it('Escape while armed turns Edit Mode off', async () => {
    const { GISEdit, gMap } = load({ role: 'engineer' });
    await GISEdit.toggleEditMode(true);
    expect(GISEdit.isEditMode()).toBe(true);
    const handled = GISEdit._test.onEscape();
    expect(handled).toBe(true);
    expect(GISEdit.isEditMode()).toBe(false);
    expect(gMap.getContainer().classList.contains('gis-edit-mode')).toBe(false);
  });

  it('MultiPoint feature: save() produces ALL points via fromEditable (the historical drop-all-but-first bug)', async () => {
    const { GISEdit, GIS } = load({ role: 'engineer', activeLayers: [{ id: 'L1', geometry_type: 'Point' }] });
    await GISEdit.beginEditFeature(MULTIPOINT_FEATURE, 'L1');
    expect(GISEdit._test.state().editLayer.getLayers().length).toBe(3);
    GISEdit._test.setDirty(true);
    await GISEdit._test.save();
    const geomSaved = GIS.features.updateGeometry.mock.calls[0][1];
    expect(geomSaved.type).toBe('MultiPoint');
    expect(geomSaved.coordinates).toEqual([[35, 32], [35.1, 32.1], [35.2, 32.2]]);
  });

  it('validate() failure blocks save — updateGeometry is never called', async () => {
    const { GISEdit, GIS } = load({ role: 'engineer' });
    const outOfBounds = { id: 'f2', properties: { __id: 'f2', __layer_id: 'L1' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } };
    await GISEdit.beginEditFeature(outOfBounds, 'L1');
    GISEdit._test.setDirty(true);
    await GISEdit._test.save();
    expect(GIS.features.updateGeometry).not.toHaveBeenCalled();
    // still editing, dirty, so the user can fix it
    expect(GISEdit._test.state().mode).toBe('editing');
    expect(GISEdit._test.state().dirty).toBe(true);
  });
});
