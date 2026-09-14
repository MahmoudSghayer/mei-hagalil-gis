// ════════════════════════════════════════════════════════════════════════
//  מי הגליל GIS — Vector-tile layer   →   window.GISMvtLayer
//
//  Renders an engine layer as Mapbox Vector Tiles (Leaflet.VectorGrid). Two
//  sources, picked by probe():
//    'edge' → /api/tiles (Vercel serverless, CDN-cached, robust byte decode)
//    'rpc'  → the PostGIS features_mvt RPC fetched straight from the browser
//  Edge is preferred (cached + no auth quirks); rpc is the no-serverless
//  fallback; if neither works probe() returns false and the caller uses the
//  GeoJSON tile loader. So the app keeps working through every config state.
//
//  Tiles are SLIM (id/asset_code + symbology inputs); full attributes load on
//  click. VectorGrid manages its own tiling/cache/abort/prefetch, so the
//  controller's update() is a no-op and invalidate() rebuilds (bumping a cache-
//  buster so an edit isn't masked by the CDN).
//
//  Same controller shape as GISTileLoader so the sidebar swaps transparently.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── Compat shim: Leaflet.VectorGrid 1.3.0 calls L.DomEvent.fakeStop in its
  //    canvas click handler, but fakeStop was removed in Leaflet 1.x. Without
  //    this, EVERY click on a vector tile throws "L.DomEvent.fakeStop is not a
  //    function", which breaks the map's click/drag handling — including the
  //    export area-draw. Map it to the modern stopPropagation (same intent:
  //    don't let the map also handle a click that hit a feature).
  if (window.L && L.DomEvent && typeof L.DomEvent.fakeStop !== 'function') {
    L.DomEvent.fakeStop = function (e) { return L.DomEvent.stopPropagation(e); };
  }

  function base() { return typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : ''; }
  function anon() { return typeof SUPABASE_ANON !== 'undefined' ? SUPABASE_ANON : ''; }
  function rpcBase() { return base() + '/rest/v1/rpc/features_mvt'; }
  function edgeBase() { return '/api/tiles'; }

  function supported() { return !!(window.L && L.vectorGrid && L.vectorGrid.protobuf); }

  // Current session JWT (so RLS sees the real user on the direct-rpc path), else anon.
  function authToken() {
    try {
      if (window.gSb && gSb.auth && gSb.auth.getSession) {
        return gSb.auth.getSession()
          .then(function (r) { var s = r && r.data && r.data.session; return (s && s.access_token) || anon(); })
          .catch(function () { return anon(); });
      }
    } catch (e) {}
    return Promise.resolve(anon());
  }
  function rpcHeaders(token) { return { apikey: anon(), Authorization: 'Bearer ' + token, Accept: 'application/octet-stream' }; }

  // A Galilee tile for probing (z13 over ~lat 32.9 / lng 35.3).
  function sampleTile() {
    var z = 13, n = Math.pow(2, z);
    var x = Math.floor((35.3 + 180) / 360 * n);
    var rad = 32.9 * Math.PI / 180;
    var y = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
    return { z: z, x: x, y: y };
  }

  // → Promise<'edge' | 'rpc' | false>  (cached). Tries the edge endpoint first.
  var _mode = null, _probe = null;
  function probe(sampleLayerId) {
    if (_probe) return _probe;
    if (!supported() || !sampleLayerId) { _mode = false; return Promise.resolve(false); }
    var t = sampleTile();
    _probe = fetch(edgeBase() + '?layer=' + encodeURIComponent(sampleLayerId) + '&z=' + t.z + '&x=' + t.x + '&y=' + t.y)
      .then(function (r) { return r.ok ? 'edge' : null; })
      .catch(function () { return null; })
      .then(function (edge) {
        if (edge) return edge;
        // fall back to the direct RPC
        return authToken().then(function (token) {
          var u = rpcBase() + '?p_layer_id=' + encodeURIComponent(sampleLayerId) + '&p_z=' + t.z + '&p_x=' + t.x + '&p_y=' + t.y;
          return fetch(u, { headers: rpcHeaders(token) }).then(function (r) { return r.ok ? 'rpc' : false; }).catch(function () { return false; });
        });
      })
      .then(function (mode) { _mode = mode; return mode; })
      .catch(function () { _mode = false; return false; });
    return _probe;
  }
  function mode() { return _mode; }

  // create(opts) → controller
  // ── pixel-space geometry helpers (pure; unit-tested) ─────────────────────
  function segDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    var t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function ringContains(ring, p) {   // even-odd ray cast
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  // Distance (tile px) from p to a VectorGrid symbolizer: 0 inside a filled
  // polygon; else nearest edge / vertex. Points: distance to the centre.
  function featureDistPx(feat, p) {
    if (feat._point) return Math.hypot(feat._point.x - p.x, feat._point.y - p.y);
    var parts = feat._parts;
    if (!parts || !parts.length) return Infinity;
    var isFill = !!(typeof L !== 'undefined' && L.Polygon && feat instanceof L.Polygon) || feat._isFill === true;
    var d = Infinity;
    for (var i = 0; i < parts.length; i++) {
      var ring = parts[i];
      if (isFill && ring.length > 2 && ringContains(ring, p)) return 0;
      for (var k = 1; k < ring.length; k++) { var s = segDist(p, ring[k - 1], ring[k]); if (s < d) d = s; }
      if (isFill && ring.length > 2) { var c = segDist(p, ring[ring.length - 1], ring[0]); if (c < d) d = c; }
      if (ring.length === 1) { var o = Math.hypot(ring[0].x - p.x, ring[0].y - p.y); if (o < d) d = o; }
    }
    return d;
  }

  //   opts: map, layerId, style(props,zoom)→Leaflet style, onClick(props),
  //         onStatus({loading}), getFeatureId(props)→id
  function create(opts) {
    var map = opts.map;
    var group = L.layerGroup().addTo(map);
    var vg = null, dead = false, ver = 0, _op = 1;

    function tileUrl() {
      var v = ver ? '&v=' + ver : '';
      if (_mode === 'edge')
        return edgeBase() + '?layer=' + encodeURIComponent(opts.layerId) + '&z={z}&x={x}&y={y}' + v;
      return rpcBase() + '?p_layer_id=' + encodeURIComponent(opts.layerId) + '&p_z={z}&p_x={x}&p_y={y}' + v;
    }

    function build(token) {
      if (dead) return;
      var fetchOptions = (_mode === 'rpc') ? { headers: rpcHeaders(token) } : {};
      vg = L.vectorGrid.protobuf(tileUrl(), {
        rendererFactory: L.canvas.tile,
        interactive: true,
        maxNativeZoom: 19,   // deepest tiles we fetch; VectorGrid OVERZOOMS (scales) these beyond it
        maxZoom: 22,         // keep the layer attached past z18 (it was vanishing) — vectors scale cleanly
        fetchOptions: fetchOptions,
        getFeatureId: function (f) { return opts.getFeatureId ? opts.getFeatureId(f.properties) : f.properties.__id; },
        vectorTileLayerStyles: {
          features: function (props, zoom) { return opts.style ? opts.style(props, zoom) : { weight: 3, color: '#1a7fc1' }; }
        }
      });
      if (opts.onClick) vg.on('click', function (e) { if (e.layer && e.layer.properties) opts.onClick(e.layer.properties); });
      if (opts.onStatus) {
        vg.on('loading', function () { opts.onStatus({ loading: true }); });
        vg.on('load',    function () { opts.onStatus({ loading: false }); });
      }
      group.addLayer(vg);
      if (_op !== 1 && vg.setOpacity) { try { vg.setOpacity(_op); } catch (e) {} }
    }

    function start() { authToken().then(build); }
    start();

    function rebuild() {
      ver = Date.now();                 // bust CDN + VectorGrid caches after an edit
      if (vg) { group.removeLayer(vg); vg = null; }
      start();
    }

    // ── Local hit-test against the vector tiles ALREADY in memory ───────────
    // VectorGrid keeps, per tile, `renderer._features[id] = { feature }` where
    // `feature` is a symbolizer with `_parts` (poly/line rings, L.Point in TILE
    // pixel space) or `_point` (points). Converting the mouse latlng into that
    // tile's pixel space (one projection per tile) lets us find the nearest
    // feature with plain 2D math — no network, any zoom, all active layers —
    // which is what makes hover/click/edit-pick instant. Returns
    // { id, props, distPx } (distPx in SCREEN pixels) or null.
    function hitTest(latlng, tolPx) {
      if (!vg || !vg._vectorTiles || !map || !latlng) return null;
      var best = null;
      var tiles = vg._vectorTiles;
      var mapZoom = map.getZoom();
      Object.keys(tiles).forEach(function (key) {
        var r = tiles[key];
        if (!r || !r._features || !r._tileCoord) return;
        var tc = r._tileCoord;
        var size = r._size || (vg.getTileSize && vg.getTileSize()) || L.point(256, 256);
        var scale = Math.pow(2, mapZoom - tc.z);          // screen px per tile px (overzoom-safe)
        var tol = (tolPx == null ? 12 : tolPx) / scale;   // tolerance in tile px
        var p = map.project(latlng, tc.z).subtract(tc.scaleBy(size));   // mouse in this tile's px space
        if (p.x < -tol || p.y < -tol || p.x > size.x + tol || p.y > size.y + tol) return;
        Object.keys(r._features).forEach(function (id) {
          var feat = r._features[id] && r._features[id].feature;
          if (!feat) return;
          var d = featureDistPx(feat, p);
          if (d <= tol && (!best || d * scale < best.distPx)) {
            best = { id: id, props: feat.properties || {}, distPx: d * scale };
          }
        });
      });
      return best;
    }

    return {
      update: function () {},
      invalidate: rebuild,
      hitTest: hitTest,
      // Bbox-scoped invalidate (W2.3 — realtime): kept for API symmetry with
      // gis-tile-loader.js's controller, but Leaflet.VectorGrid's canvas
      // tiles (rendererFactory: L.canvas.tile) aren't individually
      // addressable from outside the plugin — there is no per-tile cache
      // this file owns to selectively evict, only the CDN/browser HTTP
      // cache behind the whole tile URL template. So this is an ALIAS for
      // a full cache-busted rebuild() (bumps `ver`, forcing every tile —
      // on screen or not — to be refetched), same as invalidate(). The bbox
      // argument is accepted (and ignored) so callers can treat both
      // controller types uniformly.
      invalidateBBox: function () { rebuild(); },
      restyle: rebuild,
      destroy: function () { dead = true; if (map.hasLayer(group)) map.removeLayer(group); group.clearLayers(); vg = null; },
      group: group,
      setOpacity: function (v) { _op = v < 0 ? 0 : v > 1 ? 1 : v; if (vg && vg.setOpacity) { try { vg.setOpacity(_op); } catch (e) {} } },
      toFront: function () { if (vg && vg.bringToFront) { try { vg.bringToFront(); } catch (e) {} } },
      toBack: function () { if (vg && vg.bringToBack) { try { vg.bringToBack(); } catch (e) {} } },
      count: function () { return null; },
      isMvt: true
    };
  }

  window.GISMvtLayer = {
    supported: supported, probe: probe, mode: mode, create: create,
    _featureDistPx: featureDistPx   // test-only (pure pixel-space distance)
  };
})();
