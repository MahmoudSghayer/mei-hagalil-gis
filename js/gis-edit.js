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
  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
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
      var i = l.name.indexOf(' · ');
      return {
        id: l.id, name: l.name,
        label: i >= 0 ? l.name.slice(i + 3) : l.name,
        village: i >= 0 ? l.name.slice(0, i) : '',
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
    for (var i = 0; i < layers.length; i++) {
      try {
        var fc = await GIS.features.getInBBox(layers[i].id, bbox, SNAP_LIMIT);
        grp.addData(fc);
      } catch (e) { /* skip a layer that fails to load */ }
    }
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

  // Layer picker → resolves { id, label, village, geometry_type } or null.
  async function pickLayer(title, geomFilter) {
    var layers;
    try { layers = await listLayers(); }
    catch (e) { toast('שגיאה בטעינת שכבות'); return null; }
    if (geomFilter) layers = layers.filter(function (l) { return geomFilter.indexOf(l.geometry_type) >= 0; });
    if (!layers.length) { toast('אין שכבות מתאימות במנוע'); return null; }
    var typeHe = { Point: 'נקודה', LineString: 'קו', Polygon: 'מצולע' };
    var opts = layers.map(function (l, i) {
      var nm = (l.village ? l.village + ' · ' : '') + l.label + ' (' + (typeHe[l.geometry_type] || l.geometry_type) + ')';
      return '<option value="' + i + '">' + esc(nm) + '</option>';
    }).join('');
    var res = await openDialog(title, gadRow('שכבת יעד', '<select id="ge-layer" class="gad-in">' + opts + '</select>'), {
      okLabel: 'המשך',
      collect: function (bg) { return layers[+bg.querySelector('#ge-layer').value]; }
    });
    return res || null;
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
    var layer = await pickLayer('➕ הוסף ישות — בחר שכבה', ['Point', 'LineString', 'Polygon']);
    if (!layer) return;
    var shape = DRAW_SHAPE[layer.geometry_type];
    if (!shape) { toast('סוג גאומטריה לא נתמך'); return; }

    state.mode = 'add';
    state.targetLayerId = layer.id;
    await buildSnapGuide(layer.village);

    banner('➕ <b>' + esc(layer.label) + '</b> — ' +
      (shape === 'Marker' ? 'לחץ על המפה למיקום' : 'לחץ להוספת קודקודים, לחיצה כפולה לסיום') +
      ' · <span style="opacity:.8">Esc לביטול</span>');

    state.createHandler = function (e) { onCreate(e, layer); };
    window.gMap.on('pm:create', state.createHandler);
    try {
      window.gMap.pm.enableDraw(shape, { snappable: state.snap, snapDistance: SNAP_DISTANCE, finishOn: null });
    } catch (err) { toast('שגיאה בהפעלת הציור: ' + cleanErr(err), 'error'); disarm(); }
  }

  async function onCreate(e, layer) {
    // capture the drawn geometry, drop Geoman's temp layer, stop drawing.
    var gj = e.layer && e.layer.toGeoJSON ? e.layer.toGeoJSON() : null;
    try { window.gMap.removeLayer(e.layer); } catch (err) {}
    try { window.gMap.pm.disableDraw(); } catch (err) {}
    if (window.gMap && state.createHandler) { window.gMap.off('pm:create', state.createHandler); state.createHandler = null; }
    banner(false);
    if (!gj || !gj.geometry) { disarm(); return; }
    await openAttrForm(layer, gj.geometry);
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
      await GIS.features.createFeature(layer.id, geometry, res.props, res.code);
      toast('הישות נוצרה ✓');
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
    var layer = await pickLayer('✏️ עריכת גאומטריה — בחר שכבה', ['Point', 'LineString', 'Polygon']);
    if (!layer) return;
    state.mode = 'editgeom';
    state.targetLayerId = layer.id;
    cursor(true);
    banner('✏️ <b>' + esc(layer.label) + '</b> — לחץ על ישות לעריכה · <span style="opacity:.8">Esc לביטול</span>');
    armPick(layer, function (pick) { beginVertexEdit(layer, pick.f); });
  }

  function beginVertexEdit(layer, feature) {
    cursor(false); banner(false);
    var pane = ensurePane('gisEditTop', 700);
    state.editId = feature.id || (feature.properties && feature.properties.__id);
    if (!state.editId) { toast('לא נמצא מזהה לישות'); disarm(); return; }
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
    buildSnapGuide(layer.village).catch(function () {});
    showSaveBar(saveGeom);
  }

  async function saveGeom() {
    if (!state.editLayer || !state.editId) { disarm(); return; }
    var gj = state.editLayer.toGeoJSON();
    var feat = gj && (gj.type === 'FeatureCollection' ? (gj.features || [])[0] : gj);
    var geometry = feat && feat.geometry;
    if (!geometry) { toast('אין גאומטריה לשמירה'); return; }
    var layerId = state.targetLayerId, id = state.editId;
    toast('שומר…');
    try {
      await GIS.features.updateGeometry(id, geometry);
      toast('הגאומטריה נשמרה ✓');
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
    var layer = await pickLayer('🗑 מחיקת ישות — בחר שכבה', ['Point', 'LineString', 'Polygon']);
    if (!layer) return;
    state.mode = 'delete';
    state.targetLayerId = layer.id;
    cursor(true);
    banner('🗑 <b>' + esc(layer.label) + '</b> — לחץ על ישות למחיקה · <span style="opacity:.8">Esc לביטול</span>');
    armPick(layer, function (pick) { confirmDelete(layer, pick.f); });
  }

  async function confirmDelete(layer, feature) {
    cursor(false); banner(false);
    var p = feature.properties || {};
    var id = feature.id || p.__id;
    var code = p.asset_code || id;
    var res = await openDialog('🗑 מחיקת ישות', '<div class="gad-note">למחוק לצמיתות את הישות <b>' + esc(code) +
      '</b> מהשכבה <b>' + esc(layer.label) + '</b>? פעולה זו נרשמת ביומן הביקורת.</div>', {
      okLabel: 'מחק', collect: function () { return { ok: true }; }
    });
    if (!res) { disarm(); return; }
    toast('מוחק…');
    try {
      await GIS.features.deleteFeature(id);
      toast('הישות נמחקה ✓');
      refreshLayer(layer.id, false);
    } catch (e) { toast(cleanErr(e), 'error'); }
    disarm();
  }

  // ── shared one-shot feature pick (edit/delete) ──────────────────────────────
  function armPick(layer, onPick) {
    state.clickHandler = async function (e) {
      var click = [e.latlng.lng, e.latlng.lat];
      var fc;
      try { fc = await GIS.features.getInBBox(layer.id, bboxAround(e.latlng, CLICK_FIND_M + 15), 1000); }
      catch (err) { toast('שגיאה בטעינת ישויות'); disarm(); return; }
      var best = nearestInFC(click, fc);
      if (!best || best.d > CLICK_FIND_M) {
        toast('לא נמצאה ישות סמוכה — לחץ קרוב יותר');
        // re-arm so the user can try again without re-picking the layer
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
      '.geb-req{color:#dc2626}.geb-ty,.geb-fn{font-size:10px;color:#94a3b8;font-weight:400}';
    document.head.appendChild(s);
  })();

  window.GISEdit = {
    startAdd: startAdd,
    startEditGeom: startEditGeom,
    startDelete: startDelete,
    toggleSnap: toggleSnap,
    disarm: disarm,
    clear: disarm
  };
})();
