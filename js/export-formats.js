// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Export format serializers (DXF / CSV / KML / GeoJSON /
//  Shapefile-prep / Excel-prep / WKT)
//  Extracted from export-feature.js for readability. Plain globals, loaded
//  BEFORE export-feature.js (see index.html) so the shared helpers below are
//  visible from both files as real globals.
//
//  IMPORTANT — why the shared helpers (LABELS/makeToITM/groupByCategory/
//  reprojCoords/cleanProps) live HERE and not in export-feature.js: that file
//  wraps its entire body in an IIFE `(function(){ 'use strict'; ... })()`, so
//  any `var`/`function` declared there is local to that closure and NOT a
//  property of `window` — a separate script (like this one) cannot see it.
//  A previous version of this file assumed otherwise ("both are plain
//  globals") which was wrong: buildDXF() calling makeToITM() and buildKML()
//  reading LABELS both threw ReferenceError at runtime (verified: exporting
//  DXF or KML was completely broken). Keeping these pure, DOM-free helpers in
//  this un-wrapped script — which genuinely does put its top-level
//  declarations on `window` — fixes that for good and lets export-feature.js
//  keep reading them by plain identifier (global scope is always reachable
//  from inside its IIFE).
// ════════════════════════════════════════════════════════════════

// ── async chunking ─────────────────────────────────────────────────────────────
// Yield to the browser between chunks so a big export doesn't freeze the tab and
// the progress spinner keeps animating. _forEachChunked applies fn to every item
// in order (identical output to .forEach), pausing every `chunk` items.
function _yieldUI() { return new Promise(function (r) { setTimeout(r, 0); }); }
async function _forEachChunked(arr, chunk, fn, onProgress) {
  for (var i = 0; i < arr.length; i++) {
    fn(arr[i], i);
    if ((i + 1) % chunk === 0) { if (onProgress) onProgress(i + 1, arr.length); await _yieldUI(); }
  }
  if (onProgress) onProgress(arr.length, arr.length);
}

// ── SHARED HELPERS (moved from export-feature.js — see note above) ─────────────
var LABELS = {
  sewage_pipe:'קווי ביוב (DWG)', manhole:'שוחות ביוב (DWG)', sleeve:'שרוולים',
  control_point:'נקודות בקרה', pipe_label:'תוויות צנרת', elevation_label:'גבהים TL/IL',
  attribute_label:'תוויות שוחות', distance_label:'מרחקים', dimension_line:'קווי מידה',
  manhole_drawing:'שרטוטי שוחות', buildings:'בניינים', parcels:'חלקות',
  water_meters:'מדי מים', water_pipes:'קווי מים', sewage_pipes:'קווי ביוב',
  sewage_manholes:'שוחות ביוב', hydrants:'הידרנטים', valves:'מגופים',
  control_valves:'מגופים שולטים', connection_points:'נקודות חיבור מקורות',
  reservoirs:'מאגרי מים', pump_stations:'תחנות שאיבה',
  sampling_points:'נקודות דיגום',
  main_sewer:'ביב ראשי', supply_pipe:'קו הספקה',
  sewage_cascade:'מפל ביוב', fittings:'מתאמים',
  annotation_points:'נקודות להערות', sewer_exit:'יציאה מרשת ביוב',
  annotation_polygons:'פוליגונים להערות', annotation_lines:'קווים להערות',
  valve_chamber:'תא מגופים', block:'גוש',
  other:'אחר'
};

// EPSG:4326 → EPSG:2039 (ITM) converter factory. Returns a plain (lng,lat)->[x,y]
// function; falls back to identity if proj4 isn't loaded.
function makeToITM() {
  if (window.proj4 && !window.proj4.defs('EPSG:2039')) {
    // Canonical def now lives in js/crs-utils.js (CRSUtils.EPSG2039_DEF); the
    // literal string is kept ONLY as a load-order-safety fallback for when
    // that script hasn't loaded yet. EXACT "Israel 1993 to WGS 84 (2)" 7-param
    // Helmert that PROJ/pyproj uses (~0.5 m); the old 3-param -48,55,52 was
    // ~10 m off. Keep the fallback string in sync with search/upload/CRSUtils.
    window.proj4.defs('EPSG:2039', window.CRSUtils ? window.CRSUtils.EPSG2039_DEF :
      '+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 ' +
      '+k=1.0000067 +x_0=219529.584 +y_0=626907.39 +ellps=GRS80 ' +
      '+towgs84=23.772,17.49,17.859,-0.3132,-1.85274,1.67299,-5.4262 +units=m +no_defs');
  }
  return function (lng, lat) {
    if (window.proj4) { try { return window.proj4('EPSG:4326', 'EPSG:2039', [lng, lat]); } catch (e) {} }
    return [lng, lat];
  };
}

function groupByCategory(features) {
  var by = {};
  features.forEach(function (f) {
    var c = (f.properties && f.properties._category) || 'other';
    (by[c] = by[c] || []).push(f);
  });
  return by;
}

function reprojCoords(g, t) {
  function pt(c) { var p = t(c[0], c[1]); return (c.length > 2) ? [p[0], p[1], c[2]] : [p[0], p[1]]; }
  function arr(a) { return a.map(pt); }
  if (g.type === 'Point') return { type: 'Point', coordinates: pt(g.coordinates) };
  if (g.type === 'LineString') return { type: 'LineString', coordinates: arr(g.coordinates) };
  if (g.type === 'MultiLineString') return { type: 'MultiLineString', coordinates: g.coordinates.map(arr) };
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.coordinates.map(arr) };
  if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: g.coordinates.map(function (poly) { return poly.map(arr); }) };
  return g;
}

function cleanProps(p) {  // shp/dbf can't hold nested objects; drop internal _keys
  var out = {};
  Object.keys(p || {}).forEach(function (k) {
    if (k.charAt(0) === '_') return;
    var v = p[k];
    if (v === null || v === undefined) return;
    out[k] = (typeof v === 'object') ? JSON.stringify(v) : v;
  });
  return out;
}

// ── DXF ───────────────────────────────────────────────────────────────────────
async function buildDXF(features, onProgress) {
  var toITM = makeToITM();
  var colors = {
    sewage_pipe:2,manhole:4,sleeve:6,control_point:1,water_pipes:5,water_meters:5,
    hydrants:1,valves:6,control_valves:6,buildings:8,parcels:3,sewage_pipes:42,
    sewage_manholes:42,reservoirs:3,pump_stations:2,sampling_points:6,
    connection_points:5,pipe_label:7,elevation_label:7,attribute_label:7,
    distance_label:7,dimension_line:9,manhole_drawing:8,
    main_sewer:1,supply_pipe:5,sewage_cascade:42,fittings:8,
    annotation_points:3,sewer_exit:2,annotation_polygons:3,annotation_lines:3,
    valve_chamber:6,block:4,other:7
  };
  // Deduplicate features: same GlobalID/OBJECTID per category, or same coordinate fingerprint
  var seenFeatures = {};
  features = features.filter(function (f) {
    var props = f.properties || {};
    var cat   = props._category || 'other';
    var key;
    if (props.GlobalID) {
      key = cat + ':' + props.GlobalID;
    } else if (props.OBJECTID !== undefined) {
      key = cat + ':obj:' + String(props.OBJECTID);
    } else {
      var g = f.geometry;
      if (!g) return true;
      var coords = g.type === 'Point'            ? [g.coordinates]
                 : g.type === 'LineString'        ? g.coordinates
                 : g.type === 'MultiLineString'   ? g.coordinates[0]
                 : g.type === 'Polygon'           ? g.coordinates[0]
                 : g.type === 'MultiPolygon'      ? g.coordinates[0][0]
                 : null;
      if (!coords || !coords.length) return true;
      key = cat + ':' + coords[0][0].toFixed(4) + ':' + coords[0][1].toFixed(4) +
            ':' + coords[coords.length - 1][0].toFixed(4) + ':' + coords[coords.length - 1][1].toFixed(4) +
            ':' + coords.length;
    }
    if (seenFeatures[key]) return false;
    seenFeatures[key] = true;
    return true;
  });

  var seen = {};
  features.forEach(function (f) {
    var c = (f.properties && f.properties._category) || 'other';
    seen[c] = true;
  });

  var lines = [
    '0','SECTION','2','HEADER',
    '9','$ACADVER','1','AC1009',
    '9','$INSUNITS','70','6',
    '9','$MEASUREMENT','70','1',
    '0','ENDSEC'
  ];

  // TABLES — LTYPE is required by AutoCAD even if only CONTINUOUS is used
  lines.push('0','SECTION','2','TABLES');
  lines.push('0','TABLE','2','LTYPE','70','1');
  lines.push('0','LTYPE','2','CONTINUOUS','70','0','3','Solid line','72','65','73','0','40','0.0');
  lines.push('0','ENDTAB');
  // LAYER — layer 0 is mandatory in every valid DXF
  lines.push('0','TABLE','2','LAYER','70',String(Object.keys(seen).length + 2));
  lines.push('0','LAYER','2','0','70','0','62','7','6','CONTINUOUS');
  lines.push('0','LAYER','2','ATTR','70','0','62','-3','6','CONTINUOUS'); // off by default, turn on in Layer Manager
  Object.keys(seen).forEach(function (c) {
    lines.push('0','LAYER','2',c,'70','0','62',String(colors[c]||7),'6','CONTINUOUS');
  });
  lines.push('0','ENDTAB');
  // APPID — required to attach XDATA (attribute data) to entities
  lines.push('0','TABLE','2','APPID','70','1');
  lines.push('0','APPID','2','MGIS','70','0');
  lines.push('0','ENDTAB');
  lines.push('0','ENDSEC');
  lines.push('0','SECTION','2','ENTITIES');
  await _forEachChunked(features, 2000, function (f) {
    var layer = (f.properties && f.properties._category) || 'other';
    var g = f.geometry;
    if (!g) return;
    var labelPt = null; // compute representative point for attribute label — once per feature
    if (g.type === 'Point') {
      var p = toITM(g.coordinates[0], g.coordinates[1]);
      lines.push('0','POINT','8',layer,'10',String(p[0]),'20',String(p[1]),'30','0');
      dxfXdata(lines, f.properties);
      if (f.properties && f.properties.Text)
        lines.push('0','TEXT','8',layer,'10',String(p[0]),'20',String(p[1]),'30','0','40','1.0','1',String(f.properties.Text));
      labelPt = p;
    } else if (g.type === 'LineString') {
      dxfPolyline(lines, g.coordinates, layer, false, toITM, f.properties);
      var mid = g.coordinates[Math.floor(g.coordinates.length / 2)];
      labelPt = toITM(mid[0], mid[1]);
    } else if (g.type === 'MultiLineString') {
      g.coordinates.forEach(function (seg) { dxfPolyline(lines, seg, layer, false, toITM, f.properties); });
      var segs = g.coordinates;
      var midSeg = segs[Math.floor(segs.length / 2)];
      var midPt  = midSeg[Math.floor(midSeg.length / 2)];
      labelPt = toITM(midPt[0], midPt[1]);
    } else if (g.type === 'Polygon') {
      dxfPolyline(lines, g.coordinates[0], layer, true, toITM, f.properties);
      var ring = g.coordinates[0];
      var rpt  = ring[Math.floor(ring.length / 2)];
      labelPt = toITM(rpt[0], rpt[1]);
    } else if (g.type === 'MultiPolygon') {
      g.coordinates.forEach(function (poly) { dxfPolyline(lines, poly[0], layer, true, toITM, f.properties); });
      var ring2 = g.coordinates[0][0];
      var rpt2  = ring2[Math.floor(ring2.length / 2)];
      labelPt = toITM(rpt2[0], rpt2[1]);
    }
    // Write labels only for manholes and pipes (skip buildings, parcels, annotations, etc.)
    if (labelPt) {
      var lcat = (f.properties && f.properties._category) || '';
      var wantLabel = lcat === 'sewage_manholes' || lcat === 'manhole' ||
                      lcat === 'sewage_pipes'    || lcat === 'sewage_pipe' ||
                      lcat === 'water_pipes'     || lcat === 'main_sewer' || lcat === 'supply_pipe';
      if (wantLabel) dxfAttrLabel(lines, f.properties, labelPt[0], labelPt[1]);
    }
  }, onProgress);
  lines.push('0','ENDSEC','0','EOF');
  return lines.join('\r\n');
}

// Write attribute text labels on the ATTR layer — manholes only (3 rows), pipes diameter only (1 row)
function dxfAttrLabel(lines, props, x, y) {
  if (!props) return;
  var cat = props._category || '';
  var rows = [];

  var isManhole = (cat === 'sewage_manholes' || cat === 'manhole');
  var isPipe    = (cat === 'sewage_pipes' || cat === 'sewage_pipe' ||
                   cat === 'water_pipes'  || cat === 'main_sewer' || cat === 'supply_pipe');

  if (isManhole) {
    // 3 rows max: MH number, TL, Depth
    if (props.ManholeNum) rows.push('MH: ' + props.ManholeNum);
    var tl = parseFloat(props.TL);
    if (!isNaN(tl))  rows.push('TL: ' + tl.toFixed(2));
    var dep = parseFloat(props.Depth);
    if (!isNaN(dep)) rows.push('D: ' + dep.toFixed(2) + 'm');
  } else if (isPipe) {
    // 1 row: diameter only — length can be measured; category is obvious from color
    if (props.LineDiamet) rows.push('Ø' + props.LineDiamet + 'mm');
  }

  if (!rows.length) return;

  // Manholes: label goes upper-right (+15m, +12m)
  // Pipes:    label goes lower-right (+15m, -12m)
  // Leader line connects feature to label so it is clear which feature it belongs to
  var th = 1.2, spacing = 3.5;
  var dx = 15.0;
  var dy = isManhole ? 12.0 : -12.0;
  var ox = x + dx;
  var leaderY = y + dy;
  var oy = leaderY + (rows.length - 1) * spacing; // top row

  lines.push('0','LINE','8','ATTR',
    '10', String(x),  '20', String(y),      '30', '0',
    '11', String(ox), '21', String(leaderY), '31', '0');

  rows.forEach(function(row, i) {
    lines.push('0','TEXT','8','ATTR',
      '10', String(ox),
      '20', String(oy - i * spacing),
      '30', '0',
      '40', String(th),
      '1',  row);
  });
}

// Attach all feature attributes as XDATA on the entity
var XDATA_SKIP = { Layer:1, Text:1, EntityHand:1, GlobalID:1, created_us:1, created_da:1, last_edite:1, last_edi_1:1, UpdatingUs:1, UpdatingDa:1 };
function dxfXdata(lines, props) {
  if (!props) return;
  var entries = [];
  Object.keys(props).forEach(function(k) {
    if (k.charAt(0) === '_') return;
    if (XDATA_SKIP[k]) return;
    var v = props[k];
    if (v === null || v === undefined || v === '') return;
    var str = String(v);
    if (str.length > 250) str = str.substring(0, 250);
    entries.push(k + '=' + str);
  });
  if (!entries.length) return;
  lines.push('1001','MGIS');
  entries.forEach(function(e) { lines.push('1000', e); });
}

function dxfPolyline(lines, coords, layer, closed, toITM, props) {
  lines.push('0','POLYLINE','8',layer,'66','1','70',closed?'1':'0','10','0','20','0','30','0');
  dxfXdata(lines, props);
  coords.forEach(function (c) {
    var p = toITM(c[0], c[1]);
    lines.push('0','VERTEX','8',layer,'10',String(p[0]),'20',String(p[1]),'30','0');
  });
  lines.push('0','SEQEND','8',layer);
}

// ── WKT (Well-Known Text), WGS84 — optional "geometry_wkt" column for CSV/Excel ─
function wktCoord(c) { return c[0] + ' ' + c[1]; }
function wktRing(ring) { return '(' + ring.map(wktCoord).join(', ') + ')'; }
function toWKT(g) {
  if (!g) return '';
  switch (g.type) {
    case 'Point':            return 'POINT (' + wktCoord(g.coordinates) + ')';
    case 'MultiPoint':       return 'MULTIPOINT (' + g.coordinates.map(wktCoord).join(', ') + ')';
    case 'LineString':       return 'LINESTRING (' + g.coordinates.map(wktCoord).join(', ') + ')';
    case 'MultiLineString':  return 'MULTILINESTRING (' + g.coordinates.map(function (l) { return '(' + l.map(wktCoord).join(', ') + ')'; }).join(', ') + ')';
    case 'Polygon':          return 'POLYGON (' + g.coordinates.map(wktRing).join(', ') + ')';
    case 'MultiPolygon':     return 'MULTIPOLYGON (' + g.coordinates.map(function (poly) { return '(' + poly.map(wktRing).join(', ') + ')'; }).join(', ') + ')';
    default: return '';
  }
}

// ── CSV ───────────────────────────────────────────────────────────────────────
// opts.wkt (bool, default false) — append a `geometry_wkt` column with the full
// WGS84 WKT geometry. Off by default so existing output is unchanged.
async function buildCSV(features, onProgress, opts) {
  var includeWkt = !!(opts && opts.wkt);
  var header = ['village','category','lon','lat','geometry_type','text','layer','properties_json'];
  if (includeWkt) header.push('geometry_wkt');
  var rows = [header];
  await _forEachChunked(features, 5000, function (f) {
    var p = f.properties || {}, g = f.geometry, lon = '', lat = '';
    if (g.type === 'Point') { lon = g.coordinates[0]; lat = g.coordinates[1]; }
    else if (g.type === 'LineString' && g.coordinates.length) { lon = g.coordinates[0][0]; lat = g.coordinates[0][1]; }
    else if (g.type === 'Polygon' && g.coordinates[0] && g.coordinates[0].length) { lon = g.coordinates[0][0][0]; lat = g.coordinates[0][0][1]; }
    var row = [p._village||'', p._category||'', lon, lat, g.type, p.Text||'', p.Layer||'', JSON.stringify(p)];
    if (includeWkt) row.push(toWKT(g));
    rows.push(row);
  }, onProgress);
  return rows.map(function (r) {
    return r.map(function (v) {
      var s2 = String(v==null?'':v);
      // CSV/formula-injection guard (CWE-1236): a cell whose first char is = + - @
      // TAB or CR is run as a live formula by Excel/Sheets. Attribute values here can
      // come from uploaded DWG/Shapefile/GeoJSON, so prefix ' to force plain text.
      // (The WKT column always starts with a geometry keyword — a letter — so it
      // never matches this pattern and is never prefixed; no special-casing needed.)
      if (/^[=+\-@\t\r]/.test(s2)) s2 = "'" + s2;
      s2 = s2.replace(/"/g,'""');
      return '"'+s2+'"';
    }).join(',');
  }).join('\n');
}

// ── KML (pure JS, no dependency; GeoJSON is already WGS84 lon/lat) ─────────────
function kmlEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function kmlCoord(c) { return c[0] + ',' + c[1] + ',' + (c[2] != null ? c[2] : 0); }
function kmlPoly(rings) {
  var s2 = '<Polygon><outerBoundaryIs><LinearRing><coordinates>' +
    rings[0].map(kmlCoord).join(' ') + '</coordinates></LinearRing></outerBoundaryIs>';
  for (var i = 1; i < rings.length; i++) {
    s2 += '<innerBoundaryIs><LinearRing><coordinates>' +
      rings[i].map(kmlCoord).join(' ') + '</coordinates></LinearRing></innerBoundaryIs>';
  }
  return s2 + '</Polygon>';
}
function kmlGeom(g) {
  if (g.type === 'Point') return '<Point><coordinates>' + kmlCoord(g.coordinates) + '</coordinates></Point>';
  if (g.type === 'LineString') return '<LineString><coordinates>' + g.coordinates.map(kmlCoord).join(' ') + '</coordinates></LineString>';
  if (g.type === 'MultiLineString') return '<MultiGeometry>' + g.coordinates.map(function (l) {
    return '<LineString><coordinates>' + l.map(kmlCoord).join(' ') + '</coordinates></LineString>';
  }).join('') + '</MultiGeometry>';
  if (g.type === 'Polygon') return kmlPoly(g.coordinates);
  if (g.type === 'MultiPolygon') return '<MultiGeometry>' + g.coordinates.map(kmlPoly).join('') + '</MultiGeometry>';
  return '';
}
async function buildKML(features, onProgress) {
  var byCat = groupByCategory(features);
  var out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
    '<name>Mei HaGalil GIS Export</name>'];
  var cats = Object.keys(byCat);
  for (var ci = 0; ci < cats.length; ci++) {
    var c = cats[ci];
    out.push('<Folder><name>' + kmlEsc(LABELS[c] || c) + '</name>');
    await _forEachChunked(byCat[c], 5000, function (f) {
      var p = f.properties || {}, g = f.geometry;
      if (!g) return;
      out.push('<Placemark>');
      if (p.Text) out.push('<name>' + kmlEsc(p.Text) + '</name>');
      var data = [];
      Object.keys(p).forEach(function (k) {
        if (k.charAt(0) === '_') return;
        var v = p[k];
        if (v === null || v === undefined || v === '') return;
        data.push('<Data name="' + kmlEsc(k) + '"><value>' + kmlEsc(v) + '</value></Data>');
      });
      if (data.length) out.push('<ExtendedData>' + data.join('') + '</ExtendedData>');
      out.push(kmlGeom(g));
      out.push('</Placemark>');
    });
    out.push('</Folder>');
  }
  if (onProgress) onProgress(features.length, features.length);
  out.push('</Document></kml>');
  return out.join('\n');
}

// ── GeoJSON ───────────────────────────────────────────────────────────────────
// Chunked clone/strip loop: drops internal bookkeeping keys (_category, _village,
// …) that fetchFeaturesForCats stamps onto properties — every other serializer
// (KML ExtendedData, Shapefile cleanProps, DXF XDATA) already skips `_`-prefixed
// keys, so GeoJSON now matches instead of leaking internal fields into the file.
// The final JSON.stringify is one synchronous call at the end — it can't be
// chunked/yielded mid-call, so the chunked loop above is what keeps the tab
// responsive for large exports; the stringify itself is an accepted sync cost.
async function buildGeoJSON(features, onProgress) {
  var out = [];
  await _forEachChunked(features, 5000, function (f) {
    var props = {};
    var src = f.properties || {};
    Object.keys(src).forEach(function (k) { if (k.charAt(0) !== '_') props[k] = src[k]; });
    out.push({ type: 'Feature', properties: props, geometry: f.geometry });
  }, onProgress);
  return JSON.stringify({ type: 'FeatureCollection', features: out }, null, 2);
}

// ── Shapefile prep (pure data transform) ───────────────────────────────────────
// Chunked per-feature ITM reprojection + attribute flattening, grouped by
// category. Returns { category: Feature[] } ready to hand to shp-write — the
// CDN load + shpwrite.zip()/JSZip assembly (which need the DOM/CDN scripts)
// stay in export-feature.js and remain synchronous per call.
async function buildShapefileCollections(features, onProgress) {
  var toITM = makeToITM();
  var byCat = groupByCategory(features);
  var cats = Object.keys(byCat);
  var out = {};
  var total = features.length, doneBase = 0;
  for (var ci = 0; ci < cats.length; ci++) {
    var c = cats[ci];
    var catFeatures = byCat[c];
    var feats = [];
    out[c] = feats;
    await _forEachChunked(catFeatures, 2000, function (f) {
      feats.push({ type: 'Feature', properties: cleanProps(f.properties), geometry: reprojCoords(f.geometry, toITM) });
    }, onProgress ? (function (base) { return function (done) { onProgress(base + done, total); }; })(doneBase) : null);
    doneBase += catFeatures.length;
  }
  if (onProgress) onProgress(total, total);
  return out;
}

// ── Excel prep (pure data transform) ───────────────────────────────────────────
// Chunked per-category row-building (first-coord columns + flattened attributes,
// optional geometry_wkt). Returns { category: row[] } — XLSX.utils.json_to_sheet
// + XLSX.writeFile (which need the CDN script) stay in export-feature.js.
// opts.wkt (bool, default false) — mirrors the CSV option.
async function buildExcelRows(features, onProgress, opts) {
  var includeWkt = !!(opts && opts.wkt);
  var byCat = groupByCategory(features);
  var cats = Object.keys(byCat);
  var out = {};
  var total = features.length, doneBase = 0;
  for (var ci = 0; ci < cats.length; ci++) {
    var c = cats[ci];
    var catFeatures = byCat[c];
    var rows = [];
    out[c] = rows;
    await _forEachChunked(catFeatures, 2000, function (f) {
      var p = f.properties || {}, g = f.geometry, lon = '', lat = '';
      if (g) {
        if (g.type === 'Point') { lon = g.coordinates[0]; lat = g.coordinates[1]; }
        else if (g.type === 'LineString' && g.coordinates.length) { lon = g.coordinates[0][0]; lat = g.coordinates[0][1]; }
        else if (g.type === 'Polygon' && g.coordinates[0] && g.coordinates[0].length) { lon = g.coordinates[0][0][0]; lat = g.coordinates[0][0][1]; }
      }
      var row = { village: p._village || '', category: p._category || '', lon: lon, lat: lat, geometry_type: g ? g.type : '' };
      Object.keys(p).forEach(function (k) {
        if (k.charAt(0) === '_') return;
        var v = p[k];
        row[k] = (v && typeof v === 'object') ? JSON.stringify(v) : v;
      });
      if (includeWkt) row.geometry_wkt = g ? toWKT(g) : '';
      rows.push(row);
    }, onProgress ? (function (base) { return function (done) { onProgress(base + done, total); }; })(doneBase) : null);
    doneBase += catFeatures.length;
  }
  if (onProgress) onProgress(total, total);
  return out;
}
