// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Backend Client
//  קורא ל-Backend (Render.com) להמרת DWG → GeoJSON
//
//  הוראות התקנה:
//   1. Deploy את ה-backend ל-Render.com (ראה backend/DEPLOY.md)
//   2. הדבק כאן את ה-URL וה-Token שקיבלת מ-Render
//   3. כלול ב-upload.html ו-index.html
//
//  אבטחה: ה-Token לא מאפשר שום פעולה רגישה — רק המרת קבצים דרך
//  ה-backend שלך. אם הוא נחשף, מקסימום מישהו ינצל את quota של
//  ה-Aspose שלך. ה-quota מוגבל כברירת מחדל ב-Aspose dashboard.
// ════════════════════════════════════════════════════════════════
(function() {
'use strict';

var BACKEND_URL = 'https://mei-hagalil-gis-backend.onrender.com';      // ← e.g. https://mei-hagalil-gis-backend.onrender.com
var BACKEND_TOKEN = '7bnNTN5T70qMRGp75AnrWe5NwaQFawG6tUmi35mz'; // ← Render auto-generated this for you

// ════════════════════════════════════════════════════════════════
//  PUBLIC API
// ════════════════════════════════════════════════════════════════

/**
 * המרת DWG ל-GeoJSON (דרך ה-backend)
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

  validateConfig();

  if (onProgress) onProgress('init', 5, 'מתחיל המרה דרך השרת...');

  var formData = new FormData();
  formData.append('file', dwgFile, dwgFile.name || 'input.dwg');
  formData.append('source_crs', sourceCrs);
  formData.append('target_crs', targetCrs);

  if (onProgress) onProgress('upload', 15, 'מעלה DWG לשרת...');

  // The backend handles: Aspose conversion + GDAL processing + reprojection
  // Could take 30-90 seconds, especially after Render free tier wakes up
  var startedAt = Date.now();
  var pollProgress = setInterval(function() {
    if (!onProgress) return;
    var elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed < 5) onProgress('process', 20, 'השרת מעבד...');
    else if (elapsed < 15) onProgress('process', 35, 'Aspose ממיר DWG → DXF...');
    else if (elapsed < 30) onProgress('process', 60, 'GDAL ממיר ומבצע reprojection...');
    else if (elapsed < 60) onProgress('process', 80, 'מסיים עיבוד... (' + Math.round(elapsed) + 'ש)');
    else onProgress('process', 90, 'עוד רגע... (' + Math.round(elapsed) + 'ש)');
  }, 2000);

  try {
    var res = await fetch(BACKEND_URL + '/api/convert/dwg', {
      method: 'POST',
      headers: { 'X-API-Token': BACKEND_TOKEN },
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
 * המרת DXF ל-GeoJSON (יותר מהיר, לא דורש Aspose)
 */
window.dxfToGeoJSON = async function(dxfFile, options, onProgress) {
  if (typeof options === 'function') { onProgress = options; options = {}; }
  options = options || {};
  validateConfig();

  if (onProgress) onProgress('upload', 30, 'מעלה DXF...');
  var formData = new FormData();
  formData.append('file', dxfFile, dxfFile.name || 'input.dxf');
  formData.append('source_crs', options.sourceCrs || 'EPSG:2039');
  formData.append('target_crs', options.targetCrs || 'EPSG:4326');

  var res = await fetch(BACKEND_URL + '/api/convert/dxf', {
    method: 'POST',
    headers: { 'X-API-Token': BACKEND_TOKEN },
    body: formData,
  });
  if (!res.ok) {
    var errText = await res.text();
    throw new Error('Backend error: ' + errText.substring(0, 200));
  }
  if (onProgress) onProgress('done', 100, '✅ הומר');
  return await res.json();
};

/**
 * בדיקת מצב backend
 */
window.backendStatus = async function() {
  if (BACKEND_URL === 'YOUR_RENDER_URL') {
    return { ok: false, error: 'Backend URL not configured' };
  }
  try {
    var res = await fetch(BACKEND_URL + '/api/health', {
      headers: { 'X-API-Token': BACKEND_TOKEN }
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    var data = await res.json();
    return {
      ok: true,
      gdal_version: data.gdal_version,
      aspose_configured: data.aspose_configured,
      crs_count: (data.supported_crs || []).length,
    };
  } catch(e) {
    return { ok: false, error: e.message };
  }
};

/**
 * קבלת רשימת מערכות קואורדינטות נתמכות
 */
window.backendListCRS = async function() {
  validateConfig();
  var res = await fetch(BACKEND_URL + '/api/crs/list', {
    headers: { 'X-API-Token': BACKEND_TOKEN }
  });
  if (!res.ok) throw new Error('Could not fetch CRS list');
  var data = await res.json();
  return data.systems || [];
};


function validateConfig() {
  if (BACKEND_URL === 'YOUR_RENDER_URL' || !BACKEND_URL) {
    throw new Error('Backend URL לא הוגדר. ערוך את backend-client.js');
  }
  if (BACKEND_TOKEN === 'YOUR_BACKEND_TOKEN' || !BACKEND_TOKEN) {
    throw new Error('Backend Token לא הוגדר. ערוך את backend-client.js');
  }
}

// Backwards-compatible alias for existing code that calls asposeStatus()
window.asposeStatus = async function() {
  var s = await window.backendStatus();
  return { authenticated: s.ok && s.aspose_configured, error: s.error };
};

console.log('✓ Backend client loaded' +
  (BACKEND_URL === 'YOUR_RENDER_URL' ? ' (⚠️ not configured!)' : ' → ' + BACKEND_URL));
})();
