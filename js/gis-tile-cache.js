// ════════════════════════════════════════════════════════════════════════
//  מי הגליל GIS — Tile Cache (IndexedDB)   →   window.GISTileCache
//
//  Persists fetched tile GeoJSON across sessions/reloads so revisiting an
//  area is instant (no network round-trip). Keyed by "<layerId>/<z>/<x>/<y>".
//  The in-memory tile cache (gis-tile-loader.js) still does per-session dedup;
//  this is the durable second tier behind it.
//
//  • TTL: entries older than TTL are treated as a miss (covers edits by other
//    users without explicit invalidation).
//  • Invalidation: clearPrefix("<layerId>/") drops a layer's tiles after a
//    local edit / recolour (the loader calls it via onInvalidate).
//  • Bounded: prunes the oldest entries once the store grows past MAX.
//
//  All operations fail soft → null/no-op (private-mode, quota, no IDB), so the
//  loader transparently falls back to network-only.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var DB = 'mgis-tiles', STORE = 'tiles', VER = 1;
  var TTL = 60 * 60 * 1000;   // 1 hour
  var MAX = 4000;             // max cached tiles before pruning oldest
  var PRUNE_EVERY = 200;      // check the cap once per N writes

  var dbp = null;
  function openDB() {
    if (dbp) return dbp;
    if (typeof indexedDB === 'undefined') { dbp = Promise.resolve(null); return dbp; }
    dbp = new Promise(function (res) {
      var r;
      try { r = indexedDB.open(DB, VER); } catch (e) { return res(null); }
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'key' });
          os.createIndex('ts', 'ts');
        }
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { res(null); };
    }).catch(function () { return null; });
    return dbp;
  }
  function store(mode) {
    return openDB().then(function (db) {
      if (!db) return null;
      try { return db.transaction(STORE, mode).objectStore(STORE); }
      catch (e) { return null; }
    });
  }

  var writes = 0;
  function maybePrune(os) {
    if (++writes < PRUNE_EVERY) return;
    writes = 0;
    var cReq = os.count();
    cReq.onsuccess = function () {
      var over = cReq.result - MAX;
      if (over <= 0) return;
      var cur = os.index('ts').openCursor(); // oldest first
      cur.onsuccess = function () {
        var c = cur.result;
        if (!c || over <= 0) return;
        c.delete(); over--; c.continue();
      };
    };
  }

  window.GISTileCache = {
    enabled: (typeof indexedDB !== 'undefined'),

    // → Promise<FeatureCollection | null>  (null = miss / expired / unavailable)
    get: function (key) {
      return store('readonly').then(function (os) {
        if (!os) return null;
        return new Promise(function (res) {
          var r = os.get(key);
          r.onsuccess = function () {
            var v = r.result;
            if (!v || (Date.now() - v.ts) > TTL) return res(null);
            res(v.fc);
          };
          r.onerror = function () { res(null); };
        });
      }).catch(function () { return null; });
    },

    set: function (key, fc) {
      return store('readwrite').then(function (os) {
        if (!os) return;
        try { os.put({ key: key, ts: Date.now(), fc: fc }); maybePrune(os); } catch (e) {}
      }).catch(function () {});
    },

    // Drop every tile whose key starts with prefix (e.g. "<layerId>/").
    clearPrefix: function (prefix) {
      return store('readwrite').then(function (os) {
        if (!os) return;
        return new Promise(function (res) {
          var r = os.openCursor();
          r.onsuccess = function () {
            var c = r.result;
            if (!c) return res();
            if (String(c.key).indexOf(prefix) === 0) c.delete();
            c.continue();
          };
          r.onerror = function () { res(); };
        });
      }).catch(function () {});
    },

    clearAll: function () {
      return store('readwrite').then(function (os) { if (os) try { os.clear(); } catch (e) {} }).catch(function () {});
    }
  };
})();
