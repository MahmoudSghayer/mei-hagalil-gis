/* ══════════════════════════════════════════════════════════════════════════
   Print / Map Layout — ArcGIS-style map sheet.
   Produces a printable map sheet of the current extent with a title block,
   legend, scale and north arrow. Uses leaflet-easyPrint when available (it
   pre-loads tiles so the print is not blank); falls back to native window.print.

   NOTE: in the browser print dialog, enable "Background graphics" so tiles &
   fills render. Self-contained IIFE; opens from the ribbon Share tab.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2400); }

  var printer = null;
  function ensurePrinter() {
    if (printer) return printer;
    if (!window.L || !L.easyPrint || !window.gMap) return null;
    try {
      printer = L.easyPrint({
        hidden: true, hideControlContainer: true, exportOnly: false,
        sizeModes: ['Current', 'A4Landscape', 'A4Portrait'], tileLayer: null, tileWait: 1500
      }).addTo(window.gMap);
    } catch (e) { printer = null; }
    return printer;
  }

  // ── on-map sheet overlays (captured in the print) ───────────────────────────
  function injectOverlays(title, subtitle) {
    cleanup();
    var host = window.gMap.getContainer();
    var date = new Date().toLocaleDateString('he-IL');
    var scale = (document.getElementById('ags-scale') || {}).textContent || '';
    var legend = (window.GISSymbology && window.GISSymbology.legendHTML) ? window.GISSymbology.legendHTML() : '';

    var titleEl = document.createElement('div');
    titleEl.className = 'gis-print-ov gis-print-title';
    titleEl.innerHTML = '<div class="gpt-t">' + esc(title || 'מפת תשתית') + '</div>' +
      '<div class="gpt-m">' + esc(subtitle || '') + (subtitle ? ' · ' : '') + date + ' · 💧 מי הגליל GIS</div>';
    host.appendChild(titleEl);

    if (legend) {
      var leg = document.createElement('div');
      leg.className = 'gis-print-ov gis-print-legend';
      leg.innerHTML = '<div class="gpl-h">מקרא</div>' + legend;
      host.appendChild(leg);
    }

    var ns = document.createElement('div');
    ns.className = 'gis-print-ov gis-print-ns';
    ns.innerHTML = '<div class="gpn-arrow">⬆</div><div class="gpn-n">צפון</div>' + (scale ? '<div class="gpn-scale">קנ״מ ' + esc(scale) + '</div>' : '');
    host.appendChild(ns);
  }
  function cleanup() {
    Array.prototype.slice.call(document.querySelectorAll('.gis-print-ov')).forEach(function (el) { el.remove(); });
    document.body.classList.remove('gis-printing');
  }

  function doPrint(title, subtitle, sizeKey) {
    if (!window.gMap) { toast('המפה עדיין נטענת…'); return; }
    injectOverlays(title, subtitle);
    var p = ensurePrinter();
    if (p) {
      // easyPrint restores the map itself; remove overlays shortly after.
      try { p.printMap(sizeKey || 'CurrentSize', title || 'map'); }
      catch (e) { fallback(); return; }
      setTimeout(cleanup, 3000);
    } else {
      fallback();
    }
  }
  function fallback() {
    document.body.classList.add('gis-printing');
    window.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(function () { window.print(); }, 200);
    setTimeout(cleanup, 4000); // safety net if afterprint never fires
  }

  // ── dialog ──────────────────────────────────────────────────────────────────
  function open() {
    if (!window.gMap) { toast('המפה עדיין נטענת…'); return; }
    if (document.getElementById('gis-print-dlg')) return;
    var bg = document.createElement('div'); bg.className = 'gis-anly-bg'; bg.id = 'gis-print-dlg';
    bg.innerHTML =
      '<div class="gis-anly-dlg"><div class="gad-head">🖨️ גיליון מפה להדפסה<button class="gad-x">✕</button></div>' +
      '<div class="gad-body">' +
        '<div class="gad-row"><label>כותרת</label><input id="gp-title" class="gad-in" value="מפת תשתית מים"></div>' +
        '<div class="gad-row"><label>כותרת משנה (אזור/כפר)</label><input id="gp-sub" class="gad-in" placeholder="לא חובה"></div>' +
        '<div class="gad-row"><label>גודל</label><select id="gp-size" class="gad-in">' +
          '<option value="A4Landscape">A4 לרוחב</option><option value="A4Portrait">A4 לאורך</option><option value="CurrentSize">תצוגה נוכחית</option>' +
        '</select></div>' +
        '<div style="font-size:11px;color:#94a3b8;line-height:1.5">💡 בתיבת ההדפסה של הדפדפן הפעל "גרפיקת רקע" כדי שהמפה תודפס. לשמירה כ-PDF בחר יעד "שמור כ-PDF".</div>' +
      '</div>' +
      '<div class="gad-foot"><button class="gad-ok">🖨️ הדפס</button><button class="gad-cancel">ביטול</button></div></div>';
    document.body.appendChild(bg);
    function close() { bg.remove(); }
    bg.querySelector('.gad-x').onclick = close;
    bg.querySelector('.gad-cancel').onclick = close;
    bg.onclick = function (e) { if (e.target === bg) close(); };
    bg.querySelector('.gad-ok').onclick = function () {
      var title = bg.querySelector('#gp-title').value, sub = bg.querySelector('#gp-sub').value, size = bg.querySelector('#gp-size').value;
      close();
      setTimeout(function () { doPrint(title, sub, size); }, 150);
    };
  }

  window.GISPrint = { open: open };
})();
