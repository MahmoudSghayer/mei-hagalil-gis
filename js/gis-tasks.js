/* ══════════════════════════════════════════════════════════════════════════
   Field tasks — create (C3, engineer/admin). Assign a located task to a viewer.
   Location: defaults to the map center, or click "בחר על המפה" to pick the exact
   spot on the map. The viewer sees it in field mode (gis-field.js → המשימות שלי),
   navigates there (Waze), and marks it done.
   Self-contained IIFE; opened from the ribbon (עריכה → משימת שטח).
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  function sb() { return window.GIS ? GIS.sb() : window.gSb; }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2600); }

  async function openCreate() {
    var role = window.GIS ? await GIS.currentRole() : null;
    if (role !== 'admin' && role !== 'engineer') { toast('יצירת משימה למהנדס/מנהל בלבד'); return; }
    if (!window.gMap) { toast('המפה עדיין נטענת…'); return; }
    if (document.getElementById('gtsk-bg')) return;

    var vr; try { vr = await sb().from('profiles').select('id,full_name,email').eq('role', 'viewer'); } catch (e) { vr = { data: [] }; }
    var viewers = (vr && vr.data) || [];
    var c = window.gMap.getCenter();
    var picked = { lat: c.lat, lng: c.lng };   // default = map center; updated by map pick
    var marker = null;
    var opts = viewers.length
      ? viewers.map(function (v) { return '<option value="' + v.id + '">' + esc(v.full_name || v.email) + '</option>'; }).join('')
      : '';

    var bg = document.createElement('div'); bg.id = 'gtsk-bg';
    bg.style.cssText = 'position:fixed;inset:0;z-index:1750;background:rgba(7,30,48,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    bg.innerHTML =
      '<div style="background:#fff;border-radius:14px;width:420px;max-width:95vw;direction:rtl;font-family:Rubik,sans-serif;overflow:hidden">' +
      '<div style="background:#0d3b5e;color:#fff;padding:12px 16px;font-weight:700;display:flex;justify-content:space-between">📌 משימת שטח<button id="gtsk-x" style="background:none;border:none;color:#fff;font-size:16px;cursor:pointer">✕</button></div>' +
      '<div style="padding:16px">' +
      '<div style="font-size:12px;color:#475569;margin-bottom:4px">כותרת *</div><input id="gtsk-title" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px">' +
      '<div style="font-size:12px;color:#475569;margin:10px 0 4px">תיאור</div><textarea id="gtsk-desc" rows="2" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px"></textarea>' +
      '<div style="font-size:12px;color:#475569;margin:10px 0 4px">הקצה לצופה *</div>' +
      (viewers.length ? '<select id="gtsk-who" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px">' + opts + '</select>'
        : '<div style="color:#b45309;font-size:12px">אין משתמשי צופה במערכת</div>') +
      '<div style="font-size:12px;color:#475569;margin:10px 0 4px">מיקום המשימה *</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input id="gtsk-loc" readonly style="flex:1;padding:8px;border:1px solid #cbd5e1;border-radius:8px;direction:ltr;text-align:left;font-size:12px" value="' + picked.lat.toFixed(5) + ', ' + picked.lng.toFixed(5) + '">' +
        '<button id="gtsk-pick" style="white-space:nowrap;padding:8px 10px;border:1px solid #0d3b5e;border-radius:8px;background:#eef4fb;color:#0d3b5e;cursor:pointer;font-weight:600">📍 בחר על המפה</button>' +
      '</div>' +
      '<div style="font-size:11px;color:#94a3b8;margin-top:4px">ברירת מחדל: מרכז המפה. לחץ "בחר על המפה" ואז לחץ על הנקודה המדויקת.</div>' +
      '<div style="display:flex;gap:8px;margin-top:14px"><button id="gtsk-save" style="flex:1;padding:10px;border:none;border-radius:9px;background:#0d3b5e;color:#fff;font-weight:700;cursor:pointer">שמור והקצה</button>' +
      '<button id="gtsk-cancel" style="padding:10px 16px;border:1px solid #cbd5e1;border-radius:9px;background:#f1f5f9;cursor:pointer">ביטול</button></div></div></div>';
    document.body.appendChild(bg);

    function close() { if (marker) { try { window.gMap.removeLayer(marker); } catch (e) {} marker = null; } bg.remove(); }
    bg.querySelector('#gtsk-x').onclick = close; bg.querySelector('#gtsk-cancel').onclick = close;
    bg.onclick = function (e) { if (e.target === bg) close(); };

    // map-click location picker — hides the dialog, lets the engineer click the
    // exact spot, drops a marker, then reopens. Esc cancels.
    bg.querySelector('#gtsk-pick').onclick = function () {
      bg.style.display = 'none';
      var cont = window.gMap.getContainer(); cont.style.cursor = 'crosshair';
      toast('לחץ על המפה לבחירת מיקום המשימה • Esc לביטול');
      function cleanup() { window.gMap.off('click', onPick); document.removeEventListener('keydown', onEsc); cont.style.cursor = ''; bg.style.display = 'flex'; }
      function onPick(e) {
        picked = { lat: e.latlng.lat, lng: e.latlng.lng };
        if (marker) window.gMap.removeLayer(marker);
        marker = L.marker(e.latlng).addTo(window.gMap);
        var loc = bg.querySelector('#gtsk-loc'); if (loc) loc.value = picked.lat.toFixed(5) + ', ' + picked.lng.toFixed(5);
        cleanup();
      }
      function onEsc(ev) { if (ev.key === 'Escape') cleanup(); }
      window.gMap.on('click', onPick);
      document.addEventListener('keydown', onEsc);
    };

    bg.querySelector('#gtsk-save').onclick = async function () {
      var title = (bg.querySelector('#gtsk-title').value || '').trim();
      var whoEl = bg.querySelector('#gtsk-who');
      if (!title) { toast('כותרת חובה'); return; }
      if (!whoEl) { toast('אין צופה להקצאה'); return; }
      var btn = bg.querySelector('#gtsk-save'); btn.disabled = true; btn.textContent = '⏳ שומר…';
      var r = await sb().from('field_tasks').insert([{ title: title, description: (bg.querySelector('#gtsk-desc').value || '').trim() || null, lat: picked.lat, lng: picked.lng, assigned_to: whoEl.value }]);
      if (r.error) { btn.disabled = false; btn.textContent = 'שמור והקצה'; toast('שגיאה: ' + r.error.message + ' (הרץ tasks.sql?)'); return; }
      try { sb().functions.invoke('send-push', { body: { user_id: whoEl.value, title: 'משימת שטח חדשה', body: title, url: '/' } }); } catch (e) {}
      close(); toast('📌 המשימה הוקצתה');
    };
  }

  window.GISTasks = { openCreate: openCreate };
})();
