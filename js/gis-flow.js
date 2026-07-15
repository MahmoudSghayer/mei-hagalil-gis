// ════════════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Flow-direction arrows (L4a, manhole-invert edition)
//  Toggle "כיוון זרימה": overlays gravity-flow arrows on SEWER lines. Direction
//  is derived from the שוחות ביוב (sewage manholes) at each pipe's endpoints —
//  water flows toward the manhole with the LOWER invert level. Per manhole the
//  invert is read as LowIL (outlet) → invert_level → HighIL → (TL − Depth).
//  Manholes without any invert leave their pipe unmarked (sparse data is fine —
//  only the few that have inverts get arrows). Refreshes on pan/zoom.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var ON = false, layerGroup = null, deb = null;
  var MIN_ZOOM = 15;          // arrows only when zoomed in (perf + legibility)
  var MAX_FEATURES = 4000;    // safety cap per layer
  var SNAP_M = 6;             // manhole ↔ pipe-endpoint snap tolerance (m)

  // category key (after " · " in the engine layer name) → role
  var SEWER_CATS   = { sewage_pipes: 1, main_sewer: 1, sewage_pipe: 1 };
  var MANHOLE_CATS = { sewage_manholes: 1, manhole: 1 };

  function toast(m) { if (window.showToast) showToast(m); }

  function injectStyles() {
    if (document.getElementById('flow-styles')) return;
    var s = document.createElement('style'); s.id = 'flow-styles';
    s.textContent =
      '.flow-arrow{pointer-events:auto}' +
      '.flow-arrow div{color:#0369a1;font-size:17px;line-height:1;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 2px #fff;font-weight:700}' +
      '#flow-toggle.active{background:#0d3b5e;color:#fff}';
    document.head.appendChild(s);
  }

  // ── geo helpers (WGS84 lng/lat, metric via local scale) ────────────────────
  function scaleAt(lat) { return { x: 111320 * Math.cos(lat * Math.PI / 180), y: 110540 }; }
  function distM(a, b, sc) { var dx = (a[0] - b[0]) * sc.x, dy = (a[1] - b[1]) * sc.y; return Math.hypot(dx, dy); }

  // spatial hash for nearest-manhole lookup (cell = SNAP_M, so a candidate within
  // SNAP_M is at most one cell away → a 3×3 neighbourhood scan is exhaustive).
  function makeHash(sc, cellM) {
    var grid = new Map();
    return {
      add: function (lng, lat, val) {
        var gx = Math.round(lng * sc.x / cellM), gy = Math.round(lat * sc.y / cellM), k = gx + '_' + gy;
        var a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push({ lng: lng, lat: lat, val: val });
      },
      nearest: function (lng, lat, r) {
        var gx = Math.round(lng * sc.x / cellM), gy = Math.round(lat * sc.y / cellM), best = null;
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
          var a = grid.get((gx + dx) + '_' + (gy + dy)); if (!a) continue;
          for (var i = 0; i < a.length; i++) {
            var d = distM([lng, lat], [a[i].lng, a[i].lat], sc);
            if (d <= r && (!best || d < best.d)) best = { d: d, val: a[i].val };
          }
        }
        return best ? best.val : null;
      }
    };
  }

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : NaN; }

  // representative invert of a manhole — LowIL (outlet) first, then fallbacks.
  // NOTE: in the source data LowIL is the placeholder 0.00 for EVERY manhole
  // (and HighIL is often absent), so a finite 0 is treated as "missing" and the
  // real invert is derived from TL − Depth (the CEO-confirmed IL2 derivation).
  // A genuine 0 m invert is impossible here (Galilee elevations are ~200 m).
  function manholeInvert(p) {
    if (!p) return NaN;
    var v;
    v = num(p.LowIL);        if (isFinite(v) && v !== 0) return v;
    v = num(p.invert_level); if (isFinite(v) && v !== 0) return v;
    v = num(p.HighIL);       if (isFinite(v) && v !== 0) return v;
    var tl = num(p.TL);
    if (!isFinite(tl)) tl = num(p.top_level);
    if (!isFinite(tl)) tl = num(p.TopLevel);
    var d = num(p.Depth);
    if (isFinite(tl) && isFinite(d)) return tl - d;   // invert = top level − depth
    return NaN;
  }

  // engine layer row → { id, village, cat }. Prefers the DB-derived
  // village/category columns (W5.2) via LayerNaming.fromRow when loaded;
  // identical inline fallback (load-order safety) when it isn't. NOTE the
  // historical quirk preserved here: with no separator, village falls back
  // to the FULL name (not null/'') — flow grouping relied on that before
  // the consolidation, and still does regardless of which path derived
  // { village, category }.
  function parseLayer(l) {
    var p = (window.LayerNaming && LayerNaming.fromRow) ? LayerNaming.fromRow(l) : (function (name) {
      var i = name.indexOf(' · ');
      return i >= 0 ? { village: name.slice(0, i), category: name.slice(i + 3) } : { village: null, category: name };
    })(l.name);
    return { id: l.id, village: p.village != null ? p.village : l.name, cat: p.category };
  }

  // (Multi)LineString → array of coord arrays
  function partsOf(geom) {
    if (!geom) return [];
    if (geom.type === 'LineString') return [geom.coordinates];
    if (geom.type === 'MultiLineString') return geom.coordinates;
    return [];
  }

  // ── arrows ─────────────────────────────────────────────────────────────────
  // Compass bearing a→b (deg, 0=N,90=E); a,b = [lng,lat].
  function bearing(a, b) {
    var t = Math.PI / 180;
    var y = Math.sin((b[0] - a[0]) * t) * Math.cos(b[1] * t);
    var x = Math.cos(a[1] * t) * Math.sin(b[1] * t) - Math.sin(a[1] * t) * Math.cos(b[1] * t) * Math.cos((b[0] - a[0]) * t);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  // The ➤ glyph points east at rotate(0); to aim it along compass bearing → rotate(bearing-90).
  function arrowIcon(rot) {
    return L.divIcon({ className: 'flow-arrow', html: '<div style="transform:rotate(' + rot.toFixed(0) + 'deg)">➤</div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  function clearArrows() { if (layerGroup) { try { gMap.removeLayer(layerGroup); } catch (e) {} layerGroup = null; } }

  // coords = one line part; forward=true keeps coords (flow = coords[0]→last).
  // The arrow is placed AT THE DOWNSTREAM MANHOLE (the pipe's lower-invert end),
  // oriented along the incoming segment — so direction reads on the שוחות, not
  // scattered mid-pipe. up/down = higher/lower-invert endpoint manholes (tooltip).
  function drawArrow(coords, forward, up, down) {
    var seq = forward ? coords : coords.slice().reverse();   // oriented downstream
    if (seq.length < 2) return;
    var b = seq[seq.length - 1];                              // downstream end = at the manhole
    var a = seq[seq.length - 2];
    var m = L.marker([b[1], b[0]], { icon: arrowIcon(bearing(a, b) - 90), keyboard: false, zIndexOffset: 500 });
    var nums = (up.num || down.num) ? ' · שוחות ' + (up.num || '?') + ' → ' + (down.num || '?') : '';
    m.bindTooltip('כיוון זרימה · מפלס תחתית ' + up.inv.toFixed(2) + ' → ' + down.inv.toFixed(2) + nums,
      { direction: 'top' });
    m.addTo(layerGroup);
  }

  async function render() {
    if (!ON || !window.gMap || !window.GIS || !GIS.features || !GIS.layers) return;
    clearArrows();
    if (gMap.getZoom() < MIN_ZOOM) { toast('התקרב (זום ' + MIN_ZOOM + '+) כדי לראות כיווני זרימה'); return; }

    var all = (await GIS.layers.getLayers().catch(function () { return []; })).map(parseLayer);
    var sewerLayers   = all.filter(function (l) { return SEWER_CATS[l.cat]; });
    var manholeLayers = all.filter(function (l) { return MANHOLE_CATS[l.cat]; });
    if (!sewerLayers.length) { toast('אין שכבות ביוב במנוע'); return; }

    var bnd = gMap.getBounds();
    var bbox = { minLng: bnd.getWest(), minLat: bnd.getSouth(), maxLng: bnd.getEast(), maxLat: bnd.getNorth() };
    var sc = scaleAt((bbox.minLat + bbox.maxLat) / 2);

    // 1) manholes in view → spatial hash keyed by location, carrying their invert.
    var mhFcs = await Promise.all(manholeLayers.map(function (l) {
      return GIS.features.getInBBox(l.id, bbox, MAX_FEATURES).catch(function () { return null; });
    }));
    if (!ON) { clearArrows(); return; }
    var mhHash = makeHash(sc, SNAP_M);
    mhFcs.forEach(function (fc) {
      if (!fc || !fc.features) return;
      fc.features.forEach(function (f) {
        if (!f.geometry || f.geometry.type !== 'Point') return;
        var c = f.geometry.coordinates, p = f.properties || {};
        mhHash.add(c[0], c[1], { inv: manholeInvert(p), num: p.ManholeNum });
      });
    });

    // 2) sewer pipes in view → arrow per part from its endpoint manholes' inverts.
    var pipeFcs = await Promise.all(sewerLayers.map(function (l) {
      return GIS.features.getInBBox(l.id, bbox, MAX_FEATURES).catch(function () { return null; });
    }));
    if (!ON) { clearArrows(); return; }
    layerGroup = L.layerGroup().addTo(gMap);

    var arrows = 0, parts = 0, mhPairs = 0, invPairs = 0;
    pipeFcs.forEach(function (fc) {
      if (!fc || !fc.features) return;
      fc.features.forEach(function (f) {
        partsOf(f.geometry).forEach(function (coords) {
          if (coords.length < 2) return;
          parts++;
          var e0 = coords[0], e1 = coords[coords.length - 1];
          var m0 = mhHash.nearest(e0[0], e0[1], SNAP_M);
          var m1 = mhHash.nearest(e1[0], e1[1], SNAP_M);
          if (!m0 || !m1 || m0 === m1) return;
          mhPairs++;
          if (!isFinite(m0.inv) || !isFinite(m1.inv)) return;
          invPairs++;
          if (m0.inv === m1.inv) return;                 // flat — direction unknown
          var forward = m0.inv > m1.inv;                 // arrow aims at lower invert
          var up = forward ? m0 : m1, down = forward ? m1 : m0;
          drawArrow(coords, forward, up, down);
          arrows++;
        });
      });
    });

    if (arrows === 0) {
      toast(parts === 0 ? 'אין קווי ביוב בתצוגה — התקרב/הפעל שכבת ביוב'
        : mhPairs === 0 ? 'לא נמצאו שוחות בקצוות הקווים'
        : invPairs === 0 ? 'לשוחות בקצוות אין מפלס תחתית (LowIL וכו׳)'
        : 'מפלסי התחתית שווים בקצוות — לא ניתן לקבוע כיוון');
    } else { toast(arrows + ' חיצי כיוון (לפי מפלס שוחות)'); }
  }

  function scheduleRender() { if (!ON) return; clearTimeout(deb); deb = setTimeout(render, 300); }

  function toggle() {
    ON = !ON;
    var b = document.getElementById('flow-toggle'); if (b) b.classList.toggle('active', ON);
    toast(ON ? 'כיווני זרימה: פעיל' : 'כיווני זרימה: כבוי');
    if (ON) { gMap.on('moveend', scheduleRender); render(); }
    else { gMap.off('moveend', scheduleRender); clearArrows(); }
  }

  // Entry point is the ribbon (the floating #layer-toggles panel is hidden by the
  // ArcGIS-Pro theme). The ribbon's "כיוון זרימה" command calls GISFlow.toggle().
  window.GISFlow = {
    toggle: toggle, isOn: function () { return ON; },
    // Exposed so the row-preferring lookup (LayerNaming.fromRow-backed, with
    // an inline load-order-safety fallback) is independently unit-testable.
    _parseLayer: parseLayer
  };

  var tries = 0;
  var timer = setInterval(function () {
    if (window.gMap && window.GIS) { clearInterval(timer); injectStyles(); }
    else if (++tries > 100) clearInterval(timer);
  }, 200);
})();
