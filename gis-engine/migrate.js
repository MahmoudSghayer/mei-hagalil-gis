// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — migrate.js   →   GIS.migrate
//  One-time migration of uploaded village data (flat GeoJSON in Storage,
//  already loaded by index.js into gVillageFeatures) INTO the engine's
//  features/layers/fields tables — so it becomes fully editable through
//  the engine (edit values, add/delete columns, calculator, queries, RLS).
//
//  Modeling: one engine layer per (village, category), named
//  "<village_name> · <category>". Each feature gets a stable synthesised
//  asset_code and keeps _village_id / _category in properties. Idempotent
//  (re-running upserts by asset_code). Admin only (RLS).
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var GIS = window.GIS;
  GIS._assert(GIS, 'core.js must load before migrate.js');

  var CHUNK = 800; // features per import_features RPC call

  function geomTypeOf(features) {
    for (var i = 0; i < features.length; i++) {
      var t = features[i].geometry && features[i].geometry.type;
      if (t === 'Point' || t === 'MultiPoint') return 'Point';
      if (t === 'LineString' || t === 'MultiLineString') return 'LineString';
      if (t === 'Polygon' || t === 'MultiPolygon') return 'Polygon';
    }
    return 'Point';
  }

  function synthAssetCode(props, slug, cat, idx) {
    var uid = props.asset_code || props.GlobalID || props.globalid ||
              props.OBJECTID || props.objectid || props.EntityHand || props.entityhand;
    return uid != null && uid !== '' ? (slug + '-' + cat + '-' + uid)
                                     : (slug + '-' + cat + '-' + idx);
  }

  // Build the feature payload for one category (asset_code + tags injected).
  function buildPayload(rawFeatures, slug, villageId, cat) {
    return rawFeatures.map(function (f, i) {
      var props = Object.assign({}, f.properties || {});
      props.asset_code = synthAssetCode(props, slug, cat, i);
      props._village_id = villageId;
      props._category = cat;
      return { type: 'Feature', geometry: f.geometry, properties: props };
    });
  }

  async function importChunks(layerId, payload, onProgress, baseDone, grandTotal) {
    var sb = GIS.sb();
    var done = baseDone;
    for (var i = 0; i < payload.length; i += CHUNK) {
      var slice = payload.slice(i, i + CHUNK);
      GIS._unwrap(await sb.rpc('import_features', { p_layer_id: layerId, p_features: slice }), 'import features');
      done += slice.length;
      if (onProgress) onProgress(done, grandTotal);
    }
    return done;
  }

  GIS.migrate = {

    // Has this village been migrated? (true if any "<village> · *" layer exists)
    isMigrated: async function (villageId) {
      var village = (window.gVillageById && gVillageById[villageId]) || {};
      var name = village.village_name;
      if (!name) return false;
      var sb = GIS.sb();
      var rows = GIS._unwrap(await sb.from('layers').select('id').like('name', name + ' · %').limit(1), 'check migration') || [];
      return rows.length > 0;
    },

    // Migrate one village. opts.onProgress(done, total). Returns a summary.
    village: async function (villageId, opts) {
      opts = opts || {};
      await GIS._requireRole(['admin'], 'migrate villages');
      var byCat = window.gVillageFeatures && window.gVillageFeatures[villageId];
      GIS._assert(byCat && typeof byCat === 'object', 'village not loaded — open it on the map first');
      var village = (window.gVillageById && gVillageById[villageId]) || { village_name: villageId };
      var slug = String(villageId).split('_')[0];

      var cats = Object.keys(byCat);
      var grandTotal = cats.reduce(function (t, c) { return t + byCat[c].length; }, 0);
      var done = 0, layersOut = [];
      var sb = GIS.sb();

      for (var ci = 0; ci < cats.length; ci++) {
        var cat = cats[ci];
        var raw = byCat[cat];
        if (!raw.length) continue;
        var layerName = window.LayerNaming ? LayerNaming.compose(village.village_name, cat) : village.village_name + ' · ' + cat;
        var layerId = GIS._unwrap(await sb.rpc('ensure_layer', {
          p_name: layerName, p_geometry_type: geomTypeOf(raw)
        }), 'ensure layer');
        var payload = buildPayload(raw, slug, villageId, cat);
        done = await importChunks(layerId, payload, opts.onProgress, done, grandTotal);
        layersOut.push({ category: cat, layer_id: layerId, count: raw.length });
      }
      return { village_id: villageId, layers: layersOut, total: done };
    },

    // Import an arbitrary parsed FeatureCollection/array straight into the
    // engine, grouped by properties._category. Used by the upload page so a
    // DWG/Shapefile/GeoJSON upload lands directly in features/layers/fields.
    // villageName → engine layer prefix; slug → asset_code prefix. Admin only.
    importFeatures: async function (villageName, slug, features, opts) {
      opts = opts || {};
      await GIS._requireRole(['admin'], 'import features');
      features = (features && features.features) ? features.features : (features || []);
      GIS._assert(features.length, 'no features to import');

      var byCat = {};
      features.forEach(function (f) {
        var c = (f.properties && f.properties._category) || 'other';
        (byCat[c] = byCat[c] || []).push(f);
      });
      var cats = Object.keys(byCat);
      var grandTotal = features.length, done = 0, layersOut = [];
      var sb = GIS.sb();

      for (var ci = 0; ci < cats.length; ci++) {
        var cat = cats[ci];
        var raw = byCat[cat];
        var layerName = window.LayerNaming ? LayerNaming.compose(villageName, cat) : villageName + ' · ' + cat;
        var layerId = GIS._unwrap(await sb.rpc('ensure_layer', {
          p_name: layerName, p_geometry_type: geomTypeOf(raw)
        }), 'ensure layer');
        var payload = buildPayload(raw, slug, slug, cat);
        done = await importChunks(layerId, payload, opts.onProgress, done, grandTotal);
        layersOut.push({ category: cat, layer_id: layerId, count: raw.length });
      }
      return { village: villageName, layers: layersOut, total: done };
    },

    // Migrate every village currently loaded into memory.
    all: async function (opts) {
      var ids = Object.keys(window.gVillageFeatures || {});
      var out = [];
      for (var i = 0; i < ids.length; i++) out.push(await GIS.migrate.village(ids[i], opts));
      return out;
    }
  };
})();
