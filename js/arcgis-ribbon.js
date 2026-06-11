/* ══════════════════════════════════════════════════════════════════════════
   ArcGIS Pro ribbon — Phase 1 UI shell.
   Self-contained IIFE. Injects a tabbed ribbon between #topbar and #main,
   wiring its commands to the app's existing global functions / injected FABs.
   No edits to index.js or the feature modules — purely additive.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── tiny helpers ──────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function toast(msg, type) {
    var t = $('toast');
    if (!t) { return; }
    t.textContent = msg;
    t.className = (type ? type + ' ' : '') + 'show';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = t.className.replace('show', '').trim(); }, 2400);
  }
  // click an injected FAB by id (robust even when it is display:none)
  function clickFab(id) {
    var el = $(id);
    if (el) { el.click(); }
    else { toast('הרכיב עדיין נטען…'); }
  }
  function soon() { toast('בקרוב — שלב הבא ברודמפ 🛣️'); }

  // ── ribbon definition ─────────────────────────────────────────────────────
  // Each tab → array of groups; each group → { label, cmds:[...] }.
  // cmd: { ic, lb, size:'lg'|'sm', act:fn, group?:'measure', mode?, disabled? }
  var RIBBON = {
    map: [
      { label: 'ניווט', cmds: [
        { ic: '🌍', lb: 'תצוגה מלאה', size: 'lg', act: fullExtent },
        { col: [
          { ic: '➕', lb: 'התקרב',  act: function () { gmap(function (m) { m.zoomIn(); }); } },
          { ic: '➖', lb: 'התרחק',  act: function () { gmap(function (m) { m.zoomOut(); }); } },
          { ic: '📍', lb: 'מיקומי', act: function () { gmap(function (m) { m.locate({ setView: true, maxZoom: 17 }); }); } }
        ] }
      ] },
      { label: 'מפת רקע', cmds: [
        { ic: '🛰️', lb: 'Esri HD',  size: 'lg', act: function () { basemap('satellite'); } },
        { col: [
          { ic: '🌍', lb: 'היברידי', act: function () { basemap('hybrid'); } },
          { ic: '🛣️', lb: 'רחובות',  act: function () { basemap('streets'); } },
          { ic: '🗺️', lb: 'בהיר',    act: function () { basemap('light'); } }
        ] }
      ] },
      { label: 'שכבות', cmds: [
        { ic: '📑', lb: 'תוכן', size: 'lg', act: function () { call('toggleSidebar'); } },
        { col: [
          { ic: '📐', lb: 'חלקות', act: function () { call('toggleCadastralLayer'); } },
          { ic: '⊟', lb: 'כווץ הכל',  act: function () { call('collapseAll'); } },
          { ic: '⊞', lb: 'הרחב הכל',  act: function () { call('expandAll'); } }
        ] }
      ] },
      { label: 'איתור', cmds: [
        { ic: '🔍', lb: 'חיפוש', size: 'lg', act: focusSearch }
      ] },
      { label: 'מראה', cmds: [
        { ic: '📖', lb: 'מקרא', size: 'lg', act: toggleLegend },
        { ic: '🏷️', lb: 'תוויות קוטר', size: 'lg', act: toggleLabels }
      ] }
    ],

    edit: [
      { label: 'תקלות', cmds: [
        { ic: '🚨', lb: 'תקלה חדשה', size: 'lg', act: function () { call('openIncModal'); } }
      ] },
      { label: 'עריכת ישויות', cmds: [
        { ic: '✏️', lb: 'עריכה', size: 'lg', act: soon, disabled: true },
        { col: [
          { ic: '➕', lb: 'הוסף ישות', act: soon, disabled: true },
          { ic: '🧲', lb: 'הצמדה',     act: soon, disabled: true },
          { ic: '🗑️', lb: 'מחק',       act: soon, disabled: true }
        ] }
      ] }
    ],

    analysis: [
      { label: 'מדידה', cmds: [
        { ic: '📏', lb: 'מרחק', size: 'lg', group: 'measure', mode: 'distance', act: measure },
        { col: [
          { ic: '📐', lb: 'שטח',  group: 'measure', mode: 'area',    act: measure },
          { ic: '🧭', lb: 'כיוון', group: 'measure', mode: 'bearing', act: measure },
          { ic: '⭕', lb: 'רדיוס', group: 'measure', mode: 'radius',  act: measure }
        ] },
        { ic: '🗑', lb: 'נקה', size: 'lg', act: measureClear }
      ] },
      { label: 'סטטיסטיקה', cmds: [
        { ic: '📊', lb: 'לוח נתונים', size: 'lg', act: function () { clickFab('stats-fab'); } }
      ] },
      { label: 'גאו-עיבוד', cmds: [
        { ic: '⭕', lb: 'חיץ', size: 'lg', act: soon, disabled: true },
        { ic: '🎯', lb: 'בחירה מרחבית', size: 'lg', act: soon, disabled: true }
      ] }
    ],

    network: [
      { label: 'רשת מים', cmds: [
        { ic: '🚰', lb: 'בידוד מגופים', size: 'lg', act: traceIsolation }
      ] },
      { label: 'מעקב זרימה', cmds: [
        { ic: '🔗', lb: 'מחוברים',    size: 'lg', act: traceConnected },
        { col: [
          { ic: '⬆️', lb: 'במעלה הזרם', act: soon, disabled: true },
          { ic: '⬇️', lb: 'במורד הזרם', act: soon, disabled: true }
        ] }
      ] },
      { label: 'ניקוי', cmds: [
        { ic: '🧹', lb: 'נקה תוצאה', size: 'lg', act: traceClear }
      ] }
    ],

    share: [
      { label: 'ייצוא', cmds: [
        { ic: '📥', lb: 'ייצא מפה', size: 'lg', act: function () { clickFab('exp-fab'); } }
      ] },
      { label: 'פריסת הדפסה', cmds: [
        { ic: '🖨️', lb: 'גיליון מפה', size: 'lg', act: soon, disabled: true }
      ] }
    ]
  };

  var TABS = [
    { id: 'map',      lb: 'מפה' },
    { id: 'edit',     lb: 'עריכה' },
    { id: 'analysis', lb: 'ניתוח' },
    { id: 'network',  lb: 'רשת' },
    { id: 'share',    lb: 'שיתוף' }
  ];

  // ── action plumbing ───────────────────────────────────────────────────────
  function gmap(fn) { if (window.gMap) { fn(window.gMap); } else { toast('המפה עדיין נטענת…'); } }
  function call(name) { if (typeof window[name] === 'function') { window[name](); } else { toast('פעולה לא זמינה'); } }
  function basemap(key) { if (typeof window.switchBasemap === 'function') { window.switchBasemap(key); } }
  function fullExtent() { gmap(function (m) { m.setView([32.92, 35.30], 12); }); }
  function traceIsolation() { if (window.GISTrace) { window.GISTrace.startIsolation(); } else { toast('מנוע הרשת עדיין נטען…'); } }
  function traceConnected() { if (window.GISTrace) { window.GISTrace.startConnected(); } else { toast('מנוע הרשת עדיין נטען…'); } }
  function traceClear() { if (window.GISTrace) { window.GISTrace.clear(); } }
  function toggleLegend() { if (window.GISSymbology) { window.GISSymbology.toggleLegend(); } else { toast('מנוע הסימבולוגיה עדיין נטען…'); } }
  function toggleLabels() { if (window.GISSymbology) { window.GISSymbology.toggleLabels(); } else { toast('מנוע הסימבולוגיה עדיין נטען…'); } }
  function focusSearch() {
    var inp = document.querySelector('#search-bar input');
    if (inp) { inp.focus(); inp.select && inp.select(); }
    else { toast('תיבת החיפוש עדיין נטענת…'); }
  }

  var activeMeasure = null;
  function measure(cmd, btn) {
    if (!window.MeasureTools) { toast('כלי המדידה עדיין נטענים…'); return; }
    // toggle: clicking the active tool again turns it off
    if (activeMeasure === cmd.mode) {
      window.MeasureTools.clearAll && window.MeasureTools.clearAll();
      clearMeasureActive();
      return;
    }
    document.querySelectorAll('.ags-cmd[data-group="measure"]').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    activeMeasure = cmd.mode;
    window.MeasureTools.activate(cmd.mode);
  }
  function measureClear() {
    if (window.MeasureTools && window.MeasureTools.clearAll) { window.MeasureTools.clearAll(); }
    clearMeasureActive();
  }
  function clearMeasureActive() {
    activeMeasure = null;
    document.querySelectorAll('.ags-cmd[data-group="measure"]').forEach(function (b) { b.classList.remove('active'); });
  }

  // ── render ────────────────────────────────────────────────────────────────
  function cmdButton(c) {
    var b = document.createElement('button');
    b.className = 'ags-cmd ags-cmd-' + (c.size === 'lg' ? 'lg' : 'sm');
    b.innerHTML = '<span class="ags-ic">' + c.ic + '</span><span class="ags-lb">' + c.lb + '</span>';
    if (c.disabled) { b.disabled = true; }
    if (c.group) { b.setAttribute('data-group', c.group); }
    b.addEventListener('click', function () { c.act(c, b); });
    return b;
  }
  function renderCmd(node, c) {
    if (c.col) {
      var col = document.createElement('div');
      col.className = 'ags-col';
      c.col.forEach(function (sc) { sc.size = 'sm'; col.appendChild(cmdButton(sc)); });
      node.appendChild(col);
    } else {
      node.appendChild(cmdButton(c));
    }
  }

  function build() {
    if ($('ags-ribbon')) { return; }
    var topbar = $('topbar');
    if (!topbar) { return; }

    var ribbon = document.createElement('div');
    ribbon.id = 'ags-ribbon';

    var tabsEl = document.createElement('div');
    tabsEl.id = 'ags-tabs';
    var panelsEl = document.createElement('div');
    panelsEl.id = 'ags-panels';

    TABS.forEach(function (t, i) {
      var tab = document.createElement('button');
      tab.className = 'ags-tab' + (i === 0 ? ' active' : '');
      tab.textContent = t.lb;
      tab.setAttribute('data-tab', t.id);
      tab.addEventListener('click', function () { switchTab(t.id); });
      tabsEl.appendChild(tab);

      var panel = document.createElement('div');
      panel.className = 'ags-panel' + (i === 0 ? ' active' : '');
      panel.setAttribute('data-panel', t.id);
      (RIBBON[t.id] || []).forEach(function (g) {
        var grp = document.createElement('div');
        grp.className = 'ags-group';
        var body = document.createElement('div');
        body.className = 'ags-group-body';
        g.cmds.forEach(function (c) { renderCmd(body, c); });
        var lbl = document.createElement('div');
        lbl.className = 'ags-group-label';
        lbl.textContent = g.label;
        grp.appendChild(body);
        grp.appendChild(lbl);
        panel.appendChild(grp);
      });
      panelsEl.appendChild(panel);
    });

    ribbon.appendChild(tabsEl);
    ribbon.appendChild(panelsEl);
    // insert directly under the title bar
    topbar.parentNode.insertBefore(ribbon, topbar.nextSibling);

    // mark the sidebar as an ArcGIS Contents pane + add its header
    var sb = $('sidebar');
    if (sb) {
      sb.classList.add('ags-contents');
      if (!$('ags-contents-head')) {
        var h = document.createElement('div');
        h.id = 'ags-contents-head';
        h.innerHTML = '<span class="ico">📑</span><span>תוכן · Contents</span>';
        sb.insertBefore(h, sb.firstChild);
      }
    }

    initStatusScale();
  }

  function switchTab(id) {
    document.querySelectorAll('.ags-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === id);
    });
    document.querySelectorAll('.ags-panel').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-panel') === id);
    });
  }

  // ── status-bar scale (1:N) + projection ───────────────────────────────────
  function initStatusScale() {
    var sbar = $('statusbar');
    if (!sbar || $('ags-scale-wrap')) { return; }
    var wrap = document.createElement('span');
    wrap.id = 'ags-scale-wrap';
    wrap.innerHTML = '<span id="ags-scalebar"></span><span id="ags-scale">1: —</span>';
    var proj = document.createElement('span');
    proj.id = 'ags-proj';
    proj.textContent = 'WGS84 · ITM 2039';
    // place after the first separator-ish span; just prepend to the bar
    sbar.insertBefore(document.createTextNode(''), sbar.firstChild);
    sbar.insertBefore(proj, sbar.firstChild);
    sbar.insertBefore(wrap, sbar.firstChild);
    attachScale();
  }
  function attachScale() {
    if (!window.gMap) { setTimeout(attachScale, 400); return; }
    var m = window.gMap;
    function upd() {
      var c = m.getCenter();
      var mpp = 40075016.686 * Math.abs(Math.cos(c.lat * Math.PI / 180)) / Math.pow(2, m.getZoom() + 8);
      var denom = Math.round(mpp * 96 / 0.0254); // 96dpi → meters→inches→dots
      var s = $('ags-scale');
      if (s) { s.textContent = '1: ' + denom.toLocaleString('en-US'); }
    }
    m.on('zoomend moveend', upd);
    upd();
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
