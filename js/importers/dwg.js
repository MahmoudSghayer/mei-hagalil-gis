// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — DWG Importer (standalone module)
//  עוטף את window.dwgToGeoJSON (js/backend-client.js) בממשק הפרסר האחיד.
//  השרת כבר מבצע reprojection ל-target_crs (ברירת מחדל WGS84) — אין צורך
//  בשלב reproject נוסף בצד הלקוח.
// ════════════════════════════════════════════════════════════════
(function (window) {
'use strict';

var Importers = window.Importers || {};
window.Importers = Importers;

Importers.dwg = {
  // parse(file, opts) → Promise<{ features, detectedCRS, warnings, sourceLayers }>
  // opts.dwgOptions is forwarded to dwgToGeoJSON as-is (e.g. { sourceCrs, targetCrs }).
  // opts.onProgress(stage, pct, msg) is forwarded as the conversion progress callback.
  parse: function (file, opts) {
    opts = opts || {};
    if (typeof window.dwgToGeoJSON !== 'function') {
      return Promise.reject(new Error('שירות המרת DWG לא נטען'));
    }
    return window.dwgToGeoJSON(file, opts.dwgOptions || {}, opts.onProgress).then(function (data) {
      if (!data || !Array.isArray(data.features) || !data.features.length) {
        throw new Error('לא נמצאו אובייקטים בקובץ ה-DWG');
      }
      return {
        features: data.features,
        detectedCRS: 'wgs84', // server already reprojects to targetCrs (default WGS84)
        warnings: [],
        sourceLayers: []
      };
    });
  }
};

})(window);
