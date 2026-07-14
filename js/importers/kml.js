// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — KML / KMZ Importer (standalone module)
//  KML הוא תמיד WGS84 (lon/lat) — אין שלב reproject עבור פורמט זה. ממיר
//  באמצעות js/vendor/togeojson.js (window.toGeoJSON.kmlWithFolders), ששומר
//  את מבנה התיקיות (<Folder>) כעץ — מה שמאפשר לתייג כל פיצ'ר עם שם התיקייה
//  המכילה אותו (_original_layer), בדיוק כמו ש-shapefile.js מתייג לפי שם
//  קובץ ה-.shp. KMZ הוא ZIP שמכיל קובץ .kml אחד (או יותר) — משתמשים ב-JSZip
//  הגלובלי שכבר טעון, ומפעילים את אותה הגנת "פצצת ZIP" של shapefile.js
//  (Importers._checkZipBomb, על אותו window.Importers המשותף).
// ════════════════════════════════════════════════════════════════
(function (window) {
'use strict';

var Importers = window.Importers || {};
window.Importers = Importers;

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

// Walks the { type:'root'|'folder', meta, children } tree that
// toGeoJSON.kmlWithFolders() returns, flattening every Feature it finds and
// tagging it with the name of its NEAREST containing <Folder> (falling back
// to the parent's folder name for features nested more than one level deep,
// and to 'KML' for features at the document root with no folder at all).
function walkFolders(node, folderName, features, sourceLayersSet) {
  (node.children || []).forEach(function (child) {
    if (!child) return;
    if (child.type === 'folder') {
      var name = (child.meta && child.meta.name) ? String(child.meta.name) : (folderName || 'KML');
      walkFolders(child, name, features, sourceLayersSet);
      return;
    }
    if (child.type === 'Feature') {
      if (!child.geometry) return; // Placemark without geometry — nothing to import
      var layerName = folderName || 'KML';
      var props = {};
      var src = child.properties || {};
      Object.keys(src).forEach(function (k) { props[k] = src[k]; });
      props._original_layer = layerName;
      features.push({ type: 'Feature', geometry: child.geometry, properties: props });
      sourceLayersSet[layerName] = true;
    }
  });
}

// Parses KML XML text → { features, detectedCRS:'wgs84', warnings, sourceLayers }.
function parseKmlText(text) {
  if (typeof window.DOMParser !== 'function') {
    throw new Error('DOMParser אינו זמין בדפדפן זה');
  }
  if (!window.toGeoJSON || typeof window.toGeoJSON.kmlWithFolders !== 'function') {
    throw new Error('ספריית המרת KML (togeojson) לא נטענה');
  }

  // A browser's native DOMParser never throws on malformed XML — it returns a
  // document containing a <parsererror> element instead, checked below. Some
  // non-browser DOMParser implementations (e.g. the one used to test this
  // file under Node) throw synchronously instead — normalize both into the
  // same Hebrew error.
  var xml;
  try {
    xml = new window.DOMParser().parseFromString(text, 'text/xml');
  } catch (err) {
    throw new Error('הקובץ אינו KML תקין (שגיאת ניתוח XML): ' + (err && err.message ? err.message : err));
  }
  var parserError = xml && xml.getElementsByTagName && xml.getElementsByTagName('parsererror')[0];
  if (parserError) throw new Error('הקובץ אינו KML תקין (שגיאת ניתוח XML)');

  var tree = window.toGeoJSON.kmlWithFolders(xml);
  var features = [];
  var sourceLayersSet = {};
  walkFolders(tree, null, features, sourceLayersSet);

  if (!features.length) throw new Error('לא נמצאו אובייקטים (Placemark) בעלי גיאומטריה בקובץ ה-KML');

  return {
    features: features,
    detectedCRS: 'wgs84',
    warnings: [],
    sourceLayers: Object.keys(sourceLayersSet)
  };
}
Importers._parseKmlText = parseKmlText; // exposed for tests

Importers.kml = {
  // parse(file) → Promise<{ features, detectedCRS:'wgs84', warnings, sourceLayers }>
  parse: function (file) {
    return readFileText(file).then(function (text) {
      return parseKmlText(text);
    });
  }
};

Importers.kmz = {
  // parse(file) → Promise<{ features, detectedCRS:'wgs84', warnings, sourceLayers }>
  // KMZ = a ZIP containing (at least) one .kml entry — find and parse the first one.
  parse: function (file) {
    if (!window.JSZip) return Promise.reject(new Error('ספריית JSZip לא נטענה'));
    return window.JSZip.loadAsync(file).then(function (zip) {
      // Same decompressed-size zip-bomb guard the shapefile importer uses,
      // shared via the common window.Importers namespace (js/importers/shapefile.js).
      if (typeof Importers._checkZipBomb === 'function') Importers._checkZipBomb(zip);

      var kmlPath = null;
      zip.forEach(function (path, entry) {
        if (!kmlPath && !entry.dir && /\.kml$/i.test(path)) kmlPath = path;
      });
      if (!kmlPath) throw new Error('לא נמצא קובץ KML בתוך ה-KMZ');

      return zip.file(kmlPath).async('string').then(function (text) {
        return parseKmlText(text);
      });
    });
  }
};

})(window);
