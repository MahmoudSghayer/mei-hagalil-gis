/* ══════════════════════════════════════════════════════════════════════════
   GIS Symbology — Phase 3 (water utility).
   Attribute-driven rendering applied automatically by the engine sidebar's
   buildLayer (which calls into window.GISSymbology when present).

   Design rule: RESPECT the user's per-layer colour (the sidebar colour picker).
   Diameter drives line WEIGHT (not hue) so graduated symbology never fights an
   explicit colour choice. Status 4 (abandoned) → dashed grey. Points get
   role-based circle symbols (canvas-friendly — no divIcons, keeps perf).

   Also provides: optional diameter labels (zoom-gated) + a legend card.
   Self-contained IIFE. No hard dependency; degrades to flat colour if absent.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var ROLE_BY_CAT = {
    water_pipes: 'water', supply_pipe: 'water',
    sewage_pipes: 'sewer', main_sewer: 'sewer',
    valves: 'valve', control_valves: 'valve',
    hydrants: 'hydrant', water_meters: 'meter',
    sewage_manholes: 'manhole', fittings: 'fitting'
  };
  function roleOf(layer) {
    var cat = layer && (layer._cat || (layer.name ? layer.name.split(' · ').pop() : ''));
    return ROLE_BY_CAT[cat] || (layer && layer.geometry_type === 'Point' ? 'point' : 'line');
  }

  var LABELS_ON = false;       // toggled from ribbon; labels are zoom-gated
  var LABEL_MIN_ZOOM = 17;

  // ── diameter → class (water = inches, sewer = mm) ──────────────────────────
  function diamOf(f) {
    var p = f.properties || {};
    var v = p.LineDiamet != null ? p.LineDiamet : (p.diameter != null ? p.diameter : p.Diameter);
    v = parseFloat(v); return isFinite(v) ? v : null;
  }
  function statusOf(f) { var p = f.properties || {}; var s = p.Status != null ? p.Status : p.status; return s == null ? null : parseInt(s, 10); }

  var WATER_BREAKS = [   // inches
    { max: 2,        w: 2,   label: 'Ø ≤2"' },
    { max: 4,        w: 3.5, label: 'Ø 3–4"' },
    { max: 8,        w: 5,   label: 'Ø 6–8"' },
    { max: Infinity, w: 7,   label: 'Ø ≥10"' }
  ];
  var SEWER_BREAKS = [   // mm
    { max: 110,      w: 2.5, label: 'Ø ≤110' },
    { max: 200,      w: 4,   label: 'Ø 160–200' },
    { max: 315,      w: 5.5, label: 'Ø 250–315' },
    { max: Infinity, w: 7,   label: 'Ø ≥400' }
  ];
  function breaksFor(role) { return role === 'sewer' ? SEWER_BREAKS : WATER_BREAKS; }
  function classOf(role, d) {
    var b = breaksFor(role);
    if (d == null) return { w: 3, label: 'Ø ?' };
    for (var i = 0; i < b.length; i++) if (d <= b[i].max) return b[i];
    return b[b.length - 1];
  }

  // darken a #rrggbb toward black by amt (0..1) — subtle ramp for large pipes
  function shade(hex, amt) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex || '')) return hex;
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r * (1 - amt)); g = Math.round(g * (1 - amt)); b = Math.round(b * (1 - amt));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // ── public: line style ─────────────────────────────────────────────────────
  // Optional user-chosen render style (set when drawing/submitting a line):
  // solid | dashed | dotted | dashdot. Applied on top of the diameter/role logic.
  function dashFor(s) { return s === 'dashed' ? '8 6' : s === 'dotted' ? '2 7' : s === 'dashdot' ? '10 6 2 6' : null; }

  // Zoom-dependent size factor. Dense networks render thousands of symbols into a
  // small area at low zoom and merge into a solid blob — shrink them when zoomed
  // out, full size only at street level. Pass a zoom (MVT) or read the map (GeoJSON).
  function zoomScale(z) {
    if (z == null) z = window.gMap ? window.gMap.getZoom() : 16;
    return z >= 17 ? 1 : z >= 16 ? 0.8 : z >= 15 ? 0.62 : z >= 14 ? 0.46 : z >= 13 ? 0.34 : 0.26;
  }

  function lineStyle(layer, f, baseColor) {
    var role = roleOf(layer);
    var st = statusOf(f);
    var userDash = dashFor((f.properties || {})._style);
    var base;
    if (st === 4) base = { color: '#9aa6b2', weight: 2, opacity: 0.7, dashArray: '5 5' };  // abandoned
    else if (role !== 'water' && role !== 'sewer') base = { color: baseColor, weight: 3, opacity: 0.9 };
    else {
      var d = diamOf(f), c = classOf(role, d), idx = breaksFor(role).indexOf(c);
      base = { color: shade(baseColor, idx * 0.12), weight: c.w, opacity: 0.92, lineCap: 'round' };
    }
    if (userDash) base.dashArray = userDash;
    base.weight = Math.max(0.6, base.weight * zoomScale());
    return base;
  }

  // ── public: point symbol (canvas circleMarker, role-tuned) ─────────────────
  var POINT = {
    valve:   { r: 5, fill: null, stroke: '#fff', sw: 2 },
    hydrant: { r: 5, fill: '#dc2626', stroke: '#fff', sw: 1.4 },
    meter:   { r: 4, fill: '#0284c7', stroke: '#fff', sw: 1.2 },
    manhole: { r: 5, fill: '#92591f', stroke: '#fff', sw: 1.2 },
    fitting: { r: 3.5, fill: '#64748b', stroke: '#fff', sw: 1 },
    point:   { r: 5, fill: null, stroke: '#fff', sw: 1.2 }
  };
  function pointToLayer(layer, f, latlng, baseColor) {
    var role = roleOf(layer);
    var s = POINT[role] || POINT.point;
    var r = s.r;
    if (role === 'valve') { var vd = parseFloat((f.properties || {}).ValveDiame); if (isFinite(vd)) r = vd >= 8 ? 7 : vd >= 4 ? 6 : 5; }
    var sc = zoomScale();
    return L.circleMarker(latlng, {
      radius: Math.max(1.4, r * sc), color: s.stroke, weight: sc < 0.6 ? 0.6 : s.sw,
      fillColor: s.fill || baseColor, fillOpacity: 0.95
    });
  }

  // ── public: label (diameter), zoom-gated ───────────────────────────────────
  function wantLabel(layer) {
    if (!LABELS_ON || !window.gMap) return false;
    var role = roleOf(layer);
    if (role !== 'water' && role !== 'sewer') return false;
    return window.gMap.getZoom() >= LABEL_MIN_ZOOM;
  }
  function labelText(layer, f) {
    var d = diamOf(f); if (d == null) return null;
    var role = roleOf(layer);
    return role === 'sewer' ? 'Ø' + d + 'mm' : 'Ø' + (Number.isInteger(d) ? d : d) + '"';
  }

  // ── legend card ─────────────────────────────────────────────────────────────
  function activeLayers() {
    return (window.GISEngineSidebar && window.GISEngineSidebar.activeLayers) ? window.GISEngineSidebar.activeLayers() : [];
  }
  function legendRow(swatchHTML, text) {
    return '<div class="gsl-row"><span class="gsl-sw">' + swatchHTML + '</span><span class="gsl-t">' + text + '</span></div>';
  }
  function colorFor(layer) {
    return (layer && layer.color) || (layer && layer.geometry_type === 'Point' ? '#0d3b5e' : '#1a7fc1');
  }
  function buildLegend() {
    var layers = activeLayers();
    if (!layers.length) return '<div class="gsl-empty">הדלק שכבות כדי לראות מקרא</div>';
    var seenRamp = {}, html = '';
    layers.forEach(function (l) {
      var role = roleOf(l), base = colorFor(l), label = (window.GISLayerLabel ? window.GISLayerLabel(l._cat) : l._cat);
      if (role === 'water' || role === 'sewer') {
        if (seenRamp[role + base]) return; seenRamp[role + base] = 1;
        html += '<div class="gsl-h">' + esc(label) + '</div>';
        breaksFor(role).forEach(function (b, i) {
          html += legendRow('<span style="display:inline-block;width:26px;height:0;border-top:' + b.w + 'px solid ' + shade(base, i * 0.12) + ';vertical-align:middle"></span>', b.label);
        });
      } else {
        var s = POINT[role] || POINT.point;
        html += legendRow('<span style="display:inline-block;width:13px;height:13px;border-radius:50%;background:' + (s.fill || base) + ';border:' + s.sw + 'px solid ' + s.stroke + ';box-sizing:border-box"></span>', esc(label));
      }
    });
    html += '<div class="gsl-h">סטטוס</div>' + legendRow('<span style="display:inline-block;width:26px;height:0;border-top:2px dashed #9aa6b2;vertical-align:middle"></span>', 'נטוש (Status 4)');
    return html;
  }
  function toggleLegend() {
    var c = document.getElementById('gis-legend');
    if (c) { c.remove(); return; }
    c = document.createElement('div'); c.id = 'gis-legend';
    c.innerHTML = '<div class="gsl-head">מקרא<button class="gsl-x" title="סגור">✕</button></div><div class="gsl-body"></div>';
    document.body.appendChild(c);
    c.querySelector('.gsl-x').onclick = function () { c.remove(); };
    refreshLegend();
  }
  function refreshLegend() { var b = document.querySelector('#gis-legend .gsl-body'); if (b) b.innerHTML = buildLegend(); }

  function toggleLabels() {
    LABELS_ON = !LABELS_ON;
    if (window.GISEngineSidebar && window.GISEngineSidebar.reloadAll) window.GISEngineSidebar.reloadAll();
    var t = document.getElementById('toast');
    if (t) { t.textContent = LABELS_ON ? 'תוויות קוטר: מופעל (זום ≥ 17)' : 'תוויות קוטר: כבוי'; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2000); }
    return LABELS_ON;
  }

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  window.GISSymbology = {
    roleOf: roleOf,
    lineStyle: lineStyle,
    pointToLayer: pointToLayer,
    zoomScale: zoomScale,
    wantLabel: wantLabel,
    labelText: labelText,
    toggleLegend: toggleLegend,
    refreshLegend: refreshLegend,
    legendHTML: buildLegend,
    breaksFor: breaksFor,
    toggleLabels: toggleLabels,
    labelsOn: function () { return LABELS_ON; }
  };
})();
