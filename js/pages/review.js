// ════════════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Review Center (F5)
//  Engineers review their assigned viewers' pending submissions (admins see all,
//  via RLS). Approve (optionally after editing attributes) → promotes to
//  production (features / incidents) + audit + notifies the submitter. Reject →
//  reason + notify. All via the SECURITY DEFINER workflow RPCs.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var map, geomLayer, gProfiles = {}, gLayers = [], gItems = [], gCurrent = null, gSel = {};

  function toast(m) { var t = document.getElementById('toast'); if (!t) { alert(m); return; } t.textContent = m; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 3000); }
  // esc() centralized in auth.js (window.escHtml)
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }

  document.getElementById('rv-logout').onclick = async function () { await gSb.auth.signOut(); window.location.replace('login.html'); };
  window.addEventListener('load', init);

  async function init() {
    var s = await gSb.auth.getSession();
    if (!s.data || !s.data.session) { window.location.replace('login.html'); return; }
    var prof = await getProfile(s.data.session.user, true);
    if (!prof) return;
    if (prof.role !== 'engineer' && prof.role !== 'admin') { window.location.replace('../index.html'); return; }

    map = L.map('rv-map').setView([32.9, 35.3], 12);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 20, attribution: 'Esri' }).addTo(map);

    await Promise.all([loadProfiles(), loadLayers()]);
    await loadQueue();
  }

  async function loadProfiles() {
    var r = await gSb.from('profiles').select('id,full_name,email');
    (r.data || []).forEach(function (p) { gProfiles[p.id] = p.full_name || p.email; });
  }
  async function loadLayers() {
    var r = await gSb.from('layers').select('id,name').order('name');
    gLayers = r.data || [];
  }

  async function loadQueue() {
    var r = await gSb.rpc('review_queue');
    var list = document.getElementById('rv-list');
    if (r.error) { list.innerHTML = '<div class="rv-empty">שגיאה: ' + esc(r.error.message) + '</div>'; return; }
    gItems = r.data || [];
    document.getElementById('rv-count').textContent = gItems.length + ' ממתינות';
    if (!gItems.length) {
      list.innerHTML = '<div class="rv-empty">אין הגשות הממתינות לבדיקה 🎉</div>';
      document.getElementById('rv-detail').innerHTML = '<div class="rv-empty">—</div>';
      if (geomLayer) { map.removeLayer(geomLayer); geomLayer = null; }
      return;
    }
    gSel = {};
    list.innerHTML =
      '<div id="rv-batch" style="display:none;position:sticky;top:0;z-index:2;background:#0d3b5e;color:#fff;padding:8px 10px;border-radius:8px;margin-bottom:8px;font-size:12.5px;align-items:center;gap:8px">' +
        '<span id="rv-batch-n"></span><span style="flex:1"></span>' +
        '<button id="rv-batch-app" style="background:#16a34a;border:none;color:#fff;border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit">אשר תקלות</button>' +
        '<button id="rv-batch-rej" style="background:#dc2626;border:none;color:#fff;border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit">דחה</button>' +
      '</div>' +
      gItems.map(function (s) {
        var who = gProfiles[s.submitted_by] || '—';
        var title = s.kind === 'issue' ? (s.payload && s.payload.title || 'תקלה') : ('ישות · ' + esc(s.target_category || ''));
        return '<div class="rv-card" data-id="' + s.id + '"><label class="rv-pick" style="float:left;cursor:pointer;padding:0 0 4px 4px"><input type="checkbox" class="rv-chk" data-id="' + s.id + '"></label><div class="t">' + esc(title) +
          '<span class="rv-kind ' + s.kind + '">' + (s.kind === 'issue' ? 'תקלה' : 'ישות') + '</span></div>' +
          '<div class="m">' + esc(who) + ' · ' + new Date(s.submitted_at).toLocaleString('he-IL') + '</div></div>';
      }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.rv-card'), function (c) {
      c.onclick = function (e) { if (e.target.classList.contains('rv-chk') || e.target.classList.contains('rv-pick')) return; select(+c.getAttribute('data-id'), c); };
    });
    Array.prototype.forEach.call(list.querySelectorAll('.rv-chk'), function (cb) {
      cb.onclick = function (e) { e.stopPropagation(); if (cb.checked) gSel[+cb.getAttribute('data-id')] = 1; else delete gSel[+cb.getAttribute('data-id')]; updateBatch(); };
    });
    document.getElementById('rv-batch-app').onclick = batchApprove;
    document.getElementById('rv-batch-rej').onclick = batchReject;
    updateBatch();
  }

  function updateBatch() {
    var bar = document.getElementById('rv-batch'); if (!bar) return;
    var n = Object.keys(gSel).length; bar.style.display = n ? 'flex' : 'none';
    var el = document.getElementById('rv-batch-n'); if (el) el.textContent = n + ' נבחרו';
  }
  async function batchReject() {
    var ids = Object.keys(gSel).map(Number); if (!ids.length) return;
    var reason = prompt('סיבת דחייה לכל הנבחרות:', ''); if (reason === null) return;
    var ok = 0;
    for (var i = 0; i < ids.length; i++) { try { var r = await gSb.rpc('reject_submission', { p_id: ids[i], p_reason: reason }); if (!r.error) ok++; } catch (e) {} }
    toast('נדחו ' + ok + ' הגשות'); gSel = {}; await loadQueue();
  }
  async function batchApprove() {
    var ids = Object.keys(gSel).map(Number); if (!ids.length) return;
    var issues = gItems.filter(function (s) { return ids.indexOf(s.id) >= 0 && s.kind === 'issue'; });
    var skipped = ids.length - issues.length;
    if (!issues.length) { toast('אישור קבוצתי לתקלות בלבד — ישויות דורשות בחירת שכבה'); return; }
    var ok = 0;
    for (var i = 0; i < issues.length; i++) { try { var r = await gSb.rpc('approve_submission', { p_id: issues[i].id, p_layer_id: null, p_edited_payload: null }); if (!r.error) ok++; } catch (e) {} }
    toast('אושרו ' + ok + ' תקלות' + (skipped ? ' · ' + skipped + ' ישויות דולגו' : '')); gSel = {}; await loadQueue();
  }

  function select(id, card) {
    gCurrent = gItems.find(function (s) { return s.id === id; });
    Array.prototype.forEach.call(document.querySelectorAll('.rv-card'), function (x) { x.classList.remove('sel'); });
    if (card) card.classList.add('sel');
    showGeom(gCurrent);
    renderDetail(gCurrent);
  }

  function showGeom(s) {
    if (geomLayer) { map.removeLayer(geomLayer); geomLayer = null; }
    if (!s.geometry) return;
    try {
      geomLayer = L.geoJSON(s.geometry, {
        style: { color: '#f59e0b', weight: 4 },
        pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 8, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: .6 }); }
      }).addTo(map);
      map.fitBounds(geomLayer.getBounds(), { maxZoom: 18, padding: [40, 40] });
    } catch (e) {}
  }

  function renderDetail(s) {
    var d = document.getElementById('rv-detail');
    var who = gProfiles[s.submitted_by] || '—';
    var p = s.payload || {};
    var fields, layerSel = '';
    if (s.kind === 'issue') {
      fields =
        row('כותרת', '<input id="rv-title" class="rv-edit" value="' + esc(p.title || '') + '">') +
        row('ישוב', '<input id="rv-village" class="rv-edit" value="' + esc(p.village || '') + '">') +
        row('דחיפות', '<select id="rv-prio" class="rv-edit"><option value="high"' + sel(p.priority, 'high') + '>גבוהה</option><option value="medium"' + sel(p.priority, 'medium') + '>בינונית</option><option value="low"' + sel(p.priority, 'low') + '>נמוכה</option></select>') +
        row('תיאור', '<textarea id="rv-desc" class="rv-edit" rows="2">' + esc(p.description || '') + '</textarea>');
    } else {
      var opts = gLayers.map(function (l) { return '<option value="' + l.id + '">' + esc(l.name) + '</option>'; }).join('');
      layerSel = row('פרסם לשכבה *', gLayers.length ? '<select id="rv-layer" class="rv-edit">' + opts + '</select>'
        : '<div style="color:#b91c1c;font-size:12px">אין שכבות ייצור — צור שכבה תחילה</div>');
      fields =
        row('סוג', '<input id="rv-cat" class="rv-edit" value="' + esc(s.target_category || '') + '">') +
        row('מפלס עליון · Top', '<input id="rv-top" type="number" step="0.01" class="rv-edit" value="' + (p.top_level != null ? p.top_level : '') + '">') +
        row('מפלס תחתית · Invert', '<input id="rv-invert" type="number" step="0.01" class="rv-edit" value="' + (p.invert_level != null ? p.invert_level : '') + '">') +
        row('קוד נכס', '<input id="rv-code" class="rv-edit" value="' + esc(p.asset_code || '') + '">') +
        row('הערות', '<textarea id="rv-notes" class="rv-edit" rows="2">' + esc(p.notes || '') + '</textarea>');
    }
    d.innerHTML = '<h3>' + (s.kind === 'issue' ? '⚠️ תקלה' : '➕ ישות') + ' #' + s.id + '</h3>' +
      '<div class="rv-kv"><b>הוגש ע״י</b><span>' + esc(who) + '</span></div>' +
      '<div class="rv-kv"><b>תאריך</b><span>' + new Date(s.submitted_at).toLocaleString('he-IL') + '</span></div>' +
      layerSel + fields +
      '<div class="rv-acts">' +
      '<button class="rv-approve" id="rv-do-approve">✔ אשר ופרסם</button>' +
      '<button class="rv-reject" id="rv-do-reject">✕ דחה</button>' +
      '</div>';
    document.getElementById('rv-do-approve').onclick = doApprove;
    document.getElementById('rv-do-reject').onclick = doReject;
    loadMedia(s.id);
  }

  // Show the submission's photos/videos inline (private bucket → signed URLs).
  async function loadMedia(subId) {
    var r;
    try { r = await gSb.from('submission_media').select('storage_path,kind').eq('submission_id', subId); } catch (e) { return; }
    if (!r || r.error || !r.data || !r.data.length) return;
    var parts = ['<div class="rv-media" style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">'];
    for (var i = 0; i < r.data.length; i++) {
      var m = r.data[i], u = null;
      try { var sg = await gSb.storage.from('submissions').createSignedUrl(m.storage_path, 3600); u = sg.data && sg.data.signedUrl; } catch (e) {}
      if (!u) { try { u = gSb.storage.from('submissions').getPublicUrl(m.storage_path).data.publicUrl; } catch (e) {} }
      if (!u) continue;
      parts.push(m.kind === 'video'
        ? '<video src="' + u + '" controls style="width:108px;border-radius:8px;border:1px solid #e2e8f0"></video>'
        : '<a href="' + u + '" target="_blank" rel="noopener"><img src="' + u + '" loading="lazy" style="width:84px;height:84px;object-fit:cover;border-radius:8px;border:1px solid #e2e8f0"></a>');
    }
    parts.push('</div>');
    if (gCurrent && gCurrent.id !== subId) return;          // selection changed while loading
    var det = document.getElementById('rv-detail'); if (!det) return;
    var anchor = det.querySelector('.rv-acts');
    if (anchor) anchor.insertAdjacentHTML('beforebegin', parts.join('')); else det.insertAdjacentHTML('beforeend', parts.join(''));
  }
  function row(label, inner) { return '<div class="rv-row"><label>' + label + '</label>' + inner + '</div>'; }
  function sel(v, opt) { return v === opt ? ' selected' : ''; }

  async function doApprove() {
    var s = gCurrent; if (!s) return;
    var orig = JSON.stringify(s.payload || {});
    var edited, layerId = null;
    var p = s.payload || {};
    if (s.kind === 'issue') {
      edited = Object.assign({}, p, { title: val('rv-title'), village: val('rv-village'), priority: val('rv-prio'), description: val('rv-desc') });
    } else {
      if (!gLayers.length) { toast('אין שכבת ייצור לפרסום'); return; }
      layerId = val('rv-layer');
      var top = val('rv-top'), inv = val('rv-invert');
      edited = Object.assign({}, p, {
        asset_code: val('rv-code') || undefined, notes: val('rv-notes'),
        top_level: top !== '' ? Number(top) : undefined,
        invert_level: inv !== '' ? Number(inv) : undefined
      });
    }
    var changed = JSON.stringify(edited) !== orig;
    var args = { p_id: s.id, p_layer_id: layerId, p_edited_payload: changed ? edited : null };
    var btn = document.getElementById('rv-do-approve'); btn.disabled = true; btn.textContent = '⏳ מאשר...';
    var r = await gSb.rpc('approve_submission', args);
    if (r.error) { btn.disabled = false; btn.textContent = '✔ אשר ופרסם'; toast('שגיאה: ' + r.error.message); return; }
    try { gSb.functions.invoke('send-push', { body: { user_id: s.submitted_by, title: 'ההגשה אושרה ✅', body: (s.kind === 'issue' ? 'התקלה שדיווחת אושרה' : 'הישות שהגשת פורסמה'), url: '/' } }); } catch (e) {}
    toast('✅ אושר ופורסם');
    await loadQueue();
    document.getElementById('rv-detail').innerHTML = '<div class="rv-empty">בחר הגשה מהרשימה</div>';
  }

  async function doReject() {
    var s = gCurrent; if (!s) return;
    var reason = prompt('סיבת הדחייה (תישלח למגיש):', '');
    if (reason === null) return;
    var btn = document.getElementById('rv-do-reject'); btn.disabled = true; btn.textContent = '⏳...';
    var r = await gSb.rpc('reject_submission', { p_id: s.id, p_reason: reason });
    if (r.error) { btn.disabled = false; btn.textContent = '✕ דחה'; toast('שגיאה: ' + r.error.message); return; }
    try { gSb.functions.invoke('send-push', { body: { user_id: s.submitted_by, title: 'ההגשה נדחתה', body: reason || 'ההגשה שלך נדחתה — ראה פרטים באפליקציה', url: '/' } }); } catch (e) {}
    toast('הדחייה נשלחה');
    await loadQueue();
    document.getElementById('rv-detail').innerHTML = '<div class="rv-empty">בחר הגשה מהרשימה</div>';
  }
})();
