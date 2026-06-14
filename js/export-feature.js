(function () {
'use strict';

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

// Supported export formats, in display order. DXF/DWG/GeoJSON/CSV are unchanged from before;
// shapefile/kml/excel are new.
var FORMATS = {
  dxf:       { icon:'📐', label:'DXF',       sub:'AutoCAD · ITM' },
  dwg:       { icon:'🏗️', label:'DWG',       sub:'AutoCAD · ITM' },
  geojson:   { icon:'🗺️', label:'GeoJSON',   sub:'GIS סטנדרט' },
  shapefile: { icon:'🗃️', label:'Shapefile', sub:'ZIP · ITM' },
  kml:       { icon:'🌍', label:'KML',       sub:'Google Earth' },
  csv:       { icon:'📊', label:'CSV',       sub:'Excel' },
  excel:     { icon:'📗', label:'Excel',     sub:'XLSX' }
};

// Lazy-loaded CDN libraries (only fetched when their format is chosen)
var URL_JSZIP   = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
var URL_SHPWRITE = 'https://cdn.jsdelivr.net/npm/@mapbox/shp-write@0.4.3/shpwrite.js';
var URL_XLSX    = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

// EPSG:2039 (Israel 1993 / Israeli TM Grid) WKT — written into the shapefile .prj so ITM coords place correctly
var ITM_WKT = 'PROJCS["Israel 1993 / Israeli TM Grid",GEOGCS["Israel 1993",DATUM["Israel_1993",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],TOWGS84[-24.0024,-17.1032,-17.8444,-0.33077,-1.85269,1.66969,5.4262],AUTHORITY["EPSG","6141"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4141"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",31.73439361111111],PARAMETER["central_meridian",35.20451694444445],PARAMETER["scale_factor",1.0000067],PARAMETER["false_easting",219529.584],PARAMETER["false_northing",626907.39],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","2039"]]';

// ── DEDICATED EXPORT STATE (separate from map visibility) ─────────────────────
// The data lives in the GIS engine now (layers/features tables via GIS.*), NOT the old
// flat-file village system (gVillages is empty — loadAllVillages is disabled in index.js).
var gExp = {
  step: 1,            // 1..4 wizard step
  format: 'dxf',
  scope: 'all',       // 'all' | 'draw'
  busy: false,
  loading: false,     // building the layer list (engine layers + head counts)
  loaded: false,      // layer model built this session
  loadError: null,
  layers: {}          // catId -> { label, count, visible, selected, layerIds:[{id,village}] }
};

var gRect = null, gDrawing = false, gDrawStart = null, gDrawTemp = null;

// ── STYLES ──────────────────────────────────────────────────────────────────
var s = document.createElement('style');
s.textContent =
  '#exp-fab{position:absolute;bottom:90px;right:14px;background:#0d3b5e;color:#fff;border:none;border-radius:50%;width:50px;height:50px;font-size:20px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.3);z-index:400;display:flex;align-items:center;justify-content:center;}' +
  '#exp-fab:hover{background:#1a7fc1;}' +
  '.exp-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1500;align-items:center;justify-content:center;}' +
  '.exp-bg.open{display:flex;}' +
  '.exp-mod{background:#fff;border-radius:14px;width:480px;max-width:95vw;direction:rtl;box-shadow:0 12px 40px rgba(0,0,0,0.25);max-height:90vh;overflow:hidden;display:flex;flex-direction:column;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif;}' +
  '.exp-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 16px;border-bottom:1px solid #e2e8f0;flex-shrink:0;}' +
  '.exp-title{font-size:17px;font-weight:700;color:#0d3b5e;}' +
  '.exp-close-btn{background:none;border:none;font-size:18px;cursor:pointer;color:#94a3b8;padding:2px 8px;border-radius:6px;line-height:1;}' +
  '.exp-close-btn:hover{background:#f1f5f9;color:#0d3b5e;}' +
  '.exp-body{padding:18px 20px;overflow-y:auto;flex:1;}' +
  '.exp-sec{font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px;display:flex;align-items:center;justify-content:space-between;}' +
  '.exp-sec-acts{display:flex;gap:5px;}' +
  '.exp-sec-acts button{font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;color:#64748b;font-family:inherit;}' +
  '.exp-sec-acts button:hover{background:#f1f5f9;}' +
  // stepper
  '.exp-stepper{display:flex;gap:4px;margin:-2px 0 20px;}' +
  '.exp-step{flex:1;text-align:center;font-size:10px;color:#94a3b8;font-weight:600;position:relative;padding-top:26px;}' +
  '.exp-step::before{content:attr(data-n);position:absolute;top:0;left:50%;transform:translateX(-50%);width:24px;height:24px;border-radius:50%;background:#e2e8f0;color:#94a3b8;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;}' +
  '.exp-step::after{content:"";position:absolute;top:12px;right:50%;width:100%;height:2px;background:#e2e8f0;z-index:-1;}' +
  '.exp-step:first-child::after{display:none;}' +
  '.exp-step.active{color:#0d3b5e;}' +
  '.exp-step.active::before{background:#0d3b5e;color:#fff;}' +
  '.exp-step.done::before{content:"✓";background:#16a34a;color:#fff;}' +
  '.exp-step.done::after{background:#16a34a;}' +
  // layer rows
  '.exp-layers{display:flex;flex-direction:column;gap:6px;margin-bottom:20px;max-height:300px;overflow-y:auto;}' +
  '.exp-lrow{display:flex;align-items:center;gap:10px;padding:10px 12px;border:2px solid #e2e8f0;border-radius:9px;cursor:pointer;user-select:none;transition:border-color .15s,background .15s;}' +
  '.exp-lrow:hover{border-color:#93c5fd;}' +
  '.exp-lrow.on{border-color:#0d3b5e;background:#eff6ff;}' +
  '.exp-lrow input{margin:0;cursor:pointer;accent-color:#0d3b5e;width:16px;height:16px;flex-shrink:0;}' +
  '.exp-lname{flex:1;font-size:13px;font-weight:600;color:#334155;}' +
  '.exp-lcount{font-size:11px;font-weight:700;color:#0d3b5e;background:#e0ecf7;padding:2px 9px;border-radius:10px;white-space:nowrap;}' +
  '.exp-lvis{font-size:10px;font-weight:600;padding:2px 8px;border-radius:6px;white-space:nowrap;}' +
  '.exp-lvis.vis{color:#16a34a;background:#dcfce7;}' +
  '.exp-lvis.hid{color:#94a3b8;background:#f1f5f9;}' +
  // format grid
  '.exp-fmts{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;}' +
  '.exp-fmt{width:calc(33.33% - 6px);box-sizing:border-box;padding:13px 6px;border:2px solid #e2e8f0;border-radius:10px;background:#fff;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;color:#64748b;text-align:center;transition:border-color .15s,background .15s;}' +
  '.exp-fmt:hover{border-color:#93c5fd;color:#1a7fc1;}' +
  '.exp-fmt.active{border-color:#0d3b5e;background:#eff6ff;color:#0d3b5e;}' +
  '.exp-fmt-sub{display:block;font-size:9px;font-weight:400;margin-top:3px;opacity:.8;}' +
  '.exp-note{font-size:11px;color:#94a3b8;line-height:1.5;background:#f8fafc;border-radius:8px;padding:10px 12px;}' +
  // summary
  '.exp-sum{border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:6px;}' +
  '.exp-sum-row{display:flex;justify-content:space-between;padding:9px 14px;font-size:13px;border-bottom:1px solid #f1f5f9;color:#334155;}' +
  '.exp-sum-row:last-child{border-bottom:none;}' +
  '.exp-sum-row .v{font-weight:700;color:#0d3b5e;}' +
  '.exp-sum-head{font-size:10px;font-weight:700;color:#94a3b8;background:#f8fafc;padding:7px 14px;text-transform:uppercase;letter-spacing:.05em;}' +
  '.exp-sum-detail{max-height:200px;overflow-y:auto;}' +
  '.exp-sum-detail .exp-sum-row{font-size:12px;padding:7px 14px;}' +
  '.exp-sum-total{background:#eff6ff;font-weight:700;color:#0d3b5e;}' +
  // generate pane
  '.exp-gen{text-align:center;padding:34px 10px;}' +
  '.exp-gen-spin{width:44px;height:44px;margin:0 auto 16px;border:4px solid #e2e8f0;border-top-color:#0d3b5e;border-radius:50%;animation:dwgspin .9s linear infinite;}' +
  '@keyframes dwgspin{to{transform:rotate(360deg);}}' +
  '.exp-gen-icon{font-size:46px;margin-bottom:12px;line-height:1;}' +
  '.exp-gen-msg{font-size:14px;color:#334155;}' +
  // standalone busy overlay (used for draw-region export, where the modal is closed)
  '.exp-busy-bg{display:none;position:fixed;inset:0;background:rgba(15,23,42,0.5);z-index:2000;align-items:center;justify-content:center;}' +
  '.exp-busy-bg.open{display:flex;}' +
  '.exp-busy-mod{background:#fff;border-radius:14px;padding:26px 30px;min-width:240px;text-align:center;direction:rtl;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,0.3);}' +
  '.exp-busy-icon{font-size:44px;line-height:1;margin-bottom:10px;}' +
  '.exp-busy-msg{font-size:14px;color:#334155;margin-top:6px;}' +
  // scope
  '.exp-scope{display:flex;flex-direction:column;gap:7px;margin-bottom:4px;}' +
  '.exp-scope-opt{display:flex;align-items:center;gap:10px;padding:11px 14px;border:2px solid #e2e8f0;border-radius:9px;cursor:pointer;transition:border-color .15s,background .15s;font-size:13px;color:#334155;user-select:none;}' +
  '.exp-scope-opt:hover{border-color:#93c5fd;}' +
  '.exp-scope-opt.active{border-color:#0d3b5e;background:#eff6ff;color:#0d3b5e;font-weight:600;}' +
  '.exp-scope-opt input{margin:0;cursor:pointer;accent-color:#0d3b5e;}' +
  '.exp-foot{padding:14px 20px;border-top:1px solid #e2e8f0;display:flex;gap:8px;justify-content:space-between;flex-shrink:0;}' +
  '.exp-btn{padding:10px 22px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;}' +
  '.exp-btn-primary{background:#0d3b5e;color:#fff;}' +
  '.exp-btn-primary:hover{background:#1a7fc1;}' +
  '.exp-btn-primary:disabled{opacity:.45;cursor:default;}' +
  '.exp-btn-secondary{background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;}' +
  '.exp-btn-secondary:hover{background:#e2e8f0;}' +
  '#exp-banner{position:absolute;top:14px;left:50%;transform:translateX(-50%);background:#0d3b5e;color:#fff;padding:10px 22px;border-radius:10px;font-size:13px;font-weight:600;z-index:500;display:none;white-space:nowrap;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.25);}' +
  '#exp-banner.show{display:block;}' +
  '#exp-cancel-draw{position:absolute;top:14px;right:14px;background:#dc2626;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;z-index:500;display:none;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.25);}' +
  '#exp-cancel-draw.show{display:block;}';
document.head.appendChild(s);

// ── INJECT HTML ──────────────────────────────────────────────────────────────
function injectUI() {
  var mw = document.getElementById('map-wrap');
  if (!mw) { setTimeout(injectUI, 200); return; }

  var fab = document.createElement('button');
  fab.id = 'exp-fab';
  fab.title = 'יצוא נתונים';
  fab.innerHTML = '📥';
  fab.onclick = openExportModal;
  mw.appendChild(fab);

  var banner = document.createElement('div');
  banner.id = 'exp-banner';
  banner.textContent = '🖱️ לחץ וגרור לסימון אזור על המפה';
  mw.appendChild(banner);

  var cancelBtn = document.createElement('button');
  cancelBtn.id = 'exp-cancel-draw';
  cancelBtn.textContent = '✖ בטל';
  cancelBtn.onclick = cancelDrawing;
  mw.appendChild(cancelBtn);

  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<div class="exp-bg" id="exp-modal">' +
      '<div class="exp-mod">' +
        '<div class="exp-head">' +
          '<div class="exp-title">📥 יצוא נתונים <span style="font-size:10px;font-weight:400;opacity:0.45;font-family:monospace">v14</span></div>' +
          '<button class="exp-close-btn" onclick="closeExportModal()">✕</button>' +
        '</div>' +
        '<div class="exp-body" id="exp-body"></div>' +
        '<div class="exp-foot" id="exp-foot"></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);
}

// ── MODAL CONTROLS ───────────────────────────────────────────────────────────
function openExportModal() {
  if (!window.gMap) { alert('המפה עדיין לא נטענה'); return; }
  if (!window.GIS || !window.GIS.layers) { alert('מנוע ה-GIS עדיין נטען — נסה שוב בעוד רגע'); return; }
  gExp.step = 1;
  gExp.busy = false;
  gExp.loadError = null;
  document.getElementById('exp-modal').classList.add('open');

  if (gExp.loaded) { renderWizard(); return; }

  // Build the layer list from the engine (every layer + a cheap head count). The actual
  // features are fetched only for the SELECTED categories, at export time.
  gExp.loading = true;
  renderWizard();                       // shows a loading state in step 1
  buildLayerModel()
    .then(function () { gExp.loading = false; gExp.loaded = true; })
    .catch(function (e) { gExp.loading = false; gExp.loadError = (e && e.message) ? e.message : String(e); })
    .then(function () {
      if (document.getElementById('exp-modal').classList.contains('open') && gExp.step === 1) renderWizard();
    });
}
function closeExportModal() { document.getElementById('exp-modal').classList.remove('open'); }
window.closeExportModal = closeExportModal;

// Simple bounded-concurrency pool over `items`, running `fn(item)` (returns a Promise).
function runPool(items, concurrency, fn) {
  return new Promise(function (resolve) {
    var i = 0, active = 0, n = items.length;
    if (!n) return resolve();
    function next() {
      while (active < concurrency && i < n) {
        var item = items[i++]; active++;
        Promise.resolve(fn(item)).catch(function () {}).then(function () {
          active--;
          if (i >= n && active === 0) resolve();
          else next();
        });
      }
    }
    next();
  });
}

// Build the export layer model from the GIS engine. One row per CATEGORY (engine layers are
// named "<village> · <category>"), aggregating counts across villages. Selection is OWNED by
// gExp and never derived from visibility — visibility is read only for an informational badge.
function buildLayerModel() {
  var GIS = window.GIS;
  return GIS.layers.getLayers().then(function (layers) {
    var cats = {}, prev = gExp.layers || {};
    (layers || []).forEach(function (l) {
      var idx = l.name.indexOf(' · ');
      var cat = idx >= 0 ? l.name.slice(idx + 3) : l.name;
      var village = idx >= 0 ? l.name.slice(0, idx) : '';
      if (!cats[cat]) cats[cat] = {
        label: (window.GISLayerLabel ? window.GISLayerLabel(cat) : (LABELS[cat] || cat)),
        count: 0, visible: false, selected: prev[cat] ? prev[cat].selected : true, layerIds: []
      };
      cats[cat].layerIds.push({ id: l.id, village: village });
    });
    // Visibility badge (informational): a category is "visible" if any of its engine layers
    // is currently toggled on in the sidebar.
    try {
      var act = (window.GISEngineSidebar && window.GISEngineSidebar.activeLayers) ? window.GISEngineSidebar.activeLayers() : [];
      act.forEach(function (l) {
        var idx = l.name.indexOf(' · ');
        var c = idx >= 0 ? l.name.slice(idx + 3) : l.name;
        if (cats[c]) cats[c].visible = true;
      });
    } catch (e) { /* visibility is optional */ }

    // Cheap exact head counts per layer (COUNT uses idx_features_layer; "features read" RLS
    // allows any authenticated user to SELECT).
    var sb = GIS.sb();
    var jobs = [];
    Object.keys(cats).forEach(function (cat) {
      cats[cat].layerIds.forEach(function (lyr) { jobs.push({ cat: cat, id: lyr.id }); });
    });
    return runPool(jobs, 6, function (job) {
      return sb.from('features').select('*', { count: 'exact', head: true }).eq('layer_id', job.id)
        .then(function (r) { cats[job.cat].count += (r.count || 0); });
    }).then(function () { gExp.layers = cats; });
  });
}

// Fetch features for the selected categories from the engine (only what's needed for export).
// Optionally filter to draw `bounds`. Calls cb(features) with WGS84 GeoJSON features.
function fetchFeaturesForCats(cats, bounds, cb) {
  var GIS = window.GIS;
  var jobs = [];
  cats.forEach(function (cat) {
    var L = gExp.layers[cat];
    if (!L) return;
    L.layerIds.forEach(function (lyr) { jobs.push({ cat: cat, id: lyr.id, village: lyr.village }); });
  });
  var all = [];
  runPool(jobs, 4, function (job) {
    return GIS.features.getFeatures(job.id, 1000000).then(function (fc) {
      ((fc && fc.features) || []).forEach(function (f) {
        if (!f.geometry) return;
        if (bounds && !isInBounds(f.geometry, bounds)) return;
        if (!f.properties) f.properties = {};
        f.properties._category = job.cat;       // authoritative (from layer name)
        if (job.village) f.properties._village = job.village;
        all.push(f);
      });
    });
  }).then(function () { cb(all); });
}

function selectedCats() {
  return Object.keys(gExp.layers).filter(function (c) { return gExp.layers[c].selected; });
}
function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

// ── WIZARD RENDER ─────────────────────────────────────────────────────────────
function renderWizard() {
  var body = document.getElementById('exp-body');
  var foot = document.getElementById('exp-foot');
  if (!body) return;
  var html = stepperHTML();
  if      (gExp.step === 1) html += step1HTML();
  else if (gExp.step === 2) html += step2HTML();
  else if (gExp.step === 3) html += step3HTML();
  else                      html += step4HTML();
  body.innerHTML = html;
  foot.innerHTML = footHTML();
}

function stepperHTML() {
  var names = ['שכבות', 'פורמט', 'סיכום', 'ייצוא'];
  return '<div class="exp-stepper">' + names.map(function (n, i) {
    var step = i + 1, cls = 'exp-step';
    if (step === gExp.step) cls += ' active';
    else if (step < gExp.step) cls += ' done';
    return '<div class="' + cls + '" data-n="' + step + '">' + n + '</div>';
  }).join('') + '</div>';
}

// Step 1 — layer manager + area scope
function step1HTML() {
  var keys = Object.keys(gExp.layers);
  var rows;
  if (gExp.loading) {
    rows = '<div class="exp-gen" style="padding:24px 10px"><div class="exp-gen-spin"></div><div class="exp-gen-msg">טוען שכבות…</div></div>';
  } else if (gExp.loadError) {
    rows = '<div style="padding:16px;text-align:center;color:#dc2626;font-size:13px">שגיאה בטעינת שכבות: ' + gExp.loadError + '</div>';
  } else if (!keys.length) {
    rows = '<div style="padding:16px;text-align:center;color:#94a3b8;font-size:13px">לא נמצאו שכבות לייצוא</div>';
  } else {
    rows = keys.map(function (c) {
      var L = gExp.layers[c];
      return '<label class="exp-lrow' + (L.selected ? ' on' : '') + '">' +
        '<input type="checkbox" ' + (L.selected ? 'checked' : '') + ' onchange="expToggle(\'' + c + '\',this)">' +
        '<span class="exp-lname">' + L.label + '</span>' +
        '<span class="exp-lcount">' + fmtNum(L.count) + '</span>' +
        '<span class="exp-lvis ' + (L.visible ? 'vis' : 'hid') + '">' + (L.visible ? '👁 גלוי' : '🚫 מוסתר') + '</span>' +
      '</label>';
    }).join('');
  }
  return '<div class="exp-sec">שכבות לייצוא<div class="exp-sec-acts">' +
      '<button onclick="expSelAll()">הכל</button>' +
      '<button onclick="expSelNone()">נקה</button>' +
      '<button onclick="expSelVisible()">גלויות</button>' +
    '</div></div>' +
    '<div class="exp-layers">' + rows + '</div>' +
    '<div class="exp-sec">אזור</div>' +
    '<div class="exp-scope">' +
      '<label class="exp-scope-opt' + (gExp.scope === 'all' ? ' active' : '') + '" onclick="expSetScope(\'all\')">' +
        '<input type="radio" name="exp-scope" ' + (gExp.scope === 'all' ? 'checked' : '') + '> כל הנתונים</label>' +
      '<label class="exp-scope-opt' + (gExp.scope === 'draw' ? ' active' : '') + '" onclick="expSetScope(\'draw\')">' +
        '<input type="radio" name="exp-scope" ' + (gExp.scope === 'draw' ? 'checked' : '') + '> 🖱️ סמן אזור על המפה</label>' +
    '</div>';
}

// Step 2 — format picker
function step2HTML() {
  var pills = Object.keys(FORMATS).map(function (f) {
    var F = FORMATS[f];
    return '<button class="exp-fmt' + (gExp.format === f ? ' active' : '') + '" onclick="expSetFmt(\'' + f + '\')">' +
      F.icon + ' ' + F.label + '<span class="exp-fmt-sub">' + F.sub + '</span></button>';
  }).join('');
  var note = '';
  if (gExp.format === 'csv' || gExp.format === 'excel')
    note = '<div class="exp-note">פורמטים טבלאיים — מתאימים בעיקר לשכבות נקודה (מדי מים, שוחות וכו\'). עבור גאומטריה מורכבת תישמר הקואורדינטה הראשונה בלבד; הגאומטריה המלאה נשמרת בעמודת JSON.</div>';
  else if (gExp.format === 'shapefile')
    note = '<div class="exp-note">לכל שכבה נוצר Shapefile נפרד בתוך קובץ ZIP אחד, בקואורדינטות רשת ישראל החדשה (ITM / EPSG:2039).</div>';
  return '<div class="exp-sec">פורמט ייצוא</div><div class="exp-fmts">' + pills + '</div>' + note;
}

// Step 3 — review summary (rendered from gExp only)
function step3HTML() {
  var cats = selectedCats(), total = 0;
  var detail = cats.map(function (c) {
    var L = gExp.layers[c];
    total += L.count;
    return '<div class="exp-sum-row"><span>' + L.label + '</span><span class="v">' + fmtNum(L.count) + '</span></div>';
  }).join('');
  var F = FORMATS[gExp.format] || { label: gExp.format };
  return '<div class="exp-sec">סיכום ייצוא</div>' +
    '<div class="exp-sum">' +
      '<div class="exp-sum-row"><span>שכבות נבחרו</span><span class="v">' + cats.length + '</span></div>' +
      '<div class="exp-sum-head">פירוט שכבות</div>' +
      '<div class="exp-sum-detail">' + (detail || '<div class="exp-sum-row"><span style="color:#94a3b8">לא נבחרו שכבות</span></div>') + '</div>' +
      '<div class="exp-sum-row exp-sum-total"><span>סה"כ אובייקטים</span><span class="v">' + fmtNum(total) + '</span></div>' +
      '<div class="exp-sum-row"><span>פורמט</span><span class="v">' + F.label + '</span></div>' +
      '<div class="exp-sum-row"><span>אזור</span><span class="v">' + (gExp.scope === 'draw' ? 'אזור מסומן' : 'כל הנתונים') + '</span></div>' +
    '</div>';
}

// Step 4 — generation progress
function step4HTML() {
  return '<div class="exp-gen" id="exp-gen">' +
    '<div class="exp-gen-spin"></div>' +
    '<div class="exp-gen-msg" id="exp-gen-msg">מתחיל…</div>' +
    '</div>';
}

function footHTML() {
  if (gExp.step === 4) return '';  // footer for step 4 is managed by finishGen()
  var s2 = gExp.step;
  var left = s2 === 1
    ? '<button class="exp-btn exp-btn-secondary" onclick="closeExportModal()">ביטול</button>'
    : '<button class="exp-btn exp-btn-secondary" onclick="expBack()">→ הקודם</button>';
  var right;
  if (s2 === 3) {
    right = '<button class="exp-btn exp-btn-primary" onclick="expRun()">📥 ייצא</button>';
  } else {
    var dis = (s2 === 1 && selectedCats().length === 0) ? ' disabled' : '';
    right = '<button class="exp-btn exp-btn-primary" onclick="expNext()"' + dis + '>הבא →</button>';
  }
  return left + right;
}

// ── WIZARD ACTIONS (exposed for inline handlers) ──────────────────────────────
window.expToggle = function (cat, input) {
  if (!gExp.layers[cat]) return;
  gExp.layers[cat].selected = input.checked;
  var row = input.closest('.exp-lrow');
  if (row) row.classList.toggle('on', input.checked);
  document.getElementById('exp-foot').innerHTML = footHTML();
};
window.expSelAll     = function () { Object.keys(gExp.layers).forEach(function (c) { gExp.layers[c].selected = true; }); renderWizard(); };
window.expSelNone    = function () { Object.keys(gExp.layers).forEach(function (c) { gExp.layers[c].selected = false; }); renderWizard(); };
window.expSelVisible = function () { Object.keys(gExp.layers).forEach(function (c) { gExp.layers[c].selected = gExp.layers[c].visible; }); renderWizard(); };
window.expSetFmt     = function (f) { gExp.format = f; renderWizard(); };
window.expSetScope   = function (sc) { gExp.scope = sc; renderWizard(); };
window.expBack  = function () { if (gExp.step > 1) { gExp.step--; renderWizard(); } };
window.expNext  = function () { if (gExp.step < 3) { gExp.step++; renderWizard(); } };
window.expBackTo3 = function () { gExp.step = 3; renderWizard(); };

// ── EXPORT RUN ────────────────────────────────────────────────────────────────
window.expRun = function () {
  var cats = selectedCats();
  if (!cats.length) { alert('בחר לפחות שכבה אחת'); return; }

  // Draw scope keeps the existing on-map flow (modal closes, user drags a box)
  if (gExp.scope === 'draw') { closeExportModal(); startDrawMode(cats); return; }

  // DWG keeps its dedicated wait modal exactly as before — fetch first, then hand off.
  if (gExp.format === 'dwg') {
    closeExportModal();
    fetchFeaturesForCats(cats, null, function (features) {
      if (!features.length) { alert('לא נמצאו אובייקטים'); return; }
      generateAndDownload(features);
    });
    return;
  }

  // Everything else generates inside the wizard step-4 pane
  gExp.step = 4; gExp.busy = true;
  renderWizard();
  setGenMsg('אוסף נתונים…');
  fetchFeaturesForCats(cats, null, function (features) {
    if (!features.length) { finishGen(false, 'לא נמצאו אובייקטים'); return; }
    setGenMsg('מייצא…');
    // defer so the spinner paints before a potentially heavy synchronous build (DXF/CSV)
    setTimeout(function () { generateAndDownload(features); }, 30);
  });
};

// Standalone busy overlay — shown during the draw-region export (the wizard modal is closed then).
var _busyEl = null;
function showBusy(msg) {
  if (!_busyEl) {
    var bg = document.createElement('div');
    bg.className = 'exp-busy-bg';
    bg.innerHTML = '<div class="exp-busy-mod"><div class="exp-gen-spin"></div><div class="exp-busy-msg" id="exp-busy-msg"></div></div>';
    document.body.appendChild(bg);
    _busyEl = bg;
  }
  _busyEl.querySelector('.exp-busy-mod').innerHTML = '<div class="exp-gen-spin"></div><div class="exp-busy-msg" id="exp-busy-msg">' + (msg || 'מעבד…') + '</div>';
  _busyEl.classList.add('open');
}
function setBusyMsg(m) { if (_busyEl && _busyEl.classList.contains('open') && m) { var el = _busyEl.querySelector('#exp-busy-msg'); if (el) el.textContent = m; } }
function busyActive() { return !!(_busyEl && _busyEl.classList.contains('open')); }
function closeBusy() { if (_busyEl) _busyEl.classList.remove('open'); }
function busyDone(ok, msg) {
  if (!_busyEl) return;
  if (ok) {
    _busyEl.querySelector('.exp-busy-mod').innerHTML = '<div class="exp-busy-icon">✅</div><div class="exp-busy-msg">הייצוא הושלם — הקובץ הורד</div>';
    if (window.showToast) window.showToast('הייצוא הושלם');
    setTimeout(closeBusy, 1400);
  } else {
    _busyEl.querySelector('.exp-busy-mod').innerHTML = '<div class="exp-busy-icon">⚠️</div><div class="exp-busy-msg">שגיאה ביצוא' + (msg ? ': ' + msg : '') + '</div>';
    setTimeout(closeBusy, 3500);
  }
}

function setGenMsg(m) {
  var el = document.getElementById('exp-gen-msg');
  if (el && m) { el.textContent = m; return; }
  setBusyMsg(m);   // draw-region path → standalone overlay
}

function finishGen(ok, msg) {
  gExp.busy = false;
  var gen = document.getElementById('exp-gen');
  if (!gen) { busyDone(ok, msg); return; }  // draw-region path → standalone overlay
  if (ok) {
    gen.innerHTML = '<div class="exp-gen-icon">✅</div><div class="exp-gen-msg">הייצוא הושלם — הקובץ הורד</div>';
    if (window.showToast) window.showToast('הייצוא הושלם');
  } else {
    gen.innerHTML = '<div class="exp-gen-icon">⚠️</div><div class="exp-gen-msg">שגיאה ביצוא' + (msg ? ': ' + msg : '') + '</div>';
  }
  var foot = document.getElementById('exp-foot');
  if (foot) {
    foot.innerHTML = (ok ? '' : '<button class="exp-btn exp-btn-secondary" onclick="expBackTo3()">→ חזור</button>') +
      '<button class="exp-btn exp-btn-primary" onclick="closeExportModal()">סגור</button>';
  }
}

// ── DRAW MODE ────────────────────────────────────────────────────────────────
function startDrawMode(selectedCatsArg) {
  if (gRect) { window.gMap.removeLayer(gRect); gRect = null; }
  gDrawing = true;
  document.getElementById('exp-banner').classList.add('show');
  document.getElementById('exp-cancel-draw').classList.add('show');
  window.gMap.dragging.disable();
  window.gMap.getContainer().style.cursor = 'crosshair';
  window.gMap.once('mousedown', function (e) {
    gDrawStart = e.latlng;
    window.gMap.on('mousemove', onDrawMove);
    window.gMap.once('mouseup', function (e2) {
      window.gMap.off('mousemove', onDrawMove);
      if (gDrawTemp) { window.gMap.removeLayer(gDrawTemp); gDrawTemp = null; }
      finishDraw(e2.latlng, selectedCatsArg);
    });
  });
}

function onDrawMove(e) {
  if (gDrawTemp) window.gMap.removeLayer(gDrawTemp);
  if (!gDrawStart) return;
  gDrawTemp = L.rectangle([gDrawStart, e.latlng], { color: '#0d3b5e', weight: 2, fillOpacity: 0.1, dashArray: '5,5' }).addTo(window.gMap);
}

function finishDraw(endLatLng, selectedCatsArg) {
  gDrawing = false;
  document.getElementById('exp-banner').classList.remove('show');
  document.getElementById('exp-cancel-draw').classList.remove('show');
  window.gMap.dragging.enable();
  window.gMap.getContainer().style.cursor = '';
  gRect = L.rectangle([gDrawStart, endLatLng], { color: '#16a34a', weight: 2, fillOpacity: 0.08 }).addTo(window.gMap);
  var bounds = gRect.getBounds();
  gDrawStart = null;
  showBusy('אוסף נתונים…');
  fetchFeaturesForCats(selectedCatsArg, bounds, function (features) {
    if (gRect) { window.gMap.removeLayer(gRect); gRect = null; }
    if (!features.length) { closeBusy(); alert('לא נמצאו אובייקטים באזור שנבחר'); return; }
    setBusyMsg('מייצא…');
    // defer so the spinner repaints before a potentially heavy synchronous build
    setTimeout(function () { generateAndDownload(features); }, 30);
  });
}

function cancelDrawing() {
  gDrawing = false; gDrawStart = null;
  if (gDrawTemp) { window.gMap.removeLayer(gDrawTemp); gDrawTemp = null; }
  document.getElementById('exp-banner').classList.remove('show');
  document.getElementById('exp-cancel-draw').classList.remove('show');
  window.gMap.dragging.enable();
  window.gMap.getContainer().style.cursor = '';
  window.gMap.off('mousemove', onDrawMove);
}
window.cancelDrawing = cancelDrawing;

// ── LAZY SCRIPT LOADER ────────────────────────────────────────────────────────
var _scriptCache = {};
function loadScript(url) {
  if (_scriptCache[url]) return _scriptCache[url];
  _scriptCache[url] = new Promise(function (resolve, reject) {
    var sc = document.createElement('script');
    sc.src = url;
    sc.onload = function () { resolve(); };
    sc.onerror = function () { _scriptCache[url] = null; reject(new Error('טעינת ספרייה נכשלה: ' + url)); };
    document.head.appendChild(sc);
  });
  return _scriptCache[url];
}

function triggerDownload(blob, name) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
}

// ── GENERATE & DOWNLOAD ───────────────────────────────────────────────────────
function generateAndDownload(features) {
  var ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  var filename = 'mei-hagalil-' + ts;

  try {
    if (gExp.format === 'dwg') {
      closeBusy();                               // DWG has its own dedicated wait modal
      _exportDWG(features, filename);            // own wait modal; success/error handled inside
    } else if (gExp.format === 'dxf') {
      triggerDownload(new Blob([buildDXF(features)], { type: 'application/dxf' }), filename + '.dxf');
      finishGen(true);
    } else if (gExp.format === 'geojson') {
      triggerDownload(new Blob([JSON.stringify({ type: 'FeatureCollection', features: features }, null, 2)], { type: 'application/geo+json' }), filename + '.geojson');
      finishGen(true);
    } else if (gExp.format === 'csv') {
      triggerDownload(new Blob(['﻿' + buildCSV(features)], { type: 'text/csv;charset=utf-8' }), filename + '.csv');
      finishGen(true);
    } else if (gExp.format === 'kml') {
      triggerDownload(new Blob([buildKML(features)], { type: 'application/vnd.google-earth.kml+xml' }), filename + '.kml');
      finishGen(true);
    } else if (gExp.format === 'shapefile') {
      setGenMsg('בונה Shapefile…');
      exportShapefile(features, filename).then(function () { finishGen(true); })
        .catch(function (e) { finishGen(false, e && e.message ? e.message : String(e)); });
    } else if (gExp.format === 'excel') {
      setGenMsg('בונה Excel…');
      exportExcel(features, filename).then(function () { finishGen(true); })
        .catch(function (e) { finishGen(false, e && e.message ? e.message : String(e)); });
    }
  } catch (e) {
    finishGen(false, e && e.message ? e.message : String(e));
  }
}

function _exportDWG(features, filename) {
  if (typeof window.geoJSONtoDWG !== 'function') {
    alert('שגיאה: backend-client.js לא נטען. ודא שהקובץ כלול ב-HTML.');
    return;
  }
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var wait = showDwgWait(function onCancel() { if (ctrl) ctrl.abort(); });

  window.geoJSONtoDWG(features, { filename: filename, signal: ctrl ? ctrl.signal : undefined }, function(stage, pct, msg) {
    wait.setMsg(msg);
  }).then(function() {
    wait.close();
  }).catch(function(err) {
    wait.close();
    var aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    if (aborted) { if (window.showToast) window.showToast('היצוא בוטל'); return; }   // user cancelled — not an error
    alert('שגיאה ביצוא DWG:\n' + (err && err.message ? err.message : err));
  });
}

// ── DWG wait modal (spinner + status; reveals a Cancel button after 30s) ──────
var _dwgWaitEl = null, _dwgCancelTimer = null, _dwgElapsedTimer = null, _dwgWaitStart = 0;

function injectDwgWaitStyles() {
  if (document.getElementById('dwg-wait-styles')) return;
  var st = document.createElement('style');
  st.id = 'dwg-wait-styles';
  st.textContent =
    '.dwg-wait-bg{display:none;position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:2000;align-items:center;justify-content:center;}' +
    '.dwg-wait-bg.open{display:flex;}' +
    '.dwg-wait-mod{background:#fff;border-radius:14px;padding:26px 28px;width:340px;max-width:92vw;text-align:center;direction:rtl;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,0.3);}' +
    '.dwg-wait-spin{width:42px;height:42px;margin:0 auto 14px;border:4px solid #e2e8f0;border-top-color:#0d3b5e;border-radius:50%;animation:dwgspin .9s linear infinite;}' +
    '.dwg-wait-title{font-size:16px;font-weight:700;color:#0d3b5e;margin-bottom:6px;}' +
    '.dwg-wait-msg{font-size:13px;color:#334155;margin-bottom:4px;min-height:18px;}' +
    '.dwg-wait-elapsed{font-size:12px;color:#94a3b8;margin-bottom:10px;}' +
    '.dwg-wait-hint{font-size:11px;color:#94a3b8;line-height:1.5;margin-bottom:14px;}' +
    '.dwg-wait-cancel{width:100%;padding:11px;border:none;border-radius:8px;background:#dc2626;color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;}' +
    '.dwg-wait-cancel:hover{background:#b91c1c;}.dwg-wait-cancel:disabled{opacity:.6;cursor:default;}';
  document.head.appendChild(st);
}

function showDwgWait(onCancel) {
  injectDwgWaitStyles();
  if (!_dwgWaitEl) {
    var bg = document.createElement('div');
    bg.className = 'dwg-wait-bg';
    bg.innerHTML =
      '<div class="dwg-wait-mod">' +
        '<div class="dwg-wait-spin"></div>' +
        '<div class="dwg-wait-title">מייצא DWG…</div>' +
        '<div class="dwg-wait-msg" id="dwg-wait-msg">שולח נתונים לשרת…</div>' +
        '<div class="dwg-wait-elapsed" id="dwg-wait-elapsed">0 שניות</div>' +
        '<div class="dwg-wait-hint" id="dwg-wait-hint">השרת עשוי להתעורר ממצב שינה — ההמרה עשויה להימשך עד דקה.</div>' +
        '<button class="dwg-wait-cancel" id="dwg-wait-cancel" style="display:none">ביטול היצוא</button>' +
      '</div>';
    document.body.appendChild(bg);
    _dwgWaitEl = bg;
  }
  var bgEl = _dwgWaitEl;
  var msgEl = bgEl.querySelector('#dwg-wait-msg');
  var elapsedEl = bgEl.querySelector('#dwg-wait-elapsed');
  var hintEl = bgEl.querySelector('#dwg-wait-hint');
  var cancelBtn = bgEl.querySelector('#dwg-wait-cancel');

  cancelBtn.style.display = 'none';
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'ביטול היצוא';
  hintEl.textContent = 'השרת עשוי להתעורר ממצב שינה — ההמרה עשויה להימשך עד דקה.';
  elapsedEl.textContent = '0 שניות';
  bgEl.classList.add('open');
  _dwgWaitStart = Date.now();

  if (_dwgElapsedTimer) clearInterval(_dwgElapsedTimer);
  _dwgElapsedTimer = setInterval(function() {
    elapsedEl.textContent = Math.round((Date.now() - _dwgWaitStart) / 1000) + ' שניות';
  }, 1000);

  if (_dwgCancelTimer) clearTimeout(_dwgCancelTimer);
  _dwgCancelTimer = setTimeout(function() {   // reveal Cancel only after 30s
    cancelBtn.style.display = 'block';
    hintEl.textContent = 'לוקח יותר מהצפוי. ניתן לבטל ולנסות שוב.';
  }, 30000);

  cancelBtn.onclick = function() {
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'מבטל…';
    if (onCancel) onCancel();
  };

  return {
    setMsg: function(m) { if (m) msgEl.textContent = m; },
    close: function() {
      if (_dwgCancelTimer) { clearTimeout(_dwgCancelTimer); _dwgCancelTimer = null; }
      if (_dwgElapsedTimer) { clearInterval(_dwgElapsedTimer); _dwgElapsedTimer = null; }
      bgEl.classList.remove('open');
    }
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function isInBounds(g, b) {
  if (g.type === 'Point') return b.contains([g.coordinates[1], g.coordinates[0]]);
  if (g.type === 'LineString') return g.coordinates.some(function (c) { return b.contains([c[1], c[0]]); });
  if (g.type === 'MultiLineString') return g.coordinates.some(function (line) { return line.some(function (c) { return b.contains([c[1], c[0]]); }); });
  if (g.type === 'Polygon') return g.coordinates[0] && g.coordinates[0].some(function (c) { return b.contains([c[1], c[0]]); });
  return false;
}

// ── ITM CONVERSION ────────────────────────────────────────────────────────────
function makeToITM() {
  if (window.proj4 && !window.proj4.defs('EPSG:2039')) {
    window.proj4.defs('EPSG:2039',
      '+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 ' +
      '+k=1.0000067 +x_0=219529.584 +y_0=626907.39 +ellps=GRS80 ' +
      '+towgs84=-48,55,52,0,0,0,0 +units=m +no_defs');
  }
  return function (lng, lat) {
    if (window.proj4) { try { return window.proj4('EPSG:4326', 'EPSG:2039', [lng, lat]); } catch (e) {} }
    return [lng, lat];
  };
}

// ── DXF ───────────────────────────────────────────────────────────────────────
function buildDXF(features) {
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
  features.forEach(function (f) {
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
  });
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

// ── CSV ───────────────────────────────────────────────────────────────────────
function buildCSV(features) {
  var rows = [['village','category','lon','lat','geometry_type','text','layer','properties_json']];
  features.forEach(function (f) {
    var p = f.properties || {}, g = f.geometry, lon = '', lat = '';
    if (g.type === 'Point') { lon = g.coordinates[0]; lat = g.coordinates[1]; }
    else if (g.type === 'LineString' && g.coordinates.length) { lon = g.coordinates[0][0]; lat = g.coordinates[0][1]; }
    else if (g.type === 'Polygon' && g.coordinates[0] && g.coordinates[0].length) { lon = g.coordinates[0][0][0]; lat = g.coordinates[0][0][1]; }
    rows.push([p._village||'', p._category||'', lon, lat, g.type, p.Text||'', p.Layer||'', JSON.stringify(p)]);
  });
  return rows.map(function (r) {
    return r.map(function (v) { var s2 = String(v==null?'':v).replace(/"/g,'""'); return '"'+s2+'"'; }).join(',');
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
function buildKML(features) {
  var byCat = groupByCategory(features);
  var out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
    '<name>Mei HaGalil GIS Export</name>'];
  Object.keys(byCat).forEach(function (c) {
    out.push('<Folder><name>' + kmlEsc(LABELS[c] || c) + '</name>');
    byCat[c].forEach(function (f) {
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
  });
  out.push('</Document></kml>');
  return out.join('\n');
}

// ── Shapefile (ZIP) — one shapefile per category, ITM coords + .prj ───────────
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
function exportShapefile(features, filename) {
  return loadScript(URL_JSZIP)
    .then(function () { return loadScript(URL_SHPWRITE); })
    .then(function () {
      var JSZip = window.JSZip, shpwrite = window.shpwrite;
      if (!JSZip || !shpwrite) throw new Error('ספריית Shapefile לא נטענה');
      var toITM = makeToITM();
      var byCat = groupByCategory(features);
      var master = new JSZip();
      var cats = Object.keys(byCat);

      return cats.reduce(function (chain, c) {
        return chain.then(function () {
          var safe = (c || 'other').replace(/[^a-zA-Z0-9_]/g, '_');
          var fc = { type: 'FeatureCollection', features: byCat[c].map(function (f) {
            return { type: 'Feature', properties: cleanProps(f.properties), geometry: reprojCoords(f.geometry, toITM) };
          }) };
          var opts = {
            outputType: 'blob', compression: 'STORE', prj: ITM_WKT,
            types: { point: safe, polygon: safe, polyline: safe, line: safe, multipolygon: safe }
          };
          // zip() may return a Blob/ArrayBuffer/base64 synchronously, or (older builds) a Promise
          return Promise.resolve(shpwrite.zip(fc, opts)).then(function (res) {
            if (typeof res === 'string') return JSZip.loadAsync(res, { base64: true });
            return JSZip.loadAsync(res);   // Blob or ArrayBuffer
          }).then(function (sub) {
            return Promise.all(Object.keys(sub.files).map(function (path) {
              if (sub.files[path].dir) return null;
              return sub.files[path].async('uint8array').then(function (content) {
                master.file(safe + '/' + path.split('/').pop(), content);
              });
            }));
          });
        });
      }, Promise.resolve())
      .then(function () { return master.generateAsync({ type: 'blob' }); })
      .then(function (zipBlob) { triggerDownload(zipBlob, filename + '.zip'); });
    });
}

// ── Excel (XLSX via SheetJS) — one worksheet per category ─────────────────────
function sheetName(name, used) {
  var s2 = String(name).replace(/[\\\/\?\*\[\]:]/g, ' ').trim().slice(0, 28) || 'Sheet';
  var base = s2, i = 1;
  while (used[s2]) { s2 = base.slice(0, 24) + ' ' + (++i); }
  used[s2] = 1;
  return s2;
}
function exportExcel(features, filename) {
  return loadScript(URL_XLSX).then(function () {
    var XLSX = window.XLSX;
    if (!XLSX) throw new Error('ספריית Excel לא נטענה');
    var byCat = groupByCategory(features);
    var wb = XLSX.utils.book_new();
    var used = {};
    Object.keys(byCat).forEach(function (c) {
      var rows = byCat[c].map(function (f) {
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
        return row;
      });
      var ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, sheetName(LABELS[c] || c, used));
    });
    XLSX.writeFile(wb, filename + '.xlsx');
  });
}

// ── INIT ──────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectUI);
} else {
  injectUI();
}

})();
