// Loads the project's browser-global scripts (no build step, no modules) into
// a Node vm context so Vitest can unit-test them. Top-level `var`/`function`
// declarations become properties of the returned context object.
//
// Usage:
//   import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
//   const ctx = loadBrowserGlobals(['js/export-formats.js'], { XLSX: fakeXlsx });
//   ctx.buildCSV(features, ...)
//
// Paths are resolved from the repo root. Pass extra globals (stubs for CDN
// libs like proj4/XLSX/JSZip, or a richer document) via the second argument.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
  };
}

function stubElement(tag) {
  const el = {
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
  return el;
}

function stubDocument() {
  const doc = {
    createElement: (t) => stubElement(t),
    createTextNode: (t) => ({ textContent: String(t) }),
    createDocumentFragment: () => stubElement('fragment'),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    body: stubElement('body'),
    head: stubElement('head'),
    documentElement: stubElement('html'),
  };
  return doc;
}

export function loadBrowserGlobals(files, extra = {}) {
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, URL, URLSearchParams, TextEncoder, TextDecoder,
    Blob: globalThis.Blob, FileReader: globalThis.FileReader,
    fetch: extra.fetch || (async () => { throw new Error('fetch not stubbed — pass one via extras'); }),
    structuredClone: globalThis.structuredClone,
    JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean,
    Uint8Array, Int8Array, Uint16Array, Int32Array, Float32Array, Float64Array,
    ArrayBuffer, DataView, Map, Set, WeakMap, Symbol, Error, TypeError, RangeError,
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    atob: globalThis.atob, btoa: globalThis.btoa,
    navigator: { userAgent: 'vitest', language: 'he-IL' },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    ...extra,
  };
  sandbox.document = extra.document || stubDocument();
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of [].concat(files)) {
    const code = readFileSync(resolve(REPO_ROOT, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  return ctx;
}
