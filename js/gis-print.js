/* ══════════════════════════════════════════════════════════════════════════
   Print / Layout composer — ArcGIS-style map sheet.
   Enter layout mode → a toolbar lets you toggle Title / Legend / North arrow /
   Scale bar; each element is DRAGGABLE on the map. Prints exactly the current
   extent (zoom/pan to frame it first). No external lib — native print with the
   map size LOCKED so tiles never reflow/blank. Self-contained IIFE.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2600); }
  function mapHost() { return window.gMap && window.gMap.getContainer(); }

  var active = false, els = {}, moveHandler = null, orientStyle = null;

  function enter() {
    if (!window.gMap) { toast('המפה עדיין נטענת…'); return; }
    if (active) { exit(); return; }
    active = true;
    buildBar();
    ['title', 'legend', 'north', 'scale'].forEach(addEl);
    moveHandler = function () { updateScale(); };
    window.gMap.on('moveend zoomend', moveHandler);
    toast('מצב פריסה: גרור רכיבים למיקום, מסגר את האזור, ואז הדפס');
  }
  function exit() {
    active = false;
    Object.keys(els).forEach(function (k) { if (els[k] && els[k].el) els[k].el.remove(); });
    els = {};
    var bar = document.getElementById('gis-layout-bar'); if (bar) bar.remove();
    if (moveHandler && window.gMap) { window.gMap.off('moveend zoomend', moveHandler); moveHandler = null; }
    document.body.classList.remove('gis-printing');
  }

  function buildBar() {
    if (document.getElementById('gis-layout-bar')) return;
    var bar = document.createElement('div'); bar.id = 'gis-layout-bar';
    bar.innerHTML =
      '<span class="glb-title">🖨️ פריסת הדפסה</span>' +
      '<input id="glb-titletext" class="glb-in" value="מפת תשתית מים" title="כותרת">' +
      '<label class="glb-tg"><input type="checkbox" data-el="title" checked> כותרת</label>' +
      '<label class="glb-tg"><input type="checkbox" data-el="legend" checked> מקרא</label>' +
      '<label class="glb-tg"><input type="checkbox" data-el="north" checked> חץ צפון</label>' +
      '<label class="glb-tg"><input type="checkbox" data-el="scale" checked> קנה מידה</label>' +
      '<select id="glb-orient" class="glb-in"><option value="landscape">לרוחב</option><option value="portrait">לאורך</option></select>' +
      '<button class="glb-print">🖨️ הדפס</button>' +
      '<button class="glb-exit">יציאה</button>';
    document.body.appendChild(bar);
    Array.prototype.forEach.call(bar.querySelectorAll('input[data-el]'), function (cb) {
      cb.onchange = function () { toggleEl(cb.getAttribute('data-el'), cb.checked); };
    });
    bar.querySelector('#glb-titletext').oninput = function (e) {
      if (els.title && els.title.el) { var t = els.title.el.querySelector('.lt-t'); if (t) t.textContent = e.target.value; }
    };
    bar.querySelector('#glb-orient').onchange = function (e) { setOrient(e.target.value); };
    bar.querySelector('.glb-print').onclick = doPrint;
    bar.querySelector('.glb-exit').onclick = exit;
    setOrient('landscape');
  }
  function setOrient(o) {
    if (!orientStyle) { orientStyle = document.createElement('style'); document.head.appendChild(orientStyle); }
    orientStyle.textContent = '@media print{@page{size:' + o + ';margin:8mm}}';
  }

  function addEl(key) {
    var host = mapHost(); if (!host) return;
    var el = document.createElement('div'); el.className = 'gis-lay-ov gis-lay-' + key;
    if (key === 'title') {
      var tt = (document.getElementById('glb-titletext') || {}).value || 'מפת תשתית מים';
      el.innerHTML = '<div class="lt-t">' + esc(tt) + '</div><div class="lt-m">💧 מי הגליל GIS · ' + new Date().toLocaleDateString('he-IL') + '</div>';
      el.style.top = '10px'; el.style.left = '50%'; el.style.transform = 'translateX(-50%)';
    } else if (key === 'legend') {
      var lg = (window.GISSymbology && window.GISSymbology.legendHTML) ? window.GISSymbology.legendHTML() : '<div style="font-size:11px;color:#94a3b8">הדלק שכבות למקרא</div>';
      el.innerHTML = '<div class="ll-h">מקרא</div>' + lg;
      el.style.bottom = '28px'; el.style.left = '14px';
    } else if (key === 'north') {
      el.innerHTML = '<div class="ln-a">⬆</div><div class="ln-n">צפון</div>';
      el.style.top = '70px'; el.style.right = '14px';
    } else if (key === 'scale') {
      el.innerHTML = '<span class="ls-line"></span><span class="ls-lbl">—</span>';
      el.style.bottom = '28px'; el.style.right = '14px';
    }
    host.appendChild(el);
    if (window.L && L.DomEvent) { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); }
    makeDraggable(el);
    els[key] = { el: el, on: true };
    if (key === 'scale') updateScale();
  }
  function toggleEl(key, on) {
    if (on) { if (!els[key] || !els[key].el) addEl(key); else els[key].el.style.display = ''; }
    else if (els[key] && els[key].el) els[key].el.style.display = 'none';
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
      if (ev.target.closest('input,select,button')) return;
      ev.preventDefault(); ev.stopPropagation();
      var host = mapHost().getBoundingClientRect(), r = el.getBoundingClientRect();
      var baseLeft = r.left - host.left, baseTop = r.top - host.top, sx = ev.clientX, sy = ev.clientY;
      el.style.left = baseLeft + 'px'; el.style.top = baseTop + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none';
      function mv(e) { el.style.left = (baseLeft + e.clientX - sx) + 'px'; el.style.top = (baseTop + e.clientY - sy) + 'px'; }
      function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  // Lock the map's pixel size so hiding the chrome doesn't reflow/blank the tiles.
  function doPrint() {
    var m = document.getElementById('map'); if (!m) { window.print(); return; }
    var w = m.offsetWidth, h = m.offsetHeight;
    m.style.width = w + 'px'; m.style.height = h + 'px';
    document.body.classList.add('gis-printing');
    function restore() { m.style.width = ''; m.style.height = ''; document.body.classList.remove('gis-printing'); }
    window.addEventListener('afterprint', restore, { once: true });
    setTimeout(function () { window.print(); }, 150);
    setTimeout(restore, 6000); // safety net if afterprint never fires
  }

  window.GISPrint = { open: enter, exit: exit };
})();
