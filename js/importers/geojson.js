// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — GeoJSON Importer (standalone module)
//  קורא קובץ GeoJSON/JSON גולמי ומזהה (היוריסטית, בדגימה) האם הקואורדינטות
//  נראות כמו ITM (רשת ישראל) לעומת WGS84 — הזיהוי בפועל מבוצע ע"י שלב
//  ה-reproject ב-ImportPipeline (js/import-pipeline.js), שקורא ל-CRSUtils.
// ════════════════════════════════════════════════════════════════
(function (window) {
'use strict';

var Importers = window.Importers || {};
window.Importers = Importers;

// First numeric [x, y] of any geometry (drills into nested coordinate arrays).
function firstCoord(g) {
  if (!g || !g.coordinates) return null;
  var c = g.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return (Array.isArray(c) && typeof c[0] === 'number') ? c : null;
}

// Samples up to 80 features' first coordinate and classifies the dataset as
// 'itm' | 'wgs84' | 'unknown' based on the ratio that look like each.
function detectCRS(features) {
  var n = 0, itm = 0, wgs = 0;
  for (var i = 0; i < features.length && n < 80; i++) {
    var c = firstCoord(features[i].geometry);
    if (!c) continue;
    n++;
    if (window.CRSUtils && window.CRSUtils.looksLikeITM(c)) itm++;
    else if (Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90) wgs++;
  }
  if (n === 0) return 'unknown';
  if (itm / n > 0.7) return 'itm';
  if (wgs / n > 0.7) return 'wgs84';
  return 'unknown';
}

// Reads a File/Blob as text. Prefers the modern Blob#text() (works the same
// in browsers and in Node test environments) and falls back to FileReader
// for older browsers that only support that.
function readFileText(file) {
  if (file && typeof file.text === 'function') return file.text();
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function (e) { resolve(e.target.result); };
    reader.onerror = function () { reject(new Error('שגיאת קריאת קובץ')); };
    reader.readAsText(file);
  });
}

Importers.geojson = {
  detectCRS: detectCRS, // exposed for tests

  // parse(file) → Promise<{ features, detectedCRS, warnings, sourceLayers }>
  parse: function (file) {
    return readFileText(file).then(function (text) {
      var data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new Error('הקובץ אינו JSON תקין: ' + (err && err.message ? err.message : err));
      }
      if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
        throw new Error('הקובץ אינו GeoJSON תקין');
      }
      return {
        features: data.features,
        detectedCRS: detectCRS(data.features),
        warnings: [],
        sourceLayers: []
      };
    });
  }
};

})(window);
