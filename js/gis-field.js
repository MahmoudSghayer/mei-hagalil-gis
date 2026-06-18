// ════════════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Field Mode (F3 + F4)
//  For role = viewer (field submitter). Strips the full GIS UI down to a clean,
//  mobile-first shell: Create Entity · Create Issue · My Submissions · Logout.
//  Submissions go to the PENDING queue (submit_entity / submit_issue RPCs) and
//  never touch production — an engineer reviews them (F5).
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var VILLAGES = ['מגד אל-כרום', 'בענה', 'דיר אל-אסד', 'נחף', 'סחנין', 'דיר חנא', 'עראבה'];
  var ENTITY_CATS = [
    ['water_pipes', 'קו מים'], ['sewage_pipes', 'קו ביוב'], ['valves', 'מגוף'],
    ['hydrants', 'ברז כיבוי אש'], ['water_meters', 'מד מים'], ['manholes', 'שוחה'],
    ['service_route', 'קו שירות'], ['utility_path', 'תוואי תשתית'], ['other', 'אחר']
  ];
  var LINE_STYLES = [['solid', 'מלא'], ['dashed', 'מקווקו'], ['dotted', 'מנוקד'], ['dashdot', 'קו-נקודה']];
  function styleOptions() { return LINE_STYLES.map(function (x) { return '<option value="' + x[0] + '">' + esc(x[1]) + '</option>'; }).join(''); }
  var STATUS_HE = { pending: 'ממתין לבדיקה', approved: 'אושר', rejected: 'נדחה' };

  function sb() { return window.GIS ? GIS.sb() : window.gSb; }
  function toast(m, t) { if (window.showToast) showToast(m, t); else alert(m); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // ── styles ────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('fld-styles')) return;
    var css =
      'body.field-mode #ags-ribbon, body.field-mode #sidebar, body.field-mode #layer-toggles,' +
      'body.field-mode #sidebar-collapse-btn, body.field-mode #add-btn { display:none !important; }' +
      'body.field-mode #main { display:block; }' +
      'body.field-mode #map-wrap, body.field-mode #map { inset:0; width:100%; height:100%; }' +
      '#fld-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:1200;display:flex;gap:8px;' +
      'background:#0d3b5e;padding:8px;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.35)}' +
      '#fld-bar button{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:78px;padding:9px 10px;' +
      'border:none;border-radius:10px;background:#1a7fc1;color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer}' +
      '#fld-bar button:hover{background:#2a90d2}#fld-bar button .i{font-size:19px;line-height:1}' +
      '.fld-bg{position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center}' +
      '.fld-dlg{background:#fff;width:100%;max-width:520px;border-radius:16px 16px 0 0;padding:16px;direction:rtl;max-height:85vh;overflow:auto}' +
      '@media(min-width:560px){.fld-bg{align-items:center}.fld-dlg{border-radius:16px}}' +
      '.fld-dlg h3{margin:0 0 12px;font-size:17px;color:#0d3b5e}.fld-row{margin-bottom:10px}' +
      '.fld-row label{display:block;font-size:12px;color:#475569;margin-bottom:4px}' +
      '.fld-row input,.fld-row select,.fld-row textarea{width:100%;padding:9px;border:1px solid #cbd5e1;border-radius:9px;font:inherit;box-sizing:border-box}' +
      '.fld-acts{display:flex;gap:8px;margin-top:14px}.fld-acts button{flex:1;padding:11px;border:none;border-radius:10px;font:inherit;font-weight:700;cursor:pointer}' +
      '.fld-ok{background:#0d9488;color:#fff}.fld-cancel{background:#e2e8f0;color:#334155}' +
      '.fld-geom{display:flex;gap:8px}.fld-geom button{flex:1;flex-direction:column}' +
      '#fld-mine{position:fixed;top:0;right:0;bottom:0;width:min(420px,100%);z-index:1250;background:#f8fafc;box-shadow:-4px 0 20px rgba(0,0,0,.2);' +
      'transform:translateX(100%);transition:transform .25s;display:flex;flex-direction:column}' +
      '#fld-mine.open{transform:none}#fld-mine .h{padding:14px 16px;background:#0d3b5e;color:#fff;display:flex;justify-content:space-between;align-items:center}' +
      '#fld-mine .h button{background:none;border:none;color:#fff;font-size:20px;cursor:pointer}#fld-mine .list{flex:1;overflow:auto;padding:12px}' +
      '.fld-sub{background:#fff;border:1px solid #e2e8f0;border-radius:11px;padding:11px 13px;margin-bottom:9px}' +
      '.fld-sub .t{font-weight:700;color:#1e293b;font-size:14px}.fld-sub .m{font-size:12px;color:#64748b;margin-top:3px}' +
      '.fld-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700}' +
      '.fld-badge.pending{background:#fef3c7;color:#92400e}.fld-badge.approved{background:#dcfce7;color:#166534}.fld-badge.rejected{background:#fee2e2;color:#991b1b}' +
      '.fld-media-btn{padding:8px 12px;border:1px dashed #94a3b8;border-radius:9px;background:#f8fafc;cursor:pointer;font:inherit;font-size:13px}' +
      '.cap-thumb{background:#e2e8f0;border-radius:8px;padding:4px 8px;font-size:12px;display:flex;align-items:center;gap:5px}' +
      '.cap-rm{cursor:pointer;color:#dc2626;font-weight:700}' +
      '#fld-route-bar{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:2500;background:#0d9488;color:#fff;padding:10px 16px;border-radius:10px;display:flex;align-items:center;gap:10px;box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:94vw;flex-wrap:wrap;justify-content:center}' +
      '#fld-route-bar button{background:#fff;color:#0d9488;border:none;border-radius:8px;padding:6px 12px;font:inherit;font-weight:700;cursor:pointer}' +
      '#fld-route-cancel{background:rgba(255,255,255,.22)!important;color:#fff!important}';
    var s = document.createElement('style'); s.id = 'fld-styles'; s.textContent = css; document.head.appendChild(s);
  }

  // ── minimal modal ───────────────────────────────────────────────────────────
  function dialog(title, bodyHTML, onOk) {
    var bg = document.createElement('div'); bg.className = 'fld-bg';
    bg.innerHTML = '<div class="fld-dlg"><h3>' + esc(title) + '</h3>' + bodyHTML +
      '<div class="fld-acts"><button class="fld-ok">שמור והגש</button><button class="fld-cancel">ביטול</button></div></div>';
    document.body.appendChild(bg);
    function close() { bg.remove(); }
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    bg.querySelector('.fld-cancel').onclick = close;
    bg.querySelector('.fld-ok').onclick = function () { onOk(bg, close); };
    return bg;
  }

  // ── Create Entity ────────────────────────────────────────────────────────────
  function startEntity() {
    var bg = document.createElement('div'); bg.className = 'fld-bg';
    bg.innerHTML = '<div class="fld-dlg"><h3>צור ישות חדשה — בחר סוג</h3>' +
      '<div class="fld-geom">' +
      '<button data-g="Marker"><span class="i">📍</span>נקודה</button>' +
      '<button data-g="Line"><span class="i">〰️</span>קו</button>' +
      '<button data-g="Polygon"><span class="i">⬠</span>שטח</button>' +
      '</div><div class="fld-acts"><button class="fld-cancel">ביטול</button></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) { if (e.target === bg) bg.remove(); });
    bg.querySelector('.fld-cancel').onclick = function () { bg.remove(); };
    Array.prototype.forEach.call(bg.querySelectorAll('[data-g]'), function (b) {
      b.onclick = function () { bg.remove(); drawThen(b.getAttribute('data-g')); };
    });
  }

  function drawThen(shape) {
    if (!window.gMap || !gMap.pm) { toast('כלי השרטוט לא נטען', 'error'); return; }
    toast('שרטט על המפה — סיים בלחיצה כפולה', 'info');
    gMap.pm.enableDraw(shape, { snappable: true });
    gMap.once('pm:create', function (e) {
      var gj = e.layer.toGeoJSON();
      try { gMap.removeLayer(e.layer); } catch (x) {}   // pending, not production
      gMap.pm.disableDraw();
      entityForm(gj.geometry);
    });
  }

  // The draw flow uses the SAME full submit form as capture, so every asset gets
  // consistent fields: category, line style, Top Level, Invert Level, notes, photos.
  function entityForm(geometry) { captureForm(geometry, {}); }

  // ── Create Issue ───────────────────────────────────────────────────────────
  function startIssue() {
    if (!window.gMap) { toast('המפה עדיין נטענת', 'error'); return; }
    enterPickMode('📍 לחץ על המפה במיקום התקלה', function (latlng) { issueForm(latlng); });
  }

  // Map-pick mode mirroring the main app's incident pick: crosshair + a persistent
  // hint banner + Esc/cancel, capturing the next map click. Replaces the fragile
  // once('click') so the viewer clearly picks the spot, then fills the form.
  function enterPickMode(message, cb) {
    if (document.getElementById('fld-pick-hint')) return;  // already picking
    var hint = document.createElement('div');
    hint.id = 'fld-pick-hint';
    hint.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:1400;' +
      'background:#1e293b;color:#fff;padding:10px 18px;border-radius:10px;font-size:14px;direction:rtl;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;align-items:center;gap:14px';
    hint.innerHTML = '<span>' + message + '</span>' +
      '<button id="fld-pick-cancel" style="background:#475569;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;font-size:13px">ביטול (Esc)</button>';
    document.body.appendChild(hint);
    gMap.getContainer().style.cursor = 'crosshair';

    function cleanup() {
      gMap.off('click', onClick);
      document.removeEventListener('keydown', onEsc);
      gMap.getContainer().style.cursor = '';
      var h = document.getElementById('fld-pick-hint'); if (h) h.remove();
    }
    function onClick(e) { cleanup(); cb(e.latlng); }
    function onEsc(e) { if (e.key === 'Escape') cleanup(); }
    document.getElementById('fld-pick-cancel').onclick = cleanup;
    gMap.on('click', onClick);
    document.addEventListener('keydown', onEsc);
  }

  function issueForm(latlng) {
    var vil = VILLAGES.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('');
    var body =
      '<div class="fld-row"><label>כותרת *</label><input id="fld-title" placeholder="לדוגמה: נזילה בצנרת"></div>' +
      '<div class="fld-row"><label>ישוב</label><select id="fld-vil">' + vil + '</select></div>' +
      '<div class="fld-row"><label>דחיפות</label><select id="fld-prio"><option value="high">גבוהה</option><option value="medium" selected>בינונית</option><option value="low">נמוכה</option></select></div>' +
      '<div class="fld-row"><label>תיאור</label><textarea id="fld-desc" rows="3"></textarea></div>';
    dialog('דיווח תקלה', body, function (bg, close) {
      var title = bg.querySelector('#fld-title').value.trim();
      if (!title) { toast('כותרת חובה', 'error'); return; }
      var ok = bg.querySelector('.fld-ok'); ok.disabled = true; ok.textContent = '⏳ מגיש...';
      var payload = { title: title, description: bg.querySelector('#fld-desc').value.trim(),
                      village: bg.querySelector('#fld-vil').value, priority: bg.querySelector('#fld-prio').value };
      function queued() { enqueue({ kind: 'issue', lng: latlng.lng, lat: latlng.lat, payload: payload }); close(); toast('📴 נשמר במכשיר — יישלח כשתחזור הרשת', 'success'); renderPending(); }
      if (isOffline()) { queued(); return; }
      sb().rpc('submit_issue', { p_lng: latlng.lng, p_lat: latlng.lat, p_payload: payload }).then(function (res) {
        if (res.error) { ok.disabled = false; ok.textContent = 'שמור והגש'; toast('שגיאה: ' + res.error.message, 'error'); return; }
        close(); toast('✅ התקלה דווחה ונשלחה לבדיקה', 'success'); renderPending();
      }).catch(queued);   // network failure → offline queue
    });
  }

  // ── My Submissions ───────────────────────────────────────────────────────────
  function openMine() {
    var p = document.getElementById('fld-mine');
    if (!p) {
      p = document.createElement('div'); p.id = 'fld-mine';
      p.innerHTML = '<div class="h"><span>ההגשות שלי</span><button id="fld-mine-x">✕</button></div><div class="list" id="fld-mine-list"></div>';
      document.body.appendChild(p);
      p.querySelector('#fld-mine-x').onclick = function () { p.classList.remove('open'); };
    }
    p.classList.add('open');
    var list = document.getElementById('fld-mine-list');
    list.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:20px">טוען…</div>';
    sb().from('submissions').select('*').order('submitted_at', { ascending: false }).limit(100).then(function (res) {
      if (res.error) { list.innerHTML = '<div style="color:#b91c1c;padding:16px">שגיאה בטעינה</div>'; return; }
      var rows = res.data || [];
      var html = rows.map(function (s) {
        var t = s.kind === 'issue' ? (s.payload && s.payload.title || 'תקלה') : ('ישות · ' + esc(s.target_category || ''));
        var when = new Date(s.submitted_at).toLocaleString('he-IL');
        var rej = (s.status === 'rejected' && s.rejection_reason) ? '<div class="m" style="color:#b91c1c">סיבת דחייה: ' + esc(s.rejection_reason) + '</div>' : '';
        return '<div class="fld-sub"><div class="t">' + esc(t) + ' <span class="fld-badge ' + s.status + '">' + (STATUS_HE[s.status] || s.status) + '</span></div>' +
               '<div class="m">' + esc(when) + '</div>' + rej + '</div>';
      }).join('');
      // prepend not-yet-sent (offline) items with a pending badge
      idbAll().then(function (q) {
        var qhtml = (q || []).map(function (it) {
          var qt = it.kind === 'issue' ? (it.payload && it.payload.title || 'תקלה') : ('ישות · ' + esc(it.category || ''));
          return '<div class="fld-sub" style="border-color:#fde68a;background:#fffbeb"><div class="t">' + esc(qt) +
            ' <span class="fld-badge pending">📴 ממתין לשליחה</span></div><div class="m">' + new Date(it.ts).toLocaleString('he-IL') + '</div></div>';
        }).join('');
        list.innerHTML = (qhtml + html) || '<div style="text-align:center;color:#94a3b8;padding:24px">עדיין אין הגשות.<br>צור ישות או דווח תקלה כדי להתחיל.</div>';
      });
    });
  }

  // ── Camera + GPS capture (L1) ──────────────────────────────────────────────
  var capFiles = [];

  function startCapture() {
    var bg = document.createElement('div'); bg.className = 'fld-bg';
    bg.innerHTML = '<div class="fld-dlg"><h3>לכידת שטח</h3>' +
      '<div class="fld-geom">' +
      '<button data-c="point"><span class="i">📍</span>נקודה + מדיה<br><small>מיקום נוכחי (GPS)</small></button>' +
      '<button data-c="route"><span class="i">🛰️</span>מסלול + מדיה<br><small>הקלטת הליכה</small></button>' +
      '</div><div class="fld-acts"><button class="fld-cancel">ביטול</button></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) { if (e.target === bg) bg.remove(); });
    bg.querySelector('.fld-cancel').onclick = function () { bg.remove(); };
    bg.querySelector('[data-c="point"]').onclick = function () { bg.remove(); capturePoint(); };
    bg.querySelector('[data-c="route"]').onclick = function () { bg.remove(); captureRoute(); };
  }

  function capturePoint() {
    if (!navigator.geolocation) { toast('אין GPS במכשיר', 'error'); return; }
    toast('מאתר מיקום…', 'info');
    navigator.geolocation.getCurrentPosition(function (pos) {
      var geometry = { type: 'Point', coordinates: [pos.coords.longitude, pos.coords.latitude] };
      if (window.gMap) gMap.setView([pos.coords.latitude, pos.coords.longitude], 18);
      captureForm(geometry, { captured_at: new Date().toISOString(), accuracy_m: Math.round(pos.coords.accuracy) });
    }, function (err) { toast('שגיאת GPS: ' + err.message, 'error'); }, { enableHighAccuracy: true, timeout: 15000 });
  }

  function captureRoute() {
    if (!navigator.geolocation) { toast('אין GPS במכשיר', 'error'); return; }
    var coords = [], line = null, startedAt = new Date().toISOString(), watchId = null;
    var bar = document.createElement('div'); bar.id = 'fld-route-bar';
    bar.innerHTML = '<span id="fld-route-info">מקליט מסלול… ממתין ל-GPS…</span>' +
      '<button id="fld-route-done">✓ סיים</button><button id="fld-route-cancel">✕ בטל</button>';
    document.body.appendChild(bar);

    function stop() { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } bar.remove(); if (line) { try { gMap.removeLayer(line); } catch (e) {} } }

    watchId = navigator.geolocation.watchPosition(function (pos) {
      coords.push([pos.coords.longitude, pos.coords.latitude]);
      var latlngs = coords.map(function (c) { return [c[1], c[0]]; });
      if (line) gMap.removeLayer(line);
      line = L.polyline(latlngs, { color: '#0d9488', weight: 5 }).addTo(gMap);
      gMap.panTo(latlngs[latlngs.length - 1]);
      var info = document.getElementById('fld-route-info');
      if (info) info.textContent = 'מקליט… ' + Math.round(routeLen(coords)) + ' מ׳ · ' + coords.length + ' נק׳';
    }, function (err) {
      var info = document.getElementById('fld-route-info'); if (info) info.textContent = '⚠ אין מיקום GPS (' + (err && err.message ? err.message : '') + ')';
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });

    // Cancel always works. Finish submits whatever was captured (line / point) →
    // opens the form where you choose the type (מים / ביוב / …) and submit.
    document.getElementById('fld-route-cancel').onclick = stop;
    document.getElementById('fld-route-done').onclick = function () {
      var pts = coords.slice(); stop();
      if (pts.length >= 2) {
        captureForm({ type: 'LineString', coordinates: pts },
          { started_at: startedAt, ended_at: new Date().toISOString(), point_count: pts.length, length_m: Math.round(routeLen(pts)) });
      } else if (pts.length === 1) {
        captureForm({ type: 'Point', coordinates: pts[0] }, { captured_at: new Date().toISOString() });
      } else {
        toast('לא התקבל מיקום GPS. צא לשטח עם GPS פעיל, או השתמש ב״צור ישות״ לשרטוט ידני.', 'error');
      }
    };
  }

  function routeLen(c) { var d = 0; for (var i = 1; i < c.length; i++) d += haversine(c[i - 1], c[i]); return d; }
  function haversine(a, b) {
    var R = 6371000, t = Math.PI / 180;
    var dLat = (b[1] - a[1]) * t, dLng = (b[0] - a[0]) * t, la1 = a[1] * t, la2 = b[1] * t;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function renderThumbs(box) {
    box.innerHTML = capFiles.map(function (f, i) {
      var isV = (f.type || '').indexOf('video') === 0;
      return '<div class="cap-thumb">' + (isV ? '🎥' : '🖼️') + ' ' + esc((f.name || 'media').slice(0, 16)) + ' <span class="cap-rm" data-i="' + i + '">✕</span></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.cap-rm'), function (x) {
      x.onclick = function () { capFiles.splice(+x.getAttribute('data-i'), 1); renderThumbs(box); };
    });
  }

  function captureForm(geometry, extra) {
    capFiles = [];
    var opts = ENTITY_CATS.map(function (c) { return '<option value="' + c[0] + '">' + esc(c[1]) + '</option>'; }).join('');
    var body =
      '<div class="fld-row"><label>סוג השכבה *</label><select id="fld-cat">' + opts + '</select></div>' +
      '<div class="fld-row"><label>סגנון קו</label><select id="fld-style">' + styleOptions() + '</select></div>' +
      '<div class="fld-row"><label>מפלס עליון · Top Level (מ׳)</label><input id="fld-top" type="number" step="0.01" inputmode="decimal" placeholder="לדוגמה: 245.30"></div>' +
      '<div class="fld-row"><label>מפלס תחתית · Invert (מ׳)</label><input id="fld-invert" type="number" step="0.01" inputmode="decimal" placeholder="לדוגמה: 243.10"></div>' +
      '<div class="fld-row"><label>קוד נכס (לא חובה)</label><input id="fld-code"></div>' +
      '<div class="fld-row"><label>הערות</label><textarea id="fld-notes" rows="2"></textarea></div>' +
      '<div class="fld-row"><label>מדיה (תמונות / וידאו)</label>' +
      '<div style="display:flex;gap:8px"><button type="button" class="fld-media-btn" id="cap-ap">📷 תמונה</button>' +
      '<button type="button" class="fld-media-btn" id="cap-av">🎥 סרטון</button></div>' +
      '<div id="cap-thumbs" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"></div></div>' +
      '<input type="file" accept="image/*" capture="environment" multiple id="cap-pin" style="display:none">' +
      '<input type="file" accept="video/*" capture="environment" id="cap-vin" style="display:none">';
    var bg = dialog('פרטי הישות', body, function (bgEl, close) {
      var ok = bgEl.querySelector('.fld-ok'); ok.disabled = true; ok.textContent = '⏳ מעלה...';
      var topEl = bgEl.querySelector('#fld-top'), invEl = bgEl.querySelector('#fld-invert');
      var payload = Object.assign({}, extra || {}, {
        asset_code: bgEl.querySelector('#fld-code').value.trim() || undefined,
        notes: bgEl.querySelector('#fld-notes').value.trim(),
        _style: bgEl.querySelector('#fld-style').value,
        top_level: topEl && topEl.value !== '' ? Number(topEl.value) : undefined,
        invert_level: invEl && invEl.value !== '' ? Number(invEl.value) : undefined
      });
      var cat = bgEl.querySelector('#fld-cat').value, files = capFiles.slice();
      if (isOffline()) {
        enqueue({ kind: 'entity', geometry: geometry, category: cat, payload: payload, files: files });
        close(); toast('📴 נשמר במכשיר (כולל תמונות) — יישלח כשתחזור הרשת', 'success'); renderPending(); return;
      }
      submitEntityWithMedia(geometry, cat, payload, files)
        .then(function (n) { close(); toast('✅ נשלח לבדיקה' + (n ? ' · ' + n + ' קבצי מדיה' : ''), 'success'); renderPending(); })
        .catch(function (e) { ok.disabled = false; ok.textContent = 'שמור והגש'; toast('שגיאה: ' + (e.message || e), 'error'); });
    });
    var thumbs = bg.querySelector('#cap-thumbs');
    var pin = bg.querySelector('#cap-pin'), vin = bg.querySelector('#cap-vin');
    bg.querySelector('#cap-ap').onclick = function () { pin.click(); };
    bg.querySelector('#cap-av').onclick = function () { vin.click(); };
    pin.onchange = function () { Array.prototype.forEach.call(pin.files, function (f) { capFiles.push(f); }); renderThumbs(thumbs); };
    vin.onchange = function () { if (vin.files[0]) capFiles.push(vin.files[0]); renderThumbs(thumbs); };
  }

  // Submit the entity, then upload media to the 'submissions' bucket and link rows.
  async function submitEntityWithMedia(geometry, category, payload, files) {
    var res = await sb().rpc('submit_entity', { p_geometry: geometry, p_target_category: category, p_payload: payload });
    if (res.error) throw res.error;
    var subId = res.data && res.data.id;
    var n = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var isV = (f.type || '').indexOf('video') === 0;
      var ext = (f.name && f.name.lastIndexOf('.') >= 0) ? f.name.slice(f.name.lastIndexOf('.')) : (isV ? '.mp4' : '.jpg');
      var path = subId + '/' + Date.now() + '-' + i + ext;
      try {
        var up = await sb().storage.from('submissions').upload(path, f, { contentType: f.type || undefined });
        if (!up.error) { await sb().from('submission_media').insert([{ submission_id: subId, kind: isV ? 'video' : 'photo', storage_path: path }]); n++; }
      } catch (e) { /* skip a failed file */ }
    }
    return n;
  }

  // ── Offline-first queue (C1) — IndexedDB; flushed by pwa.js on reconnect ──────
  var IDB_DB = 'mhg-field', IDB_STORE = 'pending';
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(IDB_DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true }); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
  }
  function idbAdd(rec) { return idb().then(function (db) { return new Promise(function (res, rej) { var tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).add(rec); tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; }); }); }
  function idbAll() { return idb().then(function (db) { return new Promise(function (res) { var out = []; var c = db.transaction(IDB_STORE).objectStore(IDB_STORE).openCursor(); c.onsuccess = function (e) { var cur = e.target.result; if (cur) { out.push(Object.assign({ _id: cur.key }, cur.value)); cur.continue(); } else res(out); }; c.onerror = function () { res(out); }; }); }); }
  function idbDel(id) { return idb().then(function (db) { return new Promise(function (res) { var tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).delete(id); tx.oncomplete = function () { res(); }; tx.onerror = function () { res(); }; }); }); }
  function isOffline() { return typeof navigator !== 'undefined' && navigator.onLine === false; }
  function enqueue(rec) { rec.ts = Date.now(); return idbAdd(rec).catch(function () {}); }

  async function flushQueue() {
    if (isOffline()) return;
    var items; try { items = await idbAll(); } catch (e) { return; }
    var sent = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      try {
        if (it.kind === 'issue') { var r = await sb().rpc('submit_issue', { p_lng: it.lng, p_lat: it.lat, p_payload: it.payload }); if (r.error) throw r.error; }
        else { await submitEntityWithMedia(it.geometry, it.category, it.payload, it.files || []); }
        await idbDel(it._id); sent++;
      } catch (e) { break; }   // still offline / server busy → keep the rest, retry next reconnect
    }
    if (sent) { toast('✅ ' + sent + ' הגשות שנשמרו נשלחו', 'success'); if (window.gMap) renderPending(); var p = document.getElementById('fld-mine'); if (p && p.classList.contains('open')) openMine(); }
  }
  window.GISField = { flushQueue: flushQueue };

  // Render the viewer's OWN pending submissions on the map (review_queue is RLS-
  // scoped to "own" for a viewer) so a just-reported issue/entity is visible while
  // it waits for approval — it isn't in the production layers yet.
  var pendingLayer = null;
  async function renderPending() {
    if (!window.gMap) return;
    var r;
    try { r = await sb().rpc('review_queue'); } catch (e) { return; }
    if (!r || r.error) return;
    if (pendingLayer) { try { gMap.removeLayer(pendingLayer); } catch (e) {} }
    pendingLayer = L.layerGroup().addTo(gMap);
    (r.data || []).forEach(function (s) {
      if (!s.geometry) return;
      var label = s.kind === 'issue' ? (s.payload && s.payload.title || 'תקלה') : ('ישות · ' + esc(s.target_category || ''));
      var lyr = L.geoJSON(s.geometry, {
        style: { color: '#f59e0b', weight: 4, dashArray: '6 6' },
        pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 9, color: '#f59e0b', weight: 3, fillColor: '#fde68a', fillOpacity: 0.6 }); }
      });
      lyr.bindPopup('<b>' + esc(label) + '</b><br>⏳ ממתין לבדיקה');
      lyr.addTo(pendingLayer);
    });
  }

  // ── bar + init ───────────────────────────────────────────────────────────────
  function buildBar() {
    if (document.getElementById('fld-bar')) return;
    var bar = document.createElement('div'); bar.id = 'fld-bar';
    bar.innerHTML =
      '<button id="fld-ent"><span class="i">➕</span>צור ישות</button>' +
      '<button id="fld-cap"><span class="i">📷</span>מצלמה/מסלול</button>' +
      '<button id="fld-iss"><span class="i">⚠️</span>דווח תקלה</button>' +
      '<button id="fld-mn"><span class="i">📋</span>ההגשות שלי</button>';
    document.body.appendChild(bar);
    document.getElementById('fld-ent').onclick = startEntity;
    document.getElementById('fld-cap').onclick = startCapture;
    document.getElementById('fld-iss').onclick = startIssue;
    document.getElementById('fld-mn').onclick = openMine;
  }

  function init() {
    if (!window.gProfile || gProfile.role !== 'viewer') return;  // engineers/admins keep the full UI
    injectStyles();
    document.body.classList.add('field-mode');
    buildBar();
    renderPending();
    setTimeout(function () { if (window.gMap) gMap.invalidateSize(); }, 350);
  }

  // Wait until the app shell + profile are ready.
  var tries = 0;
  var timer = setInterval(function () {
    if (window.gProfile && window.gMap) { clearInterval(timer); init(); }
    else if (++tries > 100) clearInterval(timer);   // ~20s safety
  }, 200);
})();
