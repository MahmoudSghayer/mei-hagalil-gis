// ════════════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Flow-direction arrows (L4a)
//  Toggle "כיוון זרימה": overlays downstream arrows on WATER lines, derived from
//  the pipe's own end elevations (StartHeigh / EndHeight) — water flows from the
//  higher end to the lower. Height-based (gravity / elevation gradient); pipes
//  without both heights are left unmarked. Refreshes on pan/zoom.
//  L4b/L4c (manhole TopoHeight/LowIL + terrain DEM fallback) come later.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var ON = false, layerGroup = null, deb = null;
  var WATER_CATS = { water_pipes: 1, supply_pipe: 1, main_water: 1 };
  var MIN_ZOOM = 16;          // arrows only when zoomed in (perf + legibility)
  var MAX_FEATURES = 4000;    // safety cap per layer

  function sb() { return window.GIS ? GIS.sb() : window.gSb; }
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

  function drawArrow(coords, forward, p) {
    var seq = forward ? coords : coords.slice().reverse();   // oriented downstream
    if (seq.length < 2) return;
    var mi = Math.max(1, Math.floor(seq.length / 2));
    var a = seq[mi - 1], b = seq[mi];
    var mid = [(a[1] + b[1]) / 2, (a[0] + b[0]) / 2];         // [lat,lng]
    var m = L.marker(mid, { icon: arrowIcon(bearing(a, b) - 90), keyboard: false });
    m.bindTooltip('כיוון זרימה · גובה ' + p.StartHeigh + ' → ' + p.EndHeight +
      (p.PressureAr ? ' · אזור לחץ ' + p.PressureAr : ''), { direction: 'top' });
    m.addTo(layerGroup);
  }

  async function render() {
    if (!ON || !window.gMap || !window.GIS || !GIS.features) return;
    clearArrows();
    if (gMap.getZoom() < MIN_ZOOM) { toast('התקרב כדי לראות כיווני זרימה'); return; }
    layerGroup = L.layerGroup().addTo(gMap);
    var bnd = gMap.getBounds();
    var bbox = { minLng: bnd.getWest(), minLat: bnd.getSouth(), maxLng: bnd.getEast(), maxLat: bnd.getNorth() };
    var layers = (window.GISEngineSidebar && GISEngineSidebar.activeLayers) ? GISEngineSidebar.activeLayers() : [];
    var fcs = await Promise.all(layers.map(function (l) {
      return GIS.features.getInBBox(l.id, bbox, MAX_FEATURES).catch(function () { return null; });
    }));
    if (!ON) { clearArrows(); return; }   // toggled off while loading
    fcs.forEach(function (fc) {
      if (!fc || !fc.features) return;
      fc.features.forEach(function (f) {
        if (!f.geometry || f.geometry.type !== 'LineString') return;
        var p = f.properties || {};
        if (!WATER_CATS[p._category]) return;
        var sh = parseFloat(p.StartHeigh), eh = parseFloat(p.EndHeight);
        if (!isFinite(sh) || !isFinite(eh) || sh === eh) return;
        drawArrow(f.geometry.coordinates, sh > eh, p);   // downstream = lower end
      });
    });
  }

  function scheduleRender() { if (!ON) return; clearTimeout(deb); deb = setTimeout(render, 300); }

  function toggle() {
    ON = !ON;
    var b = document.getElementById('flow-toggle'); if (b) b.classList.toggle('active', ON);
    if (ON) { gMap.on('moveend', scheduleRender); render(); }
    else { gMap.off('moveend', scheduleRender); clearArrows(); }
  }

  function buildToggle() {
    var host = document.getElementById('layer-toggles');
    if (!host || document.getElementById('flow-toggle')) return;
    var btn = document.createElement('button');
    btn.id = 'flow-toggle'; btn.className = 'layer-toggle-btn'; btn.title = 'הצג/הסתר כיווני זרימה על קווי מים';
    btn.innerHTML = '<span class="lt-icon">➤</span><span class="lt-label">כיוון זרימה</span>';
    btn.onclick = toggle;
    host.appendChild(btn);
  }

  var tries = 0;
  var timer = setInterval(function () {
    if (window.gMap && window.GIS && document.getElementById('layer-toggles')) { clearInterval(timer); injectStyles(); buildToggle(); }
    else if (++tries > 100) clearInterval(timer);
  }, 200);
})();
