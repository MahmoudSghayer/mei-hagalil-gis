// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Shapefile (ZIP) Importer (standalone module)
//  קורא ZIP עם shapefile אחד או יותר (.shp/.dbf/.prj), מפענח DBF בעצמו
//  (תומך בסוג F/Float ש-shapefile.js מתעלם ממנו), מזהה CRS מתוך .prj
//  וממיר ל-WGS84 באמצעות CRSUtils כשצריך. כולל הגנת "פצצת ZIP".
// ════════════════════════════════════════════════════════════════
(function (window) {
'use strict';

var Importers = window.Importers || {};
window.Importers = Importers;

// ── ZIP-bomb guard ──────────────────────────────────────────────────────────
// Sums declared uncompressed size of every entry BEFORE extracting anything.
// JSZip parses the ZIP's local/central-directory headers on loadAsync(), so
// `_data.uncompressedSize` reflects the size a crafted entry CLAIMS it will
// expand to — exactly what a zip-bomb lies about — without us having to
// decompress a single byte to find out.
var ZIP_BOMB_TOTAL_CAP = 300 * 1024 * 1024;  // 300MB combined
var ZIP_BOMB_ENTRY_CAP = 150 * 1024 * 1024;  // 150MB per entry

function entryUncompressedSize(entry) {
  return (entry && entry._data && typeof entry._data.uncompressedSize === 'number')
    ? entry._data.uncompressedSize : 0;
}

function checkZipBomb(zip) {
  var total = 0;
  var offenders = [];
  zip.forEach(function (relPath, entry) {
    if (entry.dir) return;
    var size = entryUncompressedSize(entry);
    total += size;
    if (size > ZIP_BOMB_ENTRY_CAP) offenders.push(relPath);
  });
  if (offenders.length) {
    throw new Error('קובץ בתוך ה-ZIP חורג מהגודל המקסימלי המותר לאחר פריסה (150MB): ' + offenders.join(', '));
  }
  if (total > ZIP_BOMB_TOTAL_CAP) {
    throw new Error('גודל הקבצים הכולל בתוך ה-ZIP לאחר פריסה חורג מהמותר (300MB) — הקובץ נדחה כחשד ל"פצצת ZIP"');
  }
}
Importers._checkZipBomb = checkZipBomb; // exposed for tests

// ── DBF reader (handles type F / Float that shapefile.js ignores) ──────────
function readDbfRecords(buf) {
  var bytes = new Uint8Array(buf);
  var view  = new DataView(buf);
  var numRecs    = view.getUint32(4, true);
  var headerSize = view.getUint16(8, true);
  var recSize    = view.getUint16(10, true);

  var fields = [];
  var pos = 32;
  while (pos + 32 <= headerSize && bytes[pos] !== 0x0D) {
    var name = '';
    for (var i = 0; i < 11 && bytes[pos + i]; i++) name += String.fromCharCode(bytes[pos + i]);
    var type = String.fromCharCode(bytes[pos + 11]);
    var len  = bytes[pos + 16];
    fields.push({ name: name, type: type, len: len });
    pos += 32;
  }

  var records = [];
  for (var r = 0; r < numRecs; r++) {
    var rStart = headerSize + r * recSize;
    if (rStart + recSize > bytes.length) break;
    var rec = {};
    var fStart = rStart + 1;
    for (var f = 0; f < fields.length; f++) {
      var fd = fields[f];
      var raw = '';
      for (var c = 0; c < fd.len; c++) {
        var b = bytes[fStart + c];
        raw += (b && b !== 0) ? String.fromCharCode(b) : '';
      }
      var trimmed = raw.trim();
      if (fd.type === 'C') {
        rec[fd.name] = trimmed;
      } else if (fd.type === 'N' || fd.type === 'F') {
        var n = parseFloat(trimmed);
        rec[fd.name] = isNaN(n) ? null : n;
      } else if (fd.type === 'D') {
        rec[fd.name] = trimmed || null;
      } else if (fd.type === 'L') {
        rec[fd.name] = (trimmed === 'T' || trimmed === 'Y' || trimmed === 't' || trimmed === 'y');
      } else {
        rec[fd.name] = trimmed;
      }
      fStart += fd.len;
    }
    records.push(rec);
  }
  return records;
}
Importers._readDbfRecords = readDbfRecords; // exposed for tests

// ── .prj CRS detection ──────────────────────────────────────────────────────
function detectCRSFromPrj(prj) {
  if (!prj) return 'unknown';
  var p = prj.toUpperCase();
  // WGS84 geographic (no projection wrapper)
  if (p.indexOf('PROJCS') === -1 && (p.indexOf('WGS_1984') !== -1 || p.indexOf('WGS 1984') !== -1)) return 'WGS84';
  // Israel ITM — check name or known false-easting/northing
  if (p.indexOf('ISRAEL_TM_GRID') !== -1 || p.indexOf('ISRAEL TM GRID') !== -1) return 'ITM';
  if (p.indexOf('219529') !== -1 && p.indexOf('626907') !== -1) return 'ITM';
  return 'unknown';
}
Importers._detectCRSFromPrj = detectCRSFromPrj; // exposed for tests

function validateCoord(lng, lat) {
  // Israel bounding box
  return lat >= 29 && lat <= 34 && lng >= 34 && lng <= 37;
}

function convertCoord(xy, crs) {
  if (crs !== 'ITM') return xy;
  return window.CRSUtils.itmToWgs84(xy[0], xy[1]);
}
function convertCoords(coords, crs) {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') return convertCoord(coords, crs);
  return coords.map(function (c) { return convertCoords(c, crs); });
}
function convertGeometry(geom, crs) {
  if (!geom || crs === 'WGS84') return geom;
  return { type: geom.type, coordinates: convertCoords(geom.coordinates, crs) };
}

Importers.shapefile = {
  // parse(file) → Promise<{ features, detectedCRS, warnings, sourceLayers }>
  // Coordinates are already reprojected to WGS84 by the time this resolves
  // (each .shp/.prj pair inside the ZIP can carry its own CRS), so the
  // reported detectedCRS is always 'wgs84' — the ImportPipeline reproject
  // stage is a no-op for this format.
  parse: function (file) {
    return window.JSZip.loadAsync(file).then(function (zip) {
      checkZipBomb(zip);

      var shpPaths = [];
      zip.forEach(function (path, entry) {
        if (!entry.dir && path.toLowerCase().endsWith('.shp')) shpPaths.push(path);
      });
      if (!shpPaths.length) throw new Error('לא נמצאו קבצי .shp בתוך ה-ZIP');

      return new Promise(function (resolve, reject) {
        var allFeatures = [];
        var sourceLayers = [];
        var warnings = [];
        var remaining = shpPaths.length;

        shpPaths.forEach(function (shpPath) {
          var base = shpPath.replace(/\.shp$/i, '');
          var layerName = base.split('/').pop().split('\\').pop();
          sourceLayers.push(layerName);

          var shpPromise = zip.file(shpPath) ? zip.file(shpPath).async('arraybuffer') : Promise.resolve(null);
          var dbfFile    = zip.file(base + '.dbf') || zip.file(base + '.DBF');
          var dbfPromise = dbfFile ? dbfFile.async('arraybuffer') : Promise.resolve(null);
          var prjFile    = zip.file(base + '.prj') || zip.file(base + '.PRJ');
          var prjPromise = prjFile ? prjFile.async('string') : Promise.resolve(null);

          Promise.all([shpPromise, dbfPromise, prjPromise]).then(function (results) {
            var shpBuf = results[0], dbfBuf = results[1], prjText = results[2];
            var crs = detectCRSFromPrj(prjText);

            if (crs === 'unknown') {
              warnings.push('שכבה ' + layerName + ': לא זוהתה מערכת קואורדינטות — הונחה ITM כברירת מחדל');
              crs = 'ITM'; // Safe default for Israeli data
            }

            // Parse DBF ourselves so type-F (Float) fields like TL / LowIL are read correctly
            var dbfRecords = dbfBuf ? readDbfRecords(dbfBuf) : [];

            return window.shapefile.read(shpBuf, null).then(function (collection) {
              var bad = 0;
              collection.features.forEach(function (f, idx) {
                if (!f.geometry) return;
                var converted = convertGeometry(f.geometry, crs);

                // Validate a sample coordinate
                var sample = converted.coordinates;
                while (Array.isArray(sample[0])) sample = sample[0];
                if (!validateCoord(sample[0], sample[1])) { bad++; return; }

                // Use our own DBF parser output (handles type F correctly)
                f.properties = dbfRecords[idx] ? Object.assign({}, dbfRecords[idx]) : {};
                f.properties.Layer = layerName;
                f.properties._original_layer = layerName;
                f.geometry = converted;
                allFeatures.push(f);
              });
              if (bad > 0) warnings.push(layerName + ': ' + bad + ' אובייקטים דולגו (מחוץ לתחום ישראל)');
            });
          })
          .catch(function (e) {
            warnings.push('שכבה ' + layerName + ' נכשלה בעיבוד: ' + (e && e.message ? e.message : e));
          })
          .then(function () {
            if (--remaining === 0) {
              if (!allFeatures.length) { reject(new Error('לא נמצאו אובייקטים תקינים בקבצים')); return; }
              resolve({
                features: allFeatures,
                detectedCRS: 'wgs84',
                warnings: warnings,
                sourceLayers: sourceLayers
              });
            }
          });
        });
      });
    });
  }
};

})(window);
