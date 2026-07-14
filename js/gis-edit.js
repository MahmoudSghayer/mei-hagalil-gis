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
      var parsed = parseLayerName(l.name);
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
    disarm();
    var group = await pickCategory('➕ הוסף ישות — בחר קטגוריה', ['Point', 'LineString', 'Polygon']);
    if (!group) return;
    var shape = DRAW_SHAPE[group.geometry_type];
    if (!shape) { toast('סוג גאומטריה לא נתמך'); return; }

    state.mode = 'add';
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

  // ── 2) EDIT GEOMETRY ────────────────────────────────────────────────────────
  async function startEditGeom() {
    if (!ready() || !(await requireEditor())) return;
    disarm();
    var group = await pickCategory('✏️ עריכת גאומטריה — בחר קטגוריה', ['Point', 'LineString', 'Polygon']);
    if (!group) return;
    state.mode = 'editgeom';
    cursor(true);
    banner('✏️ <b>' + esc(group.label) + '</b> — לחץ על ישות לעריכה · <span style="opacity:.8">Esc לביטול</span>');
    armPickGroup(group, function (pick) { beginVertexEdit(pick); });
  }

  function beginVertexEdit(pick) {
    cursor(false); banner(false);
    var feature = pick.f;
    var pane = ensurePane('gisEditTop', 700);
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
  }

  // Esc cancels any armed editing.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.mode) disarm();
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
      '#gis-edit-history-bar .geh-btn:disabled{opacity:.35;cursor:default}';
    document.head.appendChild(s);
  })();

  window.GISEdit = {
    startAdd: startAdd,
    startEditGeom: startEditGeom,
    startDelete: startDelete,
    toggleSnap: toggleSnap,
    disarm: disarm,
    clear: disarm,
    // Exposed so the layer-name parsing (LayerNaming-backed, with an inline
    // load-order-safety fallback) is independently unit-testable.
    _parseLayerName: parseLayerName
  };
})();
