/* ══════════════════════════════════════════════════════════════════════════
   GIS Routing — ArcGIS Location Platform integration (Phase 2).
   Two field-ops tools, wired into the רשת (Network) ribbon:

     • אזור שירות (Service Area) — click a point (e.g. a planned shutdown / a
       crew depot) → ArcGIS solves drive-time polygons (5/10/15 min) → drawn on
       the map + the affected Arad water meters inside each zone are counted
       (GIS.meters.getMetersInBBox + point-in-polygon). Extends the shutdown-
       impact picture with "who is within N minutes' drive".

     • מסלול נסיעה (Directions) — click a start then an end → ArcGIS solves the
       driving route → polyline + distance/time + Hebrew turn list, drawn on
       OUR map (no Waze hand-off). A "פתח ב‑Waze" button is offered as a bonus,
       so the existing Waze/Google flows are complemented, never removed.

   Pure REST over the referrer-locked window.GIS_ARCGIS_KEY — no extra libs.
   Service Area is metered ($50/1k) so it ONLY fires on a deliberate click,
   never on pan/zoom. Self-contained IIFE → window.GISRouting.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var ROUTE_URL = 'https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve';
  var SA_URL = 'https://route-api.arcgis.com/arcgis/rest/services/World/ServiceAreas/NAServer/ServiceArea_World/solveServiceArea';
  var BREAKS = [5, 10, 15];                  // drive-time minutes
  var BREAK_FILL = { 5: 0.30, 10: 0.20, 15: 0.12 };
  var METER_BBOX_CAP = 8000;

  var _armed = null;          // active one-shot map handler, or null
  var _esc = null;
  var _layers = [];           // map overlays we drew (cleared together)
  var _markers = [];
  var _card = null;

  // ── tiny helpers ────────────────────────────────────────────────────────
  function toast(m) {
    if (typeof window.showToast === 'function') { window.showToast(m); return; }
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = m; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2600);
  }
  function key() { return window.GIS_ARCGIS_KEY || ''; }
  function needKey() { if (key()) return true; toast('דרוש מפתח ArcGIS (window.GIS_ARCGIS_KEY)'); return false; }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function pane() {
    if (window.gMap && !gMap.getPane('gisRouting')) {
      var p = gMap.createPane('gisRouting'); p.style.zIndex = 648; p.style.pointerEvents = 'none';
    }
    return 'gisRouting';
  }
  // Esri rings/paths come back in [x,y] = [lng,lat] (we request outSR=4326).
  function toLatLngs(rings) { return rings.map(function (r) { return r.map(function (c) { return [c[1], c[0]]; }); }); }
  // Even-odd point-in-polygon across ALL rings of a feature (handles holes).
  function inFeature(lng, lat, rings) {
    var inside = false;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      }
    }
    return inside;
  }
  function bboxOf(features) {
    var b = { minLng: 180, minLat: 90, maxLng: -180, maxLat: -90 };
    features.forEach(function (f) {
      (f.geometry.rings || []).forEach(function (ring) {
        ring.forEach(function (c) {
          if (c[0] < b.minLng) b.minLng = c[0]; if (c[0] > b.maxLng) b.maxLng = c[0];
          if (c[1] < b.minLat) b.minLat = c[1]; if (c[1] > b.maxLat) b.maxLat = c[1];
        });
      });
    });
    return b;
  }

  // ── one-shot map-click arming (yields nothing fancy; Esc cancels) ─────────
  function disarm() {
    _armed = null;
    if (window.gMap) { gMap.off('click', onClick); gMap.getContainer().style.cursor = ''; }
    if (_esc) { document.removeEventListener('keydown', _esc); _esc = null; }
  }
  function onClick(e) { var h = _armed; if (h) h(e.latlng); }
  function arm(handler, prompt) {
    disarm();
    if (!window.gMap) { toast('המפה עדיין נטענת…'); return; }
    _armed = handler;
    gMap.getContainer().style.cursor = 'crosshair';
    gMap.on('click', onClick);
    toast(prompt);
    _esc = function (ev) { if (ev.key === 'Escape') { disarm(); toast('בוטל'); } };
    document.addEventListener('keydown', _esc);
  }

  function clearOverlays() {
    _layers.forEach(function (l) { try { gMap.removeLayer(l); } catch (e) {} });
    _markers.forEach(function (m) { try { gMap.removeLayer(m); } catch (e) {} });
    _layers = []; _markers = [];
    if (_card) { _card.remove(); _card = null; }
  }
  function clear() { disarm(); clearOverlays(); }

  // ════════════════════════════════════════════════════════════════════════
  //  SERVICE AREA
  // ════════════════════════════════════════════════════════════════════════
  function startServiceArea() {
    if (!needKey()) return;
    arm(function (ll) { disarm(); runServiceArea(ll); },
      'לחץ על נקודת הניתוק / מוקד הצוות לחישוב אזור שירות (זמני נסיעה)…');
  }

  async function runServiceArea(ll) {
    clearOverlays();
    toast('מחשב אזור שירות…');
    var facility = ll.lng.toFixed(6) + ',' + ll.lat.toFixed(6);
    var url = SA_URL + '?f=json&token=' + encodeURIComponent(key()) +
      '&facilities=' + facility +
      '&defaultBreaks=' + BREAKS.join(',') +
      '&travelDirection=esriNATravelDirectionFromFacility' +
      '&outputPolygons=esriNAOutputPolygonSimplified' +
      '&splitPolygonsAtBreaks=false&mergeSimilarPolygonRanges=false' +
      '&returnFacilities=false&outSR=4326';
    var data;
    try { data = await (await fetch(url)).json(); }
    catch (e) { toast('שגיאת רשת בחישוב אזור השירות'); return; }
    if (!data || data.error) { toast('ArcGIS: ' + ((data && data.error && data.error.message) || 'נכשל')); return; }
    var feats = (data.saPolygons && data.saPolygons.features) || [];
    if (!feats.length) { toast('לא הוחזר אזור שירות'); return; }

    // draw largest break first so smaller (darker) zones paint on top
    feats.sort(function (a, b) { return (b.attributes.ToBreak || 0) - (a.attributes.ToBreak || 0); });
    var p = pane();
    feats.forEach(function (f) {
      var br = f.attributes.ToBreak || 0;
      var poly = L.polygon(toLatLngs(f.geometry.rings || []), {
        pane: p, interactive: false, color: '#1e3a8a', weight: 1.5, opacity: 0.85,
        fillColor: '#2563eb', fillOpacity: BREAK_FILL[br] != null ? BREAK_FILL[br] : 0.15
      }).addTo(gMap);
      _layers.push(poly);
    });
    var facMarker = L.circleMarker([ll.lat, ll.lng], {
      pane: p, radius: 7, color: '#b91c1c', weight: 3, fillColor: '#fff', fillOpacity: 1
    }).addTo(gMap);
    _markers.push(facMarker);
    try { gMap.fitBounds(L.polygon(toLatLngs(feats[0].geometry.rings || [])).getBounds(), { padding: [40, 40] }); } catch (e) {}

    // affected Arad meters inside each zone (cumulative: meters within ≤break min)
    var counts = {};
    BREAKS.forEach(function (b) { counts[b] = null; });
    if (window.GIS && GIS.meters && GIS.meters.getMetersInBBox) {
      try {
        var fc = await GIS.meters.getMetersInBBox(bboxOf(feats), METER_BBOX_CAP);
        var meters = (fc && fc.features) || [];
        // ascending breaks; a disk for break b contains everything reachable ≤ b min
        var asc = feats.slice().sort(function (a, b) { return (a.attributes.ToBreak || 0) - (b.attributes.ToBreak || 0); });
        asc.forEach(function (f) {
          var br = f.attributes.ToBreak || 0, rings = f.geometry.rings || [], n = 0;
          meters.forEach(function (m) {
            var g = m.geometry; if (!g || g.type !== 'Point') return;
            if (inFeature(g.coordinates[0], g.coordinates[1], rings)) n++;
          });
          counts[br] = n;
        });
        counts.__truncated = meters.length >= METER_BBOX_CAP;
      } catch (e) { /* meters layer optional — show zones without counts */ }
    }
    showServiceCard(ll, counts);
  }

  function showServiceCard(ll, counts) {
    if (_card) _card.remove();
    var rows = BREAKS.map(function (b) {
      var c = counts[b];
      var val = c == null ? '—' : (c.toLocaleString('he-IL') + ' מדי מים');
      return '<div class="grt-row"><span class="grt-sw" style="background:#2563eb;opacity:' +
        (BREAK_FILL[b] != null ? Math.max(0.35, BREAK_FILL[b] + 0.2) : 0.4) + '"></span>' +
        '<span class="grt-lb">תוך ' + b + ' דק׳ נסיעה</span><span class="grt-val">' + esc(val) + '</span></div>';
    }).join('');
    var note = counts.__truncated ? '<div class="grt-note">⊕ נספרו ' + METER_BBOX_CAP.toLocaleString('he-IL') + ' מונים (תקרה) — צמצם אזור לדיוק</div>' : '';
    _card = card('🚐 אזור שירות — זמן נסיעה',
      '<div class="grt-sub">מנקודה ' + ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5) + '</div>' + rows + note);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  DIRECTIONS (point → point driving route)
  // ════════════════════════════════════════════════════════════════════════
  function startDirections() {
    if (!needKey()) return;
    var start = null;
    arm(function (ll) {
      if (!start) {
        start = ll;
        var p = pane();
        var m = L.marker([ll.lat, ll.lng], { pane: p, title: 'התחלה' }).addTo(gMap);
        _markers.push(m);
        toast('עכשיו לחץ על היעד…');
      } else {
        var end = ll; disarm(); runDirections(start, end);
      }
    }, 'לחץ על נקודת ההתחלה, ואז על היעד…');
  }

  async function runDirections(a, b) {
    toast('מחשב מסלול…');
    var stops = a.lng.toFixed(6) + ',' + a.lat.toFixed(6) + ';' + b.lng.toFixed(6) + ',' + b.lat.toFixed(6);
    var url = ROUTE_URL + '?f=json&token=' + encodeURIComponent(key()) +
      '&stops=' + stops + '&returnRoutes=true&returnDirections=true' +
      '&directionsLanguage=he&outSR=4326';
    var data;
    try { data = await (await fetch(url)).json(); }
    catch (e) { toast('שגיאת רשת בחישוב המסלול'); return; }
    if (!data || data.error) { toast('ArcGIS: ' + ((data && data.error && data.error.message) || 'נכשל')); return; }
    var route = data.routes && data.routes.features && data.routes.features[0];
    if (!route) { toast('לא נמצא מסלול'); return; }

    var p = pane();
    var paths = (route.geometry && route.geometry.paths) || [];
    paths.forEach(function (path) {
      var line = L.polyline(path.map(function (c) { return [c[1], c[0]]; }), {
        pane: p, interactive: false, color: '#2563eb', weight: 6, opacity: 0.9
      }).addTo(gMap);
      _layers.push(line);
    });
    var endMarker = L.marker([b.lat, b.lng], { pane: p, title: 'יעד' }).addTo(gMap);
    _markers.push(endMarker);
    if (_layers.length) { try { gMap.fitBounds(L.featureGroup(_layers).getBounds(), { padding: [50, 50] }); } catch (e) {} }

    var at = route.attributes || {};
    var km = at.Total_Kilometers != null ? Math.round(at.Total_Kilometers * 10) / 10 : null;
    var min = at.Total_TravelTime != null ? Math.round(at.Total_TravelTime) : null;
    var steps = (data.directions && data.directions[0] && data.directions[0].features) || [];
    var list = steps.map(function (s) { return '<div class="grt-step">' + esc(s.attributes && s.attributes.text || '') + '</div>'; }).join('');
    var wazeBtn = '<button class="grt-btn" id="grt-waze">🧭 פתח ב‑Waze</button>';
    _card = card('🚗 מסלול נסיעה',
      '<div class="grt-big">' + (km != null ? km + ' ק״מ' : '—') + ' · ' + (min != null ? min + ' דק׳' : '—') + '</div>' +
      wazeBtn + '<div class="grt-steps">' + (list || '<div class="grt-note">אין הנחיות</div>') + '</div>');
    var wb = document.getElementById('grt-waze');
    if (wb) wb.onclick = function () { window.open('https://www.waze.com/ul?ll=' + b.lat + ',' + b.lng + '&navigate=yes', '_blank'); };
  }

  // ── shared result card ────────────────────────────────────────────────────
  function card(title, bodyHTML) {
    var c = document.getElementById('gis-route-card');
    if (c) c.remove();
    c = document.createElement('div'); c.id = 'gis-route-card';
    c.innerHTML = '<div class="grt-head"><span>' + esc(title) + '</span>' +
      '<button class="grt-x" title="סגור">✕</button></div><div class="grt-body">' + bodyHTML + '</div>';
    document.body.appendChild(c);
    c.querySelector('.grt-x').onclick = function () { clear(); };
    return c;
  }

  (function injectCSS() {
    if (document.getElementById('gis-route-style')) return;
    var s = document.createElement('style'); s.id = 'gis-route-style';
    s.textContent =
      '#gis-route-card{position:absolute;bottom:18px;left:14px;z-index:1200;width:300px;max-height:60vh;overflow:auto;' +
      'background:#fff;border:1px solid #d6dbe2;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.22);direction:rtl;font-size:13px}' +
      '#gis-route-card .grt-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 12px;' +
      'background:#0d3b5e;color:#fff;border-radius:10px 10px 0 0;font-weight:700}' +
      '#gis-route-card .grt-x{background:transparent;border:none;color:#fff;font-size:15px;cursor:pointer;line-height:1}' +
      '#gis-route-card .grt-body{padding:10px 12px}' +
      '#gis-route-card .grt-sub,#gis-route-card .grt-note{color:#64748b;font-size:11px;margin:2px 0 8px}' +
      '#gis-route-card .grt-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid #eef1f4}' +
      '#gis-route-card .grt-sw{width:14px;height:14px;border-radius:3px;flex:none;border:1px solid #1e3a8a}' +
      '#gis-route-card .grt-lb{flex:1}#gis-route-card .grt-val{font-weight:700;color:#0d3b5e}' +
      '#gis-route-card .grt-big{font-size:18px;font-weight:800;color:#0d3b5e;margin-bottom:8px}' +
      '#gis-route-card .grt-btn{width:100%;padding:7px;margin-bottom:8px;border:1px solid #2563eb;background:#eff4ff;color:#1e3a8a;' +
      'border-radius:7px;font-weight:700;cursor:pointer}' +
      '#gis-route-card .grt-steps{max-height:30vh;overflow:auto}' +
      '#gis-route-card .grt-step{padding:5px 0;border-top:1px solid #eef1f4;color:#334155}';
    document.head.appendChild(s);
  })();

  window.GISRouting = {
    startServiceArea: startServiceArea,
    startDirections: startDirections,
    clear: clear,
    disarm: disarm
  };
})();
