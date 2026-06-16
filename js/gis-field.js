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
    ['hydrants', 'ברז כיבוי אש'], ['water_meters', 'מד מים'], ['manholes', 'שוחה'], ['other', 'אחר']
  ];
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
      '.fld-badge.pending{background:#fef3c7;color:#92400e}.fld-badge.approved{background:#dcfce7;color:#166534}.fld-badge.rejected{background:#fee2e2;color:#991b1b}';
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

  function entityForm(geometry) {
    var opts = ENTITY_CATS.map(function (c) { return '<option value="' + c[0] + '">' + esc(c[1]) + '</option>'; }).join('');
    var body =
      '<div class="fld-row"><label>סוג השכבה *</label><select id="fld-cat">' + opts + '</select></div>' +
      '<div class="fld-row"><label>קוד נכס (לא חובה)</label><input id="fld-code" placeholder="לדוגמה: WP-1024"></div>' +
      '<div class="fld-row"><label>הערות</label><textarea id="fld-notes" rows="3" placeholder="תיאור / פרטים"></textarea></div>';
    dialog('פרטי הישות', body, function (bg, close) {
      var ok = bg.querySelector('.fld-ok'); ok.disabled = true; ok.textContent = '⏳ מגיש...';
      var payload = { asset_code: bg.querySelector('#fld-code').value.trim() || undefined,
                      notes: bg.querySelector('#fld-notes').value.trim() };
      sb().rpc('submit_entity', {
        p_geometry: geometry, p_target_category: bg.querySelector('#fld-cat').value, p_payload: payload
      }).then(function (res) {
        if (res.error) { ok.disabled = false; ok.textContent = 'שמור והגש'; toast('שגיאה: ' + res.error.message, 'error'); return; }
        close(); toast('✅ ההגשה נשלחה לבדיקה', 'success');
      });
    });
  }

  // ── Create Issue ───────────────────────────────────────────────────────────
  function startIssue() {
    if (!window.gMap) { toast('המפה עדיין נטענת', 'error'); return; }
    toast('לחץ על המפה במיקום התקלה', 'info');
    gMap.once('click', function (e) { issueForm(e.latlng); });
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
      sb().rpc('submit_issue', { p_lng: latlng.lng, p_lat: latlng.lat, p_payload: payload }).then(function (res) {
        if (res.error) { ok.disabled = false; ok.textContent = 'שמור והגש'; toast('שגיאה: ' + res.error.message, 'error'); return; }
        close(); toast('✅ התקלה דווחה ונשלחה לבדיקה', 'success');
      });
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
      if (!rows.length) { list.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:24px">עדיין אין הגשות.<br>צור ישות או דווח תקלה כדי להתחיל.</div>'; return; }
      list.innerHTML = rows.map(function (s) {
        var t = s.kind === 'issue' ? (s.payload && s.payload.title || 'תקלה') : ('ישות · ' + esc(s.target_category || ''));
        var when = new Date(s.submitted_at).toLocaleString('he-IL');
        var rej = (s.status === 'rejected' && s.rejection_reason) ? '<div class="m" style="color:#b91c1c">סיבת דחייה: ' + esc(s.rejection_reason) + '</div>' : '';
        return '<div class="fld-sub"><div class="t">' + esc(t) + ' <span class="fld-badge ' + s.status + '">' + (STATUS_HE[s.status] || s.status) + '</span></div>' +
               '<div class="m">' + esc(when) + '</div>' + rej + '</div>';
      }).join('');
    });
  }

  // ── bar + init ───────────────────────────────────────────────────────────────
  function buildBar() {
    if (document.getElementById('fld-bar')) return;
    var bar = document.createElement('div'); bar.id = 'fld-bar';
    bar.innerHTML =
      '<button id="fld-ent"><span class="i">➕</span>צור ישות</button>' +
      '<button id="fld-iss"><span class="i">⚠️</span>דווח תקלה</button>' +
      '<button id="fld-mn"><span class="i">📋</span>ההגשות שלי</button>';
    document.body.appendChild(bar);
    document.getElementById('fld-ent').onclick = startEntity;
    document.getElementById('fld-iss').onclick = startIssue;
    document.getElementById('fld-mn').onclick = openMine;
  }

  function init() {
    if (!window.gProfile || gProfile.role !== 'viewer') return;  // engineers/admins keep the full UI
    injectStyles();
    document.body.classList.add('field-mode');
    buildBar();
    setTimeout(function () { if (window.gMap) gMap.invalidateSize(); }, 350);
  }

  // Wait until the app shell + profile are ready.
  var tries = 0;
  var timer = setInterval(function () {
    if (window.gProfile && window.gMap) { clearInterval(timer); init(); }
    else if (++tries > 100) clearInterval(timer);   // ~20s safety
  }, 200);
})();
