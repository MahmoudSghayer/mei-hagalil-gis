/* ══════════════════════════════════════════════════════════════════════════
   Print / Layout composer — ArcGIS-style map sheet.
   Compact draggable toolbar; toggle Title / Legend / North arrow / Scale bar
   (each draggable); draw a print AREA (overlays go non-interactive so the drag
   is free); print fits that area TIGHTLY (fractional zoom). Editable legend.
   Native print, map size locked so tiles never blank. Self-contained IIFE.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2600); }
  function mapHost() { return window.gMap && window.gMap.getContainer(); }

  var active = false, els = {}, moveHandler = null, orientStyle = null;
  var printBounds = null, printRectLayer = null;

  function enter() {
    if (!window.gMap) { toast('המפה עדיין נטענת…'); return; }
    if (active) { exit(); return; }
    active = true;
    buildBar();
    ['title', 'legend', 'north', 'scale'].forEach(addEl);
    moveHandler = function () { updateScale(); };
    window.gMap.on('moveend zoomend', moveHandler);
    toast('פריסה: גרור רכיבים, ערוך מקרא, בחר אזור — ואז הדפס');
  }
  function exit() {
    active = false;
    Object.keys(els).forEach(function (k) { if (els[k] && els[k].el) { if (els[k].el._ro) els[k].el._ro.disconnect(); els[k].el.remove(); } });
    els = {};
    clearArea();
    var bar = document.getElementById('gis-layout-bar'); if (bar) bar.remove();
    if (moveHandler && window.gMap) { window.gMap.off('moveend zoomend', moveHandler); moveHandler = null; }
    document.body.classList.remove('gis-printing');
  }

  // ── compact toolbar (draggable by its title) ────────────────────────────────────
  function buildBar() {
    if (document.getElementById('gis-layout-bar')) return;
    var bar = document.createElement('div'); bar.id = 'gis-layout-bar';
    bar.innerHTML =
      '<span class="glb-grip" title="גרור להזזת הסרגל">⠿ פריסה</span>' +
      '<input id="glb-titletext" class="glb-in" value="מפת תשתית מים" title="כותרת">' +
      '<label class="glb-tg"><input type="checkbox" data-el="title" checked>כותרת</label>' +
      '<label class="glb-tg"><input type="checkbox" data-el="legend" checked>מקרא</label>' +
      '<label class="glb-tg"><input type="checkbox" data-el="north" checked>צפון</label>' +
      '<label class="glb-tg"><input type="checkbox" data-el="scale" checked>קנ״מ</label>' +
      '<button class="glb-area" id="glb-area">✏️ בחר אזור</button>' +
      '<select id="glb-orient" class="glb-in"><option value="landscape">לרוחב</option><option value="portrait">לאורך</option></select>' +
      '<button class="glb-print">🖨️ הדפס</button>' +
      '<button class="glb-exit">✕</button>';
    document.body.appendChild(bar);
    Array.prototype.forEach.call(bar.querySelectorAll('input[data-el]'), function (cb) {
      cb.onchange = function () { toggleEl(cb.getAttribute('data-el'), cb.checked); };
    });
    bar.querySelector('#glb-titletext').oninput = function (e) {
      if (els.title && els.title.el) { var t = els.title.el.querySelector('.lt-t'); if (t) t.textContent = e.target.value; }
    };
    bar.querySelector('#glb-orient').onchange = function (e) { setOrient(e.target.value); };
    bar.querySelector('#glb-area').onclick = startAreaSelect;
    bar.querySelector('.glb-print').onclick = doPrint;
    bar.querySelector('.glb-exit').onclick = exit;
    dragByHandle(bar, bar.querySelector('.glb-grip'));
    setOrient('landscape');
  }
  function setOrient(o) {
    if (!orientStyle) { orientStyle = document.createElement('style'); document.head.appendChild(orientStyle); }
    orientStyle.textContent = '@media print{@page{size:' + o + ';margin:8mm}}';
  }
  // drag a fixed/absolute element by a handle, using viewport coords
  function dragByHandle(el, handle) {
    if (!handle) return;
    handle.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      var r = el.getBoundingClientRect(), bl = r.left, bt = r.top, sx = ev.clientX, sy = ev.clientY;
      el.style.left = bl + 'px'; el.style.top = bt + 'px'; el.style.transform = 'none';
      function mv(e) { el.style.left = (bl + e.clientX - sx) + 'px'; el.style.top = (bt + e.clientY - sy) + 'px'; }
      function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  // ── draggable layout elements ──────────────────────────────────────────────────
  function addEl(key) {
    var host = mapHost(); if (!host) return;
    var el = document.createElement('div'); el.className = 'gis-lay-ov gis-lay-' + key;
    if (key === 'title') {
      var tt = (document.getElementById('glb-titletext') || {}).value || 'מפת תשתית מים';
      el.innerHTML = '<div class="lt-t">' + esc(tt) + '</div><div class="lt-m">💧 מי הגליל GIS · ' + new Date().toLocaleDateString('he-IL') + '</div>';
      el.style.top = '8px'; el.style.left = '50%'; el.style.transform = 'translateX(-50%)';
    } else if (key === 'legend') {
      el.innerHTML = legendInner();
      el.style.bottom = '24px'; el.style.left = '12px';
    } else if (key === 'north') {
      el.innerHTML = '<div class="ln-a">⬆</div><div class="ln-n">צפון</div>';
      el.style.top = '60px'; el.style.right = '12px';
    } else if (key === 'scale') {
      el.innerHTML = '<span class="ls-line"></span><span class="ls-lbl">—</span>';
      el.style.bottom = '24px'; el.style.right = '12px';
    }
    host.appendChild(el);
    if (window.L && L.DomEvent) { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); }
    makeDraggable(el);
    els[key] = { el: el, on: true, scale: 1 };
    makeResizable(el, key);
    if (key === 'legend') wireLegend(el);
    if (key === 'scale') updateScale();
  }
  // Corner grip → drag to scale uniformly. The box hugs its content (width:
  // max-content) so there is never empty space. Down/outward = bigger.
  function makeResizable(el, key) {
    var g = document.createElement('div'); g.className = 'ov-grip'; g.title = 'גרור לשינוי גודל';
    el.appendChild(g);
    g.addEventListener('mousedown', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      var sx = ev.clientX, sy = ev.clientY, s0 = (els[key] && els[key].scale) || 1;
      function mv(e) {
        var grow = (e.clientY - sy) + (sx - e.clientX);     // drag down + left (RTL outward) = larger
        var s = Math.max(0.5, Math.min(6, s0 + grow / 170));
        if (els[key]) els[key].scale = s;
        el.style.setProperty('--ov-scale', s);
        if (key === 'scale') updateScale();
      }
      function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }
  function toggleEl(key, on) {
    if (on) { if (!els[key] || !els[key].el) addEl(key); else els[key].el.style.display = ''; }
    else if (els[key] && els[key].el) els[key].el.style.display = 'none';
  }

  // ── dynamic, editable legend ───────────────────────────────────────────────────
  function swatch(l) {
    var color = l.color || (l.geometry_type === 'Point' ? '#0d3b5e' : l.geometry_type === 'Polygon' ? '#0e7490' : '#1a7fc1');
    if (l.geometry_type === 'Point') return '<span style="display:inline-block;width:0.95em;height:0.95em;border-radius:50%;background:' + color + ';border:1.5px solid #fff;box-shadow:0 0 0 1px ' + color + '"></span>';
    if (l.geometry_type === 'Polygon') return '<span style="display:inline-block;width:1.2em;height:0.8em;background:' + color + '33;border:1.5px solid ' + color + '"></span>';
    return '<span style="display:inline-block;width:1.6em;height:0;border-top:0.22em solid ' + color + ';vertical-align:middle"></span>';
  }
  function legendInner() {
    var layers = (window.GISEngineSidebar && window.GISEngineSidebar.activeLayers) ? window.GISEngineSidebar.activeLayers() : [];
    var rows = layers.map(function (l) {
      var name = window.GISLayerLabel ? window.GISLayerLabel(l._cat || '') : (l._cat || l.name || '');
      return '<div class="ll-row"><span class="ll-sw">' + swatch(l) + '</span>' +
        '<span class="ll-name" contenteditable="true">' + esc(name) + '</span>' +
        '<button class="ll-del" title="הסר">×</button></div>';
    }).join('');
    if (!rows) rows = '<div class="ll-empty">הדלק שכבות במפה כדי למלא את המקרא</div>';
    return '<div class="ll-h" contenteditable="true">מקרא</div><div class="ll-rows">' + rows + '</div>';
  }
  function wireLegend(el) {
    Array.prototype.forEach.call(el.querySelectorAll('.ll-del'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); var row = b.closest('.ll-row'); if (row) row.remove(); };
    });
  }

  function updateScale() {
    if (!els.scale || !els.scale.el || !window.gMap) return;
    var c = window.gMap.getCenter();
    var mpp = 40075016.686 * Math.abs(Math.cos(c.lat * Math.PI / 180)) / Math.pow(2, window.gMap.getZoom() + 8);
    var target = 110 * mpp, pows = [1, 2, 5], d = 1;
    outer: for (var e = 0; e < 8; e++) { for (var i = 0; i < 3; i++) { d = pows[i] * Math.pow(10, e); if (d >= target) break outer; } }
    var px = Math.round(d / mpp), lbl = d >= 1000 ? (d / 1000) + ' ק"מ' : d + ' מ׳';
    var line = els.scale.el.querySelector('.ls-line'), lab = els.scale.el.querySelector('.ls-lbl');
    if (line) line.style.width = px + 'px'; if (lab) lab.textContent = lbl;
  }

  function makeDraggable(el) {
    el.addEventListener('mousedown', function (ev) {
      if (ev.target.closest('input,select,button,[contenteditable="true"],.ov-grip')) return;
      ev.preventDefault(); ev.stopPropagation();
      var host = mapHost().getBoundingClientRect(), r = el.getBoundingClientRect();
      var baseLeft = r.left - host.left, baseTop = r.top - host.top, sx = ev.clientX, sy = ev.clientY;
      el.style.left = baseLeft + 'px'; el.style.top = baseTop + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none';
      function mv(e) { el.style.left = (baseLeft + e.clientX - sx) + 'px'; el.style.top = (baseTop + e.clientY - sy) + 'px'; }
      function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  // ── print AREA selection (drag a rectangle) ─────────────────────────────────────
  function clearArea() { if (printRectLayer && window.gMap) window.gMap.removeLayer(printRectLayer); printRectLayer = null; printBounds = null; }
  function setOverlaysInteractive(on) {
    Object.keys(els).forEach(function (k) { if (els[k] && els[k].el) els[k].el.style.pointerEvents = on ? '' : 'none'; });
  }
  function startAreaSelect() {
    var m = window.gMap; if (!m) return;
    clearArea();
    var btn = document.getElementById('glb-area'); if (btn) btn.textContent = '✏️ גרור על המפה…';
    setOverlaysInteractive(false);                 // let the drag pass through the layout elements
    m.dragging.disable(); if (m.boxZoom) m.boxZoom.disable();
    m.getContainer().style.cursor = 'crosshair';
    var start = null;
    function down(e) { start = e.latlng; if (printRectLayer) { m.removeLayer(printRectLayer); printRectLayer = null; } }
    function move(e) {
      if (!start) return;
      var b = L.latLngBounds(start, e.latlng);
      if (printRectLayer) printRectLayer.setBounds(b);
      else printRectLayer = L.rectangle(b, { color: '#dc2626', weight: 2, dashArray: '6 4', fillColor: '#dc2626', fillOpacity: 0.06 }).addTo(m);
    }
    function up(e) { if (!start) return; printBounds = L.latLngBounds(start, e.latlng); start = null; finish(); }
    function finish() {
      m.off('mousedown', down); m.off('mousemove', move); m.off('mouseup', up);
      m.dragging.enable(); if (m.boxZoom) m.boxZoom.enable();
      m.getContainer().style.cursor = '';
      setOverlaysInteractive(true);
      if (btn) btn.textContent = '✏️ אזור ✓ (לשינוי)';
      toast('אזור נבחר — לחץ הדפס');
    }
    m.on('mousedown', down); m.on('mousemove', move); m.on('mouseup', up);
    toast('גרור על המפה לסימון אזור ההדפסה');
  }

  // ── print ───────────────────────────────────────────────────────────────────────
  // Render the map at the PAPER aspect ratio (A-series = 1:√2) before printing,
  // so it fills any A-size page (A4/A3/A2) instead of being scaled from a fixed
  // on-screen size. Fits the chosen area into that canvas, waits for tiles, prints.
  function doPrint() {
    var m = document.getElementById('map'); if (!m || !window.gMap) { window.print(); return; }
    var orient = (document.getElementById('glb-orient') || {}).value || 'landscape';
    var ratio = 1.41421, LONG = 1580;
    var target = printBounds || window.gMap.getBounds();   // drawn area, else current view
    var center = window.gMap.getCenter(), zoom = window.gMap.getZoom(), snap = window.gMap.options.zoomSnap;

    // Canvas aspect = the DRAWN rectangle's own aspect → pixel-exact crop to the
    // selection (letterboxes on the paper). With no rectangle, use the paper
    // aspect and print the current view.
    var aspect;
    if (printBounds) {
      var ne = window.gMap.project(printBounds.getNorthEast(), zoom);
      var sw = window.gMap.project(printBounds.getSouthWest(), zoom);
      aspect = Math.abs(ne.x - sw.x) / Math.max(1, Math.abs(ne.y - sw.y));
    } else {
      aspect = orient === 'landscape' ? ratio : 1 / ratio;
    }
    var W = aspect >= 1 ? LONG : Math.round(LONG * aspect);
    var H = aspect >= 1 ? Math.round(LONG / aspect) : LONG;
    if (printRectLayer) { window.gMap.removeLayer(printRectLayer); printRectLayer = null; }
    var saved = { position: m.style.position, top: m.style.top, left: m.style.left, width: m.style.width, height: m.style.height, zIndex: m.style.zIndex };

    // capture each overlay's position as a fraction of the map, and its inline
    // styles, so we can keep WYSIWYG placement across the resize then restore.
    var hostRect = m.getBoundingClientRect(), ovSaved = {};
    Object.keys(els).forEach(function (k) {
      var e = els[k] && els[k].el; if (!e) return;
      ovSaved[k] = { left: e.style.left, top: e.style.top, right: e.style.right, bottom: e.style.bottom, transform: e.style.transform };
      els[k]._fx = els[k]._fy = null;
      if (e.style.display === 'none') return;
      var r = e.getBoundingClientRect();
      els[k]._fx = (r.left - hostRect.left) / hostRect.width;
      els[k]._fy = (r.top - hostRect.top) / hostRect.height;
    });

    document.body.classList.add('gis-printing');
    m.style.position = 'fixed'; m.style.top = '0'; m.style.left = '0';
    m.style.width = W + 'px'; m.style.height = H + 'px'; m.style.zIndex = '99990';
    window.gMap.invalidateSize(true);
    window.gMap.options.zoomSnap = 0;                       // fit the area tightly into the paper canvas
    window.gMap.fitBounds(target, { padding: [0, 0], animate: false });

    // re-place overlays at the same relative spot on the paper canvas
    Object.keys(els).forEach(function (k) {
      var e = els[k] && els[k].el; if (!e || els[k]._fx == null) return;
      e.style.left = Math.round(els[k]._fx * W) + 'px'; e.style.top = Math.round(els[k]._fy * H) + 'px';
      e.style.right = 'auto'; e.style.bottom = 'auto'; e.style.transform = 'none';
    });
    toast('מכין הדפסה — בחר "התאם לעמוד" (Fit to page) בתיבת ההדפסה');

    var done = false;
    function restore() {
      if (done) return; done = true;
      m.style.position = saved.position; m.style.top = saved.top; m.style.left = saved.left;
      m.style.width = saved.width; m.style.height = saved.height; m.style.zIndex = saved.zIndex;
      Object.keys(ovSaved).forEach(function (k) {
        var e = els[k] && els[k].el; if (!e) return; var s = ovSaved[k];
        e.style.left = s.left; e.style.top = s.top; e.style.right = s.right; e.style.bottom = s.bottom; e.style.transform = s.transform;
      });
      document.body.classList.remove('gis-printing');
      window.gMap.options.zoomSnap = snap; window.gMap.invalidateSize(true);
      window.gMap.setView(center, zoom, { animate: false });
    }
    window.addEventListener('afterprint', restore, { once: true });
    setTimeout(function () { window.print(); }, 1800);      // let the resized canvas load tiles
    setTimeout(restore, 9000);                              // safety net
  }

  window.GISPrint = { open: enter, exit: exit };
})();
