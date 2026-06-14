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
  //   opts: map, layerId, style(props,zoom)→Leaflet style, onClick(props),
  //         onStatus({loading}), getFeatureId(props)→id
  function create(opts) {
    var map = opts.map;
    var group = L.layerGroup().addTo(map);
    var vg = null, dead = false, ver = 0;

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
    }

    function start() { authToken().then(build); }
    start();

    function rebuild() {
      ver = Date.now();                 // bust CDN + VectorGrid caches after an edit
      if (vg) { group.removeLayer(vg); vg = null; }
      start();
    }

    return {
      update: function () {},
      invalidate: rebuild,
      restyle: rebuild,
      destroy: function () { dead = true; if (map.hasLayer(group)) map.removeLayer(group); group.clearLayers(); vg = null; },
      group: group,
      count: function () { return null; },
      isMvt: true
    };
  }

  window.GISMvtLayer = { supported: supported, probe: probe, mode: mode, create: create };
})();
