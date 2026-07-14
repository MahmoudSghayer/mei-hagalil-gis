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

// exportDXFSmart(): health-ping timeout + negative-result cache (see below).
var DXF_HEALTH_PING_TIMEOUT_MS = 2500;
var DXF_PING_NEGATIVE_CACHE_MS = 60000; // 60s
var _dxfPingNegativeUntil = 0;          // Date.now() ms; skip re-pinging until this

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

// Reads a non-OK response body and returns the best user-facing message.
// The DWG-export service (dwg-export/main.py) raises FastAPI HTTPExceptions
// with `{"detail": "..."}` — including the bilingual Hebrew/English strings
// added for the ODA-conversion failure paths (e.g. "DWG conversion failed —
// likely too large/complex for the server..."). Prefer that verbatim over a
// generic wrapper so the user sees the server's actual, actionable message
// instead of just a status code. Falls back to an older {error,message}
// shape (a couple of legacy stubs used this), then a raw-text snippet.
async function _extractErrorMessage(res) {
  var errText = '';
  try { errText = await res.text(); } catch (e) { /* body unreadable/already consumed */ }
  try {
    var errJson = JSON.parse(errText);
    if (errJson && typeof errJson.detail === 'string' && errJson.detail) return errJson.detail;
    if (errJson && errJson.error) return errJson.error + (errJson.message ? ': ' + errJson.message : '');
  } catch (e) { /* not JSON */ }
  return 'שגיאה ' + res.status + ': ' + errText.substring(0, 200);
}

// Hebrew hint shown when fetch() itself REJECTS (as opposed to resolving with
// a non-OK response) — a network-level failure with no HTTP response at all.
// This is exactly the OOM-killed-container / cold-Render-instance case: the
// connection drops mid-request, the browser never sees any response (let
// alone CORS headers), and reports a bogus "TypeError: Failed to fetch" /
// "CORS error" that has nothing to do with CORS. Browsers reject fetch()
// with a TypeError specifically for this class of failure, which is what
// _isNetworkError() below keys off of — distinct from the Errors this file
// throws itself after a successful-but-non-OK response (those are plain
// Error, not TypeError, so they pass through unchanged).
var FETCH_UNAVAILABLE_HINT_HE =
  'שירות ההמרה אינו זמין כרגע (ייתכן שהוא מתעורר או שהקובץ גדול מדי) — ' +
  'נסה שוב בעוד דקה, או המר ל-DXF והעלה אותו ישירות.';

function _isNetworkError(e) {
  return e instanceof TypeError;
}

// Wraps a caught error from a fetch() call site: a genuine network failure
// (fetch rejected) becomes the Hebrew "service unavailable" hint; anything
// else (a session error from authHeaders(), an Error we threw ourselves
// after reading a real response, an AbortError from a caller-supplied
// signal, ...) passes through unchanged so its original message still
// reaches the user.
function _friendlyFetchError(e) {
  return _isNetworkError(e) ? new Error(FETCH_UNAVAILABLE_HINT_HE) : e;
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
    else if (elapsed < 30) onProgress('process', 60, 'השרת ממיר (ezdxf/ODA) ומבצע reprojection...');
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
      throw new Error(await _extractErrorMessage(res));
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
    throw _friendlyFetchError(e);
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
      throw new Error(await _extractErrorMessage(res));
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
    throw _friendlyFetchError(e);
  }
};

// Health-pings the DXF export microservice with a short timeout. Returns
// true only on a genuine 200 within DXF_HEALTH_PING_TIMEOUT_MS; any error,
// non-ok status, or timeout is treated as "unavailable" and cached negative
// for DXF_PING_NEGATIVE_CACHE_MS so a burst of exports (or a slow Render
// free-tier wake-up) doesn't re-ping on every call.
async function _pingDxfService() {
  if (Date.now() < _dxfPingNegativeUntil) return false;
  if (!DWG_EXPORT_URL || DWG_EXPORT_URL === 'YOUR_DWG_EXPORT_URL') return false;

  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function() { ctrl.abort(); }, DXF_HEALTH_PING_TIMEOUT_MS) : null;
  try {
    var res = await fetch(DWG_EXPORT_URL + '/health', {
      method: 'GET',
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    if (!res.ok) { _dxfPingNegativeUntil = Date.now() + DXF_PING_NEGATIVE_CACHE_MS; return false; }
    return true;
  } catch (e) {
    if (timer) clearTimeout(timer);
    _dxfPingNegativeUntil = Date.now() + DXF_PING_NEGATIVE_CACHE_MS;
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
//  CONTRACT (coordinated with export-feature.js — that file's owner wires
//  the actual call site; do not assume it has landed yet):
//
//  window.exportDXFSmart(features, filename, onProgress) → Promise<Blob | null>
//
//  Server-primary DXF export with a client-fallback contract:
//    1. Health-pings DWG_EXPORT_URL + '/health' with a short (~2.5s) timeout.
//    2. Ping fails/times out (cold Render instance, offline, misconfigured
//       URL) → resolves to `null`. The caller is expected to fall back to
//       the existing client-side R12 builder (buildDXF() in
//       js/export-formats.js) and may want to show a Hebrew notice that the
//       richer server-side DXF wasn't available. A failed ping is cached
//       for DXF_PING_NEGATIVE_CACHE_MS (60s) so repeated exports in that
//       window skip straight to `null` without re-pinging a sleeping
//       service.
//    3. Ping succeeds → POSTs { features, filename } to
//       DWG_EXPORT_URL + '/api/export/dxf' (same endpoint/body shape as
//       geoJSONtoDWG() above) with the caller's Supabase JWT, and resolves
//       to the response body as a Blob (application/dxf) — this is the
//       richer R2018 dxf_builder.py output (manhole blocks, flow arrows,
//       pipe labels), NOT the client R12 builder's output.
//    4. Any failure AFTER a successful ping (missing/expired session, 4xx,
//       5xx, a network error mid-request) REJECTS with an Error — this is
//       "the server said no", distinct from "the server is unavailable",
//       and the caller should surface it as an error rather than silently
//       falling back.
//
//  `onProgress`, if given, is called as onProgress(stage, percent, message)
//  with Hebrew `message` strings, mirroring geoJSONtoDWG()'s convention.
//  Does NOT trigger a browser download itself (unlike geoJSONtoDWG) — the
//  caller downloads the returned Blob, same as it already does for the
//  client-side buildDXF() path.
// ════════════════════════════════════════════════════════════════
window.exportDXFSmart = async function(features, filename, onProgress) {
  filename = filename || 'mei-hagalil-export';

  if (onProgress) onProgress('ping', 5, 'בודק זמינות שירות ההמרה...');

  var available;
  try {
    available = await _pingDxfService();
  } catch (e) {
    available = false;
  }
  if (!available) return null;   // caller falls back to the client R12 builder

  if (onProgress) onProgress('upload', 20, 'שולח נתונים לשרת...');

  var startedAt = Date.now();
  var pollProgress = setInterval(function() {
    if (!onProgress) return;
    var elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed < 5) onProgress('process', 40, 'בונה DXF בשרת...');
    else if (elapsed < 15) onProgress('process', 65, 'בונה DXF בשרת... (' + Math.round(elapsed) + 'ש)');
    else onProgress('process', 85, 'עוד רגע... (' + Math.round(elapsed) + 'ש)');
  }, 2000);

  try {
    var headers = await authHeaders({ 'Content-Type': 'application/json' });
    var res = await fetch(DWG_EXPORT_URL + '/api/export/dxf', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ features: features, filename: filename }),
    });

    clearInterval(pollProgress);

    if (!res.ok) {
      throw new Error(await _extractErrorMessage(res));
    }

    if (onProgress) onProgress('download', 95, 'מקבל DXF...');
    var blob = await res.blob();

    var elapsed = (Date.now() - startedAt) / 1000;
    if (onProgress) onProgress('done', 100, '✅ DXF נבנה בשרת ב-' + Math.round(elapsed) + 'ש');

    return blob;
  } catch (e) {
    clearInterval(pollProgress);
    // real error post-ping — caller shows it, does NOT silently fall back
    // (a network-level failure here still gets the friendly Hebrew hint,
    // e.g. the service died between the health ping and this request)
    throw _friendlyFetchError(e);
  }
};

console.log('✓ Backend client loaded (JWT auth) → ' + DWG_EXPORT_URL);
})();
