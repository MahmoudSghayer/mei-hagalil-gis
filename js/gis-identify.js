/* ══════════════════════════════════════════════════════════════════════════
   GIS Identify highlight — ArcGIS "Identify" behaviour.
   Click a feature (→ attribute panel) and the segment lights up on the map:
   a white casing under a bright cyan line so it pops on any basemap, and for
   pipes the START is marked green ("התחלה") and the END red ("סוף") so you know
   exactly which קטע you're on. Points get a cyan ring.
   Self-contained IIFE; pane `gisIdentify` (z660, non-interactive). Driven by two
   one-line hooks: openPanelFor (highlight) + GISPanel.close (clear).
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var _layers = [];

  function ensurePane() {
    if (!window.gMap.getPane('gisIdentify')) {
      var p = window.gMap.createPane('gisIdentify');
      p.style.zIndex = 660;
      p.style.pointerEvents = 'none';   // decorative — never eats clicks
    }
    return 'gisIdentify';
  }

  function clear() {
    _layers.forEach(function (l) { try { window.gMap.removeLayer(l); } catch (e) {} });
    _layers = [];
  }

  // [lng,lat] of the first and last vertex of a line geometry, else null.
  function endpointsOf(g) {
    if (g.type === 'LineString') {
      var c = g.coordinates; if (!c || !c.length) return null;
      return { start: c[0], end: c[c.length - 1] };
    }
    if (g.type === 'MultiLineString') {
      var parts = g.coordinates; if (!parts || !parts.length) return null;
      var first = parts[0], last = parts[parts.length - 1];
      if (!first.length || !last.length) return null;
      return { start: first[0], end: last[last.length - 1] };
    }
    return null;
  }

  function endpointMarker(lngLat, color, label) {
    return L.circleMarker([lngLat[1], lngLat[0]], {
      pane: 'gisIdentify', interactive: false, radius: 7, color: '#fff', weight: 2.5,
      fillColor: color, fillOpacity: 1
    }).bindTooltip(label, { permanent: true, direction: 'top', className: 'gis-id-tip', offset: [0, -6] });
  }

  function highlight(feature) {
    if (!window.gMap || !feature || !feature.geometry) return;
    clear();
    var pane = ensurePane();
    var g = feature.geometry;

    if (g.type === 'Point' || g.type === 'MultiPoint') {
      _layers.push(L.geoJSON(g, {
        pane: pane, interactive: false,
        pointToLayer: function (f, ll) { return L.circleMarker(ll, { pane: pane, radius: 10, color: '#06b6d4', weight: 4, fillColor: '#cffafe', fillOpacity: 0.55 }); }
      }).addTo(window.gMap));
      return;
    }

    // white casing under a bright cyan line → readable on any basemap
    _layers.push(L.geoJSON(g, { pane: pane, interactive: false, style: { color: '#ffffff', weight: 9, opacity: 0.9 } }).addTo(window.gMap));
    _layers.push(L.geoJSON(g, { pane: pane, interactive: false, style: { color: '#06b6d4', weight: 5, opacity: 1, fillColor: '#22d3ee', fillOpacity: 0.15 } }).addTo(window.gMap));

    var e = endpointsOf(g);
    if (e) {
      _layers.push(endpointMarker(e.start, '#16a34a', 'התחלה').addTo(window.gMap));
      _layers.push(endpointMarker(e.end, '#dc2626', 'סוף').addTo(window.gMap));
    }
  }

  (function injectCSS() {
    if (document.getElementById('gis-id-style')) return;
    var s = document.createElement('style'); s.id = 'gis-id-style';
    s.textContent =
      '.gis-id-tip{background:#0f172a;color:#fff;border:none;font-size:10.5px;font-weight:700;padding:2px 6px;' +
      'border-radius:5px;box-shadow:0 2px 8px rgba(0,0,0,.25)}' +
      '.gis-id-tip:before{border-top-color:#0f172a}';
    document.head.appendChild(s);
  })();

  window.GISIdentify = { highlight: highlight, clear: clear };
})();
