/* ══════════════════════════════════════════════════════════════════════════
   GIS Edit — on-map editing (ArcGIS Pro "Edit" tab).
   • Add entity   — pick a target layer → draw a point/line/polygon (Geoman) →
                    fill asset_code + attributes (domains) → create_feature.
   • Edit geom.   — pick a layer → click a feature → drag its vertices (Geoman)
                    → Save → update_feature_geometry (length_m recomputes).
   • Delete       — pick a layer → click a feature → confirm → delete_feature.
   • Snap         — toggle Geoman global snapping; a hidden snap-guide layer of
                    nearby features lets new/edited geometry snap to real
                    pipe endpoints/vertices.

   Self-contained IIFE; mirrors gis-meter-connect.js / gis-network-trace.js.
   Drives the DB only through GIS.features.* and renders on window.gMap.
   Needs Leaflet-Geoman (gMap.pm). All writes are admin|engineer (RLS enforces).
   Wired from the עריכה ribbon tab. Reuses the .gis-anly-* / .gad-* dialog styles.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var SNAP_DISTANCE = 20;     // px — Geoman snap radius
  var CLICK_FIND_M  = 35;     // metres — click→feature pick tolerance (edit/delete)
  var SNAP_LIMIT    = 4000;   // cap on snap-guide features per layer

  // Geoman draw shape per layer geometry type.
  var DRAW_SHAPE = { Point: 'Marker', LineString: 'Line', Polygon: 'Polygon' };

  var state = {
    mode: null,            // 'add' | 'editgeom' | 'delete' | null
    snap: true,            // global snapping (default on)
    targetLayerId: null,
    snapGuide: null,       // L.geoJSON guide layer for snapping
    editLayer: null,       // temp editable L.geoJSON during editgeom
    editId: null,
    editBeforeGeometry: null,  // geometry captured at edit-start, for undo
    clickHandler: null,    // one-shot map-click handler (edit/delete pick)
    createHandler: null    // pm:create handler (add)
  };

  // Sticky Edit Mode (section 2b, below) state — deliberately a SEPARATE
  // object from the legacy one-shot `state` above (mode/editLayer/etc. keep
  // their old meaning for startAdd/startEditGeomLegacy/startDelete) so the
  // two flows can never step on each other's bookkeeping.
  var emState = {
    mode: 'off',            // 'off' | 'armed' | 'editing' | 'saving'
    dirty: false,
    sub: null,               // 'vertices' | 'move' | 'extend' | 'shorten'
    originalType: null,      // geometry type of the feature being edited
    editToken: null,         // features.edited_at as last read — concurrency token
    featureId: null,
    layerId: null,
    editLayer: null,         // live editable Leaflet layer/FeatureGroup
    before: null,            // geometry captured at edit-start (undo + conflict retry)
    layerHandlers: [],       // [[emitter, event, handler], ...] — torn down per sub-mode switch
    beforeUnloadHandler: null,
    moveDrag: null,          // MultiPoint manual translate: {onDown,onMove,onUp}
    _extendHandler: null,
    _shortenHandler: null,
    pickArmed: false,        // one-shot map-click pick currently registered
    saveSeq: 0               // bumps per save attempt — a stale save never touches newer state
  };

  // ── tiny helpers (mirrors gis-meter-connect) ────────────────────────────────
  function ready() {
    if (!window.GIS || !window.gMap) { toast('המנוע עדיין נטען…'); return false; }
    if (!window.gMap.pm) { toast('כלי העריכה (Geoman) לא נטען'); return false; }
    return true;
  }
  function toast(msg, type) {
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.className = (type ? type + ' ' : '') + 'show';
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = ''; }, 2800);
  }
  // esc() centralized in auth.js (window.escHtml)
  function cleanErr(e) { return (e && e.message) ? e.message.replace('[GIS] ', '') : 'שגיאה'; }
  // metres between two [lng,lat]
  function distM(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b[1] - a[1]) * toR, dLng = (b[0] - a[0]) * toR;
    var la1 = a[1] * toR, la2 = b[1] * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bboxAround(latlng, halfM) {
    var dLat = halfM / 110540, dLng = halfM / (111320 * Math.cos(latlng.lat * Math.PI / 180) || 1);
    return { minLng: latlng.lng - dLng, minLat: latlng.lat - dLat, maxLng: latlng.lng + dLng, maxLat: latlng.lat + dLat };
  }
  function bboxOfView(padM) {
    var b = window.gMap.getBounds();
    var dLat = (padM || 0) / 110540;
    var dLng = (padM || 0) / (111320 * Math.cos(b.getCenter().lat * Math.PI / 180) || 1);
    return { minLng: b.getWest() - dLng, minLat: b.getSouth() - dLat, maxLng: b.getEast() + dLng, maxLat: b.getNorth() + dLat };
  }
  // מפרק "<כפר> · <category>" דרך LayerNaming כשהוא טעון; נופל בחזרה לפירוק
  // inline זהה מבחינה סמנטית אם הסקריפט טרם נטען (בטיחות סדר-טעינה).
  function parseLayerName(name) {
    name = name || '';
    if (window.LayerNaming) return LayerNaming.parse(name);
    var idx = name.indexOf(' · ');
    return idx >= 0 ? { village: name.slice(0, idx), category: name.slice(idx + 3) } : { village: null, category: name };
  }
  // { village, category } for a FULL layer row — prefers the DB-derived
  // columns (layer.village/category — W5.2) via LayerNaming.fromRow when
  // loaded; falls back to parsing layer.name (parseLayerName above)
  // otherwise. GIS.layers.getLayers() selects('*'), so village/category are
  // already on the rows listLayers() maps below.
  function rowVC(layer) {
    if (window.LayerNaming && LayerNaming.fromRow) return LayerNaming.fromRow(layer);
    return parseLayerName(layer && layer.name);
  }

  // Strip UI-only marker properties (added by features_geojson/features_in_bbox)
  // before they can be replayed back into a new row's `properties` column —
  // asset_code travels separately; __id/__layer_id are query-time synthetics.
  function cleanProps(props) {
    var out = {};
    Object.keys(props || {}).forEach(function (k) {
      if (k === '__id' || k === '__layer_id' || k === 'asset_code') return;
      out[k] = props[k];
    });
    return out;
  }

  async function requireEditor() {
    var role = null;
    try { role = await GIS.currentRole(); } catch (e) {}
    if (role === 'admin' || role === 'engineer') return true;
    toast('אין הרשאת עריכה', 'error');
    return false;
  }

  // All engine layers, split into { id, name, label, village, geometry_type }.
  async function listLayers() {
    var ls = await GIS.layers.getLayers();
    return (ls || []).map(function (l) {
      var parsed = rowVC(l);
      return {
        id: l.id, name: l.name,
        label: parsed.category,
        village: parsed.village != null ? parsed.village : '',
        geometry_type: l.geometry_type
      };
    });
  }

  // nearest feature in a FeatureCollection to a [lng,lat] click (min vertex dist).
  function nearestInFC(click, fc) {
    var best = null;
    (fc.features || []).forEach(function (f) {
      var g = f.geometry; if (!g) return;
      var d = minVertexDist(click, g);
      if (best === null || d < best.d) best = { d: d, f: f };
    });
    return best;
  }
  function minVertexDist(click, g) {
    var best = Infinity;
    function scan(coords) {
      if (typeof coords[0] === 'number') { var d = distM(click, coords); if (d < best) best = d; return; }
      for (var i = 0; i < coords.length; i++) scan(coords[i]);
    }
    if (g.coordinates) scan(g.coordinates);
    return best;
  }

  // ── panes ───────────────────────────────────────────────────────────────────
  function ensurePane(name, z) {
    if (!window.gMap.getPane(name)) {
      var p = window.gMap.createPane(name); p.style.zIndex = z;
    }
    return name;
  }
  // Panes for on-map editing. The editable copy lives in `gisEditTop` (z 700,
  // above every app overlay: snap guide 640, meter 648/655, trace 650,
  // identify 660). Geoman draws its vertex / midpoint / hint markers in the
  // pane named by its global option panes.vertexPane — DEFAULT `markerPane`
  // (z 600), i.e. UNDER the copy, so a mousedown on a corner hit the copy's
  // path and never reached the handle ("קודקודים does nothing"). Give the
  // handles their own pane ABOVE the copy. Idempotent; called from every
  // edit/draw entry point. setGlobalOptions() replaces the whole `panes`
  // object, so all three keys are passed.
  var EDIT_PANE = 'gisEditTop', EDIT_PANE_Z = 700;
  var VERTEX_PANE = 'gisEditVertex', VERTEX_PANE_Z = 710;
  function ensureEditPanes() {
    var pane = ensurePane(EDIT_PANE, EDIT_PANE_Z);
    ensurePane(VERTEX_PANE, VERTEX_PANE_Z);
    try {
      window.gMap.pm.setGlobalOptions({
        panes: { vertexPane: VERTEX_PANE, layerPane: 'overlayPane', markerPane: 'markerPane' }
      });
    } catch (e) {}
    return pane;
  }

  // ── snap guide: hidden copy of nearby features so Geoman can snap to them ────
  async function buildSnapGuide(village) {
    clearSnapGuide();
    if (!state.snap) return;
    var pane = ensurePane('gisEditSnap', 640);
    var bbox = bboxOfView(0);
    var layers = (await listLayers()).filter(function (l) {
      return !village || l.village === village;
    });
    var grp = L.geoJSON(null, {
      pane: pane,
      style: { opacity: 0, fillOpacity: 0, weight: 8 },     // invisible, but wide hit for snapping
      pointToLayer: function (f, latlng) {
        return L.circleMarker(latlng, { pane: pane, radius: 1, opacity: 0, fillOpacity: 0 });
      }
    });
    // Fetch every layer's snap features in parallel (was sequential await-in-loop,
    // which blocked the editor ~Nx200ms before snapping was ready).
    var fcs = await Promise.all(layers.map(function (l) {
      return GIS.features.getInBBox(l.id, bbox, SNAP_LIMIT).catch(function () { return null; });
    }));
    fcs.forEach(function (fc) { if (fc) grp.addData(fc); });
    grp.eachLayer(function (lyr) { lyr.options.snapIgnore = false; });
    state.snapGuide = grp.addTo(window.gMap);
  }
  function clearSnapGuide() {
    if (state.snapGuide) { try { window.gMap.removeLayer(state.snapGuide); } catch (e) {} state.snapGuide = null; }
  }

  // ── dialog framework (mirrors gis-meter-connect) ────────────────────────────
  function gadRow(label, inner) { return '<div class="gad-row"><label>' + label + '</label>' + inner + '</div>'; }
  function openDialog(title, bodyHTML, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var bg = document.createElement('div'); bg.className = 'gis-anly-bg';
      bg.innerHTML =
        '<div class="gis-anly-dlg"><div class="gad-head">' + title + '<button class="gad-x">✕</button></div>' +
        '<div class="gad-body">' + bodyHTML + '</div>' +
        '<div class="gad-foot"><button class="gad-ok">' + (opts.okLabel || 'אישור') + '</button>' +
        '<button class="gad-cancel">ביטול</button></div></div>';
      document.body.appendChild(bg);
      if (opts.onRender) opts.onRender(bg);
      function done(v) { bg.remove(); resolve(v); }
      bg.querySelector('.gad-x').onclick = function () { done(null); };
      bg.querySelector('.gad-cancel').onclick = function () { done(null); };
      bg.onclick = function (e) { if (e.target === bg) done(null); };
      bg.querySelector('.gad-ok').onclick = function () {
        var v = opts.collect ? opts.collect(bg) : {};
        if (v === false) return;            // collect may veto (validation)
        done(v);
      };
    });
  }

  // Categories = layers grouped by name ACROSS villages. Data stays per-village
  // (one layer per village·category); we only group the PICKER so you work by
  // category. A category = { label, geometry_type, layers:[{id,village}] }.
  async function listCategories() {
    var ls = await listLayers();
    var groups = {};
    ls.forEach(function (l) {
      var key = l.label + '||' + l.geometry_type;
      if (!groups[key]) groups[key] = { label: l.label, geometry_type: l.geometry_type, layers: [] };
      groups[key].layers.push({ id: l.id, village: l.village });
    });
    return Object.keys(groups).map(function (k) { return groups[k]; })
      .sort(function (a, b) { return String(a.label).localeCompare(String(b.label), 'he'); });
  }

  // Category picker → resolves a category group (all villages together) or null.
  async function pickCategory(title, geomFilter) {
    var cats;
    try { cats = await listCategories(); }
    catch (e) { toast('שגיאה בטעינת שכבות'); return null; }
    if (geomFilter) cats = cats.filter(function (c) { return geomFilter.indexOf(c.geometry_type) >= 0; });
    if (!cats.length) { toast('אין קטגוריות מתאימות במנוע'); return null; }
    var typeHe = { Point: 'נקודה', LineString: 'קו', Polygon: 'מצולע' };
    var opts = cats.map(function (c, i) {
      var nm = c.label + ' (' + (typeHe[c.geometry_type] || c.geometry_type) + ')' +
        (c.layers.length > 1 ? ' · ' + c.layers.length + ' כפרים' : '');
      return '<option value="' + i + '">' + esc(nm) + '</option>';
    }).join('');
    var res = await openDialog(title, gadRow('קטגוריה', '<select id="ge-cat" class="gad-in">' + opts + '</select>'), {
      okLabel: 'המשך',
      collect: function (bg) { return cats[+bg.querySelector('#ge-cat').value]; }
    });
    return res || null;
  }

  // representative [lng,lat] of a geometry (first coordinate) — used to route a
  // new feature to the geographically-correct village layer.
  function repPoint(geometry) {
    if (!geometry || !geometry.coordinates) return null;
    var c = geometry.coordinates;
    while (c && typeof c[0] !== 'number') c = c[0];
    return (c && typeof c[0] === 'number') ? c : null;
  }
  // extents (bbox + center) for every village layer in a category, keyed by id.
  async function groupCenters(group) {
    var out = {};
    await Promise.all(group.layers.map(async function (l) {
      try {
        var ext = await GIS.layers.extent([l.id]);   // [minLng,minLat,maxLng,maxLat]
        if (ext && ext.length === 4) {
          out[l.id] = { bbox: ext, center: [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2] };
        }
      } catch (e) {}
    }));
    return out;
  }
  // pick the village layer whose extent CONTAINS (else is nearest to) the point.
  function resolveLayerForPoint(pt, group, centers) {
    if (group.layers.length === 1 || !pt) return group.layers[0].id;
    var contain = [], all = [];
    group.layers.forEach(function (l) {
      var c = centers[l.id];
      if (!c) { all.push({ id: l.id, d: Infinity }); return; }
      var inside = pt[0] >= c.bbox[0] && pt[0] <= c.bbox[2] && pt[1] >= c.bbox[1] && pt[1] <= c.bbox[3];
      var d = distM(pt, c.center);
      all.push({ id: l.id, d: d });
      if (inside) contain.push({ id: l.id, d: d });
    });
    var pool = contain.length ? contain : all;
    pool.sort(function (a, b) { return a.d - b.d; });
    return pool.length ? pool[0].id : group.layers[0].id;
  }

  // ── banner + cursor + save bar ──────────────────────────────────────────────
  function banner(html) {
    var b = document.getElementById('gis-edit-banner');
    if (html === false) { if (b) b.style.display = 'none'; return; }
    if (!b) { b = document.createElement('div'); b.id = 'gis-edit-banner'; document.body.appendChild(b); }
    b.innerHTML = html; b.style.display = 'block';
  }
  function cursor(on) { if (window.gMap) window.gMap.getContainer().style.cursor = on ? 'crosshair' : ''; }

  function showSaveBar(onSave) {
    closeSaveBar();
    var bar = document.createElement('div'); bar.id = 'gis-edit-bar';
    bar.innerHTML =
      '<span class="geb-msg">גרור קודקודים לעריכת הגאומטריה</span>' +
      '<button class="geb-save">💾 שמור</button><button class="geb-cancel">ביטול</button>';
    document.body.appendChild(bar);
    bar.querySelector('.geb-save').onclick = onSave;
    bar.querySelector('.geb-cancel').onclick = function () { disarm(); };
  }
  function closeSaveBar() { var b = document.getElementById('gis-edit-bar'); if (b) b.remove(); }

  // ── 1) ADD ──────────────────────────────────────────────────────────────────
  async function startAdd() {
    if (!ready() || !(await requireEditor())) return;
    if (!(await confirmLeaveEditing())) return;
    if (emState.mode !== 'off') disarmEditMode();
    disarm();
    var group = await pickCategory('➕ הוסף ישות — בחר קטגוריה', ['Point', 'LineString', 'Polygon']);
    if (!group) return;
    var shape = DRAW_SHAPE[group.geometry_type];
    if (!shape) { toast('סוג גאומטריה לא נתמך'); return; }

    state.mode = 'add';
    ensureEditPanes();                         // draw-mode hint/vertex markers above the overlays too
    var centers = await groupCenters(group);   // route the new feature to its village
    await buildSnapGuide(null);                 // snap to whatever's in view (any village)

    banner('➕ <b>' + esc(group.label) + '</b> — ' +
      (shape === 'Marker' ? 'לחץ על המפה למיקום' : 'לחץ להוספת קודקודים, לחיצה כפולה לסיום') +
      ' · <span style="opacity:.8">Esc לביטול</span>');

    state.createHandler = function (e) { onCreate(e, group, centers); };
    window.gMap.on('pm:create', state.createHandler);
    try {
      window.gMap.pm.enableDraw(shape, { snappable: state.snap, snapDistance: SNAP_DISTANCE, finishOn: null });
    } catch (err) { toast('שגיאה בהפעלת הציור: ' + cleanErr(err), 'error'); disarm(); }
  }

  async function onCreate(e, group, centers) {
    // capture the drawn geometry, drop Geoman's temp layer, stop drawing.
    var gj = e.layer && e.layer.toGeoJSON ? e.layer.toGeoJSON() : null;
    try { window.gMap.removeLayer(e.layer); } catch (err) {}
    try { window.gMap.pm.disableDraw(); } catch (err) {}
    if (window.gMap && state.createHandler) { window.gMap.off('pm:create', state.createHandler); state.createHandler = null; }
    banner(false);
    if (!gj || !gj.geometry) { disarm(); return; }
    // route to the correct village's layer for this category (create it if missing).
    var layerId = await resolveAddLayer(repPoint(gj.geometry), group, centers);
    if (!layerId) { disarm(); return; }
    await openAttrForm({ id: layerId, label: group.label }, gj.geometry);
  }

  async function resolveAddLayer(pt, group, centers) {
    var village = (pt && window.GISEngineSidebar && GISEngineSidebar.villageAt)
      ? GISEngineSidebar.villageAt(pt[0], pt[1]) : null;
    if (village) {
      var hit = group.layers.filter(function (l) { return l.village === village; })[0];
      if (hit) return hit.id;
      var name = window.LayerNaming ? LayerNaming.compose(village, group.label) : village + ' · ' + group.label;
      try {
        var found = await GIS.layers.findByName(name);
        if (found) return found.id;
        toast('יוצר שכבה: ' + name + '…');
        var created = await GIS.layers.createLayer({ name: name, geometry_type: group.geometry_type });
        return created && created.id;
      } catch (err) {
        toast('לא ניתן ליצור שכבה חדשה — ' + cleanErr(err), 'error');
        return null;
      }
    }
    return resolveLayerForPoint(pt, group, centers);
  }

  // Attribute form built from the layer's field schema + a required asset_code.
  async function openAttrForm(layer, geometry) {
    var defs = [];
    try { defs = await GIS.fields.getFields(layer.id); } catch (e) {}
    var editable = defs.filter(function (d) { return !d.is_calculated; });

    var slug = (layer.label || 'asset').replace(/\s+/g, '-').slice(0, 18);
    var defCode = slug + '-' + Date.now().toString(36);

    var body = gadRow('asset_code <span class="geb-req">*</span>',
      '<input id="ge-code" class="gad-in" value="' + esc(defCode) + '" autocomplete="off">');
    editable.forEach(function (d) {
      body += fieldInput(d);
    });
    if (!editable.length) {
      body += '<div class="gad-note">לשכבה זו אין שדות מוגדרים — תיווסף ישות עם asset_code בלבד. ניתן להוסיף שדות בטבלת התכונות.</div>';
    }

    var res = await openDialog('📝 תכונות הישות החדשה — ' + esc(layer.label), body, {
      okLabel: 'צור ישות',
      collect: function (bg) {
        var code = (bg.querySelector('#ge-code').value || '').trim();
        if (!code) { toast('יש להזין asset_code'); return false; }
        var props = {};
        editable.forEach(function (d) {
          var el = bg.querySelector('[data-field="' + cssId(d.name) + '"]');
          if (!el) return;
          var v = readFieldValue(el, d);
          if (v !== undefined) props[d.name] = v;
        });
        return { code: code, props: props };
      }
    });
    if (!res) { disarm(); return; }

    toast('יוצר ישות…');
    try {
      var created = await GIS.features.createFeature(layer.id, geometry, res.props, res.code);
      toast('הישות נוצרה ✓');
      GISEditHistory.push({
        type: 'create', layerId: layer.id, id: created && created.id,
        geometry: geometry, properties: res.props, assetCode: res.code
      });
      refreshLayer(layer.id, true);
    } catch (e) {
      toast(cleanErr(e), 'error');
    }
    disarm();
  }

  function cssId(name) { return String(name).replace(/"/g, ''); }
  function fieldInput(d) {
    var name = d.name;
    var fkey = cssId(name);
    // domain field → dropdown of coded values (ArcGIS coded-value domain)
    if (window.GISDomains && GISDomains.has(name)) {
      var opts = GISDomains.options(name, '').map(function (o) {
        return '<option value="' + esc(o.code) + '">' + esc(o.label) + '</option>';
      }).join('');
      var lbl = GISDomains.fieldLabel(name);
      return gadRow(esc(lbl) + ' <span class="geb-fn">' + esc(name) + '</span>',
        '<select class="gad-in" data-field="' + esc(fkey) + '"><option value="">—</option>' + opts + '</select>');
    }
    if (d.type === 'bool') {
      return gadRow(esc(name),
        '<select class="gad-in" data-field="' + esc(fkey) + '"><option value="">—</option>' +
        '<option value="true">כן</option><option value="false">לא</option></select>');
    }
    var t = (d.type === 'int' || d.type === 'float') ? 'number' : 'text';
    var step = d.type === 'float' ? ' step="any"' : (d.type === 'int' ? ' step="1"' : '');
    return gadRow(esc(name) + ' <span class="geb-ty">' + esc(d.type) + '</span>',
      '<input class="gad-in" type="' + t + '"' + step + ' data-field="' + esc(fkey) + '">');
  }
  function readFieldValue(el, d) {
    var raw = el.value;
    if (raw === '' || raw == null) return undefined;     // omit empty fields
    if (window.GISDomains && GISDomains.has(d.name) && GISDomains.numeric(d.name)) return Number(raw);
    if (d.type === 'int') { var i = parseInt(raw, 10); return isNaN(i) ? undefined : i; }
    if (d.type === 'float') { var f = parseFloat(raw); return isNaN(f) ? undefined : f; }
    if (d.type === 'bool') return raw === 'true';
    return String(raw);
  }

  // ── 2) EDIT GEOMETRY (legacy one-shot category flow) ────────────────────────
  // Superseded for the common case by the sticky Edit Mode (section 2b,
  // below): startEditGeom() now enters Edit Mode directly whenever a layer is
  // active on the map. This legacy category-picker flow survives as the
  // fallback for when nothing is active yet, and unchanged for startDelete()
  // (which shares armPickGroup()/pickCategory() below).
  async function startEditGeomLegacy() {
    if (!ready() || !(await requireEditor())) return;
    disarm();
    var group = await pickCategory('✏️ עריכת גאומטריה — בחר קטגוריה', ['Point', 'LineString', 'Polygon']);
    if (!group) return;
    state.mode = 'editgeom';
    cursor(true);
    banner('✏️ <b>' + esc(group.label) + '</b> — לחץ על ישות לעריכה · <span style="opacity:.8">Esc לביטול</span>');
    armPickGroup(group, function (pick) { beginVertexEdit(pick); });
  }

  // Public entry point (ribbon "הוסף ישות" col button + startEditGeom callers):
  // if any layer is active on the map, go straight into sticky Edit Mode
  // (armed, pick-on-click across every active layer); otherwise fall back to
  // the legacy category picker above so editing still works with no layer on.
  async function startEditGeom() {
    if (!ready() || !(await requireEditor())) return;
    var actives = (window.GISEngineSidebar && GISEngineSidebar.activeLayers && GISEngineSidebar.activeLayers()) || [];
    if (actives.length) { await toggleEditMode(true); return; }
    await startEditGeomLegacy();
  }

  function beginVertexEdit(pick) {
    cursor(false); banner(false);
    var feature = pick.f;
    var pane = ensureEditPanes();
    state.targetLayerId = pick.layerId;
    state.editId = feature.id || (feature.properties && feature.properties.__id);
    if (!state.editId) { toast('לא נמצא מזהה לישות'); disarm(); return; }
    state.editBeforeGeometry = feature.geometry;   // captured for undo
    state.editLayer = L.geoJSON(feature, {
      pane: pane,
      style: { color: '#e11d48', weight: 4, opacity: 0.95 },
      pointToLayer: function (f, latlng) {
        return L.circleMarker(latlng, { pane: pane, radius: 7, color: '#e11d48', weight: 3, fillColor: '#fff', fillOpacity: 1 });
      }
    }).addTo(window.gMap);
    state.editLayer.eachLayer(function (lyr) {
      try { lyr.pm.enable({ allowSelfIntersection: false, snappable: state.snap, snapDistance: SNAP_DISTANCE }); } catch (e) {}
    });
    buildSnapGuide(null).catch(function () {});
    showSaveBar(saveGeom);
  }

  async function saveGeom() {
    if (!state.editLayer || !state.editId) { disarm(); return; }
    var gj = state.editLayer.toGeoJSON();
    var feat = gj && (gj.type === 'FeatureCollection' ? (gj.features || [])[0] : gj);
    var geometry = feat && feat.geometry;
    if (!geometry) { toast('אין גאומטריה לשמירה'); return; }
    var layerId = state.targetLayerId, id = state.editId, before = state.editBeforeGeometry;
    toast('שומר…');
    try {
      await GIS.features.updateGeometry(id, geometry);
      toast('הגאומטריה נשמרה ✓');
      if (before) GISEditHistory.push({ type: 'geometry', layerId: layerId, id: id, before: before, after: geometry });
      disarm();
      refreshLayer(layerId, false);
    } catch (e) {
      toast(cleanErr(e), 'error');
    }
  }

  // ── 3) DELETE ───────────────────────────────────────────────────────────────
  async function startDelete() {
    if (!ready() || !(await requireEditor())) return;
    if (!(await confirmLeaveEditing())) return;
    if (emState.mode !== 'off') disarmEditMode();
    disarm();
    var group = await pickCategory('🗑 מחיקת ישות — בחר קטגוריה', ['Point', 'LineString', 'Polygon']);
    if (!group) return;
    state.mode = 'delete';
    cursor(true);
    banner('🗑 <b>' + esc(group.label) + '</b> — לחץ על ישות למחיקה · <span style="opacity:.8">Esc לביטול</span>');
    armPickGroup(group, function (pick) { confirmDelete(group, pick); });
  }

  async function confirmDelete(group, pick) {
    cursor(false); banner(false);
    var feature = pick.f;
    var p = feature.properties || {};
    var id = feature.id || p.__id;
    var code = p.asset_code || id;
    var res = await openDialog('🗑 מחיקת ישות', '<div class="gad-note">למחוק לצמיתות את הישות <b>' + esc(code) +
      '</b> מהקטגוריה <b>' + esc(group.label) + '</b>? פעולה זו נרשמת ביומן הביקורת.</div>', {
      okLabel: 'מחק', collect: function () { return { ok: true }; }
    });
    if (!res) { disarm(); return; }
    toast('מוחק…');
    try {
      await GIS.features.deleteFeature(id);
      toast('הישות נמחקה ✓');
      GISEditHistory.push({
        type: 'delete', layerId: pick.layerId, id: id,
        geometry: feature.geometry, properties: cleanProps(p), assetCode: code
      });
      refreshLayer(pick.layerId, false);
      // a deleted pipe's meters are reset to NONE by a DB trigger — refresh the
      // connector overlay (if shown) so they flip to yellow right away.
      if (window.GISMeterConnect && GISMeterConnect.refreshIfShown) GISMeterConnect.refreshIfShown();
    } catch (e) { toast(cleanErr(e), 'error'); }
    disarm();
  }

  // ── shared one-shot feature pick ACROSS all village layers of a category ─────
  function armPickGroup(group, onPick) {
    state.clickHandler = async function (e) {
      var click = [e.latlng.lng, e.latlng.lat];
      var bbox = bboxAround(e.latlng, CLICK_FIND_M + 15);
      var best = null;
      for (var i = 0; i < group.layers.length; i++) {
        var lid = group.layers[i].id, fc;
        try { fc = await GIS.features.getInBBox(lid, bbox, 1000); }
        catch (err) { continue; }
        var b = nearestInFC(click, fc);
        if (b && (best === null || b.d < best.d)) best = { d: b.d, f: b.f, layerId: lid };
      }
      if (!best || best.d > CLICK_FIND_M) {
        toast('לא נמצאה ישות סמוכה — לחץ קרוב יותר');
        // re-arm so the user can try again without re-picking the category
        window.gMap.once('click', state.clickHandler);
        return;
      }
      onPick(best);
    };
    window.gMap.once('click', state.clickHandler);
  }

  // ── 4) SNAP toggle ──────────────────────────────────────────────────────────
  function toggleSnap(btn) {
    if (!ready()) return;
    state.snap = !state.snap;
    try { window.gMap.pm.setGlobalOptions({ snappable: state.snap, snapDistance: SNAP_DISTANCE }); } catch (e) {}
    if (btn) btn.classList.toggle('active', state.snap);
    if (!state.snap) clearSnapGuide();
    toast(state.snap ? 'הצמדה פעילה' : 'הצמדה כבויה');
  }

  // ── 2b) EDIT MODE (sticky) ───────────────────────────────────────────────────
  // A persistent, role-gated editing mode: toggle on → click any feature on
  // an active layer → move / drag vertices / extend / shorten → dirty flag +
  // Save (validated, concurrency-checked, classified errors) or Cancel
  // (confirms when dirty, restores nothing was ever mutated server-side).
  // Stays armed after a successful save so the next feature can be picked
  // right away. Geometry algorithms live in window.GISEditGeom
  // (js/gis-edit-geom.js) — resolved lazily via Geom() below so this file
  // still loads (and its unrelated exports still work) even when that script
  // hasn't loaded yet or a test loads gis-edit.js on its own.
  function Geom() { return window.GISEditGeom || null; }

  // Inline fallback caps — semantically identical to GISEditGeom.caps() —
  // used only if the geometry engine script hasn't loaded (mirrors the
  // parseLayerName()/LayerNaming load-order-safety pattern above).
  function inlineFamily(type) {
    if (type === 'Polygon' || type === 'MultiPolygon') return 'Polygon';
    if (type === 'LineString' || type === 'MultiLineString') return 'LineString';
    return 'Point';
  }
  function geomCaps(type) {
    var Geo = Geom();
    if (Geo) return Geo.caps(type);
    var fam = inlineFamily(type);
    if (fam === 'Point') return { move: true, vertices: false, addVertex: false, removeVertex: false, extend: false, shorten: false, minVertices: 1 };
    if (fam === 'Polygon') return { move: true, vertices: true, addVertex: true, removeVertex: true, extend: false, shorten: false, minVertices: 4 };
    return { move: true, vertices: true, addVertex: true, removeVertex: true, extend: true, shorten: true, minVertices: 2 };
  }
  // GeoJSON minVertices counts a CLOSED ring's repeated first/last point;
  // Leaflet's own latlngs for a Polygon do not repeat it (a 4-point GeoJSON
  // ring = 3 Leaflet latlngs). Lines have no such offset.
  function leafletMinVertices(type) {
    var fam = (Geom() && Geom().typeFamily(type)) || inlineFamily(type);
    if (fam === 'Polygon') return 3;
    if (fam === 'LineString') return 2;
    return 1;
  }
  // Best-effort vertex count from a Geoman pm:* event — used only to keep
  // removeVertexOn from taking a part below its minimum; never blocks a
  // removal it can't confidently count (defensive — Geoman's own
  // limitMarkersToCount is the primary guard).
  function leafletVertexCount(evt) {
    try {
      var lyr = evt && (evt.layer || evt.workingLayer);
      if (lyr && lyr.getLatLngs) {
        var ll = lyr.getLatLngs();
        var flat = Array.isArray(ll[0]) ? [].concat.apply([], ll) : ll;
        return flat.length;
      }
    } catch (e) {}
    return Infinity;
  }

  function isEditMode() { return emState.mode !== 'off'; }

  // off → armed (or already on → no-op true) / armed|editing|saving → off.
  // Pass no argument to toggle; pass a boolean to force a direction. Always
  // returns a Promise<boolean> of the resulting on/off state — the ribbon
  // button does `.then(on => …)`.
  async function toggleEditMode(on) {
    var currentlyOn = emState.mode !== 'off';
    var target = (typeof on === 'boolean') ? on : !currentlyOn;
    if (!target) {
      if (!currentlyOn) return false;
      if (!(await confirmLeaveEditing())) return true;   // user kept editing → still on
      disarmEditMode();
      return false;
    }
    if (currentlyOn) return true;
    if (!ready()) return false;
    if (!(await requireEditor())) return false;
    armEditModeCore();
    armPickActive();
    return true;
  }

  // Data-safety gate shared by every path that would tear down an active edit
  // session from OUTSIDE the HUD (ribbon toggle-off, ribbon "clear", add/delete
  // tools): resolves true when there is nothing to lose or the user explicitly
  // agreed to discard; false while a save is in flight or the user declined.
  async function confirmLeaveEditing() {
    if (emState.mode === 'saving') { toast('שומר… המתן לסיום השמירה'); return false; }
    if (emState.mode === 'editing' && emState.dirty) {
      return confirmDialog('ביטול עריכה', 'יש שינויים שלא נשמרו — לבטל אותם ולצאת ממצב העריכה?', 'בטל שינויים');
    }
    return true;
  }
  function activateRibbonButton(on) {
    var btn = document.querySelector && document.querySelector('.ags-cmd[data-edit-toggle]');
    if (btn) btn.classList.toggle('active', !!on);
  }
  function renderEditBanner() {
    var actives = (window.GISEngineSidebar && GISEngineSidebar.activeLayers && GISEngineSidebar.activeLayers()) || [];
    var pickLink = actives.length ? '' :
      ' · <a href="#" id="gis-edit-pickcat" style="color:#93c5fd;text-decoration:underline">בחר קטגוריה</a>';
    banner('✏️ מצב עריכה — לחץ על ישות לעריכה' + pickLink + ' · <span style="opacity:.8">Esc ליציאה</span>');
    var link = document.getElementById && document.getElementById('gis-edit-pickcat');
    if (link) link.onclick = function (e) { if (e && e.preventDefault) e.preventDefault(); disarmEditMode(); startEditGeomLegacy(); };
  }
  // Arms the mode's outline/cursor/banner WITHOUT arming the map-click pick
  // (beginEditFeature uses this when jumping straight to a known feature).
  function armEditModeCore() {
    disarm();   // clear any legacy add/editgeom/delete flow first (idempotent)
    if (window.gMap) { try { window.gMap.getContainer().classList.add('gis-edit-mode'); } catch (e) {} }
    cursor(true);
    renderEditBanner();
    emState.mode = 'armed';
    activateRibbonButton(true);
  }

  // One-shot map-click pick across every ACTIVE layer (unlike the legacy
  // armPickGroup(), which is scoped to one category's village layers) —
  // nearest feature by GISEditGeom.nearestPointOnGeometry (segment-aware for
  // every geometry family), falling back to the old vertex-only distance if
  // the geometry engine script hasn't loaded.
  function armPickActive() {
    if (!window.gMap || emState.pickArmed) return;   // never double-arm
    emState.pickArmed = true;
    window.gMap.once('click', pickHandler);
  }
  function disarmPick() {
    if (window.gMap) { try { window.gMap.off('click', pickHandler); } catch (e) {} }
    emState.pickArmed = false;
  }
  async function pickHandler(e) {
    emState.pickArmed = false;
    if (emState.mode !== 'armed') return;
    var latlng = e.latlng;
    var click = [latlng.lng, latlng.lat];
    // Fast path: the sidebar's LOCAL hit-test over the vector tiles already in
    // memory (js/gis-engine-sidebar.js hitTest) — instant, no DB round trip.
    // It yields a slim feature (id only), so the fresh geometry + concurrency
    // token come from one getEditToken() read. Falls through to the bbox
    // query below only when nothing is hit locally or that read fails.
    var local = null;
    try { local = (window.GISEngineSidebar && GISEngineSidebar.hitTest) ? GISEngineSidebar.hitTest(latlng) : null; } catch (err) { local = null; }
    if (local && local.f && local.layer) {
      var lid = local.f.properties && local.f.properties.__id != null ? local.f.properties.__id : local.f.id;
      var feat = local.f;
      if (!feat.geometry && window.GIS && GIS.features && GIS.features.getEditToken && lid != null) {
        cursor(false); try { window.gMap.getContainer().style.cursor = 'progress'; } catch (err) {}
        try {
          var tok = await GIS.features.getEditToken(lid);
          if (tok && tok.geometry) feat = { type: 'Feature', id: lid, geometry: tok.geometry, properties: Object.assign({}, feat.properties, { __edited_at: tok.edited_at }) };
        } catch (err) { /* fall through to the bbox path */ }
        cursor(true);
      }
      if (emState.mode !== 'armed') return;
      if (feat.geometry) { beginEditFeature(feat, local.layer.id).catch(function (err) { toast(cleanErr(err), 'error'); }); return; }
    }
    var bbox = bboxAround(latlng, CLICK_FIND_M + 15);
    var actives = (window.GISEngineSidebar && GISEngineSidebar.activeLayers && GISEngineSidebar.activeLayers()) || [];
    if (!actives.length) { toast('אין שכבות פעילות לעריכה — הפעל שכבה מהתוכן או בחר קטגוריה'); armPickActive(); return; }
    var Geo = Geom();
    var fcs = await Promise.all(actives.map(function (l) {
      return GIS.features.getInBBox(l.id, bbox, 1000).catch(function () { return null; });
    }));
    var best = null;
    fcs.forEach(function (fc, i) {
      if (!fc) return;
      (fc.features || []).forEach(function (f) {
        if (!f.geometry) return;
        var d = Geo ? Geo.nearestPointOnGeometry(f.geometry, click).distM : minVertexDist(click, f.geometry);
        if (best === null || d < best.d) best = { d: d, f: f, layerId: actives[i].id };
      });
    });
    if (emState.mode !== 'armed') return;   // mode was turned off while the fetch was in flight
    if (!best || best.d > CLICK_FIND_M) { toast('לא נמצאה ישות סמוכה — לחץ קרוב יותר'); armPickActive(); return; }
    beginEditFeature(best.f, best.layerId).catch(function (err) { toast(cleanErr(err), 'error'); });
  }

  // Enter editing for a specific feature — from a map-click pick OR directly
  // from the attribute panel's "✏️ ערוך גאומטריה" button (no click needed).
  // If something else is already being edited, confirms discard when dirty.
  async function beginEditFeature(feature, layerId) {
    if (!feature || !feature.geometry) { toast('אין גאומטריה לעריכה', 'error'); return false; }
    if (!ready() || !(await requireEditor())) return false;
    if (emState.mode === 'saving') { toast('שומר… המתן לסיום השמירה'); return false; }
    if (dialogOpen) return false;
    if (emState.mode === 'editing') {
      if (emState.dirty) {
        var ok = await confirmDialog('ביטול עריכה', 'יש שינויים שלא נשמרו בישות הנוכחית — לבטל אותם ולעבור לישות אחרת?', 'בטל ועבור');
        if (!ok) return false;
      }
      teardownEditingLayer();
    } else if (emState.mode === 'off') {
      armEditModeCore();
    } else {
      // 'armed': cancel the pending one-shot click pick — we already have a target
      disarmPick();
    }
    await enterEditing(feature, layerId);
    return true;
  }

  // Builds the live editable surface for one feature. MultiPoint gets a
  // FeatureGroup of plain draggable circle markers (no outer L.geoJSON
  // wrapper — Leaflet's own geometryToLayer() would nest it one level
  // deeper, and GISEditGeom.fromEditable()'s FeatureGroup branch expects the
  // markers directly). Every other type is built via a throwaway L.geoJSON()
  // just to reuse Leaflet's coordsToLatLngs/ring-nesting conversion, then
  // its single child layer (Leaflet always returns exactly one for a lone
  // Point/LineString/Polygon/Multi* feature) is pulled out and added to the
  // map on its own — this fixes the historical bug where saveGeom() read
  // toGeoJSON().features[0] of the OUTER wrapper and silently dropped every
  // point but the first for a MultiPoint feature.
  function buildEditLayer(feature, pane) {
    var style = { color: '#e11d48', weight: 4, opacity: 0.95 };
    function ptLayer(f, latlng) {
      return L.circleMarker(latlng, { pane: pane, radius: 7, color: '#e11d48', weight: 3, fillColor: '#fff', fillOpacity: 1 });
    }
    if (feature.geometry.type === 'MultiPoint') {
      var markers = (feature.geometry.coordinates || []).map(function (c) {
        return ptLayer(feature, L.latLng(c[1], c[0]));
      });
      emState.editLayer = L.featureGroup(markers).addTo(window.gMap);
      return;
    }
    var wrapper = L.geoJSON(feature, { pane: pane, style: style, pointToLayer: ptLayer });
    var kids = wrapper.getLayers ? wrapper.getLayers() : [];
    emState.editLayer = (kids[0] || wrapper).addTo(window.gMap);
  }
  function eachEditLayer(fn) {
    if (!emState.editLayer) return;
    if (typeof emState.editLayer.eachLayer === 'function') emState.editLayer.eachLayer(fn);
    else fn(emState.editLayer);
  }
  function currentGeometryFromEditLayer() {
    var Geo = Geom();
    return Geo ? Geo.fromEditable(emState.editLayer, emState.originalType) : null;
  }

  async function enterEditing(feature, layerId) {
    cursor(false);
    var pane = ensureEditPanes();
    var id = feature.id != null ? feature.id : (feature.properties && feature.properties.__id);
    if (id == null) { toast('לא נמצא מזהה לישות', 'error'); emState.mode = 'armed'; armPickActive(); return; }
    emState.layerId = layerId;
    emState.featureId = id;
    emState.originalType = feature.geometry.type;
    var Geo = Geom();
    emState.before = Geo ? Geo.deepClone(feature.geometry) : JSON.parse(JSON.stringify(feature.geometry));
    emState.dirty = false;
    // Concurrency token: getEditToken() when the engine has it (fresh read,
    // right before editing begins); fall back to a stale __edited_at off the
    // already-loaded feature; if neither is available the save runs WITHOUT
    // a check (never blocks an edit on a missing token).
    emState.editToken = null;
    try {
      if (window.GIS && GIS.features && GIS.features.getEditToken) {
        var tok = await GIS.features.getEditToken(id);
        emState.editToken = (tok && tok.edited_at != null) ? tok.edited_at : null;
        // Fresh server geometry wins over whatever the caller had cached
        // (tile props carry none; features_geojson is capped at 5000 rows).
        if (tok && tok.geometry && tok.geometry.type && tok.geometry.coordinates) {
          feature = Object.assign({}, feature, { geometry: tok.geometry });
          emState.originalType = feature.geometry.type;
          emState.before = Geo ? Geo.deepClone(feature.geometry) : JSON.parse(JSON.stringify(feature.geometry));
        }
      } else {
        emState.editToken = (feature.properties && feature.properties.__edited_at) || null;
      }
    } catch (e) {
      emState.editToken = (feature.properties && feature.properties.__edited_at) || null;
    }
    buildEditLayer(feature, pane);
    emState.mode = 'editing';
    var capsInfo = geomCaps(emState.originalType);
    applySubMode(capsInfo.vertices ? 'vertices' : 'move');
    buildSnapGuide(null).catch(function () {});
    showHUD();
  }

  // ── sub-modes ────────────────────────────────────────────────────────────
  function wireLayerEvent(target, evt, handler) {
    if (!target || !target.on) return;
    target.on(evt, handler);
    emState.layerHandlers.push([target, evt, handler]);
  }
  function onEditMutated() { setDirty(true); }
  function teardownSubModeHandlers() {
    emState.layerHandlers.forEach(function (h) { try { h[0].off(h[1], h[2]); } catch (e) {} });
    emState.layerHandlers = [];
    eachEditLayer(function (lyr) {
      try { if (lyr.pm && lyr.pm.disable) lyr.pm.disable(); } catch (e) {}
      try { if (lyr.pm && lyr.pm.disableLayerDrag) lyr.pm.disableLayerDrag(); } catch (e) {}
      try { if (lyr.setStyle && lyr.getLatLngs) lyr.setStyle({ weight: 4, opacity: 0.95 }); } catch (e) {}   // undo the move-mode stroke
    });
    disarmMultiPointMove();
    disarmExtendClick();
    disarmShortenClick();
  }
  function switchSub(sub) {
    if (emState.mode !== 'editing') return;
    var capsInfo = geomCaps(emState.originalType);
    var key = { vertices: 'vertices', move: 'move', extend: 'extend', shorten: 'shorten' }[sub];
    if (!key || !capsInfo[key]) { toast('פעולה לא זמינה לסוג גאומטריה זה'); return; }
    applySubMode(sub);
  }
  // Switching sub-modes never sets dirty by itself — only an actual mutation
  // (vertex drag/add/remove, layer drag, extend/shorten click) does.
  // Geoman edit options for the "vertices" sub-mode. draggable:false is
  // deliberate: Geoman defaults it to TRUE, which would let a body-drag move
  // the whole feature without any pm:dragend wiring (silent geometry change,
  // Save never enabled) — whole-feature moves belong to the explicit "move"
  // sub-mode only. NOTE: Geoman's limitMarkersToCount is a DISPLAY cap
  // ("show only n markers closest to the cursor"), not a min-vertex guard —
  // never pass it here; removeVertexValidation (plus Geoman's own built-in
  // polyline≥2 / polygon≥3 floor) is what keeps a part above its minimum.
  function vertexPmOptions() {
    var minLL = leafletMinVertices(emState.originalType);
    return {
      allowSelfIntersection: false, allowSelfIntersectionEdit: false,
      draggable: false,
      snappable: state.snap, snapDistance: SNAP_DISTANCE,
      addVertexOn: 'click', removeVertexOn: 'contextmenu',
      removeVertexValidation: function (evt) { return leafletVertexCount(evt) > minLL; }
    };
  }
  function applySubMode(sub) {
    teardownSubModeHandlers();
    emState.sub = sub;
    var capsInfo = geomCaps(emState.originalType);
    if (sub === 'vertices' && capsInfo.vertices) {
      eachEditLayer(function (lyr) {
        try { lyr.pm.enable(vertexPmOptions()); } catch (e) {}
        wireLayerEvent(lyr, 'pm:vertexadded', onEditMutated);
        wireLayerEvent(lyr, 'pm:vertexremoved', onEditMutated);
        wireLayerEvent(lyr, 'pm:markerdragend', onEditMutated);
        wireLayerEvent(lyr, 'pm:edit', onEditMutated);
        wireLayerEvent(lyr, 'pm:update', onEditMutated);
      });
    } else if (sub === 'move') {
      if (emState.originalType === 'MultiPoint') {
        armMultiPointMove();
      } else {
        eachEditLayer(function (lyr) {
          // Geoman's enableLayerDrag() is a silent no-op while the layer's
          // pm option `draggable` is false — and the "vertices" sub-mode
          // deliberately stores draggable:false on this very layer (see
          // vertexPmOptions()). Flip it back on for the move sub-mode first.
          try { if (lyr.pm && lyr.pm.setOptions) lyr.pm.setOptions({ draggable: true }); } catch (e) {}
          // a fatter stroke while moving — a 4px line is a hard drag target
          try { if (lyr.setStyle) lyr.setStyle({ weight: 10, opacity: 0.8 }); } catch (e) {}
          try { lyr.pm.enableLayerDrag(); } catch (e) {}
          wireLayerEvent(lyr, 'pm:dragend', onEditMutated);
        });
      }
    } else if (sub === 'extend' && capsInfo.extend) {
      armExtendClick();
    } else if (sub === 'shorten' && capsInfo.shorten) {
      armShortenClick();
    }
    refreshHUD();
  }

  // Whole-feature move: Geoman enableLayerDrag() handles Marker/Polyline/
  // Polygon (wired above); a MultiPoint FeatureGroup has no single layer to
  // drag, so translate every marker together via a manual map-level
  // mousedown/mousemove/mouseup drag (map panning disabled meanwhile).
  function armMultiPointMove() {
    if (!window.gMap) return;
    var dragStart = null;
    function onDown(e) {
      dragStart = e.latlng;
      try { window.gMap.dragging.disable(); } catch (err) {}
      window.gMap.on('mousemove', onMove);
      window.gMap.once('mouseup', onUp);
    }
    function onMove(e) {
      if (!dragStart) return;
      var dLng = e.latlng.lng - dragStart.lng, dLat = e.latlng.lat - dragStart.lat;
      eachEditLayer(function (lyr) {
        var ll = lyr.getLatLng(); lyr.setLatLng(L.latLng(ll.lat + dLat, ll.lng + dLng));
      });
      dragStart = e.latlng;
      setDirty(true);
    }
    function onUp() {
      try { window.gMap.off('mousemove', onMove); } catch (e) {}
      try { window.gMap.dragging.enable(); } catch (e) {}
      dragStart = null;
    }
    window.gMap.on('mousedown', onDown);
    emState.moveDrag = { onDown: onDown, onMove: onMove, onUp: onUp };
  }
  function disarmMultiPointMove() {
    if (!emState.moveDrag) return;
    if (window.gMap) {
      try { window.gMap.off('mousedown', emState.moveDrag.onDown); } catch (e) {}
      try { window.gMap.off('mousemove', emState.moveDrag.onMove); } catch (e) {}
      try { window.gMap.dragging.enable(); } catch (e) {}
    }
    emState.moveDrag = null;
  }

  // Extend/shorten a LineString-family geometry at whichever end is nearest
  // the click. Persistent `.on('click', …)` (not `.once`) so it stays armed
  // until the sub-mode changes — teardownSubModeHandlers() removes it.
  function rebuildEditLayerLatLngs(geom) {
    var levelsDeep = (geom.type === 'MultiLineString' || geom.type === 'MultiPolygon') ? 1 : 0;
    eachEditLayer(function (lyr) {
      if (!lyr.setLatLngs) return;
      try { lyr.setLatLngs(L.GeoJSON.coordsToLatLngs(geom.coordinates, levelsDeep)); } catch (e) {}
      try { if (lyr.pm && lyr.pm.enable) lyr.pm.enable(vertexPmOptions()); } catch (e) {}
    });
  }
  function armExtendClick() {
    function handler(e) {
      if (emState.mode !== 'editing' || emState.sub !== 'extend') return;
      var Geo = Geom();
      if (!Geo) { toast('מנוע הגאומטריה לא נטען', 'error'); return; }
      var current = currentGeometryFromEditLayer();
      if (!current) return;
      var next = Geo.appendVertexAtNearestEnd(current, [e.latlng.lng, e.latlng.lat]);
      if (!next) { toast('לא ניתן להאריך גאומטריה זו', 'error'); return; }
      rebuildEditLayerLatLngs(next);
      setDirty(true);
    }
    emState._extendHandler = handler;
    if (window.gMap) window.gMap.on('click', handler);
  }
  function disarmExtendClick() {
    if (emState._extendHandler && window.gMap) { try { window.gMap.off('click', emState._extendHandler); } catch (e) {} }
    emState._extendHandler = null;
  }
  function armShortenClick() {
    function handler(e) {
      if (emState.mode !== 'editing' || emState.sub !== 'shorten') return;
      var Geo = Geom();
      if (!Geo) { toast('מנוע הגאומטריה לא נטען', 'error'); return; }
      var current = currentGeometryFromEditLayer();
      if (!current) return;
      var capsInfo = geomCaps(emState.originalType);
      var r = Geo.removeVertexAtNearestEnd(current, [e.latlng.lng, e.latlng.lat], capsInfo.minVertices);
      if (!r.ok) { toast(r.reason || 'לא ניתן לקצר', 'error'); return; }
      rebuildEditLayerLatLngs(r.geometry);
      setDirty(true);
    }
    emState._shortenHandler = handler;
    if (window.gMap) window.gMap.on('click', handler);
  }
  function disarmShortenClick() {
    if (emState._shortenHandler && window.gMap) { try { window.gMap.off('click', emState._shortenHandler); } catch (e) {} }
    emState._shortenHandler = null;
  }

  // ── dirty tracking + beforeunload guard ─────────────────────────────────────
  function setDirty(on) {
    emState.dirty = !!on;
    refreshHUD();
    if (emState.dirty) installBeforeUnload(); else removeBeforeUnload();
  }
  function installBeforeUnload() {
    if (emState.beforeUnloadHandler || typeof window.addEventListener !== 'function') return;
    emState.beforeUnloadHandler = function (e) { e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', emState.beforeUnloadHandler);
  }
  function removeBeforeUnload() {
    if (!emState.beforeUnloadHandler) return;
    try { if (typeof window.removeEventListener === 'function') window.removeEventListener('beforeunload', emState.beforeUnloadHandler); } catch (e) {}
    emState.beforeUnloadHandler = null;
  }

  // ── HUD (#gis-edit-hud) — sub-mode buttons, dirty indicator, save/cancel ────
  // Built via direct element refs kept in `hud` (never re-queried by
  // id/selector) so it degrades cleanly with a minimal document stub too.
  var hud = null;
  var HUD_SUBS = [['vertices', 'קודקודים'], ['move', 'הזז'], ['extend', 'הארך'], ['shorten', 'קצר']];
  function showHUD() {
    closeHUD();
    var capsInfo = geomCaps(emState.originalType);
    var root = document.createElement('div'); root.id = 'gis-edit-hud';
    var subsWrap = document.createElement('div'); subsWrap.className = 'geh-subs';
    var subBtns = {};
    HUD_SUBS.forEach(function (pair) {
      var key = pair[0], label = pair[1];
      if (!capsInfo[key]) return;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'geh-sub'; b.textContent = label;
      b.onclick = function () { switchSub(key); };
      subBtns[key] = b;
      subsWrap.appendChild(b);
    });
    var dirtyEl = document.createElement('span'); dirtyEl.className = 'geh-dirty'; dirtyEl.textContent = '● לא נשמר';
    var saveBtn = document.createElement('button'); saveBtn.type = 'button'; saveBtn.className = 'geh-save'; saveBtn.textContent = '💾 שמור'; saveBtn.disabled = true;
    saveBtn.onclick = function () { saveEM().catch(function (e) { toast(cleanErr(e), 'error'); }); };
    var cancelBtn = document.createElement('button'); cancelBtn.type = 'button'; cancelBtn.className = 'geh-cancel'; cancelBtn.textContent = 'ביטול';
    cancelBtn.onclick = function () { cancelEM().catch(function () {}); };
    root.appendChild(subsWrap); root.appendChild(dirtyEl); root.appendChild(saveBtn); root.appendChild(cancelBtn);
    document.body.appendChild(root);
    hud = { root: root, saveBtn: saveBtn, cancelBtn: cancelBtn, dirtyEl: dirtyEl, subBtns: subBtns };
    refreshHUD();
  }
  function refreshHUD() {
    if (!hud) return;
    Object.keys(hud.subBtns).forEach(function (k) { hud.subBtns[k].classList.toggle('active', k === emState.sub); });
    hud.dirtyEl.style.display = emState.dirty ? '' : 'none';
    hud.saveBtn.disabled = !emState.dirty || emState.mode === 'saving';
    hud.cancelBtn.disabled = emState.mode === 'saving';
    hud.saveBtn.textContent = emState.mode === 'saving' ? 'שומר…' : '💾 שמור';
  }
  function closeHUD() { if (hud) { try { hud.root.remove(); } catch (e) {} hud = null; } }

  // ── confirmation / choice dialogs (reuse .gis-anly-bg/.gad-* styling) ───────
  // Built via explicit createElement + closures (never innerHTML+querySelector
  // for THIS file's own new dialogs) so Edit Mode stays testable against a
  // minimal document stub; visually identical to the existing openDialog().
  var dialogOpen = false;   // one Edit-Mode dialog at a time (Escape/Cancel re-entrancy guard)
  function openChoiceDialog(title, bodyHTML, choices) {
    if (dialogOpen) return Promise.resolve(null);
    dialogOpen = true;
    return new Promise(function (resolve) {
      var bg = document.createElement('div'); bg.className = 'gis-anly-bg';
      var dlg = document.createElement('div'); dlg.className = 'gis-anly-dlg';
      var head = document.createElement('div'); head.className = 'gad-head'; head.innerHTML = title;
      var xBtn = document.createElement('button'); xBtn.type = 'button'; xBtn.className = 'gad-x'; xBtn.textContent = '✕';
      head.appendChild(xBtn);
      var body = document.createElement('div'); body.className = 'gad-body'; body.innerHTML = bodyHTML;
      var foot = document.createElement('div'); foot.className = 'gad-foot';
      function done(v) { dialogOpen = false; try { bg.remove(); } catch (e) {} resolve(v); }
      xBtn.onclick = function () { done(null); };
      bg.onclick = function (e) { if (e && e.target === bg) done(null); };
      (choices || []).forEach(function (c) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'gad-ok'; b.textContent = c.label;
        b.onclick = function () { done(c.value); };
        foot.appendChild(b);
      });
      dlg.appendChild(head); dlg.appendChild(body); dlg.appendChild(foot);
      bg.appendChild(dlg);
      document.body.appendChild(bg);
    });
  }
  function confirmDialog(title, bodyText, okLabel) {
    return openChoiceDialog(title, '<div class="gad-note">' + bodyText + '</div>', [
      { label: okLabel || 'אישור', value: true },
      { label: 'ביטול', value: false }
    ]).then(function (v) { return v === true; });
  }

  // ── teardown helpers ─────────────────────────────────────────────────────
  function teardownEditingLayer() {
    teardownSubModeHandlers();
    if (emState.editLayer) {
      try { window.gMap.removeLayer(emState.editLayer); } catch (e) {}
      emState.editLayer = null;
    }
    closeHUD();
    removeBeforeUnload();
    clearSnapGuide();
    emState.dirty = false; emState.sub = null; emState.originalType = null; emState.editToken = null;
    emState.featureId = null; emState.before = null; emState.layerId = null;
  }
  function teardownEditingKeepArmed() {
    teardownEditingLayer();
    emState.mode = 'armed';
    cursor(true);
    renderEditBanner();
    armPickActive();
  }
  function finishEditingBackToArmed() { teardownEditingKeepArmed(); }

  function disarmEditMode() {
    teardownSubModeHandlers();
    if (emState.editLayer) {
      try { window.gMap.removeLayer(emState.editLayer); } catch (e) {}
      emState.editLayer = null;
    }
    disarmPick();
    closeHUD();
    removeBeforeUnload();
    clearSnapGuide();
    banner(false);
    cursor(false);
    if (window.gMap) { try { window.gMap.getContainer().classList.remove('gis-edit-mode'); } catch (e) {} }
    activateRibbonButton(false);
    emState.mode = 'off'; emState.dirty = false; emState.sub = null; emState.originalType = null;
    emState.editToken = null; emState.featureId = null; emState.layerId = null; emState.before = null;
  }

  // ── Save / Cancel / Escape ───────────────────────────────────────────────
  async function saveEM() {
    if (emState.mode !== 'editing' || !emState.dirty) return;
    var Geo = Geom();
    var geometry = currentGeometryFromEditLayer();
    if (!geometry) { toast('אין גאומטריה לשמירה', 'error'); return; }
    if (Geo) {
      var vr = Geo.validate(geometry);
      if (!vr.ok) { toast(vr.reason || 'גאומטריה לא תקינה', 'error'); return; }
    }
    // Snapshot everything the post-await code needs: a ribbon "clear" (hard
    // disarm) can land while the RPC is in flight, and then emState no longer
    // describes THIS save. seq lets the late continuation notice and stand down.
    var seq = ++emState.saveSeq;
    var fid = emState.featureId, lid = emState.layerId, before = emState.before, token = emState.editToken;
    emState.mode = 'saving';
    refreshHUD();
    var err = null;
    try {
      await GIS.features.updateGeometry(fid, geometry, { expectedEditedAt: token });
    } catch (e) { err = e; }
    var stale = (emState.saveSeq !== seq) || (emState.mode !== 'saving');
    if (!err) {
      GISEditHistory.push({ type: 'geometry', layerId: lid, id: fid, before: before, after: geometry });
      toast('הגאומטריה נשמרה ✓');
      refreshLayer(lid, false);
      if (!stale) finishEditingBackToArmed();
      return;
    }
    if (stale) { toast(cleanErr(err), 'error'); return; }
    await handleSaveError(err, geometry);
  }

  async function handleSaveError(e, geometry) {
    var cls = (window.GIS && GIS.classifyError) ? GIS.classifyError(e) : 'unknown';
    if (cls === 'conflict') {
      emState.mode = 'editing'; refreshHUD();
      var choice = await openChoiceDialog('⚠️ הישות עודכנה על ידי משתמש אחר',
        '<div class="gad-note">הישות עודכנה על ידי משתמש אחר בזמן שערכת אותה. ניתן לטעון את הגרסה העדכנית ' +
        'ולערוך שוב, או לדרוס אותה בגרסה שלך.</div>',
        [{ label: 'טען מחדש וערוך שוב', value: 'reload' }, { label: 'דרוס בכל זאת', value: 'overwrite' }]);
      if (choice === 'reload') {
        var fresh = null;
        try { fresh = GIS.features.getFeatureById ? await GIS.features.getFeatureById(emState.featureId) : null; } catch (e2) {}
        var lid = emState.layerId;
        teardownEditingKeepArmed();
        if (fresh) await beginEditFeature(fresh, lid);
        else toast('לא ניתן לטעון את הישות מחדש', 'error');
      } else if (choice === 'overwrite') {
        var sure = await confirmDialog('דריסת שינוי', 'לדרוס את הגאומטריה שנשמרה על ידי המשתמש האחר בגרסה שלך?', 'דרוס בכל זאת');
        if (sure) {
          try {
            await GIS.features.updateGeometry(emState.featureId, geometry, {});
            GISEditHistory.push({ type: 'geometry', layerId: emState.layerId, id: emState.featureId, before: emState.before, after: geometry });
            toast('הגאומטריה נשמרה ✓ (נדרסה)');
            refreshLayer(emState.layerId, false);
            finishEditingBackToArmed();
          } catch (e3) {
            toast(cleanErr(e3), 'error');
            emState.mode = 'editing'; refreshHUD();
          }
        } else { emState.mode = 'editing'; refreshHUD(); }
      } else {
        emState.mode = 'editing'; refreshHUD();
      }
      return;
    }
    if (cls === 'forbidden') { toast('אין הרשאת עריכה', 'error'); disarmEditMode(); return; }
    if (cls === 'not_found') { toast('הישות נמחקה בינתיים', 'error'); teardownEditingKeepArmed(); return; }
    if (cls === 'network') { toast('אין חיבור — נסה שוב', 'error'); emState.mode = 'editing'; refreshHUD(); return; }
    toast(cleanErr(e), 'error');
    emState.mode = 'editing'; refreshHUD();
  }

  async function cancelEM() {
    if (emState.mode === 'saving') { toast('שומר… המתן לסיום השמירה'); return; }
    if (emState.mode !== 'editing' || dialogOpen) return;
    if (emState.dirty) {
      var ok = await confirmDialog('ביטול עריכה', 'יש שינויים שלא נשמרו — לבטל אותם?', 'בטל שינויים');
      if (!ok) return;
    }
    teardownEditingKeepArmed();
  }

  // Routed from the shared Escape keydown listener (bottom of file). Returns
  // true if it handled the key (so the legacy listener doesn't also fire).
  function escapeEditMode() {
    if (emState.mode === 'saving') return true;          // swallow: a save is in flight
    if (emState.mode === 'editing') { cancelEM().catch(function () {}); return true; }
    if (emState.mode === 'armed') { disarmEditMode(); return true; }   // nothing to lose → immediate
    return false;
  }

  // ── 5) UNDO / REDO history ──────────────────────────────────────────────────
  // Bounded (50) stack of inverse operations over GIS.features:
  //   create           → inverse = delete(id)
  //   delete           → inverse = re-create (full geometry+properties captured
  //                       BEFORE the delete; the row gets a NEW id — the entry's
  //                       id is remapped so a later redo/undo targets it)
  //   geometry edit    → inverse = restore the pre-edit geometry
  // Exposed as window.GISEditHistory so it's independently unit-testable
  // (test/gis/undo-stack.test.js) against a mocked GIS.features.
  var HISTORY_MAX = 50;
  var undoStack = [];
  var redoStack = [];
  var historyBusy = false;
  var historyBtns = { undo: null, redo: null, bar: null };

  function updateHistoryButtons() {
    if (historyBtns.undo) historyBtns.undo.disabled = !undoStack.length;
    if (historyBtns.redo) historyBtns.redo.disabled = !redoStack.length;
    // The bar stays hidden until the first edit lands — viewers (read-only)
    // never see it, and editors don't get dead buttons over the map.
    if (historyBtns.bar) historyBtns.bar.style.display = (undoStack.length || redoStack.length) ? 'flex' : 'none';
  }

  function pushHistory(entry) {
    undoStack.push(entry);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;   // a fresh action invalidates the redo chain
    updateHistoryButtons();
  }

  // Applies the INVERSE of `entry` when dir==='undo', or REPLAYS it when
  // dir==='redo'. Mutates entry.id in place whenever a delete↔recreate round
  // trip changes the row's id, so the SAME entry object stays valid across a
  // whole undo→redo→undo… chain.
  async function applyHistoryEntry(entry, dir) {
    var undoing = dir === 'undo';
    if (entry.type === 'create') {
      if (undoing) {
        await GIS.features.deleteFeature(entry.id);
      } else {
        var created = await GIS.features.createFeature(entry.layerId, entry.geometry, entry.properties, entry.assetCode);
        entry.id = created && created.id;
      }
    } else if (entry.type === 'delete') {
      if (undoing) {
        var recreated = await GIS.features.createFeature(entry.layerId, entry.geometry, entry.properties, entry.assetCode);
        entry.id = recreated && recreated.id;
      } else {
        await GIS.features.deleteFeature(entry.id);
      }
    } else if (entry.type === 'geometry') {
      await GIS.features.updateGeometry(entry.id, undoing ? entry.before : entry.after);
    }
    // A feature just came back into existence — nudge the user if its layer is off.
    var added = (entry.type === 'create' && !undoing) || (entry.type === 'delete' && undoing);
    refreshLayer(entry.layerId, added);
  }

  async function undoHistory() {
    if (historyBusy || !undoStack.length) return false;
    historyBusy = true;
    var entry = undoStack.pop();
    try {
      await applyHistoryEntry(entry, 'undo');
      redoStack.push(entry);
      if (redoStack.length > HISTORY_MAX) redoStack.shift();
      toast('הפעולה בוטלה ↶');
      return true;
    } catch (e) {
      undoStack.push(entry);   // inverse failed — restore, stacks unchanged
      toast(cleanErr(e), 'error');
      return false;
    } finally {
      historyBusy = false;
      updateHistoryButtons();
    }
  }

  async function redoHistory() {
    if (historyBusy || !redoStack.length) return false;
    historyBusy = true;
    var entry = redoStack.pop();
    try {
      await applyHistoryEntry(entry, 'redo');
      undoStack.push(entry);
      if (undoStack.length > HISTORY_MAX) undoStack.shift();
      toast('הפעולה בוצעה שוב ↷');
      return true;
    } catch (e) {
      redoStack.push(entry);   // replay failed — restore, stacks unchanged
      toast(cleanErr(e), 'error');
      return false;
    } finally {
      historyBusy = false;
      updateHistoryButtons();
    }
  }

  // Keyboard-shortcut focus guard: Ctrl/Cmd+Z / Ctrl+Y (or +Shift+Z) are
  // ignored while the user is typing anywhere (input/textarea/select/contenteditable).
  function isEditableTarget(t) {
    if (!t) return false;
    var tag = (t.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return !!t.isContentEditable;
  }
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || isEditableTarget(e.target)) return;
    var key = (e.key || '').toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undoHistory(); }
    else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redoHistory(); }
  });

  // Small floating undo/redo toolbar (Hebrew tooltips). Always present once this
  // script loads; both buttons stay disabled until there's something to act on.
  function ensureHistoryBar() {
    if (document.getElementById('gis-edit-history-bar')) return;
    var bar = document.createElement('div'); bar.id = 'gis-edit-history-bar';
    var undoBtn = document.createElement('button');
    undoBtn.type = 'button'; undoBtn.className = 'geh-btn'; undoBtn.title = 'בטל';
    undoBtn.setAttribute('aria-label', 'בטל'); undoBtn.textContent = '↶'; undoBtn.disabled = true;
    undoBtn.onclick = function () { undoHistory(); };
    var redoBtn = document.createElement('button');
    redoBtn.type = 'button'; redoBtn.className = 'geh-btn'; redoBtn.title = 'בצע שוב';
    redoBtn.setAttribute('aria-label', 'בצע שוב'); redoBtn.textContent = '↷'; redoBtn.disabled = true;
    redoBtn.onclick = function () { redoHistory(); };
    bar.appendChild(undoBtn); bar.appendChild(redoBtn);
    bar.style.display = 'none';   // shown by updateHistoryButtons() on first edit
    document.body.appendChild(bar);
    historyBtns.undo = undoBtn; historyBtns.redo = redoBtn; historyBtns.bar = bar;
  }
  ensureHistoryBar();

  window.GISEditHistory = {
    push: pushHistory,
    undo: undoHistory,
    redo: redoHistory,
    canUndo: function () { return undoStack.length > 0; },
    canRedo: function () { return redoStack.length > 0; },
    clear: function () { undoStack.length = 0; redoStack.length = 0; updateHistoryButtons(); },
    size: function () { return { undo: undoStack.length, redo: redoStack.length }; },
    peekUndo: function () { return undoStack.slice(); },
    peekRedo: function () { return redoStack.slice(); },
    isEditableTarget: isEditableTarget,
    max: HISTORY_MAX
  };

  // ── refresh the rendered layer after a write ────────────────────────────────
  function refreshLayer(layerId, added) {
    if (window.GISEngineSidebar) {
      try { if (GISEngineSidebar.reload) GISEngineSidebar.reload(layerId); } catch (e) {}
      try { if (GISEngineSidebar.refresh) GISEngineSidebar.refresh(); } catch (e) {}
    }
    if (added) {
      var actives = (window.GISEngineSidebar && GISEngineSidebar.activeLayers && GISEngineSidebar.activeLayers()) || [];
      var visible = actives.some(function (a) { return a && (a.id === layerId || a === layerId); });
      if (!visible) toast('הישות נוספה — הפעל את השכבה לתצוגה');
    }
  }

  // ── disarm / clear everything ───────────────────────────────────────────────
  function disarm() {
    try { window.gMap && window.gMap.pm && window.gMap.pm.disableDraw(); } catch (e) {}
    if (window.gMap && state.createHandler) { try { window.gMap.off('pm:create', state.createHandler); } catch (e) {} }
    if (window.gMap && state.clickHandler) { try { window.gMap.off('click', state.clickHandler); } catch (e) {} }
    state.createHandler = null; state.clickHandler = null;
    if (state.editLayer) {
      try { state.editLayer.eachLayer(function (l) { if (l.pm) l.pm.disable(); }); } catch (e) {}
      try { window.gMap.removeLayer(state.editLayer); } catch (e) {}
      state.editLayer = null;
    }
    state.editId = null;
    state.editBeforeGeometry = null;
    clearSnapGuide();
    closeSaveBar();
    banner(false);
    cursor(false);
    state.mode = null; state.targetLayerId = null;
    // Ribbon "clear"/traceClearAll calls GISEdit.disarm()/.clear() expecting a
    // hard reset of EVERYTHING this module owns — tear down the sticky Edit
    // Mode too when it's on (armEditModeCore() also calls disarm() on entry,
    // but emState.mode is still 'off' at that point so this never recurses).
    // Data safety: unsaved edits are never dropped silently — a dirty session
    // asks first (async) and a save in flight is left alone.
    if (emState.mode === 'off') return;
    if (emState.mode === 'saving') { toast('שומר… המתן לסיום השמירה'); return; }
    if (emState.mode === 'armed' || !emState.dirty) { disarmEditMode(); return; }   // nothing to lose → sync
    confirmLeaveEditing().then(function (ok) { if (ok) disarmEditMode(); }).catch(function () {});
  }

  // Esc cancels the sticky Edit Mode (editing→confirm-if-dirty, armed→off)
  // or, failing that, any legacy armed pick-flow (add/editgeom/delete).
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (escapeEditMode()) return;
    if (state.mode) disarm();
  });

  // ── styles (banner + save bar; dialogs reuse arcgis-pro.css) ─────────────────
  (function injectCSS() {
    if (document.getElementById('gis-edit-style')) return;
    var s = document.createElement('style'); s.id = 'gis-edit-style';
    s.textContent =
      '#gis-edit-banner{position:absolute;top:64px;left:50%;transform:translateX(-50%);z-index:1300;background:#0f172a;' +
      'color:#fff;padding:8px 16px;border-radius:20px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.25);direction:rtl;max-width:90vw}' +
      '#gis-edit-bar{position:absolute;bottom:96px;left:50%;transform:translateX(-50%);z-index:1300;background:#fff;' +
      'border:1px solid #d6dbe2;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.18);padding:8px 12px;display:flex;' +
      'gap:8px;align-items:center;direction:rtl;font-family:inherit}' +
      '#gis-edit-bar .geb-msg{font-size:12.5px;color:#334155;margin-left:4px}' +
      '#gis-edit-bar button{border:1px solid #cbd5e1;border-radius:7px;padding:6px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}' +
      '#gis-edit-bar .geb-save{background:#16a34a;color:#fff;border-color:#16a34a}' +
      '#gis-edit-bar .geb-cancel{background:#fff;color:#334155}' +
      '.geb-req{color:#dc2626}.geb-ty,.geb-fn{font-size:10px;color:#94a3b8;font-weight:400}' +
      '#gis-edit-history-bar{position:absolute;top:64px;inset-inline-end:14px;z-index:1250;display:flex;gap:4px;' +
      'background:#fff;border:1px solid #d6dbe2;border-radius:9px;box-shadow:0 3px 10px rgba(0,0,0,.15);padding:4px}' +
      '#gis-edit-history-bar .geh-btn{border:1px solid #cbd5e1;background:#fff;border-radius:6px;width:30px;height:28px;' +
      'font-size:15px;line-height:1;cursor:pointer;color:#334155;font-family:inherit}' +
      '#gis-edit-history-bar .geh-btn:hover:not(:disabled){background:#f1f5f9;color:#0d3b5e}' +
      '#gis-edit-history-bar .geh-btn:disabled{opacity:.35;cursor:default}' +
      // Sticky Edit Mode: red map outline while armed/editing, HUD (replaces
      // the old #gis-edit-bar for this flow), sub-mode buttons, dirty pill.
      '.leaflet-container.gis-edit-mode{outline:3px solid #e11d48;outline-offset:-3px}' +
      '#gis-edit-hud{position:absolute;bottom:96px;left:50%;transform:translateX(-50%);z-index:1300;background:#fff;' +
      'border:1px solid #d6dbe2;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.18);padding:8px 12px;display:flex;' +
      'gap:6px;align-items:center;direction:rtl;font-family:inherit;flex-wrap:wrap;max-width:92vw}' +
      '#gis-edit-hud .geh-subs{display:flex;gap:4px;flex-wrap:wrap}' +
      '#gis-edit-hud .geh-sub{border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:6px 10px;' +
      'font-size:12.5px;cursor:pointer;font-family:inherit;color:#334155}' +
      '#gis-edit-hud .geh-sub.active{background:#0d3b5e;color:#fff;border-color:#0d3b5e}' +
      '#gis-edit-hud .geh-dirty{font-size:12px;color:#b45309;font-weight:600;white-space:nowrap}' +
      '#gis-edit-hud .geh-save{background:#16a34a;color:#fff;border:1px solid #16a34a;border-radius:7px;' +
      'padding:6px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}' +
      '#gis-edit-hud .geh-save:disabled{opacity:.5;cursor:not-allowed;background:#94a3b8;border-color:#94a3b8}' +
      '#gis-edit-hud .geh-cancel{border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:6px 12px;' +
      'font-size:12.5px;cursor:pointer;font-family:inherit;color:#334155}';
    document.head.appendChild(s);
  })();

  window.GISEdit = {
    startAdd: startAdd,
    startEditGeom: startEditGeom,
    startDelete: startDelete,
    toggleSnap: toggleSnap,
    disarm: disarm,
    clear: disarm,
    // Sticky Edit Mode (section 2b): explicit on/off toggle, direct entry
    // for a known feature (attribute panel's "✏️ ערוך גאומטריה" button).
    toggleEditMode: toggleEditMode,
    isEditMode: isEditMode,
    beginEditFeature: beginEditFeature,
    // Exposed so the layer-name parsing (LayerNaming-backed, with an inline
    // load-order-safety fallback) is independently unit-testable.
    _parseLayerName: parseLayerName,
    // Exposed so the row-preferring lookup (LayerNaming.fromRow-backed, with
    // a name-parse fallback) is independently unit-testable (W5.2).
    _rowVC: rowVC,
    // Test-only hooks for test/gis/edit-mode.test.js — mirrors the
    // _parseLayerName/_rowVC precedent above; no runtime caller of its own.
    _test: {
      state: function () { return emState; },
      setDirty: setDirty,
      save: saveEM,
      cancel: cancelEM,
      onEscape: escapeEditMode,
      armPickActive: armPickActive,
      hud: function () { return hud; }
    }
  };
})();
