/* ══════════════════════════════════════════════════════════════════════════
   GIS Edit — geometry engine (window.GISEditGeom).
   Pure GeoJSON algorithms for Edit Mode (js/gis-edit.js): no Leaflet, no DOM,
   no network. Everything here operates on plain GeoJSON `geometry` objects
   ({type, coordinates}) and [lng,lat] pairs, so it loads and runs the same in
   a browser tab and in a Node vm test sandbox (test/gis/edit-geom.test.js).

   Capability model: every geometry TYPE belongs to one of three FAMILIES —
   Point (Point/MultiPoint), LineString (LineString/MultiLineString), Polygon
   (Polygon/MultiPolygon) — and caps(type) says what Edit Mode sub-modes make
   sense for it (move/vertices/addVertex/removeVertex/extend/shorten) plus its
   minimum vertex count. gis-edit.js drives its HUD buttons and Geoman/manual
   editing from this, never hard-codes per-type behaviour itself.

   The bounds box mirrors the server-side check in
   gis-engine/sql/migrations/2026-09-13-edit-mode-geometry.sql so client-side
   validate() rejects the same geometries the DB would (fail fast, same message
   family — Hebrew, no server round-trip needed to know it's bad).
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── type families + capabilities ────────────────────────────────────────
  var TYPE_FAMILY = {
    Point: 'Point', MultiPoint: 'Point',
    LineString: 'LineString', MultiLineString: 'LineString',
    Polygon: 'Polygon', MultiPolygon: 'Polygon'
  };

  function typeFamily(type) { return TYPE_FAMILY[type] || null; }

  function caps(type) {
    var fam = typeFamily(type);
    if (fam === 'Point') {
      return { move: true, vertices: false, addVertex: false, removeVertex: false, extend: false, shorten: false, minVertices: 1 };
    }
    if (fam === 'LineString') {
      return { move: true, vertices: true, addVertex: true, removeVertex: true, extend: true, shorten: true, minVertices: 2 };
    }
    if (fam === 'Polygon') {
      return { move: true, vertices: true, addVertex: true, removeVertex: true, extend: false, shorten: false, minVertices: 4 };
    }
    return { move: false, vertices: false, addVertex: false, removeVertex: false, extend: false, shorten: false, minVertices: 0 };
  }

  // ── geographic bounds (same box as validate_feature_geometry() in the SQL) ─
  var BOUNDS = { minLng: 33.5, maxLng: 36.5, minLat: 29, maxLat: 34 };

  // ── small pure helpers ───────────────────────────────────────────────────
  function deepClone(g) { return g == null ? g : JSON.parse(JSON.stringify(g)); }

  function coordEq(a, b) { return a[0] === b[0] && a[1] === b[1]; }

  // Walks every [lng,lat] leaf of a geometry's `coordinates` tree.
  function walkCoords(g, fn) {
    if (!g || !g.coordinates) return;
    (function rec(c) {
      if (typeof c[0] === 'number') { fn(c); return; }
      for (var i = 0; i < c.length; i++) rec(c[i]);
    })(g.coordinates);
  }

  // Flat list of "parts" (arrays of [lng,lat]) — one per line/ring — mirrors
  // js/gis-engine-sidebar.js's private _partsOf() (same shape, independently
  // testable here for the geometry engine). Point families have no parts.
  function _partsOf(g) {
    if (!g) return [];
    if (g.type === 'LineString') return [g.coordinates];
    if (g.type === 'MultiLineString' || g.type === 'Polygon') return g.coordinates;
    if (g.type === 'MultiPolygon') {
      var out = [];
      g.coordinates.forEach(function (poly) { poly.forEach(function (ring) { out.push(ring); }); });
      return out;
    }
    return [];
  }

  function countPoints(g) {
    if (!g) return 0;
    if (g.type === 'Point') return (g.coordinates && g.coordinates.length === 2) ? 1 : 0;
    if (g.type === 'MultiPoint') return (g.coordinates || []).length;
    if (g.type === 'LineString') return (g.coordinates || []).length;
    if (g.type === 'MultiLineString') return (g.coordinates || []).reduce(function (t, c) { return t + c.length; }, 0);
    if (g.type === 'Polygon') return (g.coordinates || []).reduce(function (t, c) { return t + c.length; }, 0);
    if (g.type === 'MultiPolygon') return (g.coordinates || []).reduce(function (t, poly) {
      return t + poly.reduce(function (t2, r) { return t2 + r.length; }, 0);
    }, 0);
    return 0;
  }

  // ── normalize: dedupe consecutive duplicate coords per part, close rings ──
  // Guard: never reduce a part below the vertex count it already had when it
  // was already at (or under) the family's minimum — dedup only kicks in when
  // there's slack above the minimum, and backs off entirely if it would have
  // dropped the part under the minimum anyway (keeps the original instead).
  function dedupeConsecutive(coords, minLen) {
    if (!coords || coords.length <= minLen) return coords ? coords.slice() : coords;
    var out = [coords[0]];
    for (var i = 1; i < coords.length; i++) {
      var prev = out[out.length - 1], cur = coords[i];
      if (!coordEq(prev, cur)) out.push(cur);
    }
    return out.length < minLen ? coords.slice() : out;
  }
  function closeRing(ring) {
    if (!ring || !ring.length) return ring;
    var first = ring[0], last = ring[ring.length - 1];
    if (!coordEq(first, last)) { ring = ring.slice(); ring.push([first[0], first[1]]); }
    return ring;
  }

  function normalize(g) {
    if (!g) return g;
    var out = deepClone(g);
    var fam = typeFamily(out.type);
    var cp = caps(out.type);
    if (fam === 'Point') {
      if (out.type === 'MultiPoint') out.coordinates = dedupeConsecutive(out.coordinates, cp.minVertices);
      return out;
    }
    if (fam === 'LineString') {
      if (out.type === 'LineString') {
        out.coordinates = dedupeConsecutive(out.coordinates, cp.minVertices);
      } else {
        out.coordinates = out.coordinates.map(function (part) { return dedupeConsecutive(part, cp.minVertices); });
      }
      return out;
    }
    if (fam === 'Polygon') {
      function fixRing(ring) { return closeRing(dedupeConsecutive(ring, cp.minVertices)); }
      if (out.type === 'Polygon') out.coordinates = out.coordinates.map(fixRing);
      else out.coordinates = out.coordinates.map(function (poly) { return poly.map(fixRing); });
      return out;
    }
    return out;
  }

  // ── translate: shift every coordinate by (dLng,dLat) — non-mutating ──────
  function translate(g, dLng, dLat) {
    if (!g) return g;
    var out = deepClone(g);
    (function rec(c) {
      if (typeof c[0] === 'number') { c[0] += dLng; c[1] += dLat; return; }
      for (var i = 0; i < c.length; i++) rec(c[i]);
    })(out.coordinates);
    return out;
  }

  // ── boundsCheck: same box as the DB-side guard ───────────────────────────
  function boundsCheck(g) {
    var bad = false;
    walkCoords(g, function (c) {
      if (c[0] < BOUNDS.minLng || c[0] > BOUNDS.maxLng || c[1] < BOUNDS.minLat || c[1] > BOUNDS.maxLat) bad = true;
    });
    return bad ? { ok: false, reason: 'הגאומטריה מחוץ לתחום הגיאוגרפי הצפוי' } : { ok: true };
  }

  // ── selfIntersects: hand-rolled O(n²) proper segment intersection ───────
  // orient() = sign of the cross product (b-a)×(c-a); segsIntersect() is the
  // classic orientation + on-segment test for two closed line segments.
  function orient(a, b, c) {
    var v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return v > 1e-12 ? 1 : (v < -1e-12 ? -1 : 0);
  }
  function onSegment(a, b, p) {
    return Math.min(a[0], b[0]) - 1e-12 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-12 &&
           Math.min(a[1], b[1]) - 1e-12 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-12;
  }
  function segsIntersect(p1, p2, p3, p4) {
    var o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4), o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSegment(p1, p2, p3)) return true;
    if (o2 === 0 && onSegment(p1, p2, p4)) return true;
    if (o3 === 0 && onSegment(p3, p4, p1)) return true;
    if (o4 === 0 && onSegment(p3, p4, p2)) return true;
    return false;
  }
  // segments of one part; `closed` (ring) also tests the implicit closing
  // segment (last→first) UNLESS the coords already repeat the first point.
  function segmentsOf(coords, closed) {
    var segs = [];
    for (var i = 0; i < coords.length - 1; i++) segs.push([coords[i], coords[i + 1]]);
    if (closed) {
      var last = coords[coords.length - 1], first = coords[0];
      if (!coordEq(last, first)) segs.push([last, first]);
    }
    return segs;
  }
  function partSelfIntersects(coords, closed) {
    var segs = segmentsOf(coords, closed);
    var n = segs.length;
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        if (j === i + 1) continue;                        // adjacent — shares an endpoint by construction
        if (closed && i === 0 && j === n - 1) continue;    // ring closure vs. the first segment — also shares a vertex
        if (segsIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) return true;
      }
    }
    return false;
  }
  function selfIntersects(g) {
    if (!g) return false;
    var fam = typeFamily(g.type);
    if (fam === 'Point' || !fam) return false;
    var closed = fam === 'Polygon';
    return _partsOf(g).some(function (part) { return partSelfIntersects(part, closed); });
  }

  // ── validate: missing → structural → min points → self-intersection → bounds ─
  function validate(g) {
    if (!g || !g.coordinates) return { ok: false, reason: 'גאומטריה חסרה' };
    var fam = typeFamily(g.type);
    if (!fam) return { ok: false, reason: 'סוג גאומטריה לא נתמך' };
    if (countPoints(g) === 0) return { ok: false, reason: 'גאומטריה ריקה' };
    if (fam === 'LineString' || fam === 'Polygon') {
      var cp = caps(g.type);
      var ok = _partsOf(g).every(function (c) { return c.length >= cp.minVertices; });
      if (!ok) return { ok: false, reason: 'מספר נקודות לא מספיק (מינימום ' + cp.minVertices + ')' };
    }
    if (selfIntersects(g)) return { ok: false, reason: 'הגאומטריה חוצה את עצמה' };
    var bc = boundsCheck(g);
    if (!bc.ok) return bc;
    return { ok: true };
  }

  // ── equirectangular metric helpers (ported from gis-engine-sidebar.js) ───
  function _scaleAt(lat) { return { x: 111320 * Math.cos(lat * Math.PI / 180), y: 110540 }; }
  function _distM(a, b, sc) { var dx = (a[0] - b[0]) * sc.x, dy = (a[1] - b[1]) * sc.y; return Math.hypot(dx, dy); }
  function _segDistM(p, a, b, sc) {
    var ax = a[0] * sc.x, ay = a[1] * sc.y, bx = b[0] * sc.x, by = b[1] * sc.y, px = p[0] * sc.x, py = p[1] * sc.y;
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    var t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // nearestPointOnGeometry(g, [lng,lat]) → {distM, partIndex, segIndex}.
  // Point families measure to the nearest coordinate (partIndex = its index,
  // segIndex 0); Line/Polygon families measure to the nearest segment across
  // every part (partIndex = the part, segIndex = the segment's first vertex).
  function nearestPointOnGeometry(g, click) {
    if (!g || !click) return null;
    var sc = _scaleAt(click[1]);
    var fam = typeFamily(g.type);
    if (fam === 'Point') {
      if (g.type === 'Point') return { distM: _distM(click, g.coordinates, sc), partIndex: 0, segIndex: 0 };
      var bestP = null;
      (g.coordinates || []).forEach(function (c, i) {
        var d = _distM(click, c, sc);
        if (!bestP || d < bestP.distM) bestP = { distM: d, partIndex: i, segIndex: 0 };
      });
      return bestP || { distM: Infinity, partIndex: -1, segIndex: -1 };
    }
    var best = null;
    _partsOf(g).forEach(function (coords, pi) {
      for (var i = 0; i < coords.length - 1; i++) {
        var d = _segDistM(click, coords[i], coords[i + 1], sc);
        if (!best || d < best.distM) best = { distM: d, partIndex: pi, segIndex: i };
      }
    });
    return best || { distM: Infinity, partIndex: -1, segIndex: -1 };
  }

  // ── extend / shorten a LineString family geometry at its nearest end ─────
  // "Nearest end" = whichever endpoint, across every part for a
  // MultiLineString, is closest to the click.
  function nearestEndPart(parts, click, sc) {
    var bestIdx = -1, bestD = Infinity, bestEnd = null;
    parts.forEach(function (coords, i) {
      if (!coords.length) return;
      var dS = _distM(click, coords[0], sc), dE = _distM(click, coords[coords.length - 1], sc);
      if (dS < bestD) { bestD = dS; bestIdx = i; bestEnd = 'start'; }
      if (dE < bestD) { bestD = dE; bestIdx = i; bestEnd = 'end'; }
    });
    return bestIdx < 0 ? null : { partIndex: bestIdx, end: bestEnd, distM: bestD };
  }

  function appendVertexAtNearestEnd(g, click) {
    if (typeFamily(g && g.type) !== 'LineString') return null;
    var sc = _scaleAt(click[1]);
    var out = deepClone(g);
    var pt = [click[0], click[1]];
    if (out.type === 'LineString') {
      var coords = out.coordinates;
      if (!coords.length) { coords.push(pt); return out; }
      var dStart = _distM(click, coords[0], sc), dEnd = _distM(click, coords[coords.length - 1], sc);
      if (dStart <= dEnd) coords.unshift(pt); else coords.push(pt);
      return out;
    }
    // MultiLineString
    var hit = nearestEndPart(out.coordinates, click, sc);
    if (!hit) return null;
    if (hit.end === 'start') out.coordinates[hit.partIndex].unshift(pt);
    else out.coordinates[hit.partIndex].push(pt);
    return out;
  }

  function removeVertexAtNearestEnd(g, click, minVertices) {
    if (typeFamily(g && g.type) !== 'LineString') return { ok: false, reason: 'לא ניתן לקצר גאומטריה זו' };
    minVertices = minVertices || 2;
    var sc = _scaleAt(click[1]);
    var out = deepClone(g);
    if (out.type === 'LineString') {
      var coords = out.coordinates;
      if (coords.length <= minVertices) return { ok: false, reason: 'לא ניתן לקצר מתחת למינימום נקודות (' + minVertices + ')' };
      var dStart = _distM(click, coords[0], sc), dEnd = _distM(click, coords[coords.length - 1], sc);
      if (dStart <= dEnd) coords.shift(); else coords.pop();
      return { ok: true, geometry: out };
    }
    // MultiLineString
    var hit = nearestEndPart(out.coordinates, click, sc);
    if (!hit) return { ok: false, reason: 'לא נמצא חלק מתאים' };
    var part = out.coordinates[hit.partIndex];
    if (part.length <= minVertices) return { ok: false, reason: 'לא ניתן לקצר מתחת למינימום נקודות (' + minVertices + ')' };
    if (hit.end === 'start') part.shift(); else part.pop();
    return { ok: true, geometry: out };
  }

  // ── fromEditable: rebuild a GeoJSON geometry from a live Leaflet layer ───
  // Fixes the historical bug where saveGeom() took features[0] of a
  // FeatureGroup's toGeoJSON() and silently dropped every point but the
  // first for a MultiPoint feature (a FeatureGroup of markers has no `.pm`
  // and no single toGeoJSON() geometry of its own — it must be reassembled
  // from each marker's current getLatLng()).
  function unwrapGJ(gj) {
    if (!gj) return null;
    if (gj.type === 'FeatureCollection') return (gj.features && gj.features[0] && gj.features[0].geometry) || null;
    if (gj.type === 'Feature') return gj.geometry || null;
    return gj; // already a bare geometry
  }
  function fromEditable(layerOrGroup, originalType) {
    var geom = null;
    if (layerOrGroup && typeof layerOrGroup.getLayers === 'function') {
      // FeatureGroup of markers (MultiPoint editing surface) — reassemble
      // from live marker positions, in their current DOM/array order.
      geom = {
        type: 'MultiPoint',
        coordinates: layerOrGroup.getLayers().map(function (l) {
          var ll = l.getLatLng();
          return [ll.lng, ll.lat];
        })
      };
    } else if (layerOrGroup && typeof layerOrGroup.toGeoJSON === 'function') {
      geom = unwrapGJ(layerOrGroup.toGeoJSON());
    }
    if (!geom && originalType) return null;
    return geom ? normalize(geom) : null;
  }

  window.GISEditGeom = {
    TYPE_FAMILY: TYPE_FAMILY,
    typeFamily: typeFamily,
    caps: caps,
    deepClone: deepClone,
    normalize: normalize,
    translate: translate,
    boundsCheck: boundsCheck,
    selfIntersects: selfIntersects,
    validate: validate,
    nearestPointOnGeometry: nearestPointOnGeometry,
    appendVertexAtNearestEnd: appendVertexAtNearestEnd,
    removeVertexAtNearestEnd: removeVertexAtNearestEnd,
    fromEditable: fromEditable,
    // test-only exports (mirrors the GISEdit._parseLayerName / GISEngineSidebar._partsOf convention)
    _partsOf: _partsOf,
    _scaleAt: _scaleAt
  };
})();
