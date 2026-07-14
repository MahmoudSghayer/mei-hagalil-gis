// A document stub sufficient to load js/export-feature.js's top-level UI wiring
// (style injection + injectUI()) without throwing or leaving a dangling retry
// timer, for tests that need BOTH export-formats.js and export-feature.js loaded
// together (e.g. to exercise exportShapefile/exportExcel end-to-end via
// window.__exportTestHooks). See test/export/shapefile.test.js and excel.test.js.
//
// Two things the default stub in test/helpers/load-browser-global.mjs doesn't
// provide, which export-feature.js needs:
//   1. getElementById('map-wrap') must return a truthy element — injectUI()
//      retries forever via setTimeout(injectUI, 200) otherwise, which never
//      resolves in a vm context and hangs the test process.
//   2. <script> elements must "load" — loadScript() awaits `sc.onload`, which
//      only fires once `.src` is set on a real <script> tag in a real DOM.

function makeElement(tag) {
  var el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], childNodes: [], style: {}, dataset: {}, attributes: {},
    className: '', id: '', innerHTML: '', textContent: '', value: '',
    setAttribute: function (k, v) { this.attributes[k] = String(v); },
    getAttribute: function (k) { return (k in this.attributes) ? this.attributes[k] : null; },
    removeAttribute: function (k) { delete this.attributes[k]; },
    appendChild: function (c) { this.children.push(c); this.childNodes.push(c); return c; },
    removeChild: function (c) { this.children = this.children.filter(function (x) { return x !== c; }); return c; },
    insertBefore: function (c) { this.children.unshift(c); return c; },
    addEventListener: function () {}, removeEventListener: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    getElementsByTagName: function () { return []; },
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    click: function () {}, focus: function () {}, blur: function () {}, remove: function () {},
    getBoundingClientRect: function () { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  if (tag === 'script') {
    // loadScript() in export-feature.js does `sc.src = url; sc.onload = ...`.
    // Simulate the network round-trip resolving on the next tick once `.src`
    // is set, so the awaited Promise in loadScript() actually settles.
    var _src = '';
    Object.defineProperty(el, 'src', {
      get: function () { return _src; },
      set: function (v) { _src = v; setTimeout(function () { if (el.onload) el.onload(); }, 0); },
    });
  }
  return el;
}

export function makeAppDocument() {
  var mapWrap = makeElement('div');
  mapWrap.id = 'map-wrap';
  return {
    createElement: makeElement,
    createTextNode: function (t) { return { textContent: String(t) }; },
    createDocumentFragment: function () { return makeElement('fragment'); },
    getElementById: function (id) { return id === 'map-wrap' ? mapWrap : null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {}, removeEventListener: function () {},
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
    readyState: 'complete',
  };
}
