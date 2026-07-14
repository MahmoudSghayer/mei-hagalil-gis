// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Import Pipeline (standalone module)
//  מארגן את זרימת הייבוא בחמישה שלבים: parse → validate → reproject →
//  mapToLayers → commit. פורמט הפרסרים נרשם ב-window.Importers.<format>
//  (js/importers/*.js); שני השלבים האחרונים הם חילוץ ישיר של הלוגיקה
//  שהייתה קודם מוטמעת ב-js/pages/upload.js (doUpload), כדי שגם היא תהיה
//  ניתנת לבדיקה עצמאית — אך עדיין נקראים משם עם ה-state של הדף (gRules,
//  gLayerStats, GIS.migrate.importFeatures וכו').
// ════════════════════════════════════════════════════════════════
(function (window) {
'use strict';

var ImportPipeline = window.ImportPipeline || {};
window.ImportPipeline = ImportPipeline;

// ── STAGE 1: parse ───────────────────────────────────────────────────────
// Looks up window.Importers[format] at call time (no load-order coupling
// with the importer scripts) and delegates to its parse(file, opts).
ImportPipeline.parse = function (format, file, opts) {
  var parser = window.Importers && window.Importers[format];
  if (!parser || typeof parser.parse !== 'function') {
    return Promise.reject(new Error('[ImportPipeline] אין פרסר רשום לפורמט: ' + format));
  }
  return Promise.resolve(parser.parse(file, opts || {}));
};

// ── STAGE 2: validate ────────────────────────────────────────────────────
var VALID_GEOM_TYPES = {
  Point: 1, MultiPoint: 1, LineString: 1, MultiLineString: 1,
  Polygon: 1, MultiPolygon: 1, GeometryCollection: 1
};

function coordsAreFinite(c) {
  if (typeof c === 'number') return isFinite(c);
  if (Array.isArray(c)) {
    for (var i = 0; i < c.length; i++) { if (!coordsAreFinite(c[i])) return false; }
    return true;
  }
  return false;
}

function sanitizePropertyKey(k) {
  return String(k).trim();
}

// Drops features with missing/invalid geometry, non-finite coordinates, or
// an unrecognised geometry type; trims property keys. Returns a NEW
// { features, detectedCRS, warnings, sourceLayers } — never mutates the input.
ImportPipeline.validate = function (parseResult) {
  parseResult = parseResult || {};
  var warnings = (parseResult.warnings || []).slice();
  var features = [];
  var dropped = 0;

  (parseResult.features || []).forEach(function (f) {
    if (!f || !f.geometry || !f.geometry.type || !VALID_GEOM_TYPES[f.geometry.type]) { dropped++; return; }
    if (f.geometry.type !== 'GeometryCollection') {
      if (!f.geometry.coordinates || !coordsAreFinite(f.geometry.coordinates)) { dropped++; return; }
    }

    var props = {};
    var src = f.properties || {};
    Object.keys(src).forEach(function (k) {
      var key = sanitizePropertyKey(k);
      if (key) props[key] = src[k];
    });

    features.push({ type: 'Feature', geometry: f.geometry, properties: props });
  });

  if (dropped > 0) warnings.push(dropped + ' אובייקטים דולגו (גיאומטריה חסרה/לא תקינה)');

  return {
    features: features,
    detectedCRS: parseResult.detectedCRS || 'unknown',
    warnings: warnings,
    sourceLayers: parseResult.sourceLayers || []
  };
};

// ── STAGE 3: reproject ───────────────────────────────────────────────────
// First numeric [x, y] of any geometry (drills into nested coordinate arrays).
function firstCoord(g) {
  if (!g || !g.coordinates) return null;
  var c = g.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return (Array.isArray(c) && typeof c[0] === 'number') ? c : null;
}

// Samples up to 80 features; true if >70% of sampled first-coordinates look
// like ITM per CRSUtils.looksLikeITM. Used only for detectedCRS === 'unknown'.
function sampleLooksLikeITM(features) {
  var n = 0, itm = 0;
  for (var i = 0; i < features.length && n < 80; i++) {
    var c = firstCoord(features[i].geometry);
    if (!c) continue;
    n++;
    if (window.CRSUtils && window.CRSUtils.looksLikeITM(c)) itm++;
  }
  return n > 0 && (itm / n) > 0.7;
}
ImportPipeline._sampleLooksLikeITM = sampleLooksLikeITM; // exposed for tests

// Reprojects ITM → WGS84 via CRSUtils when detectedCRS is 'itm', or when
// it's 'unknown' but the coordinates sampled from the data look like ITM.
// Otherwise passes features through unchanged (e.g. already-WGS84 data, or
// shapefile/DWG parsers that already converted internally).
ImportPipeline.reproject = function (validated) {
  validated = validated || {};
  var features = validated.features || [];
  var warnings = (validated.warnings || []).slice();

  var shouldReproject = validated.detectedCRS === 'itm';
  if (!shouldReproject && validated.detectedCRS === 'unknown') {
    shouldReproject = sampleLooksLikeITM(features);
  }

  if (!shouldReproject) {
    return {
      features: features,
      detectedCRS: validated.detectedCRS,
      warnings: warnings,
      sourceLayers: validated.sourceLayers || [],
      reprojected: false
    };
  }

  var fc = window.CRSUtils.reprojectFeatureCollection({ type: 'FeatureCollection', features: features }, true);
  warnings.push('קואורדינטות זוהו כ-ITM (רשת ישראל) ובוצעה המרה אוטומטית ל-WGS84');

  return {
    features: fc.features,
    detectedCRS: validated.detectedCRS,
    warnings: warnings,
    sourceLayers: validated.sourceLayers || [],
    reprojected: true
  };
};

// Convenience: parse → validate → reproject in one call.
ImportPipeline.run = function (format, file, opts) {
  return ImportPipeline.parse(format, file, opts).then(function (parsed) {
    return ImportPipeline.reproject(ImportPipeline.validate(parsed));
  });
};

// ── Shared layer-name resolution (also used by upload.js's layer-mapping UI) ──
// Same precedence the app has always used: explicit "Layer" attribute (any
// casing) from CAD/shapefile exports, else a previously-tagged _original_layer
// / _category, else 'UNKNOWN'.
ImportPipeline.getLayerName = function (feature) {
  var props = (feature && feature.properties) || {};
  var layerName = props.Layer || props.layer || props.LAYER || props._original_layer || props._category || 'UNKNOWN';
  return String(layerName).trim() || 'UNKNOWN';
};

// ── STAGE 4: mapToLayers ─────────────────────────────────────────────────
// Groups features by detected village + resolved category, matching the
// mapping-rules-driven tagging that used to live inline in upload.js's
// doUpload(). Pure function — no DOM, no network.
//
// opts:
//   layerStats           { [layerName]: { mapping: categoryValue, ... } }
//   detectFeatureVillage  function(feature) → village|null
//   overrideVillage       village object|null — forces every feature into it
//
// Returns { taggedByVillage: { [slug]: { village, features, categoryCounts } }, ignoredCount }
ImportPipeline.mapToLayers = function (features, opts) {
  opts = opts || {};
  var layerStats = opts.layerStats || {};
  var detectFeatureVillage = opts.detectFeatureVillage;
  var overrideVillage = opts.overrideVillage || null;

  var taggedByVillage = {};
  var ignoredCount = 0;

  (features || []).forEach(function (f) {
    var layerName = ImportPipeline.getLayerName(f);
    var stats = layerStats[layerName];
    if (!stats || stats.mapping === 'IGNORE') { ignoredCount++; return; }

    var targetVillage = overrideVillage || (detectFeatureVillage ? detectFeatureVillage(f) : null);
    if (!targetVillage) { ignoredCount++; return; }

    var slug = targetVillage.slug;
    if (!taggedByVillage[slug]) taggedByVillage[slug] = { village: targetVillage, features: [], categoryCounts: {} };

    var newProps = Object.assign({}, f.properties || {});
    newProps._category = stats.mapping;
    newProps._original_layer = layerName;
    taggedByVillage[slug].categoryCounts[stats.mapping] = (taggedByVillage[slug].categoryCounts[stats.mapping] || 0) + 1;
    taggedByVillage[slug].features.push({ type: 'Feature', geometry: f.geometry, properties: newProps });
  });

  return { taggedByVillage: taggedByVillage, ignoredCount: ignoredCount };
};

// ── STAGE 5: commit ──────────────────────────────────────────────────────
// Batched import into the GIS engine, one village at a time — the same loop
// that used to live inline in upload.js's doUpload(). Delegates the actual
// Supabase write to opts.importFeatures (i.e. GIS.migrate.importFeatures);
// this module never talks to Supabase directly (rule: UI/pipeline → GIS.*).
//
// opts:
//   importFeatures  async function(villageName, slug, features, { onProgress }) → { total, ... }
//   onVillageStart  function(village, index, totalVillages, featureCount)  — optional, before each village
//   onProgress      function(village, done, total)                        — optional, during each village
//
// Returns { totalAdded, slugs, results: [{ slug, village, summary }] }
ImportPipeline.commit = async function (taggedByVillage, opts) {
  opts = opts || {};
  var importFn = opts.importFeatures;
  if (typeof importFn !== 'function') throw new Error('[ImportPipeline] commit דורש opts.importFeatures');

  var slugs = Object.keys(taggedByVillage || {});
  var totalAdded = 0;
  var results = [];

  for (var i = 0; i < slugs.length; i++) {
    var slug = slugs[i];
    var vData = taggedByVillage[slug];

    if (opts.onVillageStart) opts.onVillageStart(vData.village, i, slugs.length, vData.features.length);

    var onProgress = opts.onProgress ? (function (village) {
      return function (done, total) { opts.onProgress(village, done, total); };
    })(vData.village) : undefined;

    var summary = await importFn(vData.village.name, vData.village.slug, vData.features, { onProgress: onProgress });
    totalAdded += summary.total;
    results.push({ slug: slug, village: vData.village, summary: summary });
  }

  return { totalAdded: totalAdded, slugs: slugs, results: results };
};

})(window);
