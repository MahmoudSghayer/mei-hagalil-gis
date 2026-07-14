// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — General CSV Importer (standalone module)
//  קובץ CSV גנרי עם עמודות X/Y (או WKT) בפורמט לא ידוע מראש — לא ניתן לזהות
//  אוטומטית אילו עמודות הן קואורדינטות בלי קלט מהמשתמש. parse() לכן מחזיר
//  סמן {needsMapping:true, headers, rows, preview, guess} במקום התוצאה
//  הרגילה; js/pages/upload.js מציג ממשק מיפוי עמודות קטן (בעברית), ורק
//  לאחר אישור המשתמש קורא ל-buildFeatures() כדי לקבל
//  {features, detectedCRS, warnings, sourceLayers} ולהמשיך את הצנרת הרגילה
//  (ImportPipeline.validate → reproject → ...).
//
//  הערה: זהו מנתח CSV *כללי* (כל עמודות/כל שכבה) — נפרד מ-
//  js/pages/gis-meters-import.js, שמייעד לפורמט מדי Arad הספציפי ומייבא
//  ישירות דרך GIS.meters.importMeters. לא נוגעים בקובץ ההוא.
// ════════════════════════════════════════════════════════════════
(function (window) {
'use strict';

var Importers = window.Importers || {};
window.Importers = Importers;

var MAX_ROWS = 50000;

// Reads a File/Blob as text (same helper pattern as js/importers/geojson.js).
function readFileText(file) {
  if (file && typeof file.text === 'function') return file.text();
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function (e) { resolve(e.target.result); };
    reader.onerror = function () { reject(new Error('שגיאת קריאת קובץ')); };
    reader.readAsText(file);
  });
}

// Quoted-CSV parser: handles quoted fields, embedded commas/newlines, ""
// escaping, and CRLF/LF line endings. Adapted from the parser in
// js/pages/gis-meters-import.js (that file is page-scoped, not a standalone
// module, so the logic is duplicated here rather than shared/imported).
function parseCsvTable(text) {
  text = String(text).replace(/^﻿/, ''); // strip BOM
  var rows = [], row = [], field = '', inQ = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
Importers._parseCsvTable = parseCsvTable; // exposed for tests

// Auto-guesses a column index by header name against a priority-ordered
// candidate list (case-insensitive, trimmed). Returns -1 when none match.
function guessColumn(headers, candidates) {
  var upper = headers.map(function (h) { return String(h).trim().toLowerCase(); });
  for (var c = 0; c < candidates.length; c++) {
    var idx = upper.indexOf(candidates[c].toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

var LON_CANDIDATES   = ['lon', 'lng', 'long', 'longitude', 'x', 'קו אורך', 'קו_אורך', 'קו אורך (x)'];
var LAT_CANDIDATES   = ['lat', 'latitude', 'y', 'קו רוחב', 'קו_רוחב', 'קו רוחב (y)'];
var WKT_CANDIDATES   = ['wkt', 'geometry', 'geom', 'geometry_wkt'];
var LAYER_CANDIDATES = ['layer', 'layer_name', 'שכבה', 'category', 'קטגוריה'];

Importers.csv = {
  MAX_ROWS: MAX_ROWS,       // exposed for tests / UI messaging
  guessColumn: guessColumn, // exposed for tests

  // parse(file) → Promise<{ needsMapping:true, headers, rows, preview, guess }>
  // `rows` is an array of objects keyed by header (raw string values, trimmed).
  // `guess` holds auto-guessed column INDEXES (into `headers`) for lon/lat/wkt/layer,
  // -1 when nothing matched — upload.js pre-selects these in the mapping UI.
  parse: function (file) {
    return readFileText(file).then(function (text) {
      var table = parseCsvTable(text);
      if (table.length < 2) throw new Error('קובץ CSV חייב לכלול שורת כותרת ולפחות רשומה אחת');

      var headers = table[0].map(function (h) { return String(h).trim(); });
      var dataRows = table.slice(1).filter(function (r) {
        return r.some(function (v) { return String(v).trim() !== ''; });
      });
      if (dataRows.length > MAX_ROWS) {
        throw new Error('קובץ ה-CSV חורג מהמותר: ' + dataRows.length + ' רשומות (מקסימום ' + MAX_ROWS + ')');
      }

      var rows = dataRows.map(function (r) {
        var obj = {};
        headers.forEach(function (h, idx) { obj[h] = (r[idx] !== undefined ? String(r[idx]).trim() : ''); });
        return obj;
      });

      return {
        needsMapping: true,
        headers: headers,
        rows: rows,
        preview: rows.slice(0, 20),
        guess: {
          lon: guessColumn(headers, LON_CANDIDATES),
          lat: guessColumn(headers, LAT_CANDIDATES),
          wkt: guessColumn(headers, WKT_CANDIDATES),
          layer: guessColumn(headers, LAYER_CANDIDATES)
        }
      };
    });
  },

  // buildFeatures(rows, opts) → { features, detectedCRS, warnings, sourceLayers }
  // opts: { lonCol, latCol, wktCol, layerCol, crs: 'wgs84'|'itm' }
  // Called by upload.js AFTER the user confirms the column-mapping UI (parse()
  // alone can't know which columns are which). Output feeds straight into
  // ImportPipeline.validate()/.reproject() exactly like every other importer's
  // parse() result — detectedCRS is whatever the user picked on the CRS radio,
  // not auto-detected (the user told us explicitly).
  buildFeatures: function (rows, opts) {
    return buildFeatures(rows, opts);
  },

  // Exposed for tests / potential reuse — see parseWKT() below.
  parseWKT: function (wkt) { return parseWKT(wkt); }
};

function coordNum(v) {
  var n = parseFloat(String(v == null ? '' : v).trim().replace(',', '.'));
  return isFinite(n) ? n : null;
}

function buildFeatures(rows, opts) {
  opts = opts || {};
  var useWkt = !!opts.wktCol;
  var warnings = [];
  var features = [];
  var sourceLayersSet = {};
  var skipped = 0;

  (rows || []).forEach(function (row) {
    var geometry = null;

    if (useWkt) {
      var raw = row[opts.wktCol];
      if (!raw || !String(raw).trim()) { skipped++; return; }
      try { geometry = parseWKT(raw); } catch (e) { skipped++; return; }
    } else {
      var lon = coordNum(row[opts.lonCol]);
      var lat = coordNum(row[opts.latCol]);
      if (lon === null || lat === null) { skipped++; return; }
      geometry = { type: 'Point', coordinates: [lon, lat] };
    }

    var props = {};
    Object.keys(row).forEach(function (k) {
      if (k === opts.lonCol || k === opts.latCol || k === opts.wktCol) return; // redundant with geometry
      props[k] = row[k];
    });
    var layerName = (opts.layerCol && row[opts.layerCol]) ? String(row[opts.layerCol]).trim() : '';
    if (!layerName) layerName = 'CSV';
    props._original_layer = layerName;
    sourceLayersSet[layerName] = true;

    features.push({ type: 'Feature', geometry: geometry, properties: props });
  });

  if (skipped > 0) warnings.push(skipped + ' שורות דולגו (קואורדינטות/WKT חסרים או לא תקינים)');

  return {
    features: features,
    detectedCRS: opts.crs === 'itm' ? 'itm' : 'wgs84',
    warnings: warnings,
    sourceLayers: Object.keys(sourceLayersSet)
  };
}

// ── WKT (Well-Known Text) parser — POINT / LINESTRING / POLYGON only ───────
// The inverse of toWKT() in js/export-formats.js (which only ever emits those
// geometry types' WKT verbatim without extra whitespace normalization beyond
// ', ' between coordinate pairs — this parser is intentionally lenient about
// whitespace since hand-authored/exported-elsewhere WKT can vary).

// Splits a string on `sep` only at paren-depth 0 (doesn't split inside nested
// parens) — used to separate POLYGON's ring list and each ring's coord list.
function splitTopLevel(s, sep) {
  var parts = [], depth = 0, cur = '';
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; }
    else cur += c;
  }
  parts.push(cur);
  return parts;
}

function parseCoordPair(s) {
  var nums = s.trim().split(/\s+/).map(Number);
  if (nums.length < 2 || !isFinite(nums[0]) || !isFinite(nums[1])) {
    throw new Error('קואורדינטה לא תקינה ב-WKT: "' + s + '"');
  }
  return [nums[0], nums[1]];
}

function parseCoordList(s) {
  var parts = splitTopLevel(s.trim(), ',');
  return parts.map(parseCoordPair);
}

function stripOuterParens(s) {
  s = s.trim();
  if (s.charAt(0) !== '(' || s.charAt(s.length - 1) !== ')') {
    throw new Error('WKT לא תקין: חסרים סוגריים ב-"' + s + '"');
  }
  return s.slice(1, -1);
}

function parsePolygonRings(body) {
  var ringStrs = splitTopLevel(body.trim(), ',');
  return ringStrs.map(function (r) { return parseCoordList(stripOuterParens(r)); });
}

// parseWKT(wkt) → GeoJSON geometry ({type:'Point'|'LineString'|'Polygon', coordinates})
// Throws a Hebrew error for unsupported types (e.g. MULTIPOINT) or malformed input.
function parseWKT(wkt) {
  if (!wkt || typeof wkt !== 'string') throw new Error('WKT ריק או לא תקין');
  var m = wkt.trim().match(/^([A-Za-z]+)\s*\(([\s\S]*)\)\s*$/);
  if (!m) throw new Error('WKT לא תקין: "' + wkt + '"');
  var type = m[1].toUpperCase();
  var body = m[2];

  if (type === 'POINT') return { type: 'Point', coordinates: parseCoordPair(body) };
  if (type === 'LINESTRING') return { type: 'LineString', coordinates: parseCoordList(body) };
  if (type === 'POLYGON') return { type: 'Polygon', coordinates: parsePolygonRings(body) };
  throw new Error('סוג גיאומטריית WKT לא נתמך: ' + type);
}
Importers._parseWKT = parseWKT; // exposed for tests

})(window);
