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

  // Own-write dedupe hook (W2.3 — realtime): called right after every
  // successful write below, regardless of WHICH UI triggered it
  // (js/gis-feature-table.js's cell edit / bulk edit / add-row / delete-row,
  // AND js/gis-edit.js's on-map add / edit-geometry / delete / undo-redo —
  // all of them funnel through GIS.features.*, so hooking it here ONCE
  // covers every call site instead of duplicating a suppress() call at
  // each one). Opens a short window in js/gis-realtime.js during which the
  // inevitable realtime ECHO of this very write is dropped instead of
  // triggering a second refresh. No-op (and never throws) if gis-realtime.js
  // isn't loaded — e.g. pages that only ever read features.
  function suppressEcho(layerId) {
    if (!layerId) return;
    try { if (window.GISRealtime && GISRealtime.suppress) GISRealtime.suppress(layerId); } catch (e) {}
  }

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
    // `signal` (optional AbortSignal) cancels the request when the user pans
    // away before it lands — used by the tile loader to drop stale fetches.
    getInBBox: async function (layerId, bounds, limit, signal) {
      GIS._assert(layerId && bounds, 'getInBBox requires (layerId, bounds)');
      var sb = GIS.sb();
      var q = sb.rpc('features_in_bbox', {
        p_layer_id: layerId,
        p_minlng: bounds.minLng, p_minlat: bounds.minLat,
        p_maxlng: bounds.maxLng, p_maxlat: bounds.maxLat,
        p_limit: limit || 4000
      });
      if (signal && q.abortSignal) q = q.abortSignal(signal);
      var fc = GIS._unwrap(await q, 'load features');
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
      await GIS._requireRole(['admin', 'engineer'],'create features');
      var props = properties || {};
      var code = assetCode || props.asset_code;
      GIS._assert(code, 'createFeature requires an asset_code (primary link key)');
      delete props.asset_code;
      var sb = GIS.sb();
      var created = GIS._unwrap(await sb.rpc('create_feature', {
        p_layer_id: layerId, p_asset_code: code, p_geometry: geometry, p_properties: props
      }), 'create feature');
      suppressEcho(layerId);
      return created;
    },

    // Update a feature's attributes (geometry unchanged). RLS: admin|engineer.
    updateFeature: async function (id, properties) {
      GIS._assert(id && properties, 'updateFeature requires (id, properties)');
      await GIS._requireRole(['admin', 'engineer'],'edit features');
      var sb = GIS.sb();
      var updated = GIS._unwrap(
        await sb.from('features').update({ properties: properties }).eq('id', id).select().single(),
        'update feature');
      suppressEcho(updated && updated.layer_id);
      return updated;
    },

    // Update a feature's GEOMETRY (attributes unchanged). geometry = GeoJSON
    // geometry object. Goes through the update_feature_geometry RPC (PostGIS
    // ST_GeomFromGeoJSON); the DB trigger then recomputes length_m. The
    // features RLS enforces admin|engineer. Used by the on-map Edit tool.
    updateGeometry: async function (id, geometry) {
      GIS._assert(id && geometry, 'updateGeometry requires (id, geometry)');
      await GIS._requireRole(['admin', 'engineer'],'edit geometry');
      var sb = GIS.sb();
      var updated = GIS._unwrap(await sb.rpc('update_feature_geometry', {
        p_id: id, p_geometry: geometry
      }), 'update geometry');
      suppressEcho(updated && updated.layer_id);
      return updated;
    },

    deleteFeature: async function (id) {
      GIS._assert(id, 'deleteFeature requires an id');
      await GIS._requireRole(['admin', 'engineer'],'delete features');
      var sb = GIS.sb();
      // .select('layer_id') asks PostgREST to return the deleted row's
      // representation (Prefer: return=representation) in the SAME request —
      // the only way to learn which layer this delete belongs to, since
      // deleteFeature() only takes an id (no layerId param) and the row is
      // gone after the delete.
      var rows = GIS._unwrap(await sb.from('features').delete().eq('id', id).select('layer_id'), 'delete feature');
      suppressEcho(rows && rows[0] && rows[0].layer_id);
      return { id: id, deleted: true };
    },

    // Merge `patch` into properties for up to 1000 feature ids at once (the
    // attribute table's multi-row select + bulk edit). RLS: admin|engineer.
    // Goes through the features_bulk_update RPC — see
    // gis-engine/sql/migrations/2026-07-14-feature-table-pagination.sql —
    // which flows through the same features_autocalc/gis_audit triggers as a
    // normal update. Returns { updated: <row count> }.
    bulkUpdate: async function (layerId, ids, patch) {
      GIS._assert(layerId, 'bulkUpdate requires a layerId');
      GIS._assert(ids && ids.length, 'bulkUpdate requires a non-empty ids array');
      GIS._assert(patch && typeof patch === 'object', 'bulkUpdate requires a patch object');
      await GIS._requireRole(['admin', 'engineer'], 'bulk-edit features');
      var sb = GIS.sb();
      var count = GIS._unwrap(await sb.rpc('features_bulk_update', {
        p_layer_id: layerId, p_ids: ids, p_patch: patch
      }), 'bulk update features');
      suppressEcho(layerId);
      return { updated: count || 0 };
    }
  };
})();
