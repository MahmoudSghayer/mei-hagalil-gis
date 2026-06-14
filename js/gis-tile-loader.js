// ════════════════════════════════════════════════════════════════════════
//  מי הגליל GIS — Tile Loader   →   window.GISTileLoader
//
//  A drop-in viewport loader that makes panning/zooming feel instant.
//  Replaces the old "fetch the whole viewport + removeLayer + re-add" path
//  (which flashed blank on every moveend) with:
//
//    • Tile cache manager   — the viewport is cut into slippy (XYZ) tiles;
//                             a tile is fetched once, then reused. Pans only
//                             fetch the few NEW edge tiles.
//    • Feature cache manager — each feature is added to the map exactly once
//                             and ref-counted across the tiles that share it
//                             (a pipe spanning 3 tiles is drawn once). Evicting
//                             a tile only removes features no live tile needs.
//    • Request queue         — concurrency-limited, deduped (a tile already
//                             in-flight or cached is never re-requested),
//                             visible tiles before prefetch tiles.
//    • AbortController        — when the user moves on, in-flight requests for
//                             tiles that left the desired area are aborted.
//    • Background prefetch    — a ring of tiles around the viewport is fetched
//                             at low priority so the next pan is already there.
//
//  Features ALREADY on the map are never cleared on refresh — new tiles are
//  added incrementally, so previously loaded areas stay visible the whole time.
//
//  Self-contained: no dependency on the sidebar internals. The caller supplies
//  how to fetch a bbox, how to build a feature's Leaflet layer, and how to key
//  a feature (for dedup). One controller per active engine layer.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ── Slippy-tile math (Web Mercator XYZ), same scheme Leaflet tiles use ──
  var POW = function (z) { return Math.pow(2, z); };
  function lng2x(lng, z) { return Math.floor((lng + 180) / 360 * POW(z)); }
  function lat2y(lat, z) {
    var r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * POW(z));
  }
  function x2lng(x, z) { return x / POW(z) * 360 - 180; }
  function y2lat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / POW(z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  function tileBBox(x, y, z) {
    return { minLng: x2lng(x, z), maxLng: x2lng(x + 1, z),
             maxLat: y2lat(y, z), minLat: y2lat(y + 1, z) };
  }

  // ──────────────────────────────────────────────────────────────────────
  //  create(opts) → controller { update, invalidate, restyle, destroy, count }
  //
  //  opts:
  //    map           Leaflet map
  //    fetchTile(bbox, signal) → Promise<FeatureCollection>   (honours signal)
  //    makeLayers(feature) → [L.Layer]      build the styled layer(s) for one
  //                                          feature (click handlers, labels…)
  //    featureId(feature) → string|number   stable id for dedup (default f.id)
  //    onCount(n)                            reports # features on the map
  //    tileLimit     per-tile feature cap   (default 2000)
  //    maxTiles      LRU cache budget        (default 96 tiles)
  //    prefetchRing  rings to prefetch       (default 1; 0 = off)
  //    minTileZoom / maxTileZoom            tile-grid zoom clamp (11 / 19)
  //    concurrency   max parallel fetches    (default 6)
  // ──────────────────────────────────────────────────────────────────────
  function create(opts) {
    var map = opts.map;
    var TILE_LIMIT = opts.tileLimit || 2000;
    var MAX_TILES  = opts.maxTiles  || 96;
    var RING       = opts.prefetchRing != null ? opts.prefetchRing : 1;
    var MIN_TZ     = opts.minTileZoom || 11;
    var MAX_TZ     = opts.maxTileZoom || 19;
    var CONCURRENCY = opts.concurrency || 6;
    var fid = opts.featureId || function (f) { return f.id != null ? f.id : (f.properties && f.properties.__id); };

    var group    = L.featureGroup().addTo(map); // persistent — never cleared on refresh
    var refs     = new Map();   // featureId → { layers:[L.Layer], count:int }
    var tiles    = new Map();   // tileKey   → { ids:Set, z, ts }   (cached, on map)
    var inflight = new Map();   // tileKey   → { ctrl:AbortController, prio:bool }
    var queue    = [];          // pending jobs { key, bbox, z, prio }
    var running  = 0;
    var dead     = false;
    var lastDesired = new Set();

    function tileZoom() { return clamp(Math.round(map.getZoom()), MIN_TZ, MAX_TZ); }
    function report() { if (opts.onCount) opts.onCount(refs.size); }

    // Tiles covering the current viewport (pad = extra rings of tiles around it).
    function tilesForView(z, pad) {
      var b = map.getBounds();
      var x0 = lng2x(b.getWest(), z),  x1 = lng2x(b.getEast(), z);
      var y0 = lat2y(b.getNorth(), z), y1 = lat2y(b.getSouth(), z); // north has smaller y
      var out = [];
      for (var x = x0 - pad; x <= x1 + pad; x++)
        for (var y = y0 - pad; y <= y1 + pad; y++)
          out.push({ key: z + '/' + x + '/' + y, bbox: tileBBox(x, y, z), z: z, x: x, y: y });
      return out;
    }

    // ── Feature cache: add a tile's features (dedup + ref-count) ──
    function addTile(key, fc, z) {
      if (dead) return;
      var ids = new Set();
      var feats = (fc && fc.features) || [];
      for (var i = 0; i < feats.length; i++) {
        var f = feats[i], id = fid(f);
        if (id == null) id = key + ':' + i; // fallback: tile-local id
        ids.add(id);
        var ref = refs.get(id);
        if (ref) { ref.count++; }
        else {
          var ls = opts.makeLayers(f) || [];
          for (var j = 0; j < ls.length; j++) group.addLayer(ls[j]);
          refs.set(id, { layers: ls, count: 1 });
        }
      }
      tiles.set(key, { ids: ids, z: z, ts: Date.now() });
    }

    // ── Feature cache: drop a tile, removing only features no live tile needs ──
    function evictTile(key) {
      var t = tiles.get(key);
      if (!t) return;
      t.ids.forEach(function (id) {
        var ref = refs.get(id);
        if (!ref) return;
        if (--ref.count <= 0) {
          for (var j = 0; j < ref.layers.length; j++) group.removeLayer(ref.layers[j]);
          refs.delete(id);
        }
      });
      tiles.delete(key);
    }

    // LRU prune: keep memory bounded; never evict a tile we still want on screen.
    function prune() {
      if (tiles.size <= MAX_TILES) return;
      var victims = [];
      tiles.forEach(function (t, key) { if (!lastDesired.has(key)) victims.push([key, t.ts]); });
      victims.sort(function (a, b) { return a[1] - b[1]; }); // oldest first
      var over = tiles.size - MAX_TILES;
      for (var i = 0; i < victims.length && over > 0; i++, over--) evictTile(victims[i][0]);
    }

    // ── Request queue (concurrency-limited, deduped, priority-ordered) ──
    function enqueue(t, prio) {
      if (tiles.has(t.key) || inflight.has(t.key)) return; // dedup: cached or in-flight
      t.prio = prio;
      if (prio) queue.unshift(t); else queue.push(t);      // visible tiles jump the queue
    }
    function pump() {
      while (!dead && running < CONCURRENCY && queue.length) {
        var job = queue.shift();
        if (tiles.has(job.key) || inflight.has(job.key)) continue;
        run(job);
      }
    }
    function run(job) {
      running++;
      var ctrl = new AbortController();
      inflight.set(job.key, { ctrl: ctrl, prio: job.prio });
      Promise.resolve()
        .then(function () { return opts.fetchTile(job.bbox, ctrl.signal); })
        .then(function (fc) { if (!dead && inflight.has(job.key)) addTile(job.key, fc, job.z); })
        .catch(function (e) {
          if (ctrl.signal.aborted) return;                  // we cancelled it → silent
          var m = (e && (e.name + ' ' + e.message)) || '';
          if (/abort/i.test(m) || (e && e.code === '20')) return;
          if (window.console) console.warn('[GISTileLoader] tile ' + job.key, e && e.message || e);
        })
        .then(function () {
          inflight.delete(job.key);
          running--;
          report(); prune(); pump();
        });
    }

    // ── Public: recompute desired tiles for the current view & drive loading ──
    function update() {
      if (dead) return;
      var z = tileZoom();
      var vis = tilesForView(z, 0);            // must-have (visible)
      var pre = RING > 0 ? tilesForView(z, RING) : vis; // visible + prefetch ring
      lastDesired = new Set();
      pre.forEach(function (t) { lastDesired.add(t.key); });

      // Cancel work for tiles that are no longer wanted (user moved on).
      inflight.forEach(function (v, k) { if (!lastDesired.has(k)) { v.ctrl.abort(); inflight.delete(k); } });
      queue = queue.filter(function (j) { return lastDesired.has(j.key); });

      // Queue visible tiles first (high priority), then the prefetch ring.
      var visKeys = {};
      vis.forEach(function (t) { visKeys[t.key] = 1; enqueue(t, true); });
      pre.forEach(function (t) { if (!visKeys[t.key]) enqueue(t, false); });

      pump();
      report();
    }

    // Re-render every feature currently on the map with fresh styling (e.g. a
    // colour change) WITHOUT a network round-trip — rebuild from cached features
    // is not possible (we hold layers, not GeoJSON), so callers that change
    // symbology should call invalidate() instead. Kept for API symmetry.
    function restyle() { invalidate(); }

    // Drop all caches and reload the current view (use after an edit/recolour so
    // changed geometry/attributes re-render). Briefly clears — only for explicit
    // user actions, never on pan/zoom.
    function invalidate() {
      inflight.forEach(function (v) { v.ctrl.abort(); });
      inflight.clear(); queue = [];
      group.clearLayers(); refs.clear(); tiles.clear();
      update();
    }

    function destroy() {
      dead = true;
      inflight.forEach(function (v) { v.ctrl.abort(); });
      inflight.clear(); queue = [];
      if (map.hasLayer(group)) map.removeLayer(group);
      group.clearLayers(); refs.clear(); tiles.clear();
    }

    update(); // kick off the first viewport load immediately

    return {
      update: update,
      invalidate: invalidate,
      restyle: restyle,
      destroy: destroy,
      group: group,
      count: function () { return refs.size; },
      tileLimit: TILE_LIMIT
    };
  }

  window.GISTileLoader = { create: create };
})();
