// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — meters.js   →   GIS.meters
//  Arad water-meter integration. Meters live in their own table, separate
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

  // Whitelist of villages we report for a meter. The customer file's כתובת
  // column is free text (e.g. "שכונת אלעין דייר חנא", "מד מס' 1 דייר חנא"); we
  // reduce it to one of these canonical names. Matching is spelling-tolerant
  // (see normHe — collapses doubled yod/vav, strips gershayim), so address
  // spellings like "דייר חנא" still resolve to "דיר חנא".
  var VILLAGES = [
    'סחנין', 'עראבה', 'דיר חנא', 'נחף', 'דיר אלאסד', 'בענה', 'מגד אלכרום'
  ];

  function normHe(s) {
    return String(s == null ? '' : s)
      .replace(/['"׳״’`]/g, '')   // strip geresh / gershayim / quotes
      .replace(/יי/g, 'י')         // collapse doubled yod  (דייר → דיר)
      .replace(/וו/g, 'ו')         // collapse doubled vav
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Extract the canonical village name from a free-text address, or null.
  function extractVillage(address) {
    var hay = normHe(address);
    if (!hay) return null;
    for (var i = 0; i < VILLAGES.length; i++) {
      if (hay.indexOf(normHe(VILLAGES[i])) !== -1) return VILLAGES[i];
    }
    return null;
  }

  // Normalise one raw meter record (CSV row / JSON object / Arad payload)
  // into the engine's canonical shape consumed by the import_meters RPC.
  // Accepts both English keys and the Hebrew column headers exported by the
  // Arad customer file. Columns with no first-class DB column (consumer name,
  // phone, zone, transmitter id, reading time, village…) ride along in
  // raw_data, which import_meters merges and meters_geojson spreads back into
  // the map properties — so no schema change is needed to surface them.
  function normalize(raw) {
    // Header keys in Arad/Excel exports often carry invisible bidi marks
    // (RLM/LRM), zero-width chars, NBSP or gershayim, so a literal lookup of a
    // Hebrew column name can miss. Build a cleaned-key index and fall back to
    // it, so "מספר מונה" matches regardless of such noise.
    var cleanKey = function (k) {
      return String(k == null ? '' : k)
        .replace(/[‎‏‪-‮⁦-⁩﻿​-‍]/g, '') // bidi / zero-width
        .replace(/['"׳״’`]/g, '')   // geresh / gershayim / quotes
        .replace(/ /g, ' ')     // NBSP → space
        .replace(/\s+/g, ' ')
        .trim();
    };
    var byClean = {};
    Object.keys(raw).forEach(function (k) {
      var ck = cleanKey(k);
      if (byClean[ck] === undefined) byClean[ck] = raw[k];
    });
    var pick = function () {
      for (var i = 0; i < arguments.length; i++) {
        var k = arguments[i];
        var v = raw[k];
        if (v === undefined || v === null || v === '') v = byClean[cleanKey(k)];
        if (v !== undefined && v !== null && v !== '') return v;
      }
      return null;
    };
    var lng = pick('lng', 'lon', 'longitude', 'x', 'X', 'קו אורך');
    var lat = pick('lat', 'latitude', 'y', 'Y', 'קו רוחב');
    var out = {
      // מספר מונה = the unique Arad meter id (per product decision).
      arad_meter_id: pick('arad_meter_id', 'meter_id', 'meterId', 'id', 'serial', 'מספר מונה'),
      customer_id: pick('customer_id', 'customerId', 'customer', 'מספר צרכן'),
      asset_code: pick('asset_code', 'assetCode', 'asset'),
      last_reading: pick('last_reading', 'reading', 'lastReading', 'קריאה אחרונה(קוב)', 'קריאה אחרונה (קוב)', 'קריאה אחרונה'),
      consumption: pick('consumption', 'usage'),
      status: pick('status') || 'active',
      install_date: pick('install_date', 'installDate'),
      raw_data: raw.raw_data || {}
    };
    if (lng !== null && lat !== null) { out.lng = Number(lng); out.lat = Number(lat); }
    if (!out.arad_meter_id) throw new Error('[GIS.meters] record is missing arad_meter_id (מספר מונה). עמודות שזוהו: ' + Object.keys(raw).map(cleanKey).join(' | '));

    // Hebrew-file extras → raw_data (only when present, never clobber existing).
    var extra = {};
    var addRaw = function (key, val) {
      if (val !== null && val !== undefined && val !== '' && extra[key] === undefined) extra[key] = val;
    };
    addRaw('record_id', pick('record_id', 'מס זיהוי', 'מספר זיהוי'));
    addRaw('transmitter_id', pick('transmitter_id', 'מספר משדר'));
    addRaw('customer_name', pick('customer_name', 'שם צרכן'));
    addRaw('phone', pick('phone', 'טלפון'));
    addRaw('zone', pick('zone', 'אזור'));
    addRaw('last_reading_time', pick('last_reading_time', 'זמן קריאה אחרונה'));
    var address = pick('address', 'כתובת');
    if (address) {
      addRaw('address', address);
      var village = extractVillage(address);
      if (village) addRaw('village', village);
    }
    out.raw_data = Object.assign({}, raw.raw_data || {}, extra);
    return out;
  }

  GIS.meters = {

    // All meters as a GeoJSON FeatureCollection (RPC). Read = any authed user.
    // p_limit must be passed explicitly — the RPC defaults to 20000, which
    // silently truncates large fleets (e.g. 32k meters over 7 villages).
    // NOTE: meters_geojson only returns rows WHERE geometry IS NOT NULL, so a
    // meter imported without recognised lat/lng columns will never appear here.
    getMeters: async function (limit) {
      var sb = GIS.sb();
      var fc = GIS._unwrap(await sb.rpc('meters_geojson', { p_limit: limit || 200000 }), 'load meters');
      return fc || GIS.emptyFC();
    },

    // Diagnostic: how many meters exist vs how many carry a location. Lets the
    // UI explain "imported but not on the map" (no geometry) vs an empty table.
    countMeters: async function () {
      var sb = GIS.sb();
      var total = await sb.from('meters').select('id', { count: 'exact', head: true });
      if (total.error) throw new Error('[GIS] count meters: ' + total.error.message);
      var withGeom = await sb.from('meters').select('id', { count: 'exact', head: true }).not('geometry', 'is', null);
      if (withGeom.error) throw new Error('[GIS] count located meters: ' + withGeom.error.message);
      return { total: total.count || 0, located: withGeom.count || 0 };
    },

    // Meters linked to a given asset_code (plain rows).
    getForAsset: async function (assetCode) {
      if (!assetCode) return [];
      var sb = GIS.sb();
      return GIS._unwrap(
        await sb.from('meters').select('*').eq('asset_code', assetCode), 'load meters') || [];
    },

    // Import / upsert meters. `data` = array of raw records (CSV/JSON parsed).
    // Admin only (RLS). Returns { inserted, updated, total, skipped }.
    // Rows with no מספר מונה (arad_meter_id) are skipped rather than failing the
    // whole batch — Arad/Excel exports often carry a totals/footer row or stray
    // blank line that has no meter id.
    // Sent to the RPC in chunks so a large file never exceeds the DB
    // statement_timeout (the import_meters RPC upserts row-by-row).
    // opts.onProgress(done, total) is called after each chunk so the import
    // page can show a live progress bar (a 32k-meter file is ~100 RPC calls).
    importMeters: async function (data, source, opts) {
      GIS._assert(Array.isArray(data), 'importMeters expects an array of records');
      await GIS._requireRole(['admin'], 'import meters');
      opts = opts || {};
      var rows = [], skipped = 0;
      for (var i = 0; i < data.length; i++) {
        try { rows.push(normalize(data[i])); }
        catch (e) { skipped++; }
      }
      if (!rows.length) {
        throw new Error('[GIS.meters] לא נמצאו רשומות תקינות — כל השורות חסרות מספר מונה. עמודות שזוהו: '
          + Object.keys(data[0] || {}).join(' | '));
      }
      var sb = GIS.sb();
      var CHUNK = GIS.config.importChunkSize || 300;
      var agg = { inserted: 0, updated: 0, total: 0 };
      var done = 0;
      for (var j = 0; j < rows.length; j += CHUNK) {
        var batch = rows.slice(j, j + CHUNK);
        var r = GIS._unwrap(await sb.rpc('import_meters', {
          p_meters: batch, p_source: source || 'import'
        }), 'import meters') || {};
        agg.inserted += (r.inserted || 0);
        agg.updated += (r.updated || 0);
        agg.total += (r.total || 0);
        done += batch.length;
        if (opts.onProgress) { try { opts.onProgress(done, rows.length); } catch (e) {} }
      }
      agg.skipped = skipped;
      return agg;
    },

    // Future-ready sync. If GIS.config.aradSyncUrl is set, pulls the latest
    // readings from the Arad endpoint and upserts them; otherwise re-links any
    // meters that are missing an asset_code by spatial proximity. Logs to
    // sync_logs (via importMeters / a sync_logs row). Admin only.
    syncMeters: async function () {
      await GIS._requireRole(['admin'], 'sync meters');
      if (GIS.config.aradSyncUrl) {
        var headers = { 'Accept': 'application/json' };
        if (GIS.config.aradSyncToken) headers.Authorization = 'Bearer ' + GIS.config.aradSyncToken;
        var resp = await fetch(GIS.config.aradSyncUrl, { headers: headers });
        if (!resp.ok) throw new Error('[GIS.meters] Arad sync failed: HTTP ' + resp.status);
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
