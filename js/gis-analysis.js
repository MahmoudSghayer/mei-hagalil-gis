/* ══════════════════════════════════════════════════════════════════════════
   GIS Analysis — spatial/attribute tools (ArcGIS-style), water-utility scoped.
   • Select by Attribute  — query a layer's fields → highlight matches
   • Select by Location   — features of layer A that intersect / are within
                            distance of a reference (selection or layer B)
   • Buffer               — buffer a selection/layer by metres (+ select within)

   Shared selection model (yellow highlight + selection card). Reads features
   via GIS.features.getFeatures (WGS84 GeoJSON). Spatial ops use Turf.js.
   Wired from the ribbon ניתוח tab. Self-contained IIFE; no engine edits.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var state = { selection: null, selLayer: null, bufferLayer: null };

  // ── helpers ─────────────────────────────────────────────────────────────────
  function ready() { if (!window.GIS || !window.gMap) { toast('המנוע עדיין נטען…'); return false; } return true; }
  // Turf (~0.5MB) is lazy-loaded only when buffer/location-select is first used —
  // keeps it out of the initial page load (perf).
  var _turfP = null;
  function ensureTurf() {
    if (window.turf) return Promise.resolve(true);
    if (_turfP) return _turfP;
    toast('טוען ספריית ניתוח מרחבי…');
    _turfP = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Turf.js/6.5.0/turf.min.js';
      s.onload = function () { resolve(!!window.turf); };
      s.onerror = function () { _turfP = null; toast('טעינת Turf נכשלה — בדוק חיבור'); resolve(false); };
      document.head.appendChild(s);
    });
    return _turfP;
  }
  function toast(msg, type) {
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.className = (type ? type + ' ' : '') + 'show';
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = ''; }, 2600);
  }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  async function engineLayers() {
    var ls = await GIS.layers.getLayers();
    return ls.map(function (l) {
      var i = l.name.indexOf(' · ');
      var cat = i >= 0 ? l.name.slice(i + 3) : l.name;
      var label = window.GISLayerLabel ? window.GISLayerLabel(cat) : cat;
      return { id: l.id, name: l.name, village: i >= 0 ? l.name.slice(0, i) : '', label: label, geometry_type: l.geometry_type };
    });
  }
  function layerOptions(layers, extraFirst) {
    var html = extraFirst || '';
    layers.forEach(function (l) { html += '<option value="' + esc(l.id) + '">' + esc(l.village ? l.village + ' · ' + l.label : l.label) + '</option>'; });
    return html;
  }
  function fieldsOf(features) {
    var seen = {}, out = [];
    (features || []).slice(0, 200).forEach(function (f) {
      Object.keys(f.properties || {}).forEach(function (k) { if (!/^_/.test(k) && !seen[k]) { seen[k] = 1; out.push(k); } });
    });
    return out;
  }
  var _cache = {};
  async function featuresOf(layerId) {
    if (!_cache[layerId]) _cache[layerId] = ((await GIS.features.getFeatures(layerId, 100000)).features) || [];
    return _cache[layerId];
  }

  // ── selection model ──────────────────────────────────────────────────────────
  function ensurePane() {
    if (!window.gMap.getPane('gisAnalysis')) window.gMap.createPane('gisAnalysis').style.zIndex = 645;
  }
  function setSelection(layerId, name, features) {
    ensurePane(); clearSelLayer();
    state.selection = { layerId: layerId, name: name, features: features || [] };
    if (features && features.length) {
      state.selLayer = L.geoJSON({ type: 'FeatureCollection', features: features }, {
        pane: 'gisAnalysis',
        style: { color: '#f59e0b', weight: 5, opacity: 0.95, fillColor: '#fde047', fillOpacity: 0.35 },
        pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 7, color: '#b45309', weight: 2, fillColor: '#fde047', fillOpacity: 0.9, pane: 'gisAnalysis' }); }
      }).addTo(window.gMap);
      try { window.gMap.fitBounds(state.selLayer.getBounds(), { padding: [60, 60], maxZoom: 18 }); } catch (e) {}
    }
    selectionCard();
  }
  function clearSelLayer() { if (state.selLayer) { window.gMap.removeLayer(state.selLayer); state.selLayer = null; } }
  function clearBuffer() { if (state.bufferLayer) { window.gMap.removeLayer(state.bufferLayer); state.bufferLayer = null; } }
  function clearAll() { clearSelLayer(); clearBuffer(); state.selection = null; var c = document.getElementById('gis-anly-card'); if (c) c.remove(); }

  function selectionCard() {
    var c = document.getElementById('gis-anly-card'); if (c) c.remove();
    var n = state.selection ? state.selection.features.length : 0;
    c = document.createElement('div'); c.id = 'gis-anly-card';
    c.innerHTML =
      '<div class="gac-head"><span>🎯 בחירה</span><button class="gac-x" title="נקה">✕</button></div>' +
      '<div class="gac-n">' + n.toLocaleString('he-IL') + '</div>' +
      '<div class="gac-sub">ישויות נבחרו' + (state.selection && state.selection.name ? ' · ' + esc(state.selection.name) : '') + '</div>' +
      '<div class="gac-acts">' +
        '<button class="gac-btn" id="gac-table">📋 טבלה</button>' +
        '<button class="gac-btn" id="gac-stats">📊 סטטיסטיקה</button>' +
        '<button class="gac-btn" id="gac-export">⬇ ייצוא בחירה</button>' +
        '<button class="gac-btn" id="gac-calc">ƒ חשב שדה</button>' +
        '<button class="gac-btn ghost" id="gac-clear">נקה</button>' +
      '</div>';
    document.body.appendChild(c);
    c.querySelector('.gac-x').onclick = clearAll;
    c.querySelector('#gac-clear').onclick = clearAll;
    c.querySelector('#gac-table').onclick = function () {
      if (state.selection && state.selection.layerId && window.GISTable) {
        window.GISTable.openLayer(state.selection.layerId, null, { title: '📋 ' + (state.selection.name || ''), sub: 'בחירה' });
      } else { toast('אין טבלה זמינה לשכבה זו'); }
    };
    c.querySelector('#gac-stats').onclick = statsDialog;
    c.querySelector('#gac-export').onclick = exportSelection;
    c.querySelector('#gac-calc').onclick = calcFieldDialog;
  }

  // ── dialog framework ─────────────────────────────────────────────────────────
  function row(label, inner) { return '<div class="gad-row"><label>' + label + '</label>' + inner + '</div>'; }
  var OPS = '<option value="=">שווה (=)</option><option value="!=">שונה (≠)</option>' +
            '<option value="&gt;">גדול (&gt;)</option><option value="&gt;=">גדול-שווה (≥)</option>' +
            '<option value="&lt;">קטן (&lt;)</option><option value="&lt;=">קטן-שווה (≤)</option>' +
            '<option value="like">מכיל</option>';
  function openDialog(title, bodyHTML, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var bg = document.createElement('div'); bg.className = 'gis-anly-bg';
      bg.innerHTML =
        '<div class="gis-anly-dlg"><div class="gad-head">' + title + '<button class="gad-x">✕</button></div>' +
        '<div class="gad-body">' + bodyHTML + '</div>' +
        '<div class="gad-foot"><button class="gad-ok">החל</button><button class="gad-cancel">ביטול</button></div></div>';
      document.body.appendChild(bg);
      if (opts.onRender) opts.onRender(bg);
      function done(v) { bg.remove(); resolve(v); }
      bg.querySelector('.gad-x').onclick = function () { done(null); };
      bg.querySelector('.gad-cancel').onclick = function () { done(null); };
      bg.onclick = function (e) { if (e.target === bg) done(null); };
      bg.querySelector('.gad-ok').onclick = function () { done(opts.collect ? opts.collect(bg) : {}); };
    });
  }

  // ── attribute matching ───────────────────────────────────────────────────────
  function matchAttr(val, op, target) {
    if (val == null) val = '';
    var nv = parseFloat(val), nt = parseFloat(target);
    var bothNum = !isNaN(nv) && !isNaN(nt) && String(target).trim() !== '';
    switch (op) {
      case '=': return bothNum ? nv === nt : String(val) === String(target);
      case '!=': return bothNum ? nv !== nt : String(val) !== String(target);
      case '>': return bothNum && nv > nt;
      case '>=': return bothNum && nv >= nt;
      case '<': return bothNum && nv < nt;
      case '<=': return bothNum && nv <= nt;
      case 'like': return String(val).toLowerCase().indexOf(String(target).toLowerCase()) >= 0;
    }
    return false;
  }

  // ── 1) Select by Attribute ─────────────────────────────────────────────────────
  async function selectByAttribute() {
    if (!ready()) return;
    var layers = await engineLayers();
    if (!layers.length) { toast('אין שכבות במנוע'); return; }
    var body =
      row('שכבה', '<select id="gad-layer" class="gad-in">' + layerOptions(layers) + '</select>') +
      row('שדה', '<select id="gad-field" class="gad-in"><option>טוען…</option></select>') +
      row('תנאי', '<select id="gad-op" class="gad-in">' + OPS + '</select>') +
      row('ערך', '<input id="gad-val" class="gad-in" placeholder="ערך…">');
    var res = await openDialog('🔎 בחירה לפי תכונה', body, {
      onRender: function (bg) {
        var lsel = bg.querySelector('#gad-layer'), fsel = bg.querySelector('#gad-field');
        async function loadFields() {
          fsel.innerHTML = '<option>טוען…</option>';
          var feats = await featuresOf(lsel.value);
          var fields = fieldsOf(feats);
          fsel.innerHTML = fields.length ? fields.map(function (f) { return '<option>' + esc(f) + '</option>'; }).join('') : '<option value="">(אין שדות)</option>';
        }
        lsel.onchange = loadFields; loadFields();
      },
      collect: function (bg) {
        var ls = bg.querySelector('#gad-layer');
        return { layerId: ls.value, layerName: ls.selectedOptions[0].textContent, field: bg.querySelector('#gad-field').value, op: bg.querySelector('#gad-op').value, val: bg.querySelector('#gad-val').value };
      }
    });
    if (!res || !res.field) return;
    var feats = await featuresOf(res.layerId);
    var matches = feats.filter(function (f) { return matchAttr((f.properties || {})[res.field], res.op, res.val); });
    setSelection(res.layerId, res.layerName, matches);
    toast(matches.length.toLocaleString('he-IL') + ' ישויות נבחרו');
  }

  // ── 2) Buffer ───────────────────────────────────────────────────────────────────
  async function buffer() {
    if (!ready()) return; if (!(await ensureTurf())) return;
    var layers = await engineLayers();
    var selN = state.selection ? state.selection.features.length : 0;
    var body =
      row('מקור', '<select id="gad-src" class="gad-in"><option value="__sel">הבחירה הנוכחית (' + selN + ')</option>' + layerOptions(layers) + '</select>') +
      row('מרחק (מ׳)', '<input id="gad-dist" class="gad-in" type="number" value="50" min="0" step="5">') +
      '<label class="gad-chk"><input type="checkbox" id="gad-within"> בחר ישויות בתוך החיץ</label>' +
      row('מתוך שכבה', '<select id="gad-target" class="gad-in" disabled>' + layerOptions(layers) + '</select>');
    var res = await openDialog('⭕ חיץ (Buffer)', body, {
      onRender: function (bg) {
        var chk = bg.querySelector('#gad-within'), tgt = bg.querySelector('#gad-target');
        chk.onchange = function () { tgt.disabled = !chk.checked; };
      },
      collect: function (bg) {
        var t = bg.querySelector('#gad-target');
        return { src: bg.querySelector('#gad-src').value, dist: parseFloat(bg.querySelector('#gad-dist').value) || 0,
                 within: bg.querySelector('#gad-within').checked, target: t.value, targetName: t.selectedOptions[0] && t.selectedOptions[0].textContent };
      }
    });
    if (!res) return;
    var src = res.src === '__sel' ? (state.selection ? state.selection.features : []) : await featuresOf(res.src);
    if (!src.length) { toast('אין ישויות מקור לחיץ'); return; }
    if (src.length > 3000) { toast('יותר מדי ישויות (' + src.length + ') — צמצם בחירה תחילה'); return; }
    ensurePane(); clearBuffer();
    var polys = [];
    src.forEach(function (f) { if (!f.geometry) return; try { var b = turf.buffer(f, res.dist, { units: 'meters' }); if (b) polys.push(b); } catch (e) {} });
    state.bufferLayer = L.geoJSON({ type: 'FeatureCollection', features: polys }, { pane: 'gisAnalysis', style: { color: '#0e7490', weight: 1.5, opacity: 0.85, fillColor: '#22d3ee', fillOpacity: 0.18 } }).addTo(window.gMap);
    try { window.gMap.fitBounds(state.bufferLayer.getBounds(), { padding: [60, 60], maxZoom: 18 }); } catch (e) {}
    if (res.within && res.target) {
      var tf = await featuresOf(res.target);
      var hits = tf.filter(function (f) { if (!f.geometry) return false; return polys.some(function (p) { try { return turf.booleanIntersects(f, p); } catch (e) { return false; } }); });
      setSelection(res.target, res.targetName, hits);
      toast('חיץ ' + res.dist + ' מ׳ · ' + hits.length + ' ישויות בתוכו');
    } else { toast('חיץ ' + res.dist + ' מ׳ נוצר'); }
  }

  // ── 3) Select by Location ────────────────────────────────────────────────────────
  async function selectByLocation() {
    if (!ready()) return; if (!(await ensureTurf())) return;
    var layers = await engineLayers();
    if (!layers.length) { toast('אין שכבות במנוע'); return; }
    var body =
      row('בחר ישויות מתוך', '<select id="gad-target" class="gad-in">' + layerOptions(layers) + '</select>') +
      row('יחס', '<select id="gad-rel" class="gad-in"><option value="intersect">חותכות</option><option value="within">במרחק של</option></select>') +
      row('מרחק (מ׳)', '<input id="gad-dist" class="gad-in" type="number" value="50" min="0" step="5">') +
      row('ביחס ל', '<select id="gad-ref" class="gad-in"><option value="__sel">הבחירה הנוכחית</option>' + layerOptions(layers) + '</select>');
    var res = await openDialog('🎯 בחירה לפי מיקום', body, {
      onRender: function (bg) {
        var rel = bg.querySelector('#gad-rel'), dist = bg.querySelector('#gad-dist').closest('.gad-row');
        function sync() { dist.style.display = rel.value === 'within' ? '' : 'none'; }
        rel.onchange = sync; sync();
      },
      collect: function (bg) {
        var t = bg.querySelector('#gad-target');
        return { target: t.value, targetName: t.selectedOptions[0].textContent, rel: bg.querySelector('#gad-rel').value,
                 dist: parseFloat(bg.querySelector('#gad-dist').value) || 0, ref: bg.querySelector('#gad-ref').value };
      }
    });
    if (!res) return;
    var targetFeats = await featuresOf(res.target);
    var refFeats = res.ref === '__sel' ? (state.selection ? state.selection.features : []) : await featuresOf(res.ref);
    if (!refFeats.length) { toast('אין ישויות ייחוס (בחר בחירה או שכבה)'); return; }
    if (targetFeats.length > 8000 || refFeats.length > 8000) { toast('שכבה גדולה מדי לניתוח אינטראקטיבי — צמצם תחילה'); return; }
    // within distance → test against buffered reference geometries
    var refTest = refFeats;
    if (res.rel === 'within') {
      refTest = refFeats.map(function (f) { try { return turf.buffer(f, res.dist, { units: 'meters' }); } catch (e) { return null; } }).filter(Boolean);
    }
    var matches = targetFeats.filter(function (f) {
      if (!f.geometry) return false;
      return refTest.some(function (r) { try { return turf.booleanIntersects(f, r); } catch (e) { return false; } });
    });
    setSelection(res.target, res.targetName, matches);
    toast(matches.length.toLocaleString('he-IL') + ' ישויות נבחרו');
  }

  // ── 4) Statistics on the selection (count/sum/avg/min/max of a field) ─────────
  // numeric fields: prefer the layer schema (int/float), else derive from values.
  function deriveNumeric(features) {
    var num = {}, seen = {};
    (features || []).slice(0, 300).forEach(function (f) {
      var p = f.properties || {};
      Object.keys(p).forEach(function (k) {
        if (/^_/.test(k)) return;
        var v = p[k]; if (v === '' || v == null) return;
        seen[k] = (seen[k] || 0) + 1;
        if (!isNaN(parseFloat(v)) && isFinite(v)) num[k] = (num[k] || 0) + 1;
      });
    });
    return Object.keys(num).filter(function (k) { return num[k] >= (seen[k] || 1) * 0.6; });
  }
  async function numericFields(sel) {
    var names = [];
    try {
      var defs = await GIS.fields.getFields(sel.layerId);
      names = (defs || []).filter(function (d) { return d.type === 'int' || d.type === 'float'; }).map(function (d) { return d.name; });
    } catch (e) {}
    if (!names.length) names = deriveNumeric(sel.features);
    return names;
  }

  async function statsDialog() {
    var sel = state.selection;
    if (!sel || !sel.features.length) { toast('אין בחירה'); return; }
    var nums = await numericFields(sel);
    if (!nums.length) { toast('אין שדות מספריים בבחירה'); return; }
    var body = row('שדה', '<select id="gst-field" class="gad-in">' + nums.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('') + '</select>');
    var res = await openDialog('📊 סטטיסטיקה', body, { collect: function (bg) { return { field: bg.querySelector('#gst-field').value }; } });
    if (!res || !res.field) return;
    var vals = sel.features.map(function (f) { return parseFloat((f.properties || {})[res.field]); }).filter(function (v) { return !isNaN(v); });
    if (!vals.length) { toast('אין ערכים מספריים לשדה זה'); return; }
    var sum = 0, min = Infinity, max = -Infinity;
    vals.forEach(function (v) { sum += v; if (v < min) min = v; if (v > max) max = v; });
    statsCard(res.field, { count: vals.length, total: sel.features.length, sum: sum, avg: sum / vals.length, min: min, max: max });
  }
  function fmtN(n) { return Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 }); }
  function statCell(label, val) { return '<div class="gst-cell"><div class="gst-v">' + val + '</div><div class="gst-l">' + label + '</div></div>'; }
  function statsCard(field, s) {
    var ex = document.getElementById('gis-stats-card'); if (ex) ex.remove();
    var c = document.createElement('div'); c.id = 'gis-stats-card';
    c.innerHTML =
      '<div class="gac-head"><span>📊 ' + esc(field) + '</span><button class="gac-x" title="סגור">✕</button></div>' +
      '<div class="gst-grid">' +
        statCell('כמות', fmtN(s.count)) + statCell('סכום', fmtN(s.sum)) + statCell('ממוצע', fmtN(s.avg)) +
        statCell('מינ׳', fmtN(s.min)) + statCell('מקס׳', fmtN(s.max)) +
      '</div>' +
      (s.count < s.total ? '<div class="gst-note">' + fmtN(s.total - s.count) + ' ישויות ללא ערך מספרי לא נכללו</div>' : '');
    document.body.appendChild(c);
    c.querySelector('.gac-x').onclick = function () { c.remove(); };
  }

  // ── 5) Export the selection (hands the features to the export wizard) ─────────
  function exportSelection() {
    var sel = state.selection;
    if (!sel || !sel.features.length) { toast('אין בחירה לייצוא'); return; }
    // tag with the layer name so the export groups/labels them (non-destructive).
    sel.features.forEach(function (f) { if (f.properties && f.properties._category == null) f.properties._category = sel.name || 'בחירה'; });
    if (window.GISExport && window.GISExport.openForFeatures) window.GISExport.openForFeatures(sel.features);
    else toast('מנוע הייצוא עדיין נטען…');
  }

  // ── 6) Calculate field across the selection (admin|engineer) ──────────────────
  async function calcFieldDialog() {
    var sel = state.selection;
    if (!sel || !sel.features.length) { toast('אין בחירה'); return; }
    var role = null; try { role = await GIS.currentRole(); } catch (e) {}
    if (role !== 'admin' && role !== 'engineer') { toast('אין הרשאת עריכה', 'error'); return; }
    var body =
      row('שם שדה', '<input id="gcf-field" class="gad-in" placeholder="לדוגמה: age">') +
      row('ביטוי', '<input id="gcf-expr" class="gad-in" placeholder="לדוגמה: 2026 - install_year">') +
      '<div class="gad-note">הביטוי מחושב לכל ישות נבחרת ונשמר בשדה. אופרטורים: + − × ÷ % · פונקציות: length(geometry), round(), abs(), min(), max()…</div>';
    var res = await openDialog('ƒ חשב שדה', body, {
      collect: function (bg) { return { field: bg.querySelector('#gcf-field').value.trim(), expr: bg.querySelector('#gcf-expr').value.trim() }; }
    });
    if (!res || !res.field || !res.expr) return;
    if (/^_/.test(res.field) || !/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(res.field)) { toast('שם שדה לא תקין'); return; }
    if (sel.features.length > 5000) { toast('בחירה גדולה מדי לחישוב (' + sel.features.length + ') — צמצם תחילה'); return; }
    var vals;
    try { vals = GIS.calculator.calculateField(sel.features, res.expr); }
    catch (e) { toast('שגיאה בביטוי: ' + ((e && e.message) ? e.message.replace('[GIS] ', '') : e), 'error'); return; }
    await applyCalc(sel, res.field.trim(), vals);
  }
  async function applyCalc(sel, field, vals) {
    var feats = sel.features, CHUNK = 25, ok = 0, fail = 0;
    toast('מעדכן ' + feats.length + ' ישויות…');
    for (var i = 0; i < feats.length; i += CHUNK) {
      var batch = feats.slice(i, i + CHUNK), base = i;
      await Promise.all(batch.map(function (f, j) {
        var id = f.id || (f.properties && f.properties.__id);
        if (!id) { fail++; return Promise.resolve(); }
        var props = Object.assign({}, f.properties);
        ['__id', '__layer_id', '__edited_by', '__edited_at'].forEach(function (k) { delete props[k]; });
        props[field] = vals[base + j];
        return GIS.features.updateFeature(id, props).then(function () { ok++; f.properties[field] = vals[base + j]; }).catch(function () { fail++; });
      }));
    }
    toast(ok.toLocaleString('he-IL') + ' עודכנו' + (fail ? ' · ' + fail + ' נכשלו' : ''));
    if (window.GISEngineSidebar && GISEngineSidebar.reload) GISEngineSidebar.reload(sel.layerId);
  }

  (function injectCSS() {
    if (document.getElementById('gis-anly-extra-style')) return;
    var s = document.createElement('style'); s.id = 'gis-anly-extra-style';
    s.textContent =
      '#gis-anly-card .gac-acts{flex-wrap:wrap}' +
      '#gis-stats-card{position:absolute;bottom:210px;left:14px;z-index:1200;background:#fff;border:1px solid #d6dbe2;' +
      'border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.18);padding:10px 12px;min-width:240px;max-width:300px;direction:rtl;text-align:right;font-family:inherit}' +
      '#gis-stats-card .gac-head{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:13px;margin-bottom:6px}' +
      '#gis-stats-card .gac-x{border:0;background:none;cursor:pointer;font-size:14px;color:#64748b}' +
      '#gis-stats-card .gst-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}' +
      '#gis-stats-card .gst-cell{background:#f1f5f9;border-radius:8px;padding:6px 4px;text-align:center}' +
      '#gis-stats-card .gst-v{font-size:14px;font-weight:800;color:#0f172a;word-break:break-all}' +
      '#gis-stats-card .gst-l{font-size:10px;color:#64748b}' +
      '#gis-stats-card .gst-note{font-size:10.5px;color:#92400e;background:#fef3c7;border-radius:6px;padding:5px 7px;margin-top:7px}';
    document.head.appendChild(s);
  })();

  window.GISAnalysis = {
    selectByAttribute: selectByAttribute,
    selectByLocation: selectByLocation,
    buffer: buffer,
    clear: clearAll,
    getSelection: function () { return state.selection; }
  };
})();
