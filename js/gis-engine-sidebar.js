// ════════════════════════════════════════════════════════════════
//  מי הגליל GIS — פאנל שכבות מנוע בסרגל הצד (Phase 2)
//  מזריק פאנל "שכבות מנוע GIS" לסרגל הקיים, מקובץ לפי כפר:
//    📍 כפר  (לחיץ לכיווץ/הרחבה)
//        ☐ קווי מים        (123)
//        ☐ שוחות ביוב      (45)
//  הדלקה/כיבוי לכל שכבה, ולחיצה על פיצ'ר פותחת את הטבלה הנערכת.
//  עצמאי, ללא נגיעה ב-index.js.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

// תוויות קטגוריה בעברית (נגזר משם השכבה "<כפר> · <category>")
var CAT_HE = {
  water_pipes:'קווי מים', sewage_pipes:'קווי ביוב', main_sewer:'ביב ראשי', supply_pipe:'קו הספקה',
  valves:'מגופים', control_valves:'מגופים שולטים', hydrants:'הידרנטים', water_meters:'מדי מים',
  sewage_manholes:'שוחות ביוב', connection_points:'נקודות חיבור', reservoirs:'מאגרים',
  pump_stations:'תחנות שאיבה', sampling_points:'נקודות דיגום', fittings:'אביזרים', parcels:'חלקות',
  buildings:'מבנים', annotation_points:'הערות', annotation_lines:'קווי הערה', annotation_polygons:'פוליגוני הערה',
  other:'אחר'
};
var CAT_ICON = {
  water_pipes:'💧', supply_pipe:'💧', sewage_pipes:'🟤', main_sewer:'🔴', valves:'🔧', control_valves:'⚙️',
  hydrants:'🚒', water_meters:'🔢', sewage_manholes:'⭕', reservoirs:'🏗️', pump_stations:'⛽'
};
function catLabel(cat) { return (CAT_ICON[cat] ? CAT_ICON[cat] + ' ' : '') + (CAT_HE[cat] || cat); }
function defaultColor(t) { return t === 'Point' ? '#0d3b5e' : t === 'Polygon' ? '#0e7490' : '#1a7fc1'; }
function colorFor(layer) { return (layer && layer.color) || defaultColor(layer && layer.geometry_type); }
function toHex(c) { return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : defaultColor(); }

var css = document.createElement('style');
css.textContent = `
#gis-eng-panel .ge-village{border:1px solid #eef2f6;border-radius:9px;margin-bottom:6px;overflow:hidden;}
#gis-eng-panel .ge-vhead{display:flex;align-items:center;gap:7px;padding:8px 10px;cursor:pointer;background:#f8fafc;font-size:12.5px;font-weight:700;color:#0d3b5e;}
#gis-eng-panel .ge-vhead:hover{background:#eef4fb;}
#gis-eng-panel .ge-vname{flex:1;min-width:0;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;}
#gis-eng-panel .ge-ic{width:14px;height:14px;flex-shrink:0;}
#gis-eng-panel .ge-pin{color:#1a7fc1;}
#gis-eng-panel .ge-vchev{font-size:10px;opacity:.7;}
#gis-eng-panel .ge-vcount{font-size:10.5px;color:#94a3b8;font-weight:600;}
#gis-eng-panel .ge-vbody{padding:4px 8px 6px;}
#gis-eng-panel .ge-village.collapsed .ge-vbody{display:none;}
#gis-eng-panel .ge-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:5px 4px;border-radius:6px;cursor:pointer;font-size:12.5px;color:#1e293b;}
#gis-eng-panel .ge-row:hover{background:#f1f5f9;}
#gis-eng-panel .ge-row input{accent-color:#0d3b5e;width:14px;height:14px;cursor:pointer;flex-shrink:0;}
#gis-eng-panel .ge-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
#gis-eng-panel .ge-color{width:16px;height:16px;flex-shrink:0;padding:0;border:1px solid #cbd5e1;border-radius:4px;cursor:pointer;background:none;}
#gis-eng-panel .ge-color::-webkit-color-swatch{border:none;border-radius:3px;}
#gis-eng-panel .ge-color::-webkit-color-swatch-wrapper{padding:0;}
#gis-eng-panel .ge-fly,#gis-eng-panel .ge-del{display:inline-flex;align-items:center;background:none;border:none;cursor:pointer;color:#64748b;font-size:12px;padding:0 2px;opacity:.75;}
#gis-eng-panel .ge-fly:hover{opacity:1;color:#1a7fc1;}
#gis-eng-panel .ge-del:hover{opacity:1;filter:saturate(1.5);}
#gis-eng-panel .ge-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#gis-eng-panel .ge-count{font-size:10px;color:#94a3b8;}
#gis-eng-panel .ge-stat{display:inline-flex;align-items:center;min-width:12px;}
#gis-eng-panel .ge-spin{width:11px;height:11px;border:2px solid #cbd5e1;border-top-color:#0d3b5e;border-radius:50%;animation:ge-spin .7s linear infinite;}
#gis-eng-panel .ge-warn{color:#d97706;font-size:12px;cursor:help;}
#gis-eng-panel .ge-more{color:#2563eb;font-size:12px;cursor:help;}
@keyframes ge-spin{to{transform:rotate(360deg);}}
#gis-eng-panel .ge-empty{font-size:11px;color:#94a3b8;padding:8px 2px;line-height:1.5;}
#gis-eng-panel .ge-refresh{background:none;border:none;cursor:pointer;color:#64748b;font-size:13px;}
#gis-eng-panel .ge-lc{display:none;flex-basis:100%;align-items:center;gap:8px;padding:0 24px 6px 6px;}
#gis-eng-panel .ge-lc.on{display:flex;}
#gis-eng-panel .ge-lc-btn{background:none;border:none;cursor:pointer;color:#64748b;font-size:12px;line-height:1;padding:0 2px;}
#gis-eng-panel .ge-lc-btn:hover{color:#1a7fc1;}
#gis-eng-panel .ge-lc .ge-op{flex:1;width:96px;max-width:120px;height:4px;accent-color:#0d3b5e;cursor:pointer;}
#gis-eng-panel.collapsed .ge-body{display:none;}`;
document.head.appendChild(css);

// Non-blocking error toast — NEVER a blocking alert() (a backend hiccup must not
// spam modal "OK" dialogs). Uses the app toast if present, else the #toast node.
function geToast(msg, type) {
  if (typeof window.showToast === 'function') { try { window.showToast(msg, type || 'error'); return; } catch (e) {} }
  var t = document.getElementById('toast');
  if (t) { t.textContent = msg; t.className = (type || 'error') + ' show'; clearTimeout(geToast._t); geToast._t = setTimeout(function () { t.className = t.className.replace('show', '').trim(); }, 6000); return; }
  if (window.console) console.error('[GISEngineSidebar]', msg);
}

var loaded = {};        // layerId → GISTileLoader controller (on the map)
var active = {};        // layerId → layer (toggled on → reload on pan/zoom)
var openVillages = {};  // villageName → bool (expanded)
var meterLayers = {};       // village name → meters L.layer on the map
var moveendWired = false;
var _mt;

// Build the styled Leaflet layer(s) for ONE feature (reuses buildLayer so the
// tile loader keeps the exact symbology / labels / click behaviour). colorFor
// is read per call, so a recolour is reflected after invalidate().
function makeFeatureLayers(layer) {
  return function (f) {
    var g = buildLayer({ type: 'FeatureCollection', features: [f] }, layer, colorFor(layer));
    var out = []; g.eachLayer(function (l) { out.push(l); });
    return out;
  };
}

// One tile loader per active layer: viewport tile cache + feature cache +
// request queue + AbortController + background prefetch. Previously loaded
// features stay on the map while new tiles stream in (no clear-on-refresh).
function createLoader(layer) {
  return GISTileLoader.create({
    map: window.gMap,
    // Durable tile cache (IndexedDB) in front of the bbox RPC: a tile is fetched
    // over the network once, then reused across reloads/sessions until it ages
    // out (TTL) or the layer is edited (onInvalidate clears its tiles).
    fetchTile: function (bbox, signal, tileKey) {
      var ck = layer.id + '/' + tileKey;
      var hit = window.GISTileCache ? GISTileCache.get(ck) : Promise.resolve(null);
      return hit.then(function (cached) {
        if (cached) return cached;
        return GIS.features.getInBBox(layer.id, bbox, 2000, signal).then(function (fc) {
          if (window.GISTileCache && fc && fc.features) GISTileCache.set(ck, fc);
          return fc;
        });
      });
    },
    onInvalidate: function () { if (window.GISTileCache) GISTileCache.clearPrefix(layer.id + '/'); },
    makeLayers: makeFeatureLayers(layer),
    featureId: function (f) { return f.id != null ? f.id : (f.properties && f.properties.__id); },
    onCount: function (n) {
      if (layer._cntEl) layer._cntEl.textContent = n;
      if (window.GISSymbology && window.GISSymbology.refreshLegend) window.GISSymbology.refreshLegend();
    },
    onStatus: function (s) {
      if (!layer._statEl) return;
      var html = '';
      if (s.loading) html += '<span class="ge-spin" title="טוען אריחים…"></span>';
      else if (s.errors) html += '<span class="ge-warn" title="חלק מהאריחים נכשלו בטעינה — הזז מעט את המפה כדי לנסות שוב">⚠</span>';
      else if (s.truncated) html += '<span class="ge-more" title="יש יותר פיצ\'רים מהמוצג באזור זה — התקרב כדי לראות את כולם">⊕</span>';
      layer._statEl.innerHTML = html;
    },
    prefetchRing: 1
  });
}

// ── Vector-tile path (preferred when features_mvt exists) ────────────────
// Builds a VectorGrid controller with the same interface as the tile loader.
// Tiles are SLIM: they carry only the symbology inputs (LineDiamet/Status/
// ValveDiame) + __id/asset_code. The full attribute row is loaded on click.
function createMvtLayer(layer) {
  var color = colorFor(layer);
  return GISMvtLayer.create({
    map: window.gMap,
    layerId: layer.id,
    getFeatureId: function (p) { return p.__id; },
    style: function (p, zoom) {
      var f = { properties: p };   // p already has LineDiamet/Status/ValveDiame
      var base = (window.GISSymbology && GISSymbology.lineStyle) ? GISSymbology.lineStyle(layer, f, color) : { color: color, weight: 3, opacity: .9 };
      // Zoom-scaled point radius so dense layers don't blob at low zoom (lines are
      // already scaled inside lineStyle). VectorGrid re-renders on zoom → live resize.
      var sc = (window.GISSymbology && GISSymbology.zoomScale) ? GISSymbology.zoomScale(zoom) : 1;
      // One style object serves lines, polygons and points (points use radius/fill).
      return Object.assign({ radius: Math.max(2.5, 5 * sc), fill: true, fillColor: base.color || color, fillOpacity: .9,
        weight: base.weight != null ? base.weight : 3, color: base.color || color,
        opacity: base.opacity != null ? base.opacity : .9 }, base);
    },
    onClick: function (p) {
      // Tile only has id/asset_code → fetch the full feature (attrs + meters) on demand.
      if (GIS.features && GIS.features.getFeatureById && p.__id) {
        GIS.features.getFeatureById(p.__id)
          .then(function (f) { openPanelFor(f, layer); })
          .catch(function () { openPanelFor({ type: 'Feature', properties: { asset_code: p.asset_code, __id: p.__id, __layer_id: layer.id } }, layer); });
      } else {
        openPanelFor({ type: 'Feature', properties: { asset_code: p.asset_code, __id: p.__id, __layer_id: layer.id } }, layer);
      }
    },
    onStatus: function (s) {
      if (!layer._statEl) return;
      layer._statEl.innerHTML = s.loading ? '<span class="ge-spin" title="טוען אריחים…"></span>' : '';
      if (!s.loading && layer._cntEl && !layer._cntEl.textContent) layer._cntEl.textContent = '🗺';
    }
  });
}

// Pick the renderer once per session: vector tiles when the features_mvt RPC
// is live, else the GeoJSON tile loader (always works). Probe is cached.
var _mvtMode = null; // null=unknown, true/false once probed
function decideRenderer(layer) {
  if (_mvtMode !== null) return Promise.resolve(_mvtMode);
  if (!window.GISMvtLayer || !GISMvtLayer.supported()) { _mvtMode = false; return Promise.resolve(false); }
  return GISMvtLayer.probe(layer.id).then(function (ok) {
    _mvtMode = ok;
    if (window.console) console.log('[GISEngineSidebar] renderer =', ok ? 'vector tiles (MVT)' : 'GeoJSON tile loader');
    return ok;
  }).catch(function () { _mvtMode = false; return false; });
}
function buildController(layer) {
  return decideRenderer(layer).then(function (useMvt) {
    return useMvt ? createMvtLayer(layer) : createLoader(layer);
  });
}

// Single debounced map-movement handler → nudge every active loader to fetch
// the new edge tiles (cached tiles are reused; nothing is re-requested).
function wireMoveend() {
  if (moveendWired || !window.gMap) return;
  moveendWired = true;
  window.gMap.on('moveend', function () { clearTimeout(_mt); _mt = setTimeout(reloadActive, 250); });
  wireClickFallback();
}
function reloadActive() { Object.keys(loaded).forEach(function (id) { try { loaded[id].update(); } catch (e) {} }); }

var tries = 0;
var t = setInterval(function () {
  tries++;
  if (window.GIS && window.gMap && document.getElementById('layers-scroll-area')) {
    clearInterval(t); wireClickFallback(); build().catch(function (e) { console.error('[GISEngineSidebar]', e); });
  } else if (tries > 80) { clearInterval(t); }
}, 200);

// Hide the old flat-file infrastructure panel — the engine is the layer system now.
function hideOldPanel() {
  var oldList = document.getElementById('dwg-layers-list');
  if (oldList) { var p = oldList.closest('.panel'); if (p) p.style.display = 'none'; }
}

var _lastPanelKey = null, _lastPanelTs = 0;
function openPanelFor(f, layer) {
  // De-dupe a double-open when BOTH the native feature click and the map-level
  // identify fire for the same physical click (GeoJSON mode). A genuine re-click
  // of the same feature later (>350ms) still opens normally.
  var idp = f && f.properties && (f.properties.__id != null ? f.properties.__id : f.properties.asset_code);
  if (idp != null && layer) {
    var key = layer.id + ':' + idp, now = Date.now();
    if (key === _lastPanelKey && now - _lastPanelTs < 350) return;
    _lastPanelKey = key; _lastPanelTs = now;
  }
  if (window.GISIdentify) GISIdentify.highlight(f);
  if (window.GISPanel) window.GISPanel.open(f, { layerId: layer.id, sub: layer.name.split(' · ')[0] });
  else if (window.GISTable) GISTable.openLayer(layer.id, f.properties && f.properties.asset_code, { title: '📋 ' + catLabel(layer._cat), sub: layer.name.split(' · ')[0] });
}

// ── Map-click / hover "Identify" for MVT canvas layers ────────────────────
// In MVT mode features render on stacked CANVAS tiles (L.canvas.tile): the
// topmost tile canvas (pointer-events:auto) covers the layers beneath it and
// VectorGrid per-feature canvas hit-testing is unreliable, so vg.on('click')
// never fires AND hovering a feature shows no pointer cursor. Map-level mouse
// events DO fire, so we cache the viewport's features and hit-test them
// locally: hover → pointer cursor (click affordance); click → open the nearest
// feature's panel. Same nearest-feature math as gis-find / gis-network-trace.
// Tools that own map clicks (crosshair pick, measure, trace, Geoman) are
// detected and left alone.
var TOL_PX = 12;           // click / hover pixel tolerance (a bit generous so thin pipes are easy to hit)
var HOVER_MIN_ZOOM = 16;   // build the hover cache only when zoomed in close (low feature counts, low DB load)
var _vpFeats = [];         // [{f, layer}] features currently in view (MVT only)
var _vpTimer = null;
var _vpAbort = null;        // AbortController for the in-flight hover-cache build
// OFF by default: pre-fetching features on every pan starves Postgres (so the MVT
// tile generator slows → blurry tiles → 525). Clicks still work via an on-demand
// per-click query (nearestFeatureAt). Flip to true only if you want the hover
// pointer-cursor back AND your DB has headroom.
var HOVER_CACHE = false;

function _scaleAt(lat) { return { x: 111320 * Math.cos(lat * Math.PI / 180), y: 110540 }; }
function _distM(a, b, sc) { var dx = (a[0] - b[0]) * sc.x, dy = (a[1] - b[1]) * sc.y; return Math.hypot(dx, dy); }
function _segDistM(p, a, b, sc) {
  var ax = a[0] * sc.x, ay = a[1] * sc.y, bx = b[0] * sc.x, by = b[1] * sc.y, px = p[0] * sc.x, py = p[1] * sc.y;
  var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  var t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function _partsOf(g) {
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString' || g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') { var o = []; g.coordinates.forEach(function (poly) { poly.forEach(function (r) { o.push(r); }); }); return o; }
  return [];
}
// distance (m) from point pt [lng,lat] to a feature geometry
function _featDistM(g, pt, sc) {
  if (!g) return Infinity;
  if (g.type === 'Point') return _distM(pt, g.coordinates, sc);
  if (g.type === 'MultiPoint') { var d = Infinity; g.coordinates.forEach(function (c) { d = Math.min(d, _distM(pt, c, sc)); }); return d; }
  var dd = Infinity;
  _partsOf(g).forEach(function (coords) { for (var k = 1; k < coords.length; k++) { var s = _segDistM(pt, coords[k - 1], coords[k], sc); if (s < dd) dd = s; } });
  return dd;
}
// pixel tolerance → metres at the given latlng / current zoom
function _tolMeters(ll) {
  var cp = window.gMap.latLngToContainerPoint(ll);
  return Math.max(1, ll.distanceTo(window.gMap.containerPointToLatLng(L.point(cp.x + TOL_PX, cp.y))));
}
// Yield to any armed tool that owns map clicks / sets its own cursor.
function _toolArmed() {
  try {
    var c = window.gMap.getContainer();
    if (c.style.cursor === 'crosshair') return true;          // incident / trace / field / edit pick
    if (c.classList.contains('mt-cursor')) return true;       // measure tool
    if (window.GISTrace && GISTrace._state) return true;      // network trace
    var pm = window.gMap.pm;                                  // Leaflet-Geoman (on-map editing)
    if (pm && ((pm.globalDrawModeEnabled && pm.globalDrawModeEnabled()) ||
               (pm.globalEditModeEnabled && pm.globalEditModeEnabled()) ||
               (pm.globalRemovalModeEnabled && pm.globalRemovalModeEnabled()))) return true;
  } catch (e) {}
  return false;
}

// Refresh the viewport feature cache (MVT mode, zoomed in). HEAVILY throttled so
// rapid pan/zoom can't storm the DB: debounced, ABORTS the prior in-flight build,
// capped fetch size, and skipped when many layers are on. This cache only powers
// the hover pointer-cursor + an instant click; the click itself always falls back
// to a cheap on-demand per-click query, so throttling this never breaks clicking.
function scheduleVpCache() { clearTimeout(_vpTimer); _vpTimer = setTimeout(buildVpCache, 400); }
function buildVpCache() {
  if (_vpAbort) { try { _vpAbort.abort(); } catch (e) {} _vpAbort = null; }  // cancel a prior build (rapid pan/zoom)
  _vpFeats = [];
  if (!HOVER_CACHE || !_mvtMode || !window.gMap || !window.GIS || !GIS.features || !GIS.features.getInBBox) return;
  if (window.gMap.getZoom() < HOVER_MIN_ZOOM) return;
  var layers = Object.keys(active).map(function (id) { return active[id]; });
  if (!layers.length || layers.length > 6) return;   // bound concurrency — skip the hover cache when many layers are on
  var b = window.gMap.getBounds();
  var bbox = { minLng: b.getWest(), minLat: b.getSouth(), maxLng: b.getEast(), maxLat: b.getNorth() };
  var ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  _vpAbort = ac;
  var acc = [];
  Promise.all(layers.map(function (layer) {
    return GIS.features.getInBBox(layer.id, bbox, 1200, ac && ac.signal).then(function (fc) {
      (fc && fc.features || []).forEach(function (f) { if (f.geometry) acc.push({ f: f, layer: layer }); });
    }).catch(function () {});
  })).then(function () { if (_vpAbort === ac) { _vpFeats = acc; _vpAbort = null; } });
}

// Nearest cached feature to a latlng within the pixel tolerance (local, instant).
function nearestVpFeature(ll) {
  if (!_vpFeats.length) return null;
  var pt = [ll.lng, ll.lat], sc = _scaleAt(ll.lat), tolM = _tolMeters(ll), best = null;
  for (var i = 0; i < _vpFeats.length; i++) {
    var d = _featDistM(_vpFeats[i].f.geometry, pt, sc);
    if (d <= tolM && (!best || d < best.d)) best = { d: d, f: _vpFeats[i].f, layer: _vpFeats[i].layer };
  }
  return best;
}

// On-demand nearest feature (used when the cache is empty — e.g. low zoom).
async function nearestFeatureAt(ll) {
  if (!window.GIS || !GIS.features || !GIS.features.getInBBox) return null;
  var layers = Object.keys(active).map(function (id) { return active[id]; });
  if (!layers.length) return null;
  var pt = [ll.lng, ll.lat], sc = _scaleAt(ll.lat), tolM = _tolMeters(ll);
  // Fetch a wider box than the tolerance so a feature whose nearest point sits just
  // past the click is still a candidate; acceptance is still gated by tolM below.
  var fetchM = tolM * 2.5, dLng = fetchM / sc.x, dLat = fetchM / sc.y;
  var bbox = { minLng: ll.lng - dLng, minLat: ll.lat - dLat, maxLng: ll.lng + dLng, maxLat: ll.lat + dLat };
  var best = null;
  await Promise.all(layers.map(function (layer) {
    return GIS.features.getInBBox(layer.id, bbox, 1500).then(function (fc) {
      (fc && fc.features || []).forEach(function (f) {
        var d = _featDistM(f.geometry, pt, sc);
        if (isFinite(d) && (!best || d < best.d)) best = { d: d, f: f, layer: layer };
      });
    }).catch(function () {});
  }));
  return (best && best.d <= tolM) ? best : null;
}

async function onMapClickPick(e) {
  // Runs in EVERY renderer mode so a click ALWAYS opens the nearest feature:
  //  • MVT: native VectorGrid canvas clicks are unreliable → this is THE path.
  //  • GeoJSON: native per-feature clicks also fire, but openPanelFor de-dupes
  //    the double-open; this still rescues near-misses (within tolerance).
  //  • probe still unresolved (_mvtMode === null): also works, instead of dying.
  // Only yields to a tool that owns map clicks (pick / measure / trace / Geoman).
  if (_toolArmed()) return;
  var best = nearestVpFeature(e.latlng) || await nearestFeatureAt(e.latlng);
  if (!best) return;
  if (best.f.properties && !best.f.properties.__layer_id) best.f.properties.__layer_id = best.layer.id;
  openPanelFor(best.f, best.layer);
}

// Hover → pointer cursor over a clickable feature (so the user sees it's clickable).
var _hoverRaf = null;
function onMapHover(e) {
  if (!_mvtMode) return;
  if (e.originalEvent && e.originalEvent.buttons) return;   // mid-drag (pan) → leave the grab cursor
  if (_hoverRaf) return;
  var ll = e.latlng;
  _hoverRaf = requestAnimationFrame(function () {
    _hoverRaf = null;
    if (_toolArmed()) return;                               // don't fight a tool's cursor
    var c = window.gMap.getContainer();
    if (c.style.cursor !== '' && c.style.cursor !== 'pointer') return;  // only own the default/pointer state
    c.style.cursor = nearestVpFeature(ll) ? 'pointer' : '';
  });
}

var clickFallbackWired = false;
function wireClickFallback() {
  if (clickFallbackWired || !window.gMap) return;
  clickFallbackWired = true;
  window.gMap.on('click', onMapClickPick);
  window.gMap.on('mousemove', onMapHover);
  window.gMap.on('moveend', scheduleVpCache);
  scheduleVpCache();
}

// Build the Leaflet layer for an engine layer. NO clustering — points render
// as plain circle markers (no "bubbles"); viewport loading keeps it light.
function buildLayer(fc, layer, color) {
  var sym = window.GISSymbology;   // Phase 3: attribute-driven symbology (optional)
  return L.geoJSON(fc, {
    style: function (f) { return sym ? sym.lineStyle(layer, f, color) : { color: color, weight: 3, opacity: .9 }; },
    pointToLayer: function (f, ll) { return sym ? sym.pointToLayer(layer, f, ll, color) : L.circleMarker(ll, { radius: 5, color: '#fff', weight: 1.2, fillColor: color, fillOpacity: .9 }); },
    onEachFeature: function (f, lf) {
      lf.on('click', function () { openPanelFor(f, layer); });
      if (sym && sym.wantLabel(layer)) { var txt = sym.labelText(layer, f); if (txt) lf.bindTooltip(txt, { permanent: true, direction: 'center', className: 'gis-sym-label', opacity: 1 }); }
    }
  });
}

async function build() {
  hideOldPanel();
  var host = document.getElementById('layers-scroll-area');
  var panel = document.createElement('div');
  panel.className = 'panel'; panel.id = 'gis-eng-panel';
  panel.innerHTML =
    '<div class="panel-title" style="cursor:pointer;display:flex;align-items:center;gap:7px" id="ge-head">' +
      '<svg class="ge-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M2 13l10 5 10-5"/><path d="M2 18l10 5 10-5"/></svg>' +
      '<span style="flex:1">שכבות מנוע GIS</span>' +
      '<span style="display:flex;align-items:center;gap:6px">' +
        '<button class="ge-refresh" id="ge-refresh" title="רענן">↻</button>' +
        '<span class="count-pill" id="ge-count">0</span>' +
        '<span id="ge-chev" style="font-size:11px">▾</span>' +
      '</span>' +
    '</div>' +
    '<div class="ge-body" id="ge-body"><div class="ge-empty">טוען…</div></div>';
  host.appendChild(panel);

  document.getElementById('ge-head').onclick = function (e) {
    if (e.target.id === 'ge-refresh') return;
    panel.classList.toggle('collapsed');
    document.getElementById('ge-chev').textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
  };
  document.getElementById('ge-refresh').onclick = function (e) { e.stopPropagation(); render(); };
  render();
}

async function render() {
  var body = document.getElementById('ge-body');
  body.innerHTML = '<div class="ge-empty">טוען…</div>';
  try {
    var layers = await GIS.layers.list();   // lightweight: no per-layer fields join
    document.getElementById('ge-count').textContent = layers.length;
    // קבץ לפי כפר (שם השכבה: "<כפר> · <category>")
    var groups = {}, order = [];
    layers.forEach(function (l) {
      var idx = l.name.indexOf(' · ');
      var village = idx >= 0 ? l.name.slice(0, idx) : 'שכבות כלליות';
      var cat = idx >= 0 ? l.name.slice(idx + 3) : l.name;
      l._cat = cat;
      if (!groups[village]) { groups[village] = []; order.push(village); }
      groups[village].push(l);
    });

    body.innerHTML = '';
    if (!layers.length) {
      var note = document.createElement('div');
      note.className = 'ge-empty';
      note.innerHTML = 'אין שכבות תשתית עדיין — הכפרים מוצגים עבור מדי מים.';
      body.appendChild(note);
    }
    order.forEach(function (village) { body.appendChild(villageBlock(village, groups[village])); });
    // Every known village is shown so its water meters are reachable even with no
    // uploaded infrastructure layers. Meters attach to a village by coordinates
    // (nearest centre) and load per-village via a bbox query (no fleet-wide load).
    Object.keys(VILLAGE_CENTERS).forEach(function (v) {
      if (order.indexOf(v) === -1) body.appendChild(villageBlock(v, []));
    });
  } catch (e) {
    body.innerHTML = '<div class="ge-empty" style="color:#dc2626">' + esc(e.message) + '</div>';
  }
}

function villageBlock(village, layers) {
  var wrap = document.createElement('div');
  wrap.className = 'ge-village' + (openVillages[village] ? '' : ' collapsed');
  var head = document.createElement('div');
  head.className = 'ge-vhead';
  head.innerHTML =
    '<span class="ge-vchev">' + (openVillages[village] ? '▾' : '▸') + '</span>' +
    '<span class="ge-vname"><svg class="ge-ic ge-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.7-6-10a6 6 0 0 1 12 0c0 4.3-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/></svg>' + esc(village) + '</span>' +
    '<button class="ge-fly" title="התמקד בכפר"><svg class="ge-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.6"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg></button>' +
    '<span class="ge-vcount">' + layers.length + ' שכבות</span>';
  head.onclick = function () {
    openVillages[village] = !openVillages[village];
    wrap.classList.toggle('collapsed');
    head.querySelector('.ge-vchev').textContent = openVillages[village] ? '▾' : '▸';
  };
  head.querySelector('.ge-fly').onclick = function (e) { e.stopPropagation(); flyToVillage(layers, village); };
  wrap.appendChild(head);

  var bodyEl = document.createElement('div');
  bodyEl.className = 'ge-vbody';
  layers.sort(function (a, b) { return catLabel(a._cat).localeCompare(catLabel(b._cat), 'he'); });
  layers.forEach(function (l) { bodyEl.appendChild(row(l)); });
  // Water meters for this village (own table, placed by coordinates).
  if (VILLAGE_CENTERS[village]) bodyEl.appendChild(meterVillageRow(village));
  wrap.appendChild(bodyEl);
  return wrap;
}

function flyToVillage(layers, village) {
  if (!window.gMap) return;
  // INSTANT: fly straight to the known village centre — no slow extent RPC. All 7
  // utility villages are in VILLAGE_CENTERS; only an unknown village (rare) falls
  // back to the layer-extent query.
  var c = VILLAGE_CENTERS[village];
  if (c) { gMap.flyTo([c.lat, c.lng], 15, { duration: .6 }); return; }
  if (layers && layers.length) {
    GIS.layers.extent(layers.map(function (l) { return l.id; })).then(function (bb) {
      if (bb) gMap.flyToBounds([[bb[1], bb[0]], [bb[3], bb[2]]], { padding: [40, 40], duration: .6, maxZoom: 17 });
    }).catch(function (e) { console.warn('[GISEngineSidebar] flyTo', e); });
  }
}

// Fly to a single layer's extent ("zoom to layer", ESRI-style TOC action).
function zoomToLayer(layer) {
  if (!window.gMap || !layer) return;
  GIS.layers.extent([layer.id]).then(function (bb) {
    if (bb) gMap.flyToBounds([[bb[1], bb[0]], [bb[3], bb[2]]], { padding: [40, 40], duration: .8, maxZoom: 18 });
  }).catch(function (e) { console.warn('[GISEngineSidebar] zoomToLayer', e); });
}

// Delete an entire village (all its engine layers + their features). Admin only.
async function deleteVillage(village, layers) {
  if (!window.confirm('למחוק את כל שכבות "' + village + '" מהמנוע? כולל כל הפיצ\'רים. פעולה בלתי הפיכה.')) return;
  for (var i = 0; i < layers.length; i++) {
    var id = layers[i].id;
    if (loaded[id]) { loaded[id].destroy(); delete loaded[id]; }
    delete active[id];
    try { await GIS.layers.deleteLayer(id); }
    catch (e) { geToast('שגיאה במחיקה: ' + (e && e.message || e)); break; }
  }
  render();
}

function row(layer) {
  var color = colorFor(layer);
  var el = document.createElement('div');
  el.className = 'ge-row';
  el.innerHTML =
    '<input type="checkbox">' +
    '<input type="color" class="ge-color" value="' + toHex(color) + '" title="שנה צבע שכבה">' +
    '<span class="ge-name" title="' + esc(layer.name) + '">' + esc(catLabel(layer._cat)) + '</span>' +
    '<span class="ge-count"></span>' +
    '<span class="ge-stat"></span>';
  var cb = el.querySelector('input[type=checkbox]');
  var picker = el.querySelector('.ge-color');
  var cnt = el.querySelector('.ge-count');
  layer._cntEl = cnt;
  layer._statEl = el.querySelector('.ge-stat');

  // clicking the name toggles the layer (the row is a div, not a label)
  el.querySelector('.ge-name').onclick = function () { cb.checked = !cb.checked; cb.onchange(); };

  // recolour: persist + restyle live if the layer is rendered
  picker.onclick = function (e) { e.stopPropagation(); };
  picker.onchange = async function () {
    var newColor = picker.value;
    layer.color = newColor;
    try { await GIS.layers.setColor(layer.id, newColor); }
    catch (e) { geToast('שגיאה בשמירת צבע: ' + (e && e.message || e)); return; }
    // Re-render the live tiles with the new colour (no network round-trip is
    // possible from cached layers, so invalidate refetches the current view).
    if (loaded[layer.id]) loaded[layer.id].invalidate();
  };

  // Per-layer controls (zoom-to / bring-front / send-back / opacity) — ESRI-style
  // TOC. Shown only while the layer is active; act on its live controller.
  var lc = document.createElement('div');
  lc.className = 'ge-lc';
  lc.innerHTML =
    '<button class="ge-lc-btn ge-zoom" title="התמקד בשכבה" aria-label="התמקד בשכבה">🔍</button>' +
    '<button class="ge-lc-btn ge-front" title="הבא לחזית" aria-label="הבא שכבה לחזית">▲</button>' +
    '<button class="ge-lc-btn ge-back" title="שלח לאחור" aria-label="שלח שכבה לאחור">▼</button>' +
    '<input type="range" class="ge-op" min="0" max="100" value="' + Math.round((layer._opacity != null ? layer._opacity : 1) * 100) + '" title="שקיפות שכבה" aria-label="שקיפות שכבה">';
  el.appendChild(lc);
  lc.querySelector('.ge-zoom').onclick = function (e) { e.stopPropagation(); zoomToLayer(layer); };
  lc.querySelector('.ge-front').onclick = function (e) { e.stopPropagation(); var c = loaded[layer.id]; if (c && c.toFront) c.toFront(); };
  lc.querySelector('.ge-back').onclick = function (e) { e.stopPropagation(); var c = loaded[layer.id]; if (c && c.toBack) c.toBack(); };
  var opSlider = lc.querySelector('.ge-op');
  opSlider.onclick = function (e) { e.stopPropagation(); };
  opSlider.oninput = function (e) {
    e.stopPropagation();
    layer._opacity = (parseInt(opSlider.value, 10) || 0) / 100;
    var c = loaded[layer.id]; if (c && c.setOpacity) c.setOpacity(layer._opacity);
  };

  cb.onchange = function () {
    if (cb.checked) {
      cnt.textContent = '…';
      lc.classList.add('on');
      active[layer.id] = layer; wireMoveend();
      if (loaded[layer.id]) { loaded[layer.id].destroy(); delete loaded[layer.id]; }
      buildController(layer).then(function (ctrl) {
        if (active[layer.id]) {
          loaded[layer.id] = ctrl;                       // still wanted → keep it
          if (layer._opacity != null && layer._opacity !== 1 && ctrl.setOpacity) ctrl.setOpacity(layer._opacity);
        } else { ctrl.destroy(); }                        // toggled off mid-build → drop
      }).catch(function (e) { cb.checked = false; lc.classList.remove('on'); delete active[layer.id]; cnt.textContent = '✕'; geToast('שגיאה בטעינת שכבה: ' + (e && e.message || e)); });
    } else {
      delete active[layer.id];
      lc.classList.remove('on');
      if (loaded[layer.id]) { loaded[layer.id].destroy(); delete loaded[layer.id]; }
      cnt.textContent = '';
    }
    scheduleVpCache();   // refresh the hover/click feature cache for the new active set
  };
  return el;
}

// ── Water meters (Arad) ──────────────────────────────────────────────────
// Meters live in their own table (GIS.meters), not in engine layers. They are
// shown PER VILLAGE, placed by their coordinates: each village loads only the
// meters inside its own bounding box (a GIST-indexed bbox RPC), so we never
// load the whole 30k+ fleet at once (that hits the DB statement timeout). A
// meter in an overlap zone is shown only under its NEAREST village centre.
var METER_COLOR = '#0284c7';

// The 7 villages (centre lat/lng) — mirrors upload.js VILLAGES.
var VILLAGE_CENTERS = {
  'מגד אל-כרום': { lat: 32.9189, lng: 35.2456 },
  'בענה':        { lat: 32.9485, lng: 35.2617 },
  'דיר אל-אסד':  { lat: 32.9356, lng: 35.2697 },
  'נחף':         { lat: 32.9344, lng: 35.3025 },
  'סחנין':       { lat: 32.8650, lng: 35.2978 },
  'דיר חנא':     { lat: 32.8631, lng: 35.3589 },
  'עראבה':       { lat: 32.8514, lng: 35.3339 }
};
var VILLAGE_HALF = 0.05;   // ~5 km half-box used to query a village's meters

function villageBbox(name) {
  var c = VILLAGE_CENTERS[name];
  return { minLng: c.lng - VILLAGE_HALF, minLat: c.lat - VILLAGE_HALF,
           maxLng: c.lng + VILLAGE_HALF, maxLat: c.lat + VILLAGE_HALF };
}

// Nearest of the 7 village centres to a point, or null if none within range.
function nearestVillage(lng, lat) {
  var best = null, bestD = Infinity;
  Object.keys(VILLAGE_CENTERS).forEach(function (name) {
    var c = VILLAGE_CENTERS[name];
    var d = Math.sqrt(Math.pow(lng - c.lng, 2) + Math.pow(lat - c.lat, 2));
    if (d < bestD) { bestD = d; best = name; }
  });
  return bestD <= 0.06 ? best : null;
}

// Fill colour by connection status — so a meter's connection is VISIBLE the
// moment its layer is shown, and persists across refresh (read from the DB).
function meterFill(p) {
  if (p && p.connection_type === 'MANUAL') return '#2563eb'; // blue  = manual
  if (p && p.connection_type === 'AUTO')   return '#16a34a'; // green = auto
  if (p && p.connection_type === 'NONE')   return '#f59e0b'; // amber = unconnected (flagged)
  return METER_COLOR;                                        // unknown (pre-connect)
}

// A meter layer = the meter markers (click → full attribute panel) PLUS, for
// connected meters, a thin line to the pipe (the connection). Lines are
// non-interactive so they never block clicks on pipes/meters underneath.
function buildMeterLayer(feats) {
  var grp = L.layerGroup();
  (feats || []).forEach(function (f) {
    var c = f.geometry && f.geometry.coordinates; if (!c) return;
    var p = f.properties || {};
    var fill = meterFill(p);
    if ((p.connection_type === 'AUTO' || p.connection_type === 'MANUAL') &&
        p.connection_point && p.connection_point.coordinates) {
      var sc = p.connection_point.coordinates;
      L.polyline([[c[1], c[0]], [sc[1], sc[0]]], {
        color: fill, weight: 2, opacity: 0.7, interactive: false,
        dashArray: p.connection_ambiguous ? '4 4' : null
      }).addTo(grp);
    }
    var mk = L.circleMarker([c[1], c[0]], { radius: 5, color: '#fff', weight: 1.2, fillColor: fill, fillOpacity: .95 });
    mk.on('click', function () {
      if (window.GISPanel && GISPanel.openMeter) GISPanel.openMeter(f);
      else mk.bindPopup(meterPopup(f)).openPopup();
    });
    mk.addTo(grp);
  });
  return grp;
}

function meterPopup(f) {
  var p = f.properties || {};
  var rows = [
    ['מספר מונה', p.arad_meter_id],
    ['מספר צרכן', p.customer_id],
    ['שם צרכן', p.customer_name || (p.raw_data && p.raw_data.customer_name)],
    ['קריאה אחרונה', p.last_reading],
    ['כתובת', p.address || (p.raw_data && p.raw_data.address)]
  ];
  var html = '<div style="font-size:12.5px;line-height:1.6;min-width:170px"><b>🔢 מד מים</b>';
  rows.forEach(function (r) { if (r[1] != null && r[1] !== '') html += '<br>' + esc(r[0]) + ': ' + esc(r[1]); });
  return html + '</div>';
}

// A "🔢 מדי מים" toggle inside a village block. Loads only that village's meters
// (bbox RPC) and keeps the ones whose nearest village centre is this village,
// so each meter sits under exactly one (its correct) village by coordinates.
function meterVillageRow(village) {
  var el = document.createElement('div');
  el.className = 'ge-row';
  el.innerHTML =
    '<input type="checkbox">' +
    '<span class="ge-dot" style="background:' + METER_COLOR + '"></span>' +
    '<span class="ge-name" title="מדי מים מתוך מערכת Arad (עם קריאות), ממוקמים לפי קואורדינטות"><svg class="ge-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></svg> מדי מים (Arad)</span>' +
    '<span class="ge-count"></span>';
  var cb = el.querySelector('input[type=checkbox]');
  var cnt = el.querySelector('.ge-count');
  el.querySelector('.ge-name').onclick = function () { cb.checked = !cb.checked; cb.onchange(); };
  cb.onchange = async function () {
    if (cb.checked) {
      cb.disabled = true; cnt.textContent = '…';
      try {
        if (!meterLayers[village]) {
          var fc = await GIS.meters.getMetersInBBox(villageBbox(village));
          var feats = (fc.features || []).filter(function (f) {
            var c = f.geometry && f.geometry.coordinates;
            return c && nearestVillage(c[0], c[1]) === village;
          });
          meterLayers[village] = buildMeterLayer(feats);
          meterLayers[village]._count = feats.length;
        }
        meterLayers[village].addTo(window.gMap);
        cnt.textContent = meterLayers[village]._count;
      } catch (e) {
        cb.checked = false; cnt.textContent = '✕';
        geToast('שגיאה בטעינת מדי מים — ייתכן עומס זמני בשרת, נסה שוב: ' + (e && e.message || e));
      } finally { cb.disabled = false; }
    } else {
      if (meterLayers[village]) window.gMap.removeLayer(meterLayers[village]);
      cnt.textContent = '';
    }
  };
  return el;
}

function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]; }); }

// Expose the Hebrew category label so the legend (GISSymbology) can name layers.
window.GISLayerLabel = catLabel;

// Allow the attribute table to refresh a rendered layer on the map after an edit.
window.GISEngineSidebar = {
  reload: function (layerId) { if (loaded[layerId]) loaded[layerId].invalidate(); },        // after an edit → refetch that layer
  reloadAll: function () { Object.keys(loaded).forEach(function (id) { loaded[id].invalidate(); }); }, // re-style all active (labels toggle)
  activeLayers: function () { return Object.keys(active).map(function (id) { return active[id]; }); },
  refresh: function () { try { render(); } catch (e) {} },
  villageAt: function (lng, lat) { return nearestVillage(lng, lat); }
};

})();
