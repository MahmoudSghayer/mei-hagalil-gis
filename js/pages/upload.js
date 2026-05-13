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
  { value: 'buildings', label: '🏢 בניינים' },
  { value: 'parcels', label: '📐 חלקות' },
  { value: 'sleeve', label: '🔧 שרוולים' },
  { value: 'pipe_label', label: '🏷️ תוויות צנרת' },
  { value: 'elevation_label', label: '📏 גבהים TL/IL' },
  { value: 'attribute_label', label: '📊 תוויות נתונים' },
  { value: 'distance_label', label: '↔ מרחקים' },
  { value: 'other', label: '❓ אחר' }
];

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

// ── CRS / COORDINATE UTILITIES ───────────────────────────────────────────────

function ensureITM() {
  if (window.proj4 && !window.proj4.defs('EPSG:2039')) {
    window.proj4.defs('EPSG:2039',
      '+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 ' +
      '+k=1.0000067 +x_0=219529.584 +y_0=626907.39 +ellps=GRS80 ' +
      '+towgs84=-48,55,52,0,0,0,0 +units=m +no_defs');
  }
}

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

function convertCoord(xy, crs) {
  if (crs !== 'ITM') return xy;
  var r = window.proj4('EPSG:2039', 'EPSG:4326', [xy[0], xy[1]]);
  return [r[0], r[1]]; // [lng, lat]
}

function convertCoords(coords, crs) {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') return convertCoord(coords, crs);
  return coords.map(function(c) { return convertCoords(c, crs); });
}

function convertGeometry(geom, crs) {
  if (!geom || crs === 'WGS84') return geom;
  return { type: geom.type, coordinates: convertCoords(geom.coordinates, crs) };
}

function validateCoord(lng, lat) {
  // Israel bounding box
  return lat >= 29 && lat <= 34 && lng >= 34 && lng <= 37;
}

// ── SHAPEFILE ZIP PROCESSING ──────────────────────────────────────────────────

function processZipFile(file, onDone, onError) {
  ensureITM();

  JSZip.loadAsync(file).then(function(zip) {
    var shpPaths = [];
    zip.forEach(function(path, entry) {
      if (!entry.dir && path.toLowerCase().endsWith('.shp')) shpPaths.push(path);
    });
    if (!shpPaths.length) { onError(new Error('לא נמצאו קבצי .shp בתוך ה-ZIP')); return; }

    var allFeatures = [];
    var remaining = shpPaths.length;
    var hasError = false;

    shpPaths.forEach(function(shpPath) {
      var base = shpPath.replace(/\.shp$/i, '');
      var layerName = base.split('/').pop().split('\\').pop();

      // Load .shp, .dbf, .prj in parallel
      var shpPromise  = zip.file(shpPath) ? zip.file(shpPath).async('arraybuffer') : Promise.resolve(null);
      var dbfFile     = zip.file(base + '.dbf') || zip.file(base + '.DBF');
      var dbfPromise  = dbfFile ? dbfFile.async('arraybuffer') : Promise.resolve(null);
      var prjFile     = zip.file(base + '.prj') || zip.file(base + '.PRJ');
      var prjPromise  = prjFile ? prjFile.async('string') : Promise.resolve(null);

      Promise.all([shpPromise, dbfPromise, prjPromise]).then(function(results) {
        var shpBuf = results[0], dbfBuf = results[1], prjText = results[2];
        var crs = detectCRSFromPrj(prjText);

        if (crs === 'unknown') {
          console.warn('Unknown CRS for ' + layerName + ' — assuming ITM');
          crs = 'ITM'; // Safe default for Israeli data
        }

        return window.shapefile.read(shpBuf, dbfBuf).then(function(collection) {
          var bad = 0;
          collection.features.forEach(function(f) {
            if (!f.geometry) return;
            var converted = convertGeometry(f.geometry, crs);

            // Validate a sample coordinate
            var sample = converted.coordinates;
            while (Array.isArray(sample[0])) sample = sample[0];
            if (!validateCoord(sample[0], sample[1])) { bad++; return; }

            if (!f.properties) f.properties = {};
            f.properties.Layer = layerName;
            f.properties._original_layer = layerName;
            f.geometry = converted;
            allFeatures.push(f);
          });
          if (bad > 0) console.warn(layerName + ': ' + bad + ' features skipped (outside Israel bounds)');
        });
      })
      .catch(function(e) {
        console.warn('Failed to read ' + layerName + ':', e);
      })
      .then(function() {
        if (--remaining === 0) {
          if (!allFeatures.length) { onError(new Error('לא נמצאו אובייקטים תקינים בקבצים')); return; }
          onDone({ type: 'FeatureCollection', features: allFeatures });
        }
      });
    });
  }).catch(onError);
}

// ── FILE HANDLING ─────────────────────────────────────────────────────────────

function handleFile(file) {
  var isZip     = /\.zip$/i.test(file.name);
  var isGeoJson = /\.(geojson|json)$/i.test(file.name);
  if (!isZip && !isGeoJson) { showToast('קבצי GeoJSON, JSON, או ZIP בלבד', 'error'); return; }
  if (file.size > 100*1024*1024) { showToast('גודל מקסימלי 100MB', 'error'); return; }

  gFile = file;
  document.getElementById('fp-name').textContent = file.name;
  document.getElementById('fp-size').textContent = formatSize(file.size);
  document.getElementById('file-preview').classList.add('show');

  if (isZip) {
    showToast('⏳ מעבד Shapefile...', 'info');
    processZipFile(file, function(data) {
      finishFileLoad(data);
    }, function(err) {
      showToast('שגיאה: ' + err.message, 'error');
      clearFile();
    });
  } else {
    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var data = JSON.parse(e.target.result);
        if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
          showToast('הקובץ אינו GeoJSON תקין', 'error'); clearFile(); return;
        }
        finishFileLoad(data);
      } catch(err) { showToast('שגיאה: ' + err.message, 'error'); clearFile(); }
    };
    reader.readAsText(file);
  }
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
        'בדוק את הקואורדינטות בקובץ — ייתכן שמערכת הקואורדינטות שגויה (לדוגמה: ITM במקום WGS 84).';
    } else if (result.reason === 'no_match') {
      body.textContent = 'אף אובייקט בקובץ לא נופל באזור 7 הכפרים. בדוק את הקואורדינטות.';
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

function toggleOverride() {
  document.getElementById('d-override-form').classList.toggle('show');
}

function analyzeAndDisplayLayers() {
  gLayerStats = {};
  gFileData.features.forEach(function(f) {
    var props = f.properties || {};
    var layerName = props.Layer || props.layer || props.LAYER ||
                    props._original_layer || props._category || 'UNKNOWN';
    layerName = String(layerName).trim() || 'UNKNOWN';

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
  gFile = null; gFileData = null; gLayerStats = {}; gDetectedVillage = null;
  document.getElementById('file-input').value = '';
  document.getElementById('file-preview').classList.remove('show');
  document.getElementById('meta-form').style.display = 'none';
  document.getElementById('mapping-section').classList.remove('show');
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

    var taggedByVillage = {};
    var ignoredCount = 0;

    gFileData.features.forEach(function(f) {
      var props = f.properties || {};
      var layerName = props.Layer || props.layer || props.LAYER || props._original_layer || 'UNKNOWN';
      layerName = String(layerName).trim() || 'UNKNOWN';
      var stats = gLayerStats[layerName];
      if (!stats || stats.mapping === 'IGNORE') { ignoredCount++; return; }

      var targetVillage = overrideVillage || detectFeatureVillage(f);
      if (!targetVillage) { ignoredCount++; return; }

      var slug = targetVillage.slug;
      if (!taggedByVillage[slug]) taggedByVillage[slug] = { village: targetVillage, features: [], categoryCounts: {} };
      var newProps = Object.assign({}, props);
      newProps._category = stats.mapping;
      newProps._original_layer = layerName;
      taggedByVillage[slug].categoryCounts[stats.mapping] = (taggedByVillage[slug].categoryCounts[stats.mapping] || 0) + 1;
      taggedByVillage[slug].features.push({ type: 'Feature', geometry: f.geometry, properties: newProps });
    });

    var slugs = Object.keys(taggedByVillage);
    if (!slugs.length) throw new Error('כל האובייקטים סומנו כ-IGNORE או מחוץ לאזור');

    if (saveRules) {
      ps.textContent = 'שלב 2/4: שומר חוקי מיפוי חדשים';
      pf.style.width = '35%';
      pt.textContent = 'מעדכן חוקים גלובליים...';
      await saveLearnedRules();
    }

    var ts = Date.now();
    var totalUploaded = 0;

    for (var vi = 0; vi < slugs.length; vi++) {
      var slug = slugs[vi];
      var vData = taggedByVillage[slug];
      var village = vData.village;
      var vFeatures = vData.features;
      var catCounts = vData.categoryCounts;

      ps.textContent = 'מעלה ' + village.name + ' (' + (vi + 1) + '/' + slugs.length + ')';
      pf.style.width = (55 + Math.round(40 * (vi + 1) / slugs.length)) + '%';
      pt.textContent = vFeatures.length + ' אובייקטים...';

      var fileName = village.slug + '_' + ts + (slugs.length > 1 ? '_' + vi : '') + '.geojson';
      var dataToUpload = {
        type: 'FeatureCollection',
        features: vFeatures,
        _meta: {
          uploaded_at: new Date().toISOString(),
          original_filename: gFile.name,
          detected_village: village.name,
          layer_count: Object.keys(catCounts).length,
          kept_features: vFeatures.length
        }
      };
      var fileBlob = new Blob([JSON.stringify(dataToUpload)], { type: 'application/json' });
      var uploadRes = await gSb.storage.from('village-layers').upload(fileName, fileBlob, { upsert: true, contentType: 'application/json' });
      if (uploadRes.error) throw uploadRes.error;

      var metaId = village.slug + '_' + ts + (slugs.length > 1 ? '_' + vi : '');
      var displayName = village.name + ' — ' + Object.keys(catCounts).length + ' קטגוריות';
      var metaRes = await gSb.from('village_layers').upsert({
        village_id: metaId,
        village_name: displayName,
        icon: icon,
        file_path: fileName,
        feature_count: vFeatures.length,
        uploaded_by: gAdminId,
        uploaded_at: new Date().toISOString(),
        is_active: true
      }, { onConflict: 'village_id' });
      if (metaRes.error) throw metaRes.error;

      totalUploaded += vFeatures.length;
    }

    pf.style.width = '100%';
    pt.textContent = '✅ הועלו ' + totalUploaded + ' אובייקטים ל-' + slugs.length + ' כפרים';
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

async function loadLayers() {
  var res = await gSb.from('village_layers').select('*').order('uploaded_at', {ascending:false});
  if (res.error) return;
  renderLayers(res.data || []);
}

function renderLayers(layers) {
  var el = document.getElementById('layers-list');
  if (!layers.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📭</div>אין שכבות עדיין</div>';
    return;
  }
  el.innerHTML = '<table class="layers"><thead><tr>' +
    '<th>שכבה</th><th>אובייקטים</th><th>הועלה</th><th>סטטוס</th><th>פעולות</th>' +
    '</tr></thead><tbody>' +
    layers.map(function(l) {
      var date = new Date(l.uploaded_at).toLocaleString('he-IL', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
      return '<tr>' +
        '<td><div class="layer-name"><span class="layer-icon">'+(l.icon||'🏘️')+'</span>' +
          '<div><div style="font-weight:600">'+l.village_name+'</div>' +
          '<div style="font-size:11px;color:var(--muted)">'+l.file_path+'</div></div></div></td>' +
        '<td><span class="feature-count-pill">'+l.feature_count+'</span></td>' +
        '<td><div style="font-size:12px">'+date+'</div></td>' +
        '<td>' + (l.is_active ? '🟢 פעיל' : '⚪ מושהה') + '</td>' +
        '<td><button class="btn btn-danger" style="padding:5px 12px;font-size:11px" onclick="deleteLayer(\''+l.village_id+'\',\''+l.file_path+'\')">🗑️ מחק</button></td>' +
      '</tr>';
    }).join('') +
    '</tbody></table>';
  MotionUtils.animateTableRows('#layers-list tbody');
}

async function deleteLayer(villageId, filePath) {
  if (!confirm('האם למחוק את השכבה?')) return;
  await gSb.storage.from('village-layers').remove([filePath]);
  await gSb.from('village_layers').delete().eq('village_id', villageId);
  showToast('🗑️ נמחק');
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
window.deleteLayer = deleteLayer;
window.toggleOverride = toggleOverride;
