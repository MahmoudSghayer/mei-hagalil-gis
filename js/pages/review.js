// ════════════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Review Center (F5)
//  Engineers review their assigned viewers' pending submissions (admins see all,
//  via RLS). Approve (optionally after editing attributes) → promotes to
//  production (features / incidents) + audit + notifies the submitter. Reject →
//  reason + notify. All via the SECURITY DEFINER workflow RPCs.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var map, geomLayer, gProfiles = {}, gLayers = [], gItems = [], gCurrent = null;

  function toast(m) { var t = document.getElementById('toast'); if (!t) { alert(m); return; } t.textContent = m; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 3000); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
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
    list.innerHTML = gItems.map(function (s) {
      var who = gProfiles[s.submitted_by] || '—';
      var title = s.kind === 'issue' ? (s.payload && s.payload.title || 'תקלה') : ('ישות · ' + esc(s.target_category || ''));
      return '<div class="rv-card" data-id="' + s.id + '"><div class="t">' + esc(title) +
        '<span class="rv-kind ' + s.kind + '">' + (s.kind === 'issue' ? 'תקלה' : 'ישות') + '</span></div>' +
        '<div class="m">' + esc(who) + ' · ' + new Date(s.submitted_at).toLocaleString('he-IL') + '</div></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.rv-card'), function (c) {
      c.onclick = function () { select(+c.getAttribute('data-id'), c); };
    });
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
    toast('הדחייה נשלחה');
    await loadQueue();
    document.getElementById('rv-detail').innerHTML = '<div class="rv-empty">בחר הגשה מהרשימה</div>';
  }
})();
