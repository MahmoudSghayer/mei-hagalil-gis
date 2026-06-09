// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — meters.js   →   GIS.meters
//  ARad water-meter integration. Meters live in their own table, separate
//  from GIS features, and are EDITABLE ONLY BY ADMIN (enforced by RLS).
//
//  Linking a meter to a GIS feature, in priority order:
//      1. asset_code      (primary)
//      2. customer_id      (secondary — matched to a feature carrying it)
//      3. spatial proximity (fallback — nearest feature within radius)
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var GIS = window.GIS;
  GIS._assert(GIS, 'core.js must load before meters.js');

  // Normalise one raw meter record (CSV row / JSON object / ARad payload)
  // into the engine's canonical shape consumed by the import_meters RPC.
  function normalize(raw) {
    var pick = function () {
      for (var i = 0; i < arguments.length; i++) {
        var k = arguments[i];
        if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];
      }
      return null;
    };
    var lng = pick('lng', 'lon', 'longitude', 'x', 'X');
    var lat = pick('lat', 'latitude', 'y', 'Y');
    var out = {
      arad_meter_id: pick('arad_meter_id', 'meter_id', 'meterId', 'id', 'serial'),
      customer_id: pick('customer_id', 'customerId', 'customer'),
      asset_code: pick('asset_code', 'assetCode', 'asset'),
      last_reading: pick('last_reading', 'reading', 'lastReading'),
      consumption: pick('consumption', 'usage'),
      status: pick('status') || 'active',
      install_date: pick('install_date', 'installDate'),
      raw_data: raw.raw_data || {}
    };
    if (lng !== null && lat !== null) { out.lng = Number(lng); out.lat = Number(lat); }
    if (!out.arad_meter_id) throw new Error('[GIS.meters] record is missing arad_meter_id');
    return out;
  }

  GIS.meters = {

    // All meters as a GeoJSON FeatureCollection (RPC). Read = any authed user.
    getMeters: async function () {
      var sb = GIS.sb();
      var fc = GIS._unwrap(await sb.rpc('meters_geojson', {}), 'load meters');
      return fc || GIS.emptyFC();
    },

    // Meters linked to a given asset_code (plain rows).
    getForAsset: async function (assetCode) {
      if (!assetCode) return [];
      var sb = GIS.sb();
      return GIS._unwrap(
        await sb.from('meters').select('*').eq('asset_code', assetCode), 'load meters') || [];
    },

    // Import / upsert meters. `data` = array of raw records (CSV/JSON parsed).
    // Admin only (RLS). Returns { inserted, updated, total }.
    importMeters: async function (data, source) {
      GIS._assert(Array.isArray(data), 'importMeters expects an array of records');
      await GIS._requireRole(['admin'], 'import meters');
      var rows = data.map(normalize);
      var sb = GIS.sb();
      return GIS._unwrap(await sb.rpc('import_meters', {
        p_meters: rows, p_source: source || 'import'
      }), 'import meters');
    },

    // Future-ready sync. If GIS.config.aradSyncUrl is set, pulls the latest
    // readings from the ARad endpoint and upserts them; otherwise re-links any
    // meters that are missing an asset_code by spatial proximity. Logs to
    // sync_logs (via importMeters / a sync_logs row). Admin only.
    syncMeters: async function () {
      await GIS._requireRole(['admin'], 'sync meters');
      if (GIS.config.aradSyncUrl) {
        var headers = { 'Accept': 'application/json' };
        if (GIS.config.aradSyncToken) headers.Authorization = 'Bearer ' + GIS.config.aradSyncToken;
        var resp = await fetch(GIS.config.aradSyncUrl, { headers: headers });
        if (!resp.ok) throw new Error('[GIS.meters] ARad sync failed: HTTP ' + resp.status);
        var payload = await resp.json();
        var records = Array.isArray(payload) ? payload : (payload.meters || payload.data || []);
        return GIS.meters.importMeters(records, 'arad-api');
      }
      // No endpoint configured → proximity re-link pass.
      var fc = await GIS.meters.getMeters();
      var relinked = 0;
      for (var i = 0; i < fc.features.length; i++) {
        var m = fc.features[i];
        if (m.properties.asset_code) continue;
        var match = await GIS.meters.resolveLink(m);
        if (match) { await GIS.meters.linkMeterToFeature({ id: m.properties.__id }, match); relinked++; }
      }
      return { relinked: relinked, source: 'proximity' };
    },

    // Resolve which feature a meter should link to (asset_code → customer_id
    // → nearest feature within radius). Returns a feature-ish { asset_code }.
    resolveLink: async function (meter) {
      var props = meter.properties || meter;
      // 1. asset_code already present
      if (props.asset_code) return { asset_code: props.asset_code };
      var sb = GIS.sb();
      // 2. customer_id → a feature whose properties carry the same customer_id
      if (props.customer_id) {
        var byCust = GIS._unwrap(await sb.from('features')
          .select('asset_code').eq('properties->>customer_id', props.customer_id).limit(1), 'link by customer') || [];
        if (byCust.length) return { asset_code: byCust[0].asset_code };
      }
      // 3. spatial proximity → nearest meter/feature. Here we use the meter's
      //    own coordinates to find a nearby feature via PostGIS would need an
      //    RPC; for the fallback we match the nearest EXISTING meter's asset.
      var g = meter.geometry || (meter.type === 'Feature' ? meter.geometry : null);
      if (g && g.coordinates) {
        var near = GIS._unwrap(await sb.rpc('meters_near', {
          p_lng: g.coordinates[0], p_lat: g.coordinates[1], p_radius_m: GIS.config.linkRadiusMeters
        }), 'link by proximity') || [];
        var withAsset = near.find(function (x) { return x.asset_code; });
        if (withAsset) return { asset_code: withAsset.asset_code };
      }
      return null;
    },

    // Set a meter's asset_code from a feature (primary link). Admin only.
    linkMeterToFeature: async function (meter, feature) {
      GIS._assert(meter && (meter.id || meter.arad_meter_id), 'linkMeterToFeature requires a meter with id');
      GIS._assert(feature && feature.asset_code, 'linkMeterToFeature requires a feature with asset_code');
      await GIS._requireRole(['admin'], 'link meters');
      var sb = GIS.sb();
      var q = sb.from('meters').update({ asset_code: feature.asset_code, updated_at: new Date().toISOString() });
      q = meter.id ? q.eq('id', meter.id) : q.eq('arad_meter_id', meter.arad_meter_id);
      return GIS._unwrap(await q.select().single(), 'link meter');
    },

    // Update meter scalar attributes (reading/consumption/status/customer...).
    // Admin only (RLS). Geometry changes go through importMeters.
    updateMeter: async function (id, data) {
      GIS._assert(id && data, 'updateMeter requires (id, data)');
      await GIS._requireRole(['admin'], 'edit meters');
      var allowed = ['customer_id', 'asset_code', 'last_reading', 'consumption', 'status', 'install_date', 'raw_data'];
      var patch = { updated_at: new Date().toISOString() };
      allowed.forEach(function (k) { if (data[k] !== undefined) patch[k] = data[k]; });
      var sb = GIS.sb();
      return GIS._unwrap(
        await sb.from('meters').update(patch).eq('id', id).select().single(), 'update meter');
    },

    // Lightweight anomaly detection: meters > 1.5× average consumption.
    getAnomalies: async function () {
      var sb = GIS.sb();
      return GIS._unwrap(await sb.from('v_meter_anomalies').select('*'), 'load anomalies') || [];
    }
  };
})();
