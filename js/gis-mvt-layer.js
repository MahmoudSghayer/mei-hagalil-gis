// ════════════════════════════════════════════════════════════════════════
//  מי הגליל GIS — Vector-tile layer   →   window.GISMvtLayer
//
//  Renders an engine layer as Mapbox Vector Tiles (Leaflet.VectorGrid) fetched
//  straight from the PostGIS `features_mvt` RPC (gis-engine/sql/mvt.sql). This
//  is the scale fix for the heavy layers (e.g. 18k pipes): PostGIS clips +
//  quantises each tile to a tiny binary, and VectorGrid draws it on a canvas
//  without creating one Leaflet object per feature.
//
//  Exposes the SAME controller shape as GISTileLoader
//  ({ update, invalidate, restyle, destroy, group, count }) so the sidebar can
//  swap between them transparently. VectorGrid manages its own tile pyramid,
//  caching, prefetch and aborting, so update() is a no-op and invalidate()
//  just redraws.
//
//  Safe by design: supported() + probe() let the caller fall back to the
//  GeoJSON tile loader when the migration hasn't been run or VectorGrid is
//  unavailable — so production keeps working until features_mvt exists.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  function url() { return (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '') + '/rest/v1/rpc/features_mvt'; }
  function anon() { return typeof SUPABASE_ANON !== 'undefined' ? SUPABASE_ANON : ''; }

  // Current session JWT (so SECURITY-INVOKER RLS sees the real user), else anon.
  function authToken() {
    try {
      if (window.gSb && gSb.auth && gSb.auth.getSession) {
        return gSb.auth.getSession().then(function (r) {
          var s = r && r.data && r.data.session;
          return (s && s.access_token) || anon();
        }).catch(function () { return anon(); });
      }
    } catch (e) {}
    return Promise.resolve(anon());
  }

  function headers(token) {
    return { apikey: anon(), Authorization: 'Bearer ' + token, Accept: 'application/octet-stream' };
  }

  // Is the VectorGrid plugin loaded? (CDN may have failed.)
  function supported() { return !!(window.L && L.vectorGrid && L.vectorGrid.protobuf); }

  // Convert tile XYZ → request URL with placeholders VectorGrid fills in.
  function tileUrl(layerId) {
    return url() + '?p_layer_id=' + encodeURIComponent(layerId) + '&p_z={z}&p_x={x}&p_y={y}';
  }

  // Does features_mvt exist & return tiles? Probes one Galilee tile once.
  // Resolves true/false; never rejects.
  var _probe = null;
  function probe(sampleLayerId) {
    if (_probe) return _probe;
    if (!supported() || !sampleLayerId) return Promise.resolve(false);
    _probe = authToken().then(function (token) {
      // z=13 tile over the service area (~lat 32.9, lng 35.3)
      var z = 13, n = Math.pow(2, z);
      var x = Math.floor((35.3 + 180) / 360 * n);
      var rad = 32.9 * Math.PI / 180;
      var y = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
      var u = url() + '?p_layer_id=' + encodeURIComponent(sampleLayerId) + '&p_z=' + z + '&p_x=' + x + '&p_y=' + y;
      return fetch(u, { headers: headers(token) }).then(function (r) { return r.ok; });
    }).catch(function () { return false; });
    return _probe;
  }

  // create(opts) → controller
  //   opts: map, layerId, style(props,zoom)→Leaflet style, onClick(props),
  //         onStatus({loading}), getFeatureId(props)→id
  function create(opts) {
    var map = opts.map;
    var group = L.layerGroup().addTo(map); // holds the VectorGrid; keeps a stable handle
    var vg = null, dead = false;

    function build(token) {
      if (dead) return;
      vg = L.vectorGrid.protobuf(tileUrl(opts.layerId), {
        rendererFactory: L.canvas.tile,
        interactive: true,
        fetchOptions: { headers: headers(token) },
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

    authToken().then(build);

    function rebuild() {
      if (vg) { group.removeLayer(vg); vg = null; }
      authToken().then(build);
    }

    return {
      update: function () {},          // VectorGrid self-tiles on pan/zoom
      invalidate: rebuild,             // edit/recolour → refetch with fresh token+style
      restyle: rebuild,
      destroy: function () { dead = true; if (map.hasLayer(group)) map.removeLayer(group); group.clearLayers(); vg = null; },
      group: group,
      count: function () { return null; },  // MVT doesn't expose a feature count
      isMvt: true
    };
  }

  window.GISMvtLayer = { supported: supported, probe: probe, create: create };
})();
