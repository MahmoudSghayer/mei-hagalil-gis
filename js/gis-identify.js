/* ══════════════════════════════════════════════════════════════════════════
   GIS Identify highlight — ArcGIS "Identify" behaviour.
   Click a feature (→ attribute panel) and the segment lights up on the map:
   a white casing under a bright cyan line so it pops on any basemap. Points get
   a cyan ring. Clean, unobtrusive — no endpoint dots or labels.
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
  }

  window.GISIdentify = { highlight: highlight, clear: clear };
})();
