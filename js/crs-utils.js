// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — CRS Utilities (standalone module)
//  הגדרה יחידה וקנונית של EPSG:2039 (ITM — רשת ישראל החדשה) + עזרים
//  להמרה/זיהוי קואורדינטות. תלוי ב-proj4 הגלובלי שכבר נטען (CDN).
//
//  שימוש:
//    CRSUtils.itmToWgs84(x, y)        → [lng, lat]
//    CRSUtils.wgs84ToItm(lon, lat)    → [x, y]
//    CRSUtils.looksLikeITM([x, y])    → בוליאני (היוריסטיקה לפי טווח)
//    CRSUtils.reprojectFeatureCollection(fc, fromITM) → FeatureCollection חדש
//
//  הערה: js/export-feature.js ו-js/search-feature.js עדיין מחזיקים הגדרות
//  ITM כפולות משלהם — לא נוגעים בהם בשלב הזה (מיגרציה מתוכננת בהמשך).
// ════════════════════════════════════════════════════════════════
(function (window) {
'use strict';

var CRSUtils = window.CRSUtils || {};
window.CRSUtils = CRSUtils;

// EXACT "Israel 1993 to WGS 84 (2)" 7-param Helmert (EPSG:9676) that PROJ/pyproj
// uses (~0.5 m accuracy). The old 3-param -48,55,52 placed imports ~10 m off.
// Keep this string identical across upload.js / export-feature.js / search-feature.js.
var EPSG2039_DEF =
  '+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 ' +
  '+k=1.0000067 +x_0=219529.584 +y_0=626907.39 +ellps=GRS80 ' +
  '+towgs84=23.772,17.49,17.859,-0.3132,-1.85274,1.67299,-5.4262 +units=m +no_defs';

CRSUtils.EPSG2039_DEF = EPSG2039_DEF;

// Heuristic ITM value ranges over the area of use (Israel/Palestine onshore).
// Easting ~120,000–300,000 m, Northing ~380,000–800,000 m (with generous
// margin around the 7 villages' actual ~150,000–780,000 range).
var ITM_X_MIN = 120000, ITM_X_MAX = 300000;
var ITM_Y_MIN = 380000, ITM_Y_MAX = 800000;

var defined = false;

// Registers EPSG:2039 with the global proj4 the first time it's needed.
// Safe to call repeatedly (no-op after the first successful registration).
function ensureDefined() {
  if (defined) return;
  if (!window.proj4) throw new Error('[CRSUtils] proj4 אינו טעון — יש לטעון אותו לפני שימוש ב-CRSUtils');
  if (!window.proj4.defs('EPSG:2039')) {
    window.proj4.defs('EPSG:2039', EPSG2039_DEF);
  }
  defined = true;
}
CRSUtils.ensureDefined = ensureDefined;

// ITM (EPSG:2039) → WGS84 (EPSG:4326). Returns [lng, lat].
CRSUtils.itmToWgs84 = function (x, y) {
  ensureDefined();
  var r = window.proj4('EPSG:2039', 'EPSG:4326', [x, y]);
  return [r[0], r[1]];
};

// WGS84 (EPSG:4326) → ITM (EPSG:2039). Returns [x, y].
CRSUtils.wgs84ToItm = function (lon, lat) {
  ensureDefined();
  var r = window.proj4('EPSG:4326', 'EPSG:2039', [lon, lat]);
  return [r[0], r[1]];
};

// Heuristic: does a single [x, y] pair look like it's in ITM (projected
// meters) rather than WGS84 (degrees)? Used to auto-detect the CRS of files
// that don't declare one explicitly (e.g. bare GeoJSON with no .prj).
CRSUtils.looksLikeITM = function (coords) {
  if (!Array.isArray(coords) || coords.length < 2) return false;
  var x = coords[0], y = coords[1];
  if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return false;
  return x >= ITM_X_MIN && x <= ITM_X_MAX && y >= ITM_Y_MIN && y <= ITM_Y_MAX;
};

function reprojectCoords(coords, fromITM) {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') {
    return fromITM ? CRSUtils.itmToWgs84(coords[0], coords[1]) : CRSUtils.wgs84ToItm(coords[0], coords[1]);
  }
  var out = [];
  for (var i = 0; i < coords.length; i++) out.push(reprojectCoords(coords[i], fromITM));
  return out;
}

// Returns a NEW FeatureCollection with every feature's geometry reprojected.
// fromITM=true converts ITM→WGS84 (the common import case); fromITM=false
// converts WGS84→ITM. Features without geometry/coordinates pass through
// unchanged (shallow-copied).
CRSUtils.reprojectFeatureCollection = function (fc, fromITM) {
  if (!fc || !Array.isArray(fc.features)) return fc;
  var features = fc.features.map(function (f) {
    if (!f || !f.geometry || !f.geometry.coordinates) return f;
    var newGeom = { type: f.geometry.type, coordinates: reprojectCoords(f.geometry.coordinates, fromITM) };
    var copy = {};
    for (var k in f) { if (Object.prototype.hasOwnProperty.call(f, k)) copy[k] = f[k]; }
    copy.geometry = newGeom;
    return copy;
  });
  return { type: 'FeatureCollection', features: features };
};

})(window);
