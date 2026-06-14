// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Backend Client (DWG export microservice)
//  קורא לשירות ה-DWG (Render.com) להמרת DWG ↔ GeoJSON.
//
//  אבטחה: אין יותר token סטטי בקליינט. ההזדהות מול השירות מתבצעת דרך
//  ה-Supabase JWT של המשתמש המחובר (השרת מאמת מולו SUPABASE_JWT_SECRET).
//  לכן רק משתמש מחובר יכול להמיר/לייצא קבצים, ואין סוד שדולף בדפדפן.
// ════════════════════════════════════════════════════════════════
(function() {
'use strict';

var DWG_EXPORT_URL = 'https://mei-hagalil-gis-dwg-export.onrender.com'; // DWG export microservice

// Builds the auth header from the logged-in user's Supabase session.
// Throws (in Hebrew) if there is no session, so callers fail with a clear
// message instead of sending an unauthenticated request.
async function authHeaders(extra) {
  var h = extra || {};
  var token = null;
  try {
    if (window.gSb) {
      var s = await window.gSb.auth.getSession();
      token = s && s.data && s.data.session && s.data.session.access_token;
    }
  } catch (e) { /* no session */ }
  if (!token) throw new Error('עליך להתחבר כדי להשתמש בשירות ההמרה/הייצוא.');
  h['Authorization'] = 'Bearer ' + token;
  return h;
}

function requireDwgUrl() {
  if (!DWG_EXPORT_URL || DWG_EXPORT_URL === 'YOUR_DWG_EXPORT_URL') {
    throw new Error('DWG Export URL לא הוגדר. ערוך את backend-client.js');
  }
}

// ════════════════════════════════════════════════════════════════
//  PUBLIC API
// ════════════════════════════════════════════════════════════════

/**
 * המרת DWG ל-GeoJSON (דרך שירות ה-DWG)
 * @param {File} dwgFile
 * @param {Object} options - { sourceCrs: 'EPSG:2039', targetCrs: 'EPSG:4326' }
 * @param {Function} onProgress - callback(stage, percent, message)
 */
window.dwgToGeoJSON = async function(dwgFile, options, onProgress) {
  if (typeof options === 'function') {
    // Backwards-compatible: old signature was (file, onProgress)
    onProgress = options;
    options = {};
  }
  options = options || {};
  var sourceCrs = options.sourceCrs || 'EPSG:2039';
  var targetCrs = options.targetCrs || 'EPSG:4326';

  requireDwgUrl();

  if (onProgress) onProgress('init', 5, 'מתחיל המרה דרך השרת...');

  var formData = new FormData();
  formData.append('file', dwgFile, dwgFile.name || 'input.dwg');
  formData.append('source_crs', sourceCrs);
  formData.append('target_crs', targetCrs);

  if (onProgress) onProgress('upload', 15, 'מעלה DWG לשרת...');

  // The service handles: ODA conversion + GDAL processing + reprojection.
  // Could take 30-90 seconds, especially after a Render free-tier wake.
  var startedAt = Date.now();
  var pollProgress = setInterval(function() {
    if (!onProgress) return;
    var elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed < 5) onProgress('process', 20, 'השרת מעבד...');
    else if (elapsed < 15) onProgress('process', 35, 'ממיר DWG → DXF...');
    else if (elapsed < 30) onProgress('process', 60, 'GDAL ממיר ומבצע reprojection...');
    else if (elapsed < 60) onProgress('process', 80, 'מסיים עיבוד... (' + Math.round(elapsed) + 'ש)');
    else onProgress('process', 90, 'עוד רגע... (' + Math.round(elapsed) + 'ש)');
  }, 2000);

  try {
    var convHeaders = await authHeaders();
    var res = await fetch(DWG_EXPORT_URL + '/api/convert/dwg-to-geojson', {
      method: 'POST',
      headers: convHeaders,
      body: formData,
    });

    clearInterval(pollProgress);

    if (!res.ok) {
      var errText = await res.text();
      var errMsg;
      try {
        var errJson = JSON.parse(errText);
        errMsg = errJson.error + (errJson.message ? ': ' + errJson.message : '');
      } catch(e) {
        errMsg = 'שגיאה ' + res.status + ': ' + errText.substring(0, 200);
      }
      throw new Error(errMsg);
    }

    if (onProgress) onProgress('download', 95, 'מקבל תוצאה...');
    var geojson = await res.json();

    var elapsed = (Date.now() - startedAt) / 1000;
    if (onProgress) onProgress('done', 100, '✅ הומר ב-' + Math.round(elapsed) + 'ש — ' +
      (geojson.features || []).length + ' אובייקטים');

    // Log conversion to Supabase
    if (window.gSb && window.gUser) {
      try {
        await window.gSb.from('dwg_conversions').insert([{
          user_id: window.gUser.id,
          user_name: (window.gProfile && window.gProfile.full_name) || window.gUser.email,
          source_filename: dwgFile.name || 'unknown.dwg',
          source_size: dwgFile.size,
          target_format: 'geojson',
          status: 'success',
          duration_ms: Date.now() - startedAt,
        }]);
      } catch(e) { console.warn('log err:', e); }
    }

    return geojson;
  } catch(e) {
    clearInterval(pollProgress);
    throw e;
  }
};

/**
 * Export GeoJSON features → DWG (or DXF fallback) download.
 * Calls the DWG export microservice and triggers a browser download.
 *
 * @param {Array}    features   GeoJSON Feature array (with _category property)
 * @param {Object}   options    { filename: string, signal?: AbortSignal }
 * @param {Function} onProgress callback(stage, percent, message)
 */
window.geoJSONtoDWG = async function(features, options, onProgress) {
  if (typeof options === 'function') { onProgress = options; options = {}; }
  options = options || {};
  var filename = options.filename || 'mei-hagalil-export';

  requireDwgUrl();

  if (onProgress) onProgress('upload', 10, 'שולח נתונים לשרת...');

  var startedAt = Date.now();
  var pollProgress = setInterval(function() {
    if (!onProgress) return;
    var elapsed = (Date.now() - startedAt) / 1000;
    if      (elapsed <  5) onProgress('process', 25, 'בונה DXF...');
    else if (elapsed < 15) onProgress('process', 50, 'ממיר ל-DWG...');
    else if (elapsed < 40) onProgress('process', 75, 'מסיים (' + Math.round(elapsed) + 'ש)...');
    else                   onProgress('process', 90, 'עוד רגע... (' + Math.round(elapsed) + 'ש)');
  }, 2000);

  try {
    var dwgHeaders = await authHeaders({ 'Content-Type': 'application/json' });
    var res = await fetch(DWG_EXPORT_URL + '/api/export/dwg', {
      method: 'POST',
      headers: dwgHeaders,
      body: JSON.stringify({ features: features, filename: filename }),
      signal: options.signal,   // lets the caller cancel a stuck request
    });

    clearInterval(pollProgress);

    if (!res.ok) {
      var errText = await res.text();
      throw new Error('Export error: ' + errText.substring(0, 200));
    }

    var isFallback = res.headers.get('X-Fallback-Format') === 'dxf';
    var fbReason   = res.headers.get('X-Fallback-Reason') || '';
    var ext  = isFallback ? '.dxf' : '.dwg';

    var blob = await res.blob();
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = filename + ext;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);

    var elapsed = (Date.now() - startedAt) / 1000;
    var doneMsg = !isFallback ? '✅ DWG'
      : (fbReason === 'too_large'
          ? '⚠️ ייצוא גדול — הוחזר DXF (אפשר לפתוח ולשמור כ-DWG ב-AutoCAD)'
          : '⚠️ הוחזר DXF (ODA לא זמין)');
    if (onProgress) onProgress('done', 100, doneMsg + ' — הורד ב-' + Math.round(elapsed) + 'ש');

    return { format: isFallback ? 'dxf' : 'dwg' };
  } catch(e) {
    clearInterval(pollProgress);
    throw e;
  }
};

console.log('✓ Backend client loaded (JWT auth) → ' + DWG_EXPORT_URL);
})();
