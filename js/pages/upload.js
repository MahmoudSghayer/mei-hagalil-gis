var VILLAGES = [
  { name: 'מגד אל-כרום', slug: 'majd',         icon: '🏘️', lat: 32.9189, lng: 35.2456, radius: 0.027 },
  { name: 'בענה',         slug: 'biina',        icon: '🏘️', lat: 32.9485, lng: 35.2617, radius: 0.027 },
  { name: 'דיר אל-אסד',   slug: 'deir_al_asad', icon: '🏘️', lat: 32.9356, lng: 35.2697, radius: 0.027 },
  { name: 'נחף',           slug: 'nahf',         icon: '🏘️', lat: 32.9344, lng: 35.3025, radius: 0.027 },
  { name: 'סחנין',         slug: 'sakhnin',      icon: '🏘️', lat: 32.8650, lng: 35.2978, radius: 0.027 },
  { name: 'דיר חנא',       slug: 'deir_hanna',   icon: '🏘️', lat: 32.8631, lng: 35.3589, radius: 0.027 },
  { name: 'עראבה',         slug: 'arrabeh',      icon: '🏘️', lat: 32.8514, lng: 35.3339, radius: 0.027 }
];
var MAX_VILLAGE_DISTANCE = 0.045;

var gFile = null;
var gFileData = null;
var gAdminId = null;
var gRules = [];
var gLayerStats = {};
var gDetectedVillage = null;
var gCsvParse = null; // { needsMapping, headers, rows, preview, guess } from Importers.csv.parse()

var CATEGORIES = [
  { value: 'IGNORE', label: '🚫 דלג (לא להעלות)' },
  { value: 'water_pipes', label: '💧 קווי מים' },
  { value: 'water_meters', label: '🔢 מדי מים' },
  { value: 'hydrants', label: '🚒 הידרנטים' },
  { value: 'valves', label: '🔧 מגופים' },
  { value: 'control_valves', label: '⚙️ מגופים שולטים' },
  { value: 'connection_points', label: '🔌 נקודות חיבור' },
  { value: 'reservoirs', label: '🏗️ מאגרי מים' },
  { value: 'pump_stations', label: '⛽ תחנות שאיבה' },
  { value: 'sampling_points', label: '🧪 נקודות דיגום' },
  { value: 'sewage_pipes', label: '🟤 קווי ביוב' },
  { value: 'sewage_manholes', label: '⭕ שוחות ביוב' },
  { value: 'main_sewer', label: '🔴 ביב ראשי' },
  { value: 'supply_pipe', label: '🔵 קו הספקה' },
  { value: 'sewage_cascade', label: '⬇️ מפל ביוב' },
  { value: 'fittings', label: '🔩 מתאמים' },
  { value: 'annotation_points', label: '📍 נקודות להערות' },
  { value: 'sewer_exit', label: '🚪 יציאה מרשת ביוב' },
  { value: 'annotation_polygons', label: '🔷 פוליגונים להערות' },
  { value: 'annotation_lines', label: '📏 קווים להערות' },
  { value: 'valve_chamber', label: '🔲 תא מגופים' },
  { value: 'block', label: '🗂️ גוש' },
  { value: 'buildings', label: '🏢 בניינים' },
  { value: 'parcels', label: '📐 חלקות' },
  { value: 'sleeve', label: '🔧 שרוולים' },
  { value: 'pipe_label', label: '🏷️ תוויות צנרת' },
  { value: 'elevation_label', label: '📏 גבהים TL/IL' },
  { value: 'attribute_label', label: '📊 תוויות נתונים' },
  { value: 'distance_label', label: '↔ מרחקים' },
  { value: 'other', label: '❓ אחר' }
];

// DXF is routed through the SAME server call as DWG — dwg-export/main.py's
// /api/convert/dwg-to-geojson now accepts .dxf directly and skips the ODA
// step (the file is already DXF). js/importers/dwg.js's parse() just forwards
// whatever File it's given to window.dwgToGeoJSON, so it works unmodified for
// DXF too — this registers it under the 'dxf' format name that ImportPipeline
// looks up (window.Importers[format]) rather than duplicating the wrapper
// inside js/importers/dwg.js, which this wave doesn't touch.
if (window.Importers && window.Importers.dwg && !window.Importers.dxf) {
  window.Importers.dxf = { parse: window.Importers.dwg.parse };
}

window.addEventListener('load', async function() {
  var res = await gSb.auth.getSession();
  if (!res.data || !res.data.session) { window.location.replace('login.html'); return; }
  var role = await getUserRole(res.data.session.user.id);
  if (role !== 'admin') { window.location.replace('../index.html'); return; }
  gAdminId = res.data.session.user.id;
  document.body.classList.add('ready');
  MotionUtils.animatePageIn();
  await loadRules();
  loadLayers();
  setupDragDrop();
});

async function loadRules() {
  var res = await gSb.from('layer_mapping_rules')
    .select('*').eq('is_active', true).order('priority', {ascending: true});
  if (res.error) { console.error('Rules load err:', res.error); gRules = []; return; }
  gRules = res.data || [];
}

function setupDragDrop() {
  var zone = document.getElementById('drop-zone');
  var input = document.getElementById('file-input');
  ['dragenter','dragover'].forEach(function(ev) {
    zone.addEventListener(ev, function(e) { e.preventDefault(); zone.classList.add('dragover'); });
  });
  ['dragleave','drop'].forEach(function(ev) {
    zone.addEventListener(ev, function(e) { e.preventDefault(); zone.classList.remove('dragover'); });
  });
  zone.addEventListener('drop', function(e) {
    var files = e.dataTransfer.files;
    if (files.length) handleFile(files[0]);
  });
  input.addEventListener('change', function(e) {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });
}

// ── FILE HANDLING ─────────────────────────────────────────────────────────────
// Parsing/CRS-detection/reprojection for all three formats now goes through
// ImportPipeline.run() (js/import-pipeline.js) + the per-format parsers in
// js/importers/*.js — see proceedWithFile() below.

// Reads the first `n` bytes of a file and resolves to a lowercase hex string.
function readMagic(file, n) {
  return new Promise(function(resolve) {
    var r = new FileReader();
    r.onload = function() {
      var b = new Uint8Array(r.result), hex = '';
      for (var i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, '0');
      resolve(hex);
    };
    r.onerror = function() { resolve(''); };
    r.readAsArrayBuffer(file.slice(0, n || 8));
  });
}

// Detects "XML text, possibly after a UTF-8 BOM and/or leading whitespace,
// then '<'" from a hex-encoded byte prefix. Used to sniff KML (plain XML —
// unlike KMZ there's no zip container to check the signature of instead).
function looksLikeXmlText(hex) {
  var t = hex.indexOf('efbbbf') === 0 ? hex.slice(6) : hex; // skip UTF-8 BOM
  for (var i = 0; i + 2 <= t.length; i += 2) {
    var b = parseInt(t.substr(i, 2), 16);
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue; // whitespace
    return b === 0x3c; // '<'
  }
  return false;
}

// Permissive DXF sniff: DXF is a plain-text group-code format, normally
// starting with a "0" group code line followed by "SECTION" (e.g.
// "0\r\nSECTION\r\n2\r\nHEADER..."), sometimes indented with leading spaces by
// some CAD exporters. Explicitly rejects known BINARY signatures (ZIP/DWG/PNG)
// even if the file was misnamed with a .dxf extension, but otherwise stays
// permissive — real-world DXF headers vary, and the server does the real
// parse and rejects genuinely malformed content.
function looksLikeDxfText(hex) {
  if (hex.indexOf('504b0304') === 0 || hex.indexOf('504b0506') === 0 || hex.indexOf('504b0708') === 0) return false; // ZIP
  if (hex.indexOf('414331') === 0) return false; // "AC1..." — a DWG binary, not DXF text
  if (hex.indexOf('89504e47') === 0) return false; // PNG
  var text = '';
  for (var i = 0; i + 2 <= hex.length; i += 2) text += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  text = text.replace(/^﻿/, '');
  if (/^\s*0\s*[\r\n]+\s*SECTION/i.test(text)) return true; // classic DXF header
  return /^[\s0-9]/.test(text); // permissive fallback: starts with whitespace/digit, not binary garbage
}

function handleFile(file) {
  var isZip     = /\.zip$/i.test(file.name);
  var isGeoJson = /\.(geojson|json)$/i.test(file.name);
  var isDwg     = /\.dwg$/i.test(file.name);
  var isDxf     = /\.dxf$/i.test(file.name);
  var isKml     = /\.kml$/i.test(file.name);
  var isKmz     = /\.kmz$/i.test(file.name);
  var isCsv     = /\.csv$/i.test(file.name);
  if (!isZip && !isGeoJson && !isDwg && !isDxf && !isKml && !isKmz && !isCsv) {
    showToast('קבצי GeoJSON, JSON, ZIP (Shapefile), DWG, DXF, KML, KMZ או CSV בלבד', 'error');
    return;
  }
  if (file.size > 100*1024*1024) { showToast('גודל מקסימלי 100MB', 'error'); return; }

  // DXF sniffing needs more leading bytes than a fixed signature (it looks for
  // "0\r\nSECTION" group-code header text, not a magic number at a fixed offset).
  var magicLen = isDxf ? 64 : 8;

  // Verify the real file signature matches the extension — never trust the name
  // alone before handing bytes to JSZip / shapefile / the DWG parser / DOMParser.
  readMagic(file, magicLen).then(function(hex) {
    var okZip  = hex.indexOf('504b0304') === 0 || hex.indexOf('504b0506') === 0 || hex.indexOf('504b0708') === 0; // PK..
    var okDwg  = hex.indexOf('414331') === 0; // "AC1" DWG version stamp
    var t      = hex.indexOf('efbbbf') === 0 ? hex.slice(6) : hex; // skip UTF-8 BOM
    var fb     = parseInt(t.slice(0, 2), 16); // first byte
    var okJson = fb === 0x7b || fb === 0x5b || fb === 0x20 || fb === 0x09 || fb === 0x0a || fb === 0x0d; // { [ or leading whitespace
    var okXml  = looksLikeXmlText(hex); // KML: '<' possibly after BOM/whitespace
    var okDxf  = looksLikeDxfText(hex); // DXF: permissive group-code sniff, rejects binary
    var okCsv  = !okZip && !okDwg && hex.indexOf('89504e47') !== 0; // CSV/text: reject obvious binary signatures
    if ((isZip && !okZip) || (isKmz && !okZip) || (isDwg && !okDwg) ||
        (isGeoJson && !okJson) || (isKml && !okXml) || (isDxf && !okDxf) || (isCsv && !okCsv)) {
      showToast('תוכן הקובץ אינו תואם לסיומת — ייתכן שהקובץ פגום או אינו מהסוג הנכון', 'error');
      return;
    }
    proceedWithFile(file, {
      isZip: isZip, isGeoJson: isGeoJson, isDwg: isDwg,
      isDxf: isDxf, isKml: isKml, isKmz: isKmz, isCsv: isCsv
    });
  });
}

// Hebrew error-message prefix per format, matching the wording each format
// used to show before the pipeline unification.
var IMPORT_ERROR_PREFIX = {
  shapefile: 'שגיאה: ',
  geojson: 'שגיאה: ',
  dwg: 'שגיאת המרת DWG: ',
  dxf: 'שגיאת עיבוד DXF: ',
  kml: 'שגיאת KML: ',
  kmz: 'שגיאת KMZ: ',
  csv: 'שגיאת CSV: '
};

function proceedWithFile(file, flags) {
  gFile = file;
  document.getElementById('fp-name').textContent = file.name;
  document.getElementById('fp-size').textContent = formatSize(file.size);
  document.getElementById('file-preview').classList.add('show');

  // CSV can't go through ImportPipeline.run() directly — parse() alone can't
  // know which columns are X/Y/WKT/layer, so it returns a {needsMapping:true}
  // marker instead of {features,...} and a small UI collects that first.
  if (flags.isCsv) { startCsvMappingFlow(file); return; }

  var format = flags.isZip ? 'shapefile'
    : flags.isDwg ? 'dwg'
    : flags.isDxf ? 'dxf'
    : flags.isKml ? 'kml'
    : flags.isKmz ? 'kmz'
    : 'geojson';
  var opts = {};

  if (flags.isZip) {
    showToast('⏳ מעבד Shapefile...', 'info');
  } else if (flags.isKmz) {
    showToast('⏳ מעבד KMZ...', 'info');
  } else if (flags.isDwg || flags.isDxf) {
    if (typeof window.dwgToGeoJSON !== 'function') {
      showToast('שירות המרת DWG לא נטען', 'error'); clearFile(); return;
    }
    showToast(flags.isDxf ? '⏳ מעבד DXF בשרת...' : '⏳ ממיר DWG בשרת (עשוי להימשך עד דקה)...', 'info');
    var dwgStatusEl = document.getElementById('fp-size');
    opts.onProgress = function(stage, pct, msg) { if (dwgStatusEl && msg) dwgStatusEl.textContent = msg; };
  }

  ImportPipeline.run(format, file, opts).then(applyPipelineResult).catch(function(err) {
    var prefix = IMPORT_ERROR_PREFIX[format] || 'שגיאה: ';
    showToast(prefix + (err && err.message ? err.message : err), 'error');
    clearFile();
  });
}

// Shared success handler for both the file-based pipeline (ImportPipeline.run,
// above) and the CSV mapping-confirm flow (confirmCsvMapping(), which builds
// features itself then runs just the validate/reproject stages) — both
// converge on the same { features, warnings, reprojected } shape.
function applyPipelineResult(result) {
  if (result.warnings && result.warnings.length) {
    result.warnings.forEach(function(w) { console.warn('[import] ' + w); });
  }
  if (result.reprojected) {
    showToast('ℹ️ זוהו קואורדינטות ITM — בוצעה המרה אוטומטית ל-WGS84', 'info');
  }
  finishFileLoad({ type: 'FeatureCollection', features: result.features });
}

function finishFileLoad(data) {
  gFileData = data;
  document.getElementById('fp-size').textContent = formatSize(gFile.size) + ' · ' + data.features.length + ' אובייקטים';

  var detectionResult = detectVillage(data.features);
  renderDetection(detectionResult);

  if (detectionResult.status === 'rejected') {
    document.getElementById('meta-form').style.display = 'none';
    document.getElementById('mapping-section').classList.remove('show');
    return;
  }

  gDetectedVillage = detectionResult.bestMatch;
  document.getElementById('meta-form').style.display = 'grid';
  analyzeAndDisplayLayers();
}

function detectVillage(features) {
  var villageCounts = {};
  var outsideCount = 0;
  var noGeomCount = 0;

  VILLAGES.forEach(function(v) { villageCounts[v.slug] = 0; });

  features.forEach(function(f) {
    if (!f.geometry) { noGeomCount++; return; }
    var pt = featureCenter(f.geometry);
    if (!pt) { noGeomCount++; return; }

    var bestV = null, bestDist = Infinity;
    VILLAGES.forEach(function(v) {
      var dlat = pt.lat - v.lat;
      var dlng = pt.lng - v.lng;
      var dist = Math.sqrt(dlat*dlat + dlng*dlng);
      if (dist < bestDist) { bestDist = dist; bestV = v; }
    });

    if (bestV && bestDist <= MAX_VILLAGE_DISTANCE) {
      villageCounts[bestV.slug]++;
    } else {
      outsideCount++;
    }
  });

  var totalCounted = 0;
  Object.keys(villageCounts).forEach(function(k) { totalCounted += villageCounts[k]; });

  if (totalCounted === 0 && outsideCount === 0) {
    return { status: 'rejected', reason: 'no_geometry', message: 'לא נמצאה גיאומטריה תקפה בקובץ', villageCounts: villageCounts, outsideCount: 0 };
  }

  var totalWithGeom = totalCounted + outsideCount;
  if (outsideCount / totalWithGeom > 0.5) {
    return { status: 'rejected', reason: 'outside_area', message: 'יותר מ-50% מהאובייקטים מחוץ ל-7 הכפרים', villageCounts: villageCounts, outsideCount: outsideCount, totalWithGeom: totalWithGeom };
  }

  var bestSlug = null, bestCount = 0;
  Object.keys(villageCounts).forEach(function(slug) {
    if (villageCounts[slug] > bestCount) { bestCount = villageCounts[slug]; bestSlug = slug; }
  });

  if (!bestSlug || bestCount === 0) {
    return { status: 'rejected', reason: 'no_match', message: 'אף אובייקט לא נופל ב-7 הכפרים', villageCounts: villageCounts, outsideCount: outsideCount };
  }

  var bestVillage = VILLAGES.find(function(v) { return v.slug === bestSlug; });
  var percentage = Math.round((bestCount / totalWithGeom) * 100);
  var numVillages = Object.keys(villageCounts).filter(function(k) { return villageCounts[k] > 0; }).length;

  return { status: 'accepted', bestMatch: bestVillage, percentage: percentage, bestCount: bestCount, villageCounts: villageCounts, outsideCount: outsideCount, totalWithGeom: totalWithGeom, noGeomCount: noGeomCount, numVillages: numVillages };
}

function detectFeatureVillage(feature) {
  if (!feature.geometry) return null;
  var pt = featureCenter(feature.geometry);
  if (!pt) return null;
  var bestV = null, bestDist = Infinity;
  VILLAGES.forEach(function(v) {
    var d = Math.sqrt(Math.pow(pt.lat - v.lat, 2) + Math.pow(pt.lng - v.lng, 2));
    if (d < bestDist) { bestDist = d; bestV = v; }
  });
  return (bestV && bestDist <= MAX_VILLAGE_DISTANCE) ? bestV : null;
}

function featureCenter(geom) {
  if (!geom || !geom.coordinates) return null;
  if (geom.type === 'Point') return { lng: geom.coordinates[0], lat: geom.coordinates[1] };
  if (geom.type === 'LineString') {
    var coords = geom.coordinates;
    if (!coords.length) return null;
    var mid = coords[Math.floor(coords.length / 2)];
    return { lng: mid[0], lat: mid[1] };
  }
  if (geom.type === 'MultiLineString') {
    var lines = geom.coordinates;
    if (!lines.length || !lines[0].length) return null;
    var mid = lines[0][Math.floor(lines[0].length / 2)];
    return { lng: mid[0], lat: mid[1] };
  }
  if (geom.type === 'Polygon') {
    var ring = geom.coordinates[0];
    if (!ring || !ring.length) return null;
    var sx = 0, sy = 0, n = 0;
    for (var i = 0; i < ring.length - 1; i++) { sx += ring[i][0]; sy += ring[i][1]; n++; }
    return { lng: sx/n, lat: sy/n };
  }
  return null;
}

function renderDetection(result) {
  var card = document.getElementById('detection-card');
  var icon = document.getElementById('d-icon');
  var title = document.getElementById('d-title');
  var body = document.getElementById('d-body');
  var resultEl = document.getElementById('d-result');
  var breakdownEl = document.getElementById('d-breakdown');
  var overrideEl = document.getElementById('d-override');

  card.classList.remove('error', 'warn');
  card.classList.add('show');
  resultEl.style.display = 'none';
  breakdownEl.style.display = 'none';
  overrideEl.style.display = 'none';
  document.getElementById('d-override-form').classList.remove('show');

  if (result.status === 'rejected') {
    card.classList.add('error');
    icon.textContent = '⛔';
    title.textContent = 'הקובץ נדחה';

    if (result.reason === 'no_geometry') {
      body.textContent = 'לא נמצאה גיאומטריה תקפה. ייתכן שהקובץ הומר בלי קואורדינטות.';
    } else if (result.reason === 'outside_area') {
      body.innerHTML = 'מתוך ' + result.totalWithGeom + ' אובייקטים, ' +
        '<strong>' + result.outsideCount + '</strong> נמצאו מחוץ לאזור 7 הכפרים.<br>' +
        'בדוק את הקואורדינטות בקובץ — ייתכן שמערכת הקואורדינטות שגויה (לדוגמה: ITM במקום WGS 84).' +
        coordDiagnosticHtml();
    } else if (result.reason === 'no_match') {
      body.innerHTML = 'אף אובייקט בקובץ לא נופל באזור 7 הכפרים. בדוק את הקואורדינטות.' +
        coordDiagnosticHtml();
    }
    return;
  }

  icon.textContent = '✅';
  if (result.numVillages > 1) {
    title.textContent = 'הקובץ יחולק ל-' + result.numVillages + ' כפרים';
    body.innerHTML = 'המערכת תעלה כל כפר בנפרד אוטומטית לפי מיקום כל אובייקט.';
  } else {
    title.textContent = 'זיהוי אוטומטי הצליח';
    body.innerHTML = 'הקובץ זוהה אוטומטית לפי קואורדינטות האובייקטים.';
  }

  document.getElementById('d-village-icon').textContent = result.bestMatch.icon;
  document.getElementById('d-village-name').textContent = result.numVillages > 1 ? 'כפר דומיננטי: ' + result.bestMatch.name : result.bestMatch.name;
  document.getElementById('d-village-pct').textContent = result.percentage + '% (' + result.bestCount + '/' + result.totalWithGeom + ')';
  resultEl.style.display = 'flex';

  var breakdownHtml = '<div style="font-weight:600;margin-bottom:4px">פירוט אובייקטים לפי כפר:</div>';
  var rows = [];
  VILLAGES.forEach(function(v) {
    var c = result.villageCounts[v.slug] || 0;
    if (c > 0) {
      var pct = Math.round((c / result.totalWithGeom) * 100);
      rows.push({name: v.name, count: c, pct: pct});
    }
  });
  rows.sort(function(a, b) { return b.count - a.count; });
  rows.forEach(function(r) {
    breakdownHtml += '<div class="row"><span>' + r.name + '</span><span>' + r.count + ' (' + r.pct + '%)</span></div>';
  });
  if (result.outsideCount > 0) {
    var outsidePct = Math.round((result.outsideCount / result.totalWithGeom) * 100);
    breakdownHtml += '<div class="row" style="color:#dc2626"><span>🚫 מחוץ לאזור</span><span>' + result.outsideCount + ' (' + outsidePct + '%)</span></div>';
  }
  breakdownEl.innerHTML = breakdownHtml;
  breakdownEl.style.display = 'block';

  overrideEl.style.display = 'block';
  document.getElementById('village-select-override').value = '';
}

// Diagnostic shown on a rejection: the actual coordinate range of the data we
// received. For a DWG this is whatever the conversion service returned, so it
// reveals the real CRS problem at a glance — valid WGS84 over the Galilee is
// roughly lng 35.2–35.4, lat 32.8–33.0. Anything wildly different (negatives,
// huge magnitudes) means the source coordinate system wasn't handled.
function coordDiagnosticHtml() {
  var feats = (gFileData && gFileData.features) || [];
  var minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity, sample = null, n = 0;
  for (var i = 0; i < feats.length; i++) {
    var pt = featureCenter(feats[i].geometry);
    if (!pt) continue;
    n++;
    if (!sample) sample = pt;
    if (pt.lng < minLng) minLng = pt.lng;
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lng > maxLng) maxLng = pt.lng;
    if (pt.lat > maxLat) maxLat = pt.lat;
  }
  if (!n) return '';
  var f = function (x) { return (Math.round(x * 1e4) / 1e4); };
  return '<div style="margin-top:10px;padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;' +
    'border-radius:8px;font-size:11.5px;color:#7c2d12;direction:ltr;text-align:left">' +
    '<b>🔎 טווח קואורדינטות שהתקבל / received coordinate range:</b><br>' +
    'lng: ' + f(minLng) + ' … ' + f(maxLng) + '<br>' +
    'lat: ' + f(minLat) + ' … ' + f(maxLat) + '<br>' +
    'sample: [' + f(sample.lng) + ', ' + f(sample.lat) + ']<br>' +
    '<span style="color:#9a3412">תקין לגליל ≈ lng 35.2…35.4 · lat 32.8…33.0</span></div>';
}

function toggleOverride() {
  document.getElementById('d-override-form').classList.toggle('show');
}

// ── CSV column-mapping flow ──────────────────────────────────────────────────
// CSV files can't declare which columns are coordinates/geometry, so
// Importers.csv.parse() only reads the headers/rows and returns them for a
// small mapping UI (below) to resolve; only after the user confirms does
// Importers.csv.buildFeatures() produce real GeoJSON features, which then
// join the normal validate/reproject/detect/commit flow like every other format.
function startCsvMappingFlow(file) {
  showToast('⏳ קורא CSV...', 'info');
  window.Importers.csv.parse(file).then(function(parsed) {
    gCsvParse = parsed;
    renderCsvMappingUI(parsed);
  }).catch(function(err) {
    showToast('שגיאת CSV: ' + (err && err.message ? err.message : err), 'error');
    clearFile();
  });
}

function csvColumnOptions(headers, selectedIdx, includeNone) {
  var html = includeNone ? '<option value="">— ללא —</option>' : '';
  headers.forEach(function(h, idx) {
    var sel = (idx === selectedIdx) ? ' selected' : '';
    html += '<option value="' + escapeQuote(h) + '"' + sel + '>' + escapeHtml(h) + '</option>';
  });
  return html;
}

function renderCsvMappingUI(parsed) {
  var headers = parsed.headers || [];
  var guess = parsed.guess || {};
  document.getElementById('csv-wkt-col').innerHTML   = csvColumnOptions(headers, guess.wkt, true);
  document.getElementById('csv-layer-col').innerHTML = csvColumnOptions(headers, guess.layer, true);
  document.getElementById('csv-lon-col').innerHTML   = csvColumnOptions(headers, guess.lon, true);
  document.getElementById('csv-lat-col').innerHTML   = csvColumnOptions(headers, guess.lat, true);
  document.getElementById('csv-mapping-err').textContent = '';
  document.getElementById('fp-size').textContent = formatSize(gFile.size) + ' · ' + parsed.rows.length + ' שורות';

  document.getElementById('csv-mapping-section').classList.add('show');
  document.getElementById('meta-form').style.display = 'none';
  document.getElementById('mapping-section').classList.remove('show');
  document.getElementById('detection-card').classList.remove('show');
}

function confirmCsvMapping() {
  if (!gCsvParse) return;
  var wktCol   = document.getElementById('csv-wkt-col').value;
  var lonCol   = document.getElementById('csv-lon-col').value;
  var latCol   = document.getElementById('csv-lat-col').value;
  var layerCol = document.getElementById('csv-layer-col').value;
  var crs      = document.getElementById('csv-crs-itm').checked ? 'itm' : 'wgs84';
  var errEl    = document.getElementById('csv-mapping-err');
  errEl.textContent = '';

  if (!wktCol && (!lonCol || !latCol)) {
    errEl.textContent = 'יש לבחור עמודת WKT, או שתי עמודות X/Y (קו אורך/קו רוחב).';
    return;
  }

  var built;
  try {
    built = window.Importers.csv.buildFeatures(gCsvParse.rows, {
      wktCol: wktCol || null, lonCol: lonCol || null, latCol: latCol || null,
      layerCol: layerCol || null, crs: crs
    });
  } catch (e) {
    errEl.textContent = 'שגיאת CSV: ' + (e && e.message ? e.message : e);
    return;
  }
  if (!built.features.length) {
    errEl.textContent = 'לא נמצאו רשומות עם גיאומטריה תקינה לפי המיפוי שנבחר.';
    return;
  }

  document.getElementById('csv-mapping-section').classList.remove('show');
  var result = ImportPipeline.reproject(ImportPipeline.validate(built));
  applyPipelineResult(result);
}

// ── Merge-upload dedup ────────────────────────────────────────────────────────
// A new feature is a duplicate of an existing one iff it has the same geometry
// (coordinates rounded to ~1cm to absorb float noise) AND the same real
// attributes. Internal bookkeeping fields (prefixed "_": _category, _village,
// _original_layer) are ignored — the source attributes (Layer, lengths, depths,
// diameters, etc.) are what define identity.
function _roundCoord(c) {
  if (typeof c === 'number') return Math.round(c * 1e7) / 1e7;
  if (Array.isArray(c)) { var out = []; for (var i = 0; i < c.length; i++) out.push(_roundCoord(c[i])); return out; }
  return c;
}

function featureSignature(f) {
  var g = (f && f.geometry) || {};
  var geom = (g.type || '') + ':' + JSON.stringify(_roundCoord(g.coordinates));
  var p = (f && f.properties) || {};
  var keys = [];
  for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k) && k.charAt(0) !== '_') keys.push(k); }
  keys.sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    var v = p[keys[i]];
    parts.push(keys[i] + '=' + (v == null ? '' : String(v)));
  }
  return geom + '' + parts.join('');
}

// Read the village's current active GeoJSON features (the data we must keep).
async function fetchActiveVillageFeatures(slug) {
  try {
    var res = await gSb.from('village_layers')
      .select('file_path')
      .like('village_id', slug + '_%')
      .eq('is_active', true)
      .order('uploaded_at', { ascending: false })
      .limit(1);
    if (res.error || !res.data || !res.data.length) return [];
    var url = gSb.storage.from('village-layers').getPublicUrl(res.data[0].file_path).data.publicUrl;
    var resp = await fetch(url);
    if (!resp.ok) return [];
    var data = await resp.json();
    return (data && data.features) || [];
  } catch (e) { console.warn('merge: failed to read existing village data', e); return []; }
}

function analyzeAndDisplayLayers() {
  gLayerStats = {};
  gFileData.features.forEach(function(f) {
    var layerName = ImportPipeline.getLayerName(f);

    if (!gLayerStats[layerName]) {
      gLayerStats[layerName] = { name: layerName, count: 0, geomTypes: {}, mapping: 'other', isAuto: false, matchedRule: null };
    }
    gLayerStats[layerName].count++;
    var gt = f.geometry ? f.geometry.type : 'NULL';
    gLayerStats[layerName].geomTypes[gt] = (gLayerStats[layerName].geomTypes[gt] || 0) + 1;
  });

  var stats = { total: 0, auto: 0, ignore: 0, manual: 0 };
  Object.keys(gLayerStats).forEach(function(layerName) {
    stats.total++;
    var layer = gLayerStats[layerName];
    var matched = findMatchingRule(layerName);
    if (matched) {
      layer.mapping = matched.category;
      layer.isAuto = true;
      layer.matchedRule = matched;
      if (matched.category === 'IGNORE') stats.ignore++;
      else stats.auto++;
    } else {
      layer.mapping = 'other';
      layer.isAuto = false;
      stats.manual++;
    }
  });

  renderMappingTable();
  document.getElementById('ms-total').textContent = stats.total;
  document.getElementById('ms-auto').textContent = stats.auto;
  document.getElementById('ms-ignore').textContent = stats.ignore;
  document.getElementById('ms-manual').textContent = stats.manual;
  document.getElementById('mapping-section').classList.add('show');
}

function findMatchingRule(layerName) {
  var upper = layerName.toUpperCase();
  for (var i = 0; i < gRules.length; i++) {
    var r = gRules[i];
    var pat = (r.pattern || '').toUpperCase();
    if (!pat) continue;
    var match = false;
    if (r.match_type === 'exact') match = upper === pat;
    else if (r.match_type === 'starts_with') match = upper.indexOf(pat) === 0;
    else if (r.match_type === 'contains') match = upper.indexOf(pat) !== -1;
    else if (r.match_type === 'regex') { try { match = new RegExp(r.pattern, 'i').test(layerName); } catch(e) {} }
    if (match) return r;
  }
  return null;
}

function renderMappingTable() {
  var tbl = document.getElementById('mapping-table');
  var sortedNames = Object.keys(gLayerStats).sort(function(a, b) { return gLayerStats[b].count - gLayerStats[a].count; });
  tbl.innerHTML = '<thead><tr>' +
    '<th>שכבת AutoCAD</th><th style="width:90px">אובייקטים</th>' +
    '<th>סוג גיאומטריה</th><th>מקור</th>' +
    '<th style="width:240px">קטגוריה במערכת</th></tr></thead><tbody></tbody>';
  var tbody = tbl.querySelector('tbody');
  sortedNames.forEach(function(layerName) {
    var ls = gLayerStats[layerName];
    var geomDesc = Object.keys(ls.geomTypes).map(function(g) { return g + ' (' + ls.geomTypes[g] + ')'; }).join(', ');
    var sourceTag = ls.matchedRule
      ? '<span class="auto-tag auto-rule">🤖 חוק "' + ls.matchedRule.pattern + '"</span>'
      : '<span class="auto-tag auto-manual">✏️ ידני</span>';
    var selectOptions = CATEGORIES.map(function(c) {
      var sel = (c.value === ls.mapping) ? ' selected' : '';
      return '<option value="' + c.value + '"' + sel + '>' + c.label + '</option>';
    }).join('');
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><span class="layer-cell">' + escapeHtml(layerName) + '</span></td>' +
      '<td><span class="feat-count">' + ls.count + '</span></td>' +
      '<td style="font-size:11px;color:var(--muted)">' + geomDesc + '</td>' +
      '<td>' + sourceTag + '</td>' +
      '<td><select onchange="updateLayerMapping(\'' + escapeQuote(layerName) + '\', this.value)">' + selectOptions + '</select></td>';
    tbody.appendChild(tr);
  });
}

function updateLayerMapping(layerName, newCategory) {
  if (gLayerStats[layerName]) {
    gLayerStats[layerName].mapping = newCategory;
    if (gLayerStats[layerName].isAuto) {
      gLayerStats[layerName].isAuto = false;
      gLayerStats[layerName].matchedRule = null;
    }
  }
}

function clearFile() {
  gFile = null; gFileData = null; gLayerStats = {}; gDetectedVillage = null; gCsvParse = null;
  document.getElementById('file-input').value = '';
  document.getElementById('file-preview').classList.remove('show');
  document.getElementById('meta-form').style.display = 'none';
  document.getElementById('mapping-section').classList.remove('show');
  document.getElementById('csv-mapping-section').classList.remove('show');
  document.getElementById('detection-card').classList.remove('show');
  document.getElementById('progress').classList.remove('show');
}

async function doUpload() {
  if (!gFile || !gFileData) { showToast('אין קובץ', 'error'); return; }

  var overrideValue = document.getElementById('village-select-override').value;
  var overrideVillage = overrideValue ? VILLAGES.find(function(v) { return v.name === overrideValue; }) : null;

  var icon = document.getElementById('icon-select').value;
  var saveRules = document.getElementById('save-rules-checkbox').checked;

  var btn = document.getElementById('upload-btn');
  var pw = document.getElementById('progress');
  var ps = document.getElementById('progress-stage');
  var pf = document.getElementById('progress-fill');
  var pt = document.getElementById('progress-text');
  btn.disabled = true; btn.textContent = '⏳ מעלה...';
  pw.classList.add('show');

  try {
    ps.textContent = 'שלב 1/4: מיישם מיפוי שכבות';
    pf.style.width = '15%';
    pt.textContent = 'מתייג אובייקטים...';

    var mapped = ImportPipeline.mapToLayers(gFileData.features, {
      layerStats: gLayerStats,
      overrideVillage: overrideVillage,
      detectFeatureVillage: detectFeatureVillage
    });
    var taggedByVillage = mapped.taggedByVillage;

    var slugs = Object.keys(taggedByVillage);
    if (!slugs.length) throw new Error('כל האובייקטים סומנו כ-IGNORE או מחוץ לאזור');

    if (saveRules) {
      ps.textContent = 'שלב 2/4: שומר חוקי מיפוי חדשים';
      pf.style.width = '35%';
      pt.textContent = 'מעדכן חוקים גלובליים...';
      await saveLearnedRules();
    }

    // ── Import straight into the GIS engine (features/layers/fields) ──────
    // Grouped by _category → one engine layer per "<village> · <category>".
    // Re-upload is safe: import_features upserts by synthesised asset_code.
    var commitResult = await ImportPipeline.commit(taggedByVillage, {
      importFeatures: GIS.migrate.importFeatures,
      onVillageStart: function (village, vi, total, featureCount) {
        ps.textContent = 'מייבא ' + village.name + ' למנוע (' + (vi + 1) + '/' + total + ')';
        pf.style.width = (55 + Math.round(40 * vi / total)) + '%';
        pt.textContent = featureCount + ' אובייקטים...';
      },
      onProgress: function (village, done, total) {
        pt.textContent = village.name + ': ' + done + ' / ' + total;
      }
    });
    var totalAdded = commitResult.totalAdded;

    pf.style.width = '100%';
    pt.textContent = '✅ יובאו ' + totalAdded + ' אובייקטים למנוע · ' + slugs.length + ' כפרים';
    var villageNames = slugs.map(function(s) { return taggedByVillage[s].village.name; }).join(', ');
    showToast('✅ הועלה ל: ' + villageNames, 'success');

    setTimeout(function() {
      clearFile(); btn.disabled = false; btn.textContent = '📤 העלה';
      loadLayers();
      loadRules();
    }, 2500);
  } catch(e) {
    showToast('שגיאה: ' + e.message, 'error');
    pw.classList.remove('show'); btn.disabled = false; btn.textContent = '📤 העלה';
    console.error(e);
  }
}

async function saveLearnedRules() {
  var newRules = [];
  Object.keys(gLayerStats).forEach(function(layerName) {
    var ls = gLayerStats[layerName];
    if (!ls.isAuto && ls.mapping !== 'other') {
      newRules.push({
        pattern: layerName,
        match_type: 'exact',
        category: ls.mapping,
        priority: 50,
        notes: 'נוצר אוטומטית בהעלאה',
        created_by: gAdminId,
        is_active: true
      });
    }
  });
  if (!newRules.length) return;
  for (var i = 0; i < newRules.length; i++) {
    try {
      await gSb.from('layer_mapping_rules').upsert(newRules[i], { onConflict: 'pattern,match_type' });
    } catch(e) { console.warn('Rule save failed for ' + newRules[i].pattern, e); }
  }
}

// Hebrew labels for the "<village> · <category>" engine layer names.
var CAT_LABELS = {};
CATEGORIES.forEach(function(c) { if (c.value !== 'IGNORE') CAT_LABELS[c.value] = c.label; });

// "Existing layers" now reflects what's actually in the GIS engine (the
// layers/features tables), grouped by village — uploads have imported there
// since the engine became the whole app, NOT into the old village_layers table.
async function loadLayers() {
  var el = document.getElementById('layers-list');
  el.innerHTML = '<div class="empty"><div class="empty-icon">⏳</div>טוען...</div>';
  try {
    var layers = await GIS.layers.getLayers();
    renderLayers(layers || []);
  } catch (e) {
    el.innerHTML = '<div class="empty" style="color:#dc2626"><div class="empty-icon">⚠️</div>' +
      escapeHtml(e.message || String(e)) + '</div>';
  }
}

function renderLayers(layers) {
  var el = document.getElementById('layers-list');
  if (!layers.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📭</div>אין שכבות עדיין</div>';
    return;
  }
  // Group engine layers by village (layer name = "<village> · <category>").
  var groups = {}, order = [];
  layers.forEach(function(l) {
    var parsed = LayerNaming.parse(l.name || '');
    var village = parsed.village !== null ? parsed.village : (l.name || 'שכבות כלליות');
    var cat = parsed.village !== null ? parsed.category : '';
    if (!groups[village]) { groups[village] = []; order.push(village); }
    groups[village].push({ id: l.id, cat: cat, label: CAT_LABELS[cat] || cat || l.name });
  });

  var html = '';
  order.forEach(function(village) {
    var rows = groups[village];
    html += '<div class="layers-village" style="border:1px solid #eef2f6;border-radius:10px;margin-bottom:10px;overflow:hidden">' +
      '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#f8fafc;font-weight:700;color:#0d3b5e">' +
        '<span style="flex:1">📍 ' + escapeHtml(village) + '</span>' +
        '<span style="font-size:11px;color:#94a3b8">' + rows.length + ' שכבות</span>' +
        '<button class="btn btn-danger" style="padding:4px 10px;font-size:11px" ' +
          'onclick="deleteVillageLayers(\'' + escapeQuote(village) + '\')">🗑️ מחק כפר</button>' +
      '</div><div style="padding:6px 12px">';
    rows.forEach(function(r) {
      html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-top:1px solid #f1f5f9">' +
        '<span style="flex:1;font-size:13px">' + escapeHtml(r.label) + '</span>' +
        '<button class="btn btn-danger" style="padding:3px 9px;font-size:11px" ' +
          'onclick="deleteEngineLayer(\'' + r.id + '\')">🗑️ מחק</button></div>';
    });
    html += '</div></div>';
  });
  el.innerHTML = html;
}

async function deleteEngineLayer(layerId) {
  if (!confirm('למחוק את השכבה הזו מהמנוע? כולל כל הפיצ\'רים. פעולה בלתי הפיכה.')) return;
  try {
    await GIS.layers.deleteLayer(layerId);
    showToast('🗑️ נמחק');
  } catch (e) { showToast('שגיאה: ' + e.message, 'error'); }
  loadLayers();
}

async function deleteVillageLayers(village) {
  if (!confirm('למחוק את כל שכבות "' + village + '" מהמנוע? כולל כל הפיצ\'רים. פעולה בלתי הפיכה.')) return;
  try {
    var layers = await GIS.layers.getLayers();
    var toDel = layers.filter(function(l) {
      var parsed = LayerNaming.parse(l.name || '');
      var v = parsed.village !== null ? parsed.village : (l.name || '');
      return v === village;
    });
    for (var i = 0; i < toDel.length; i++) await GIS.layers.deleteLayer(toDel[i].id);
    showToast('🗑️ נמחקו ' + toDel.length + ' שכבות');
  } catch (e) { showToast('שגיאה: ' + e.message, 'error'); }
  loadLayers();
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1024/1024).toFixed(2) + ' MB';
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeQuote(s) { return String(s).replace(/'/g,"\\'").replace(/"/g,'\\"'); }

function showToast(msg, type) {
  MotionUtils.showToast(msg, type);
}

window.updateLayerMapping = updateLayerMapping;
window.deleteEngineLayer = deleteEngineLayer;
window.deleteVillageLayers = deleteVillageLayers;
window.toggleOverride = toggleOverride;
window.confirmCsvMapping = confirmCsvMapping;
