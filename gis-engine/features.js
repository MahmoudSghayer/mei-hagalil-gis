// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — features.js   →   GIS.features
//  The GIS objects: pipes, valves, hydrants, ...
//
//  Reads return GeoJSON FeatureCollections (drop straight into L.geoJSON).
//  Writes go through RLS: only admin|engineer may mutate features.
//
//  DATA RULE: every feature carries an `asset_code` — the primary link key
//  to Arad meters and external systems.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var GIS = window.GIS;
  GIS._assert(GIS, 'core.js must load before features.js');

  GIS.features = {

    // GeoJSON FeatureCollection for a layer (via PostGIS RPC).
    getFeatures: async function (layerId, limit) {
      GIS._assert(layerId, 'getFeatures requires a layerId');
      var sb = GIS.sb();
      var fc = GIS._unwrap(await sb.rpc('features_geojson', {
        p_layer_id: layerId,
        p_limit: limit || GIS.config.defaultFeatureLimit
      }), 'load features');
      return fc || GIS.emptyFC();
    },

    // Viewport loading — only features intersecting the given bounds
    // { minLng, minLat, maxLng, maxLat }. Capped by limit. Avoids timeouts
    // on huge layers by relying on the spatial index.
    getInBBox: async function (layerId, bounds, limit) {
      GIS._assert(layerId && bounds, 'getInBBox requires (layerId, bounds)');
      var sb = GIS.sb();
      var fc = GIS._unwrap(await sb.rpc('features_in_bbox', {
        p_layer_id: layerId,
        p_minlng: bounds.minLng, p_minlat: bounds.minLat,
        p_maxlng: bounds.maxLng, p_maxlat: bounds.maxLat,
        p_limit: limit || 4000
      }), 'load features');
      return fc || GIS.emptyFC();
    },

    // Single feature as a GeoJSON Feature, plus its meters (linked).
    getFeatureById: async function (id) {
      GIS._assert(id, 'getFeatureById requires an id');
      var sb = GIS.sb();
      var row = GIS._unwrap(
        await sb.from('features').select('id, layer_id, asset_code, properties').eq('id', id).single(),
        'load feature');
      // Geometry as GeoJSON (separate RPC keeps the table read simple).
      var geo = GIS._unwrap(await sb.rpc('features_geojson', { p_layer_id: row.layer_id }), 'load geometry');
      var match = (geo.features || []).find(function (f) { return f.id === id || f.properties.__id === id; });
      var feature = {
        type: 'Feature', id: id,
        geometry: match ? match.geometry : null,
        properties: Object.assign({ asset_code: row.asset_code, __id: id, __layer_id: row.layer_id }, row.properties)
      };
      feature.meters = await GIS.meters.getForAsset(row.asset_code);
      return feature;
    },

    // Create a feature.  geometry = GeoJSON geometry object.
    // properties is a plain object (length_m / age auto-filled by DB trigger).
    createFeature: async function (layerId, geometry, properties, assetCode) {
      GIS._assert(layerId && geometry, 'createFeature requires (layerId, geometry, ...)');
      await GIS._requireRole(['admin', 'engineer'], 'create features');
      var props = properties || {};
      var code = assetCode || props.asset_code;
      GIS._assert(code, 'createFeature requires an asset_code (primary link key)');
      delete props.asset_code;
      var sb = GIS.sb();
      return GIS._unwrap(await sb.rpc('create_feature', {
        p_layer_id: layerId, p_asset_code: code, p_geometry: geometry, p_properties: props
      }), 'create feature');
    },

    // Update a feature's attributes (geometry unchanged). RLS: admin|engineer.
    updateFeature: async function (id, properties) {
      GIS._assert(id && properties, 'updateFeature requires (id, properties)');
      await GIS._requireRole(['admin', 'engineer'], 'edit features');
      var sb = GIS.sb();
      return GIS._unwrap(
        await sb.from('features').update({ properties: properties }).eq('id', id).select().single(),
        'update feature');
    },

    deleteFeature: async function (id) {
      GIS._assert(id, 'deleteFeature requires an id');
      await GIS._requireRole(['admin', 'engineer'], 'delete features');
      var sb = GIS.sb();
      GIS._unwrap(await sb.from('features').delete().eq('id', id), 'delete feature');
      return { id: id, deleted: true };
    }
  };
})();
