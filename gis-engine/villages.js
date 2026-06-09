// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — villages.js   →   GIS.villages
//  Adapter that brings the ALREADY-UPLOADED village data (flat GeoJSON in
//  Supabase Storage, indexed by `village_layers`, categorised by
//  properties._category) under the engine, so ALL data is reachable through
//  GIS.* — without migrating 150k features into PostGIS.
//
//  • Reads features that index.js already loaded (window.gVillageFeatures)
//    when available; otherwise fetches the GeoJSON from Storage.
//  • Synthesises a stable asset_code on read (from GlobalID/OBJECTID/
//    EntityHand, else <slug>-<category>-<index>) so meters can link and
//    features are addressable. Nothing stored is modified.
//  • Filtering + the field calculator run client-side (this data is not in
//    PostGIS): GIS.queries.applyFilter + GIS.calculator.calculateField.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var GIS = window.GIS;
  GIS._assert(GIS, 'core.js must load before villages.js');

  var BUCKET = 'village-layers';
  var cache = {}; // village_id → GeoJSON FeatureCollection (with synthesised asset_code)

  function synthAssetCode(props, slug, idx) {
    var uid = props.asset_code || props.GlobalID || props.globalid ||
              props.OBJECTID || props.objectid || props.EntityHand || props.entityhand;
    if (uid !== undefined && uid !== null && uid !== '') return String(uid);
    return (slug || 'V') + '-' + (props._category || 'feat') + '-' + idx;
  }

  // Normalise a raw FeatureCollection: ensure each feature has asset_code,
  // _category, and engine bookkeeping props. Mutates in place (cheap) once.
  function decorate(fc, villageId, slug) {
    (fc.features || []).forEach(function (f, i) {
      var p = f.properties || (f.properties = {});
      if (!p.asset_code) p.asset_code = synthAssetCode(p, slug, i);
      if (!p._category) p._category = 'other';
      p.__source = 'village';
      p.__village_id = villageId;
      if (f.id == null) f.id = p.asset_code;
    });
    return fc;
  }

  GIS.villages = {

    // List uploaded villages (active layers). Returns village_layers rows.
    getVillages: async function () {
      var sb = GIS.sb();
      return GIS._unwrap(
        await sb.from('village_layers').select('*').eq('is_active', true)
          .order('uploaded_at', { ascending: true }), 'load villages') || [];
    },

    // GeoJSON FeatureCollection for a village. Prefers the copy index.js has
    // already loaded (window.gVillageFeatures), else fetches from Storage.
    // opts.category → keep only features of that _category.
    getFeatures: async function (villageId, opts) {
      GIS._assert(villageId, 'getFeatures requires a villageId');
      opts = opts || {};
      var fc = cache[villageId];

      if (!fc) {
        var slug = String(villageId).split('_')[0];
        // 1. reuse already-loaded features from index.js if present
        var loaded = window.gVillageFeatures && window.gVillageFeatures[villageId];
        if (loaded && loaded.length) {
          fc = { type: 'FeatureCollection', features: loaded.slice() };
        } else {
          // 2. fetch the flat GeoJSON from Storage (same path index.js uses)
          var row = GIS._unwrap(
            await GIS.sb().from('village_layers').select('file_path')
              .eq('village_id', villageId).single(), 'load village');
          var url = GIS.sb().storage.from(BUCKET).getPublicUrl(row.file_path).data.publicUrl;
          var res = await fetch(url);
          if (!res.ok) throw new Error('[GIS.villages] fetch failed for ' + row.file_path);
          fc = JSON.parse(await res.text());
        }
        decorate(fc, villageId, slug);
        cache[villageId] = fc;
      }

      if (opts.category) {
        return { type: 'FeatureCollection',
          features: fc.features.filter(function (f) { return f.properties._category === opts.category; }) };
      }
      return fc;
    },

    // Distinct categories present in a village (with counts).
    getCategories: async function (villageId) {
      var fc = await GIS.villages.getFeatures(villageId);
      var counts = {};
      fc.features.forEach(function (f) { var c = f.properties._category || 'other'; counts[c] = (counts[c] || 0) + 1; });
      return Object.keys(counts).map(function (c) { return { category: c, count: counts[c] }; })
        .sort(function (a, b) { return b.count - a.count; });
    },

    // SQL-like filter over a village (client-side). Returns GeoJSON.
    query: async function (villageId, filter, opts) {
      var fc = await GIS.villages.getFeatures(villageId, opts);
      return { type: 'FeatureCollection', features: GIS.queries.applyFilter(fc.features, filter) };
    },

    // Calculate an expression across a village's features → array of values.
    // (Use GIS.calculator directly; this is a convenience that loads first.)
    calculate: async function (villageId, expression, opts) {
      var fc = await GIS.villages.getFeatures(villageId, opts);
      return GIS.calculator.calculateField(fc.features, expression);
    },

    // Find village features near a point (client-side, across loaded villages).
    near: async function (point, radiusMeters, villageId) {
      var fc = await GIS.villages.getFeatures(villageId);
      return GIS.spatial.withinRadius(point, radiusMeters, fc.features);
    },

    // Open a village feature in the shared attribute panel.
    openInPanel: function (feature) { if (window.GISPanel) window.GISPanel.open(feature); },

    // Drop the in-memory cache (e.g. after a re-upload).
    clearCache: function (villageId) { if (villageId) delete cache[villageId]; else cache = {}; }
  };
})();
