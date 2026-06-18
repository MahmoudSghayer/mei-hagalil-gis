/* ══════════════════════════════════════════════════════════════════════════
   Field tasks — create (C3, engineer/admin). Assign a located task to a viewer;
   location = the current map center (pan there first). The viewer sees it in
   field mode (gis-field.js → המשימות שלי), navigates, and marks it done.
   Self-contained IIFE; opened from the ribbon (עריכה → משימת שטח).
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  function sb() { return window.GIS ? GIS.sb() : window.gSb; }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2400); }

  async function openCreate() {
    var role = window.GIS ? await GIS.currentRole() : null;
    if (role !== 'admin' && role !== 'engineer') { toast('יצירת משימה למהנדס/מנהל בלבד'); return; }
    if (!window.gMap) { toast('המפה עדיין נטענת…'); return; }
    if (document.getElementById('gtsk-bg')) return;

    var vr; try { vr = await sb().from('profiles').select('id,full_name,email').eq('role', 'viewer'); } catch (e) { vr = { data: [] }; }
    var viewers = (vr && vr.data) || [];
    var c = window.gMap.getCenter();
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
      '<div style="font-size:11px;color:#94a3b8;margin-top:10px">📍 מיקום המשימה = מרכז המפה הנוכחי (' + c.lat.toFixed(5) + ', ' + c.lng.toFixed(5) + '). מרכז את המפה על הנקודה לפני שמירה.</div>' +
      '<div style="display:flex;gap:8px;margin-top:14px"><button id="gtsk-save" style="flex:1;padding:10px;border:none;border-radius:9px;background:#0d3b5e;color:#fff;font-weight:700;cursor:pointer">שמור והקצה</button>' +
      '<button id="gtsk-cancel" style="padding:10px 16px;border:1px solid #cbd5e1;border-radius:9px;background:#f1f5f9;cursor:pointer">ביטול</button></div></div></div>';
    document.body.appendChild(bg);
    function close() { bg.remove(); }
    bg.querySelector('#gtsk-x').onclick = close; bg.querySelector('#gtsk-cancel').onclick = close;
    bg.onclick = function (e) { if (e.target === bg) close(); };
    bg.querySelector('#gtsk-save').onclick = async function () {
      var title = (bg.querySelector('#gtsk-title').value || '').trim();
      var whoEl = bg.querySelector('#gtsk-who');
      if (!title) { toast('כותרת חובה'); return; }
      if (!whoEl) { toast('אין צופה להקצאה'); return; }
      var ctr = window.gMap.getCenter();
      var btn = bg.querySelector('#gtsk-save'); btn.disabled = true; btn.textContent = '⏳ שומר…';
      var r = await sb().from('field_tasks').insert([{ title: title, description: (bg.querySelector('#gtsk-desc').value || '').trim() || null, lat: ctr.lat, lng: ctr.lng, assigned_to: whoEl.value }]);
      if (r.error) { btn.disabled = false; btn.textContent = 'שמור והקצה'; toast('שגיאה: ' + r.error.message + ' (הרץ tasks.sql?)'); return; }
      close(); toast('📌 המשימה הוקצתה');
    };
  }

  window.GISTasks = { openCreate: openCreate };
})();
