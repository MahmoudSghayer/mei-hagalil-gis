/* ══════════════════════════════════════════════════════════════════════════
   Spatial Bookmarks — ArcGIS-style. Save named map views (center+zoom) and
   jump back to them (villages, recurring problem sites, etc.).
   Persists to localStorage. Self-contained IIFE; opens from the ribbon Map tab.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var LS = 'gis_bookmarks_v1';

  function load() { try { return JSON.parse(localStorage.getItem(LS) || '[]') || []; } catch (e) { return []; } }
  function save(arr) { try { localStorage.setItem(LS, JSON.stringify(arr)); } catch (e) {} }
  // esc() centralized in auth.js (window.escHtml)
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2000); }

  function card() { return document.getElementById('gis-bm-card'); }
  function toggle() {
    var c = card(); if (c) { c.remove(); return; }
    if (!window.gMap) { toast('המפה עדיין נטענת…'); return; }
    c = document.createElement('div'); c.id = 'gis-bm-card';
    c.innerHTML =
      '<div class="gbm-head"><span>🔖 סימניות</span><button class="gbm-x" title="סגור">✕</button></div>' +
      '<div class="gbm-list" id="gbm-list"></div>' +
      '<button class="gbm-add" id="gbm-add">➕ הוסף תצוגה נוכחית</button>';
    document.body.appendChild(c);
    c.querySelector('.gbm-x').onclick = function () { c.remove(); };
    c.querySelector('#gbm-add').onclick = addCurrent;
    renderList();
  }

  function renderList() {
    var box = document.getElementById('gbm-list'); if (!box) return;
    var bms = load();
    if (!bms.length) { box.innerHTML = '<div class="gbm-empty">אין סימניות עדיין.<br>נווט למקום ולחץ "הוסף".</div>'; return; }
    box.innerHTML = bms.map(function (b, i) {
      return '<div class="gbm-item" data-i="' + i + '"><span class="gbm-name">📍 ' + esc(b.name) + '</span>' +
        '<button class="gbm-del" data-i="' + i + '" title="מחק">🗑</button></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.gbm-item'), function (el) {
      el.querySelector('.gbm-name').onclick = function () { go(+el.getAttribute('data-i')); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('.gbm-del'), function (el) {
      el.onclick = function (e) { e.stopPropagation(); del(+el.getAttribute('data-i')); };
    });
  }

  function addCurrent() {
    var box = document.getElementById('gbm-list'); if (!box || !window.gMap) return;
    // inline name input row
    if (document.getElementById('gbm-newname')) return;
    var row = document.createElement('div'); row.className = 'gbm-item';
    row.innerHTML = '<input id="gbm-newname" class="gbm-input" placeholder="שם הסימנייה…" maxlength="40">';
    box.insertBefore(row, box.firstChild);
    var inp = document.getElementById('gbm-newname'); inp.focus();
    var done = false;
    function commit(ok) {
      if (done) return; done = true;
      var name = (inp.value || '').trim();
      if (ok && name) {
        var c = window.gMap.getCenter();
        var bms = load(); bms.push({ name: name, lat: c.lat, lng: c.lng, zoom: window.gMap.getZoom() }); save(bms);
        toast('נשמרה סימנייה: ' + name);
      }
      renderList();
    }
    inp.onkeydown = function (e) { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); };
    inp.onblur = function () { commit(true); };
  }

  function go(i) { var b = load()[i]; if (b && window.gMap) window.gMap.flyTo([b.lat, b.lng], b.zoom, { duration: 0.7 }); }
  function del(i) { var bms = load(); bms.splice(i, 1); save(bms); renderList(); }

  window.GISBookmarks = { toggle: toggle, add: addCurrent };
})();
