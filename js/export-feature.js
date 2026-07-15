(function () {
'use strict';

// LABELS moved to js/export-formats.js (loaded before this file — see index.html) so it's a
// real global reachable from BOTH files. This file's whole body is wrapped in this IIFE, so a
// `var LABELS` declared here would be local to this closure and invisible to export-formats.js
// (that mismatch used to make buildKML() throw "LABELS is not defined" at runtime). LABELS is
// still used below by plain identifier — it resolves via the normal global-scope lookup.

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
  wkt: false,         // CSV/Excel only: include a full-geometry geometry_wkt column (default OFF)
  busy: false,
  loading: false,     // building the layer list (engine layers + head counts)
  loaded: false,      // layer model built this session
  loadError: null,
  layers: {},         // catId -> { label, count, visible, selected, layerIds:[{id,village}] }
  seed: null,         // when set (features[]), export this fixed set from the FORMAT step
  // Draw-scope area-summary modal state (W2.2) — set by startAreaSummary() once the
  // rectangle is drawn, cleared by cleanupAreaSummary() on cancel/confirm.
  areaCats: null,     // categories the summary/export applies to
  areaBounds: null,   // {minLng,minLat,maxLng,maxLat} of the drawn rectangle
  areaModel: null     // { rows:[{cat,label,count,geomTypes,geomTypesLabel,enabled,overCap,previewPartial}], format }
};

var gRect = null, gDrawing = false, gDrawStart = null, gDrawTemp = null;

// ── DRAW-SCOPE AREA-SUMMARY STATE (W2.2) ───────────────────────────────────
// After the user drags a rectangle, an area-summary modal (counts + geometry
// types per selected category, from a fast COUNT-only RPC) is shown BEFORE
// any export runs. gAreaPreview is the temporary on-map preview layer.
var gAreaPreview = null;

// Per-layer fetch cap for the REAL draw-scope export (server bbox fetch via
// GIS.features.getInBBox / features_in_bbox). Matches the LIMIT clamp added
// to features_in_bbox in gis-engine/sql/migrations/2026-07-14-export-area-summary.sql
// — keep these two in sync if either changes.
var AREA_FETCH_CAP = 20000;
// Cap for the on-map PREVIEW fetch (separate, much smaller — just a visual
// hint of the drawn area's contents, not the export itself).
var AREA_PREVIEW_CAP = 2000;

// Rough bytes-per-feature heuristics per export format, for the "estimated
// output size" shown in the area-summary modal (always labelled "משוער" —
// real size depends heavily on attribute richness). Tuned from how each
// serializer in js/export-formats.js actually writes a feature: DXF/KML are
// verbose text formats (XDATA / ExtendedData per feature), Shapefile/CSV are
// compact flat/binary rows, DWG and Excel sit in between (binary but with
// container/format overhead).
var BYTES_PER_FEATURE = { dxf: 260, dwg: 160, geojson: 300, shapefile: 120, kml: 350, csv: 150, excel: 190 };
// Formats whose output CRS is ITM (EPSG:2039) instead of WGS84 (EPSG:4326) —
// see makeToITM() in export-formats.js.
var ITM_FORMATS = { dxf: 1, dwg: 1, shapefile: 1 };
// PostGIS GeometryType() (no ST_ prefix) → Hebrew bucket label.
var GEOM_TYPE_HE = {
  POINT: 'נקודות', MULTIPOINT: 'נקודות',
  LINESTRING: 'קווים', MULTILINESTRING: 'קווים', CIRCULARSTRING: 'קווים',
  POLYGON: 'פוליגונים', MULTIPOLYGON: 'פוליגונים'
};

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
  '.exp-warn{font-size:11px;color:#b45309;line-height:1.5;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;margin:-2px 0 6px;}' +
  '.exp-empty{padding:24px 10px;text-align:center;color:#94a3b8;font-size:13px;}' +
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
// Resolve the role and run `fn` only if the user may export (admin/editor).
// Viewers are read-only; the DWG service + DB RLS also enforce this server-side.
function withExportPermission(fn) {
  if (!window.GIS || !GIS.currentRole) return fn();
  GIS.currentRole().then(function (role) {
    if (GIS.permissions.canExport(role)) { fn(); }
    else { alert('אין לך הרשאת ייצוא (תצוגה בלבד).'); }
  }).catch(function () { alert('שגיאה בבדיקת הרשאות'); });
}

function openExportModal() { withExportPermission(_openExportModal); }
function _openExportModal() {
  if (!window.gMap) { alert('המפה עדיין לא נטענה'); return; }
  if (!window.GIS || !window.GIS.layers) { alert('מנוע ה-GIS עדיין נטען — נסה שוב בעוד רגע'); return; }
  cleanupAreaSummary();              // defensive: drop any leftover rect/preview from an abandoned draw session
  gExp.step = 1;
  gExp.busy = false;
  gExp.loadError = null;
  gExp.seed = null;                 // normal flow (FAB) — category selection, not a seeded set
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
function closeExportModal() {
  document.getElementById('exp-modal').classList.remove('open');
  // The header ✕ button calls this directly too — if the area-summary modal was
  // showing, make sure the rectangle + preview don't linger on the map (cancelAreaSummary
  // clears gExp.areaModel BEFORE calling this, so this is a no-op in that path).
  if (gExp.areaModel) cleanupAreaSummary();
}
window.closeExportModal = closeExportModal;

// Seed the wizard with a fixed feature set (e.g. the current selection) and open
// at the FORMAT step — skips category selection; expRun exports gExp.seed directly.
function openForFeatures(features) { withExportPermission(function () { _openForFeatures(features); }); }
function _openForFeatures(features) {
  if (!window.gMap) { alert('המפה עדיין לא נטענה'); return; }
  gExp.seed = (features || []).slice();
  if (!gExp.seed.length) { alert('אין אובייקטים בבחירה'); return; }
  gExp.scope = 'all';
  gExp.busy = false; gExp.loadError = null;
  gExp.step = 2;                    // start at format selection
  document.getElementById('exp-modal').classList.add('open');
  renderWizard();
}
window.GISExport = { openForFeatures: openForFeatures };

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
      var parsed = rowVC(l);   // hoisted helper (defined below) — prefers l.village/category
      var cat = parsed.category;
      var village = parsed.village || '';
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
        var c = rowVC(l).category;
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

// One { cat, id, village } job per (category, engine layer) pair among `cats` —
// shared by fetchFeaturesForCats, the area-summary RPC call and the draw-scope
// server bbox fetch, so the category→layer mapping is defined in exactly one place.
function catsJobs(cats) {
  var jobs = [];
  (cats || []).forEach(function (cat) {
    var L = gExp.layers[cat];
    if (!L) return;
    L.layerIds.forEach(function (lyr) { jobs.push({ cat: cat, id: lyr.id, village: lyr.village }); });
  });
  return jobs;
}

// Distinct layer ids referenced by `jobs`, in first-seen order.
function uniqueLayerIds(jobs) {
  var seen = {}, out = [];
  jobs.forEach(function (j) { if (!seen[j.id]) { seen[j.id] = true; out.push(j.id); } });
  return out;
}

// Fetch ALL features for the selected categories from the engine (used by the
// "כל הנתונים" / DWG / seeded flows — never bounds-filtered; the draw scope
// uses fetchAreaFeaturesServerSide instead, a real DB bbox query). Calls
// cb(features) with WGS84 GeoJSON features.
function fetchFeaturesForCats(cats, cb) {
  var GIS = window.GIS;
  var jobs = catsJobs(cats);
  var all = [];
  runPool(jobs, 4, function (job) {
    return GIS.features.getFeatures(job.id, 1000000).then(function (fc) {
      ((fc && fc.features) || []).forEach(function (f) {
        if (!f.geometry) return;
        if (!f.properties) f.properties = {};
        f.properties._category = job.cat;       // authoritative (from layer name)
        if (job.village) f.properties._village = job.village;
        all.push(f);
      });
    });
  }).then(function () { cb(all); });
}

// Fetch features for `cats` restricted to `bounds` = {minLng,minLat,maxLng,maxLat}
// via a REAL DB bbox query (features_in_bbox, through GIS.features.getInBBox) —
// one call per engine layer, capped at AREA_FETCH_CAP each. Unlike the old
// client-side isInBounds filter, this reaches features that were never loaded
// as map tiles. Calls cb(features) with WGS84 GeoJSON features.
function fetchAreaFeaturesServerSide(cats, bounds, cb) {
  var GIS = window.GIS;
  var jobs = catsJobs(cats);
  var all = [];
  runPool(jobs, 4, function (job) {
    return GIS.features.getInBBox(job.id, bounds, AREA_FETCH_CAP).then(function (fc) {
      ((fc && fc.features) || []).forEach(function (f) {
        if (!f.geometry) return;
        if (!f.properties) f.properties = {};
        f.properties._category = job.cat;
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
  var wktRow = '';
  if (gExp.format === 'csv' || gExp.format === 'excel') {
    note = '<div class="exp-note">פורמטים טבלאיים — מתאימים בעיקר לשכבות נקודה (מדי מים, שוחות וכו\'). עבור גאומטריה מורכבת תישמר הקואורדינטה הראשונה בלבד; הגאומטריה המלאה נשמרת בעמודת JSON.</div>';
    wktRow = '<label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:#334155;cursor:pointer;user-select:none;">' +
      '<input type="checkbox" ' + (gExp.wkt ? 'checked' : '') + ' onchange="expToggleWkt(this)" style="cursor:pointer;accent-color:#0d3b5e;margin:0;">' +
      'כלול גיאומטריה מלאה (WKT)</label>';
  } else if (gExp.format === 'shapefile') {
    note = '<div class="exp-note">לכל שכבה נוצר Shapefile נפרד בתוך קובץ ZIP אחד, בקואורדינטות רשת ישראל החדשה (ITM / EPSG:2039).</div>';
  }
  return '<div class="exp-sec">פורמט ייצוא</div><div class="exp-fmts">' + pills + '</div>' + note + wktRow;
}

// Step 3 — review summary (rendered from gExp only)
function step3HTML() {
  if (gExp.seed) {
    var Fs = FORMATS[gExp.format] || { label: gExp.format };
    return '<div class="exp-sec">סיכום ייצוא</div>' +
      '<div class="exp-sum">' +
        '<div class="exp-sum-row"><span>מקור</span><span class="v">בחירה</span></div>' +
        '<div class="exp-sum-row exp-sum-total"><span>סה"כ אובייקטים</span><span class="v">' + fmtNum(gExp.seed.length) + '</span></div>' +
        '<div class="exp-sum-row"><span>פורמט</span><span class="v">' + Fs.label + '</span></div>' +
      '</div>';
  }
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
  var atFloor = (s2 === 1) || (gExp.seed && s2 === 2);   // seeded mode has no step-1 to go back to
  var left = atFloor
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
window.expToggleWkt  = function (input) { gExp.wkt = !!input.checked; };
window.expBack  = function () { if (gExp.step > 1) { gExp.step--; renderWizard(); } };
window.expNext  = function () { if (gExp.step < 3) { gExp.step++; renderWizard(); } };
window.expBackTo3 = function () { gExp.step = 3; renderWizard(); };

// ── EXPORT RUN ────────────────────────────────────────────────────────────────
window.expRun = function () {
  // Seeded mode (export a fixed selection): use gExp.seed, no category fetch.
  if (gExp.seed) {
    var seedF = gExp.seed;
    if (!seedF.length) { alert('אין אובייקטים בבחירה'); return; }
    if (gExp.format === 'dwg') { closeExportModal(); generateAndDownload(seedF); return; }
    gExp.step = 4; gExp.busy = true; renderWizard();
    setGenMsg('מייצא…');
    setTimeout(function () { generateAndDownload(seedF); }, 30);
    return;
  }
  var cats = selectedCats();
  if (!cats.length) { alert('בחר לפחות שכבה אחת'); return; }

  // Draw scope keeps the existing on-map flow (modal closes, user drags a box)
  if (gExp.scope === 'draw') { closeExportModal(); startDrawMode(cats); return; }

  // DWG keeps its dedicated wait modal exactly as before — fetch first, then hand off.
  if (gExp.format === 'dwg') {
    closeExportModal();
    fetchFeaturesForCats(cats, function (features) {
      if (!features.length) { alert('לא נמצאו אובייקטים'); return; }
      generateAndDownload(features);
    });
    return;
  }

  // Everything else generates inside the wizard step-4 pane
  gExp.step = 4; gExp.busy = true;
  renderWizard();
  setGenMsg('אוסף נתונים…');
  fetchFeaturesForCats(cats, function (features) {
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
  // Rectangle drawn — show the area-summary modal BEFORE running any export
  // (was: fetch+export immediately here, client-filtered against loaded tiles).
  startAreaSummary(selectedCatsArg, bounds);
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

// ── AREA-SUMMARY MODAL (W2.2) ───────────────────────────────────────────────
// Plain object → {minLng,minLat,maxLng,maxLat}, the shape GIS.spatial.exportAreaSummary
// / GIS.features.getInBBox expect. `b` is a Leaflet LatLngBounds (duck-typed —
// only getWest/getSouth/getEast/getNorth are used, so a test stub works too).
function leafletBoundsToPlain(b) {
  return { minLng: b.getWest(), minLat: b.getSouth(), maxLng: b.getEast(), maxLat: b.getNorth() };
}

// "village · category" → category, via window.LayerNaming.parse when available
// (js/layer-naming.js — NOT currently in index.html's load order, see that
// file's own header note), else an inline fallback splitting on the same
// ' · ' separator LayerNaming.compose() uses. Kept tolerant of a missing
// separator (whole name treated as the category) to match LayerNaming.parse's
// own contract.
function parseLayerName(name) {
  if (window.LayerNaming && typeof window.LayerNaming.parse === 'function') return window.LayerNaming.parse(name);
  var SEP = ' · ';
  name = String(name == null ? '' : name);
  var idx = name.indexOf(SEP);
  if (idx === -1) return { village: null, category: name };
  return { village: name.slice(0, idx), category: name.slice(idx + SEP.length) };
}

// { village, category } for a FULL layer row — prefers the DB-derived
// columns (layer.village/category — W5.2) via LayerNaming.fromRow when
// loaded; falls back to parsing layer.name (parseLayerName above)
// otherwise. Used by buildLayerModel()/its visibility badge, both of which
// have full rows from GIS.layers.getLayers() / GISEngineSidebar.activeLayers().
// buildAreaSummaryModel() keeps using parseLayerName directly — its rows
// come from the export_area_summary RPC, which carries `name` only.
function rowVC(layer) {
  if (window.LayerNaming && typeof window.LayerNaming.fromRow === 'function') return window.LayerNaming.fromRow(layer);
  return parseLayerName(layer && layer.name);
}

// Distinct PostGIS geometry types (e.g. ['POINT'], ['LINESTRING','MULTILINESTRING'])
// → a Hebrew label ("נקודות" / "קווים · פוליגונים" for a mixed layer / '—' if unknown).
function geometryTypesLabel(types) {
  var set = {};
  (types || []).forEach(function (t) { set[GEOM_TYPE_HE[String(t || '').toUpperCase()] || t] = true; });
  var keys = Object.keys(set);
  return keys.length ? keys.join(' · ') : '—';
}

// Rough estimated output size in bytes for `count` features of format `format`
// with geometry types `geomTypes` (see BYTES_PER_FEATURE above for the tiers).
// Lines/polygons carry materially more coordinate data than points, so bump
// the per-feature estimate for layers that aren't pure point layers.
function estimateBytes(format, count, geomTypes) {
  var perFeature = BYTES_PER_FEATURE[format] || 200;
  var hasLineOrPoly = (geomTypes || []).some(function (t) { return /LINE|POLY/i.test(t); });
  if (hasLineOrPoly) perFeature = Math.round(perFeature * 1.6);
  return Math.max(0, Math.round((count || 0) * perFeature));
}
function fmtBytes(n) {
  n = n || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function crsLabelFor(format) { return ITM_FORMATS[format] ? 'ITM · EPSG:2039' : 'WGS84 · EPSG:4326'; }

// Build the area-summary modal MODEL from the export_area_summary RPC rows —
// one row per SELECTED category (aggregating village layers within a category,
// same granularity as the rest of the wizard). Every category in `cats` gets a
// row even if the RPC returned nothing for it (0-count area). Pure function —
// no RPC calls, no DOM — so it's unit-testable on its own.
function buildAreaSummaryModel(rpcRows, cats, format) {
  var byCat = {};
  (cats || []).forEach(function (c) {
    byCat[c] = {
      cat: c,
      label: (window.GISLayerLabel ? window.GISLayerLabel(c) : (LABELS[c] || c)),
      count: 0, geomTypes: {}
    };
  });
  (rpcRows || []).forEach(function (row) {
    var cat = parseLayerName(row.name).category;
    if (!byCat[cat]) return;   // defensive: ignore rows outside the requested categories
    byCat[cat].count += (row.count || 0);
    (row.geometry_types || []).forEach(function (gt) { if (gt) byCat[cat].geomTypes[gt] = true; });
  });
  var rows = (cats || []).map(function (c) {
    var r = byCat[c];
    var geomTypes = Object.keys(r.geomTypes);
    return {
      cat: r.cat, label: r.label, count: r.count,
      geomTypes: geomTypes, geomTypesLabel: geometryTypesLabel(geomTypes),
      enabled: true,
      overCap: r.count > AREA_FETCH_CAP,     // true export fetch would be truncated — warn up front
      previewPartial: false                   // set later by loadAreaPreview() if the on-map preview was capped
    };
  });
  return { rows: rows, format: format };
}

// Derived totals over the CURRENTLY ENABLED rows of a model (recomputed after
// every checkbox toggle — exclusions never mutate the RPC-sourced counts).
function areaSummaryTotals(model) {
  var count = 0, typesSet = {};
  (model.rows || []).forEach(function (r) {
    if (!r.enabled) return;
    count += r.count;
    (r.geomTypes || []).forEach(function (t) { typesSet[t] = true; });
  });
  var bytes = estimateBytes(model.format, count, Object.keys(typesSet));
  return { count: count, sizeBytes: bytes, sizeLabel: fmtBytes(bytes), empty: count === 0 };
}

// Kick off the area-summary flow right after the rectangle is drawn: fetch the
// fast per-category COUNT summary, render the modal, then lazily load the
// (capped) on-map preview in the background.
function startAreaSummary(cats, leafletBounds) {
  var GIS = window.GIS;
  var bounds = leafletBoundsToPlain(leafletBounds);
  var jobs = catsJobs(cats);
  var layerIds = uniqueLayerIds(jobs);
  showBusy('מחשב סיכום אזור…');
  GIS.spatial.exportAreaSummary(bounds, layerIds).then(function (rows) {
    closeBusy();
    gExp.areaCats = cats;
    gExp.areaBounds = bounds;
    gExp.areaModel = buildAreaSummaryModel(rows, cats, gExp.format);
    openAreaSummaryModal();
    loadAreaPreview(jobs, bounds);
  }).catch(function (e) {
    closeBusy();
    if (gRect) { window.gMap.removeLayer(gRect); gRect = null; }
    alert('שגיאה בחישוב סיכום האזור: ' + (e && e.message ? e.message : String(e)));
  });
}

function openAreaSummaryModal() {
  document.getElementById('exp-modal').classList.add('open');
  renderAreaSummaryModal();
}
function renderAreaSummaryModal() {
  var body = document.getElementById('exp-body'), foot = document.getElementById('exp-foot');
  if (!body || !gExp.areaModel) return;
  body.innerHTML = areaSummaryHTML(gExp.areaModel);
  foot.innerHTML = areaSummaryFootHTML(gExp.areaModel);
}

function areaSummaryHTML(model) {
  var totals = areaSummaryTotals(model);
  var F = FORMATS[model.format] || { label: model.format };
  // "Empty area" = the drawn rectangle itself has 0 features across every
  // selected category — independent of which checkboxes are currently on
  // (that's a separate, enabled-only check that only disables the Confirm
  // button; see areaSummaryFootHTML/areaSummaryTotals).
  var areaIsEmpty = !(model.rows || []).length || model.rows.every(function (r) { return r.count === 0; });
  if (areaIsEmpty) {
    return '<div class="exp-sec">🗺️ סיכום אזור מסומן</div>' +
      '<div class="exp-empty">לא נמצאו אובייקטים באזור שסומן</div>';
  }
  var rowsHtml = model.rows.map(function (r) {
    var warn = r.overCap
      ? '<div class="exp-warn">⚠️ באזור שסומן יש ' + fmtNum(r.count) + ' אובייקטים בשכבה "' + r.label + '" — הייצוא יכלול רק את ' + fmtNum(AREA_FETCH_CAP) + ' הראשונים</div>'
      : '';
    return '<label class="exp-lrow' + (r.enabled ? ' on' : '') + '">' +
      '<input type="checkbox" ' + (r.enabled ? 'checked' : '') + ' onchange="expAreaToggle(\'' + r.cat + '\',this)">' +
      '<span class="exp-lname">' + r.label + '</span>' +
      '<span class="exp-lcount">' + fmtNum(r.count) + '</span>' +
      '<span class="exp-lvis vis">' + r.geomTypesLabel + '</span>' +
    '</label>' + warn;
  }).join('');
  var previewNote = model.rows.some(function (r) { return r.previewPartial; })
    ? '<div class="exp-note">התצוגה המקדימה על המפה חלקית (עד ' + fmtNum(AREA_PREVIEW_CAP) + ' אובייקטים לכל שכבה) — הייצוא בפועל אינו מוגבל בכך (עד ' + fmtNum(AREA_FETCH_CAP) + ' לשכבה).</div>'
    : '';
  return '<div class="exp-sec">🗺️ סיכום אזור מסומן</div>' +
    '<div class="exp-layers" style="max-height:240px">' + rowsHtml + '</div>' +
    '<div class="exp-sum">' +
      '<div class="exp-sum-row exp-sum-total"><span>סה"כ אובייקטים לייצוא</span><span class="v">' + fmtNum(totals.count) + '</span></div>' +
      '<div class="exp-sum-row"><span>גודל משוער</span><span class="v">' + totals.sizeLabel + ' (משוער)</span></div>' +
      '<div class="exp-sum-row"><span>מערכת קואורדינטות פלט</span><span class="v">' + crsLabelFor(model.format) + '</span></div>' +
      '<div class="exp-sum-row"><span>פורמט</span><span class="v">' + F.label + '</span></div>' +
    '</div>' + previewNote;
}

function areaSummaryFootHTML(model) {
  var totals = areaSummaryTotals(model);
  var dis = totals.empty ? ' disabled' : '';
  return '<button class="exp-btn exp-btn-secondary" onclick="cancelAreaSummary()">ביטול</button>' +
    '<button class="exp-btn exp-btn-primary" onclick="confirmAreaSummaryExport()"' + dis + '>📥 ייצא</button>';
}

window.expAreaToggle = function (cat, input) {
  var row = gExp.areaModel && (gExp.areaModel.rows || []).filter(function (r) { return r.cat === cat; })[0];
  if (row) row.enabled = input.checked;
  renderAreaSummaryModal();
};

// Remove the drawn rectangle + preview layer and clear the area-summary state
// (called by both Cancel and the modal's ✕ close button — see closeExportModal).
function cleanupAreaSummary() {
  if (gRect) { window.gMap.removeLayer(gRect); gRect = null; }
  removeAreaPreview();
  gExp.areaCats = null; gExp.areaBounds = null; gExp.areaModel = null;
}
function cancelAreaSummary() { cleanupAreaSummary(); closeExportModal(); }
window.cancelAreaSummary = cancelAreaSummary;

function confirmAreaSummaryExport() {
  var model = gExp.areaModel;
  if (!model) return;
  var enabledCats = model.rows.filter(function (r) { return r.enabled; }).map(function (r) { return r.cat; });
  if (!enabledCats.length) return;   // Confirm is disabled in this state; defensive no-op
  var bounds = gExp.areaBounds;
  if (gRect) { window.gMap.removeLayer(gRect); gRect = null; }
  removeAreaPreview();
  gExp.areaCats = null; gExp.areaBounds = null; gExp.areaModel = null;
  closeExportModal();
  showBusy('אוסף נתונים…');
  fetchAreaFeaturesServerSide(enabledCats, bounds, function (features) {
    if (!features.length) { closeBusy(); alert('לא נמצאו אובייקטים באזור שנבחר'); return; }
    setBusyMsg('מייצא…');
    setTimeout(function () { generateAndDownload(features); }, 30);
  });
}
window.confirmAreaSummaryExport = confirmAreaSummaryExport;

// ── AREA PREVIEW LAYER (temporary, semi-transparent cyan) ─────────────────────
function ensurePreviewPane() {
  if (window.gMap && !window.gMap.getPane('expAreaPreview')) {
    var p = window.gMap.createPane('expAreaPreview');
    p.style.zIndex = 440; p.style.pointerEvents = 'none';
  }
}
// Lazily loads up to AREA_PREVIEW_CAP features per engine layer (job) and
// renders them on a dedicated pane behind the modal. Non-blocking — the
// summary modal is already visible by the time this resolves. If a layer's
// true count (from the already-rendered model) exceeds what the preview
// fetched, flags that category's row `previewPartial` and re-renders the
// modal note (only if it's still open).
function loadAreaPreview(jobs, bounds) {
  if (!window.gMap || typeof L === 'undefined') return;
  var GIS = window.GIS;
  ensurePreviewPane();
  removeAreaPreview();
  var group = L.layerGroup().addTo(window.gMap);
  gAreaPreview = group;
  runPool(jobs, 4, function (job) {
    return GIS.features.getInBBox(job.id, bounds, AREA_PREVIEW_CAP).then(function (fc) {
      var feats = ((fc && fc.features) || []).filter(function (f) { return f.geometry; });
      var row = gExp.areaModel && gExp.areaModel.rows.filter(function (r) { return r.cat === job.cat; })[0];
      if (row && feats.length < row.count) row.previewPartial = true;
      if (!feats.length) return;
      L.geoJSON({ type: 'FeatureCollection', features: feats }, {
        pane: 'expAreaPreview',
        style: { color: '#06b6d4', weight: 2, opacity: 0.5, fillColor: '#22d3ee', fillOpacity: 0.15 },
        pointToLayer: function (f, ll) {
          return L.circleMarker(ll, { radius: 4, color: '#06b6d4', weight: 1, fillColor: '#22d3ee', fillOpacity: 0.5, pane: 'expAreaPreview' });
        }
      }).addTo(group);
    }).catch(function () {});
  }).then(function () {
    var modal = document.getElementById('exp-modal');
    if (gExp.areaModel && modal && modal.classList.contains('open')) renderAreaSummaryModal();
  });
}
function removeAreaPreview() {
  if (gAreaPreview && window.gMap) window.gMap.removeLayer(gAreaPreview);
  gAreaPreview = null;
}

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
async function generateAndDownload(features) {
  var ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  var filename = 'mei-hagalil-' + ts;
  // Progress for the chunked builders — only show a % on large exports.
  function onProg(done, total) { if (total > 4000) setGenMsg('מייצא… ' + Math.round(done / total * 100) + '%'); }

  try {
    if (gExp.format === 'dwg') {
      closeBusy();                               // DWG has its own dedicated wait modal
      _exportDWG(features, filename);            // own wait modal; success/error handled inside
    } else if (gExp.format === 'dxf') {
      await _exportDXF(features, filename, onProg);   // rejection → outer catch → finishGen(false)
      finishGen(true);
    } else if (gExp.format === 'geojson') {
      triggerDownload(new Blob([await buildGeoJSON(features, onProg)], { type: 'application/geo+json' }), filename + '.geojson');
      finishGen(true);
    } else if (gExp.format === 'csv') {
      triggerDownload(new Blob(['﻿' + await buildCSV(features, onProg, { wkt: gExp.wkt })], { type: 'text/csv;charset=utf-8' }), filename + '.csv');
      finishGen(true);
    } else if (gExp.format === 'kml') {
      triggerDownload(new Blob([await buildKML(features, onProg)], { type: 'application/vnd.google-earth.kml+xml' }), filename + '.kml');
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

// ── DXF: server-primary with client fallback ─────────────────────────────────
// Wires window.exportDXFSmart (js/backend-client.js — read its CONTRACT block):
//   • resolves a Blob  → the richer server-built R2018 DXF; download it as-is.
//   • resolves null    → conversion service unavailable (cold Render/offline;
//     negative ping cached 60s there) → fall back to the existing client-side
//     R12 buildDXF() path unchanged, with a ONE-TIME (per session) Hebrew
//     notice toast so the user knows why the file is the basic variant.
//   • REJECTS          → a real post-ping error (auth/4xx/5xx) — propagate to
//     generateAndDownload's catch → finishGen(false, msg), the wizard's normal
//     error surface. NEVER a silent fallback.
// backend-client.js is lazy-loaded (see index.html's LAZY list), so the global
// is feature-detected — absent behaves like today's client-only path (same
// defensive pattern as parseLayerName's window.LayerNaming detection).
// The smart path's progress goes through setGenMsg (already routed to the
// step-4 pane OR the draw-scope busy overlay), because exportDXFSmart reports
// (stage, percent, hebrewMessage) — not the chunked builders' (done, total).
var _dxfFallbackNoticed = false;
function notifyDxfFallback() {
  if (_dxfFallbackNoticed) return;
  _dxfFallbackNoticed = true;
  if (window.showToast) window.showToast('נוצר DXF בסיסי (R12) — שירות ההמרה המתקדם אינו זמין כרגע');
}
async function _exportDXF(features, filename, onProg) {
  if (typeof window.exportDXFSmart === 'function') {
    var blob = await window.exportDXFSmart(features, filename, function (stage, pct, msg) { setGenMsg(msg); });
    if (blob) { triggerDownload(blob, filename + '.dxf'); return; }   // richer server R2018 DXF
    notifyDxfFallback();                                              // null → service unavailable
  }
  // Client-side R12 fallback (service unavailable, or backend-client.js not loaded yet)
  triggerDownload(new Blob([await buildDXF(features, onProg)], { type: 'application/dxf' }), filename + '.dxf');
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

// ── ITM CONVERSION, category grouping, coordinate reprojection, prop cleanup ──
// makeToITM/groupByCategory/reprojCoords/cleanProps moved to js/export-formats.js
// (loaded before this file — see index.html) so they're real globals reachable
// from both files; used below by plain identifier via normal scope-chain lookup.

// ── DXF / CSV / KML / GeoJSON serializers, and the chunked Shapefile/Excel data-prep
//    (buildShapefileCollections / buildExcelRows), all live in js/export-formats.js
//    (loaded alongside; globals). This file keeps only the CDN-dependent parts
//    (script loading + shp-write/JSZip/XLSX calls) that need the real DOM. ──────

// ── Shapefile (ZIP) — one shapefile per category, ITM coords + .prj ───────────
async function exportShapefile(features, filename) {
  await loadScript(URL_JSZIP);
  await loadScript(URL_SHPWRITE);
  var JSZip = window.JSZip, shpwrite = window.shpwrite;
  if (!JSZip || !shpwrite) throw new Error('ספריית Shapefile לא נטענה');

  // Heavy part (ITM reprojection + attribute flattening for every feature) is chunked/async —
  // see buildShapefileCollections in export-formats.js. Only the shp-write + JSZip assembly
  // below (which need the CDN libs) stay synchronous per category.
  var byCat = await buildShapefileCollections(features, function (done, total) {
    if (total > 4000) setGenMsg('בונה Shapefile… ' + Math.round(done / total * 100) + '%');
  });

  var master = new JSZip();
  var cats = Object.keys(byCat);
  for (var i = 0; i < cats.length; i++) {
    var c = cats[i];
    var safe = (c || 'other').replace(/[^a-zA-Z0-9_]/g, '_');
    var fc = { type: 'FeatureCollection', features: byCat[c] };
    var opts = {
      outputType: 'blob', compression: 'STORE', prj: ITM_WKT,
      types: { point: safe, polygon: safe, polyline: safe, line: safe, multipolygon: safe }
    };
    // zip() may return a Blob/ArrayBuffer/base64 synchronously, or (older builds) a Promise
    var res = await shpwrite.zip(fc, opts);
    var sub = (typeof res === 'string') ? await JSZip.loadAsync(res, { base64: true }) : await JSZip.loadAsync(res);
    var paths = Object.keys(sub.files);
    for (var j = 0; j < paths.length; j++) {
      var path = paths[j];
      if (sub.files[path].dir) continue;
      var content = await sub.files[path].async('uint8array');
      master.file(safe + '/' + path.split('/').pop(), content);
    }
  }
  var zipBlob = await master.generateAsync({ type: 'blob' });
  triggerDownload(zipBlob, filename + '.zip');
}

// ── Excel (XLSX via SheetJS) — one worksheet per category ─────────────────────
function sheetName(name, used) {
  var s2 = String(name).replace(/[\\\/\?\*\[\]:]/g, ' ').trim().slice(0, 28) || 'Sheet';
  var base = s2, i = 1;
  while (used[s2]) { s2 = base.slice(0, 24) + ' ' + (++i); }
  used[s2] = 1;
  return s2;
}
async function exportExcel(features, filename) {
  await loadScript(URL_XLSX);
  var XLSX = window.XLSX;
  if (!XLSX) throw new Error('ספריית Excel לא נטענה');

  // Heavy part (per-category row building) is chunked/async — see buildExcelRows in
  // export-formats.js. Only XLSX.write below (needs the CDN lib) stays synchronous.
  var byCat = await buildExcelRows(features, function (done, total) {
    if (total > 4000) setGenMsg('בונה Excel… ' + Math.round(done / total * 100) + '%');
  }, { wkt: gExp.wkt });

  var wb = XLSX.utils.book_new();
  var used = {};
  Object.keys(byCat).forEach(function (c) {
    var ws = XLSX.utils.json_to_sheet(byCat[c]);
    XLSX.utils.book_append_sheet(wb, ws, sheetName(LABELS[c] || c, used));
  });
  XLSX.writeFile(wb, filename + '.xlsx');
}

// Exposed for unit tests only (test/export/*.test.js) — not used by the app itself.
// gExp is included (by reference) so tests can flip gExp.wkt to exercise the WKT-on
// path through the real wizard state without needing to drive the UI. The
// area-summary internals (W2.2) below are the pure/testable pieces of the
// draw-scope flow — see test/export/export-area.test.js.
window.__exportTestHooks = {
  exportShapefile: exportShapefile, exportExcel: exportExcel, gExp: gExp,
  catsJobs: catsJobs, uniqueLayerIds: uniqueLayerIds,
  leafletBoundsToPlain: leafletBoundsToPlain, parseLayerName: parseLayerName, rowVC: rowVC,
  geometryTypesLabel: geometryTypesLabel, estimateBytes: estimateBytes, fmtBytes: fmtBytes,
  crsLabelFor: crsLabelFor, buildAreaSummaryModel: buildAreaSummaryModel, areaSummaryTotals: areaSummaryTotals,
  fetchAreaFeaturesServerSide: fetchAreaFeaturesServerSide,
  AREA_FETCH_CAP: AREA_FETCH_CAP, AREA_PREVIEW_CAP: AREA_PREVIEW_CAP,
  _exportDXF: _exportDXF
};

// ── INIT ──────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectUI);
} else {
  injectUI();
}

})();
