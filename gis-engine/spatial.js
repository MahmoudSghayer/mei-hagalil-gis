// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — spatial.js   →   GIS.spatial
//  Minimal GIS geometry helpers.
//
//  • distance / withinRadius / geometryLength  — pure JS (no dependency),
//    using the haversine formula. Reliable offline, no server round-trip.
//  • buffer / intersects  — delegate to Turf.js when it's loaded
//    (<script src="https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js">).
//    They throw a clear error if Turf is absent, so the failure is obvious
//    rather than silent.
//
//  Coordinate convention: GeoJSON order  [lng, lat]  (EPSG:4326).
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var GIS = window.GIS;
  GIS._assert(GIS, 'core.js must load before spatial.js');

  var R = 6371000; // earth radius (m)
  function toRad(d) { return d * Math.PI / 180; }

  // Accepts: [lng,lat] | {lng,lat} | {lat,lng} | GeoJSON Point | GeoJSON Feature(Point)
  function toLngLat(p) {
    if (!p) throw new Error('[GIS.spatial] missing point');
    if (Array.isArray(p)) return [p[0], p[1]];
    if (p.type === 'Feature') return toLngLat(p.geometry);
    if (p.type === 'Point') return [p.coordinates[0], p.coordinates[1]];
    if (typeof p.lng === 'number') return [p.lng, p.lat];
    if (typeof p.lon === 'number') return [p.lon, p.lat];
    throw new Error('[GIS.spatial] unrecognised point format');
  }

  function haversine(a, b) {
    var p1 = toLngLat(a), p2 = toLngLat(b);
    var dLat = toRad(p2[1] - p1[1]), dLng = toRad(p2[0] - p1[0]);
    var lat1 = toRad(p1[1]), lat2 = toRad(p2[1]);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  GIS.spatial = {

    // Great-circle distance between two points, in metres.
    distance: function (a, b) { return haversine(a, b); },

    // Geodesic length of a LineString / MultiLineString geometry, in metres.
    // Points/Polygons return 0 (used by calculator's length(geometry)).
    geometryLength: function (geom) {
      if (!geom) return 0;
      if (geom.type === 'Feature') geom = geom.geometry;
      if (!geom) return 0;
      var sumLine = function (coords) {
        var total = 0;
        for (var i = 1; i < coords.length; i++) {
          total += haversine([coords[i - 1][0], coords[i - 1][1]], [coords[i][0], coords[i][1]]);
        }
        return total;
      };
      if (geom.type === 'LineString') return sumLine(geom.coordinates);
      if (geom.type === 'MultiLineString') return geom.coordinates.reduce(function (t, c) { return t + sumLine(c); }, 0);
      return 0;
    },

    // Filter GeoJSON features within `radiusMeters` of `point`.
    // If `features` is omitted, returns a predicate (feature)=>boolean.
    withinRadius: function (point, radiusMeters, features) {
      var center = toLngLat(point);
      var test = function (f) {
        var g = f.type === 'Feature' ? f.geometry : f;
        if (!g) return false;
        if (g.type === 'Point') return haversine(center, g.coordinates) <= radiusMeters;
        // line/polygon: nearest vertex approximation (good enough for "near me")
        var coords = g.type === 'LineString' ? g.coordinates
          : g.type === 'Polygon' ? g.coordinates[0]
          : g.type === 'MultiLineString' ? [].concat.apply([], g.coordinates) : [];
        return coords.some(function (c) { return haversine(center, c) <= radiusMeters; });
      };
      return features ? features.filter(test) : test;
    },

    // Buffer a geometry by metres → GeoJSON polygon. Requires Turf.js.
    buffer: function (geometry, meters) {
      if (!window.turf) throw new Error('[GIS.spatial] buffer() requires Turf.js (load it via CDN).');
      var g = geometry.type === 'Feature' ? geometry : { type: 'Feature', geometry: geometry, properties: {} };
      return window.turf.buffer(g, meters, { units: 'meters' });
    },

    // True if geometries a and b intersect. Requires Turf.js.
    intersects: function (a, b) {
      if (!window.turf) throw new Error('[GIS.spatial] intersects() requires Turf.js (load it via CDN).');
      var wrap = function (x) { return x.type === 'Feature' ? x : { type: 'Feature', geometry: x, properties: {} }; };
      return window.turf.booleanIntersects(wrap(a), wrap(b));
    }
  };
})();
