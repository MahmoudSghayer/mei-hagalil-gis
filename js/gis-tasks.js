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
    var _addrToken = 0;
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
      '<div id="gtsk-addr" style="margin-top:6px"></div>' +
      '<div style="display:flex;gap:8px;margin-top:14px"><button id="gtsk-save" style="flex:1;padding:10px;border:none;border-radius:9px;background:#0d3b5e;color:#fff;font-weight:700;cursor:pointer">שמור והקצה</button>' +
      '<button id="gtsk-cancel" style="padding:10px 16px;border:1px solid #cbd5e1;border-radius:9px;background:#f1f5f9;cursor:pointer">ביטול</button></div></div></div>';
    document.body.appendChild(bg);

    function close() { if (marker) { try { window.gMap.removeLayer(marker); } catch (e) {} marker = null; } bg.remove(); }
    bg.querySelector('#gtsk-x').onclick = close; bg.querySelector('#gtsk-cancel').onclick = close;
    bg.onclick = function (e) { if (e.target === bg) close(); };

    // Phase 3: reverse-geocode the picked point → street address + an opt-in
    // "add to description" so the assigned field crew gets a navigable address.
    // Token-guarded so a slow response for an old point can't overwrite a newer pick.
    async function refreshAddr() {
      var my = ++_addrToken;
      var host = bg.querySelector('#gtsk-addr'); if (!host) return;
      if (!window.GISGeoAssist || !window.GISGeoAssist.reverseGeocode) { host.innerHTML = ''; return; }
      host.innerHTML = '<span style="font-size:11px;color:#94a3b8">🔎 מאתר כתובת…</span>';
      var info = await window.GISGeoAssist.reverseGeocode(picked.lng, picked.lat);
      if (my !== _addrToken || !host.isConnected) return;
      var addr = (info && (info.long || info.match)) || '';
      if (!addr) { host.innerHTML = ''; return; }
      host.innerHTML = '<div style="padding:7px 10px;background:#eff4ff;border:1px solid #c7d7fe;border-radius:7px;font-size:12px;color:#1e3a8a;display:flex;align-items:center;gap:8px">' +
        '<span style="flex:1">📍 ' + esc(addr) + '</span>' +
        '<button type="button" id="gtsk-addr-add" style="background:#2563eb;color:#fff;border:none;border-radius:5px;padding:3px 9px;cursor:pointer;font-size:12px;flex:none">➕ הוסף לתיאור</button></div>';
      var ab = bg.querySelector('#gtsk-addr-add');
      if (ab) ab.onclick = function () {
        var d = bg.querySelector('#gtsk-desc'); var cur = (d.value || '').trim();
        if (cur.indexOf(addr) === -1) d.value = cur ? (cur + ' · 📍 ' + addr) : ('📍 ' + addr);
        ab.disabled = true; ab.textContent = '✓ נוסף';
      };
    }
    refreshAddr();

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
        refreshAddr();
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

  // ── Engineer/admin: list of tasks I created, with completion details + photos ──
  function fmtDate(s) {
    if (!s) return '—';
    try { var d = new Date(s); return d.toLocaleDateString('he-IL') + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return String(s); }
  }
  var _tasks = [], _profs = {};
  function taskCard(t) {
    var who = _profs[t.assigned_to] || '—', done = t.status === 'done';
    return '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:11px;padding:12px;margin-bottom:10px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">' +
        '<div style="font-weight:700;color:#1e293b">' + esc(t.title) + '</div>' +
        '<span style="flex-shrink:0;font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;background:' + (done ? '#dcfce7;color:#166534' : '#fef3c7;color:#92400e') + '">' + (done ? 'בוצע' : 'פתוח') + '</span></div>' +
      (t.description ? '<div style="font-size:12.5px;color:#475569;margin-top:4px">' + esc(t.description) + '</div>' : '') +
      '<div style="font-size:11.5px;color:#64748b;margin-top:8px;line-height:1.8">' +
        '👤 ' + esc(who) + '<br>🕒 נוצר: ' + fmtDate(t.created_at) + '<br>' +
        (done ? '✅ הושלם: ' + fmtDate(t.done_at) : '⏳ טרם הושלם') + '</div>' +
      (t.completion_note ? '<div style="margin-top:8px;background:#f1f5f9;border-radius:8px;padding:8px;font-size:12.5px;color:#1e293b"><b>תיאור הביצוע:</b><br>' + esc(t.completion_note) + '</div>' : '') +
      '<div id="gtl-ph-' + t.id + '" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"></div>' +
      '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">' +
        '<button data-fly="' + t.lat + ',' + t.lng + '" style="padding:7px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#eef4fb;color:#0d3b5e;cursor:pointer;font:inherit">🎯 הצג במפה</button>' +
        (done ? '<button data-reopen="' + t.id + '" style="padding:7px 12px;border:1px solid #fdba74;border-radius:8px;background:#fff7ed;color:#b45309;cursor:pointer;font:inherit">↩ פתח מחדש</button>' : '') +
      '</div></div>';
  }
  async function loadTaskPhotos(t) {
    var box = document.getElementById('gtl-ph-' + t.id);
    if (!box || !t.completion_media) return;
    for (var i = 0; i < t.completion_media.length; i++) {
      var path = t.completion_media[i], u = null;
      try { var sg = await sb().storage.from('submissions').createSignedUrl(path, 3600); u = sg.data && sg.data.signedUrl; } catch (e) {}
      if (!u) { try { u = sb().storage.from('submissions').getPublicUrl(path).data.publicUrl; } catch (e) {} }
      if (u) box.insertAdjacentHTML('beforeend', '<a href="' + u + '" target="_blank" rel="noopener"><img src="' + u + '" loading="lazy" style="width:78px;height:78px;object-fit:cover;border-radius:8px;border:1px solid #e2e8f0"></a>');
    }
  }
  function renderList() {
    var list = document.getElementById('gtl-list'); if (!list) return;
    var st = (document.getElementById('gtl-fstatus') || {}).value || '';
    var vw = (document.getElementById('gtl-fviewer') || {}).value || '';
    var rows = _tasks.filter(function (t) { return (!st || t.status === st) && (!vw || t.assigned_to === vw); });
    if (!rows.length) { list.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:24px">אין משימות תואמות לסינון</div>'; return; }
    list.innerHTML = rows.map(taskCard).join('');
    Array.prototype.forEach.call(list.querySelectorAll('[data-fly]'), function (b) {
      b.onclick = function () { var c = b.getAttribute('data-fly').split(','); if (window.gMap) window.gMap.setView([+c[0], +c[1]], 18); var pp = document.getElementById('gtl-panel'); if (pp) pp.remove(); };
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-reopen]'), function (b) {
      b.onclick = async function () {
        var id = b.getAttribute('data-reopen');
        var r = await sb().from('field_tasks').update({ status: 'open', done_at: null }).eq('id', id);
        if (r.error) { toast('שגיאה: ' + r.error.message, 'error'); return; }
        var t = _tasks.find(function (x) { return String(x.id) === String(id); }); if (t) { t.status = 'open'; t.done_at = null; }
        toast('המשימה נפתחה מחדש'); renderList();
      };
    });
    rows.forEach(loadTaskPhotos);
  }
  async function openList() {
    var role = window.GIS ? await GIS.currentRole() : null;
    if (role !== 'admin' && role !== 'engineer') { toast('רשימת המשימות למהנדס/מנהל בלבד'); return; }
    var ex = document.getElementById('gtl-panel'); if (ex) { ex.remove(); return; }  // toggle
    var p = document.createElement('div'); p.id = 'gtl-panel';
    p.style.cssText = 'position:fixed;top:0;left:0;bottom:0;width:min(460px,100%);z-index:1700;background:#f8fafc;box-shadow:4px 0 24px rgba(0,0,0,.2);direction:rtl;font-family:Rubik,sans-serif;display:flex;flex-direction:column';
    p.innerHTML =
      '<div style="padding:13px 16px;background:#0d3b5e;color:#fff;display:flex;justify-content:space-between;align-items:center"><span style="font-weight:700">📋 ' + (role === 'admin' ? 'כל המשימות' : 'המשימות שיצרתי') + '</span><button id="gtl-x" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer">✕</button></div>' +
      '<div style="display:flex;gap:8px;padding:10px 12px;background:#eef2f6;border-bottom:1px solid #e2e8f0">' +
        '<select id="gtl-fstatus" style="flex:1;padding:6px;border:1px solid #cbd5e1;border-radius:7px;font:inherit;direction:rtl"><option value="">כל הסטטוסים</option><option value="open">פתוח</option><option value="done">בוצע</option></select>' +
        '<select id="gtl-fviewer" style="flex:1;padding:6px;border:1px solid #cbd5e1;border-radius:7px;font:inherit;direction:rtl"><option value="">כל הצופים</option></select>' +
      '</div>' +
      '<div id="gtl-list" style="flex:1;overflow:auto;padding:12px"></div>';
    document.body.appendChild(p);
    p.querySelector('#gtl-x').onclick = function () { p.remove(); };
    var list = p.querySelector('#gtl-list');
    list.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:20px">טוען…</div>';
    try {
      var me = (await sb().auth.getUser()).data.user;
      var q = sb().from('field_tasks').select('*').order('created_at', { ascending: false });
      if (role !== 'admin') q = q.eq('created_by', me.id);   // admin oversees ALL tasks; engineer sees own
      var res = await q;
      if (res.error) { list.innerHTML = '<div style="color:#b91c1c;padding:16px">שגיאה: ' + esc(res.error.message) + ' (הרץ tasks.sql?)</div>'; return; }
      _tasks = res.data || [];
      if (!_tasks.length) { list.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:24px">' + (role === 'admin' ? 'אין משימות במערכת' : 'עדיין לא יצרת משימות') + '</div>'; return; }
      var ids = []; _tasks.forEach(function (t) { if (t.assigned_to && ids.indexOf(t.assigned_to) < 0) ids.push(t.assigned_to); });
      _profs = {};
      if (ids.length) { var pr = await sb().from('profiles').select('id,full_name,email').in('id', ids); (pr.data || []).forEach(function (x) { _profs[x.id] = x.full_name || x.email; }); }
      var vsel = document.getElementById('gtl-fviewer');
      if (vsel) vsel.innerHTML = '<option value="">כל הצופים</option>' + ids.map(function (id) { return '<option value="' + id + '">' + esc(_profs[id] || id) + '</option>'; }).join('');
      var ssel = document.getElementById('gtl-fstatus'); if (ssel) ssel.onchange = renderList;
      if (vsel) vsel.onchange = renderList;
      renderList();
    } catch (e) { list.innerHTML = '<div style="color:#b91c1c;padding:16px">' + esc(String(e)) + '</div>'; }
  }

  window.GISTasks = { openCreate: openCreate, openList: openList };
})();
