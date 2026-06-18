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

  // ── ribbon definition ─────────────────────────────────────────────────────
  // Each tab → array of groups; each group → { label, cmds:[...] }.
  // cmd: { ic, lb, size:'lg'|'sm', act:fn, group?:'measure', mode?, disabled? }
  var RIBBON = {
    map: [
      { label: 'ניווט', cmds: [
        { ic: 'extent', lb: 'תצוגה מלאה', size: 'lg', act: fullExtent },
        { col: [
          { ic: 'plus',   lb: 'התקרב',  act: function () { gmap(function (m) { m.zoomIn(); }); } },
          { ic: 'minus',  lb: 'התרחק',  act: function () { gmap(function (m) { m.zoomOut(); }); } },
          { ic: 'locate', lb: 'מיקומי', act: function () { gmap(function (m) { m.locate({ setView: true, maxZoom: 17 }); }); } }
        ] }
      ] },
      { label: 'מפת רקע', cmds: [
        { ic: 'satellite', lb: 'Esri HD',  size: 'lg', act: function () { basemap('satellite'); } },
        { col: [
          { ic: 'layers', lb: 'היברידי', act: function () { basemap('hybrid'); } },
          { ic: 'street', lb: 'רחובות',  act: function () { basemap('streets'); } },
          { ic: 'map',    lb: 'בהיר',    act: function () { basemap('light'); } }
        ] }
      ] },
      { label: 'שכבות', cmds: [
        { ic: 'panel', lb: 'תוכן', size: 'lg', act: function () { call('toggleSidebar'); } },
        { col: [
          { ic: 'grid',     lb: 'חלקות', act: function () { call('toggleCadastralLayer'); } },
          { ic: 'collapse', lb: 'כווץ הכל',  act: function () { call('collapseAll'); } },
          { ic: 'expand',   lb: 'הרחב הכל',  act: function () { call('expandAll'); } }
        ] }
      ] },
      { label: 'איתור', cmds: [
        { ic: 'pin', lb: 'אתר נכס', size: 'lg', act: toggleFind },
        { col: [
          { ic: 'search',   lb: 'חיפוש כתובת', act: focusSearch },
          { ic: 'bookmark', lb: 'סימניות',     act: toggleBookmarks }
        ] }
      ] },
      { label: 'מראה', cmds: [
        { ic: 'legend', lb: 'מקרא', size: 'lg', act: toggleLegend },
        { ic: 'tag',    lb: 'תוויות קוטר', size: 'lg', act: toggleLabels }
      ] }
    ],

    edit: [
      { label: 'תקלות', cmds: [
        { ic: 'alert', lb: 'תקלה חדשה', size: 'lg', act: function () { call('startIncPick'); } }
      ] },
      { label: 'עריכת ישויות', cmds: [
        { ic: 'edit', lb: 'עריכה', size: 'lg', act: editGeom },
        { col: [
          { ic: 'plus',  lb: 'הוסף ישות', act: editAdd },
          { ic: 'snap',  lb: 'הצמדה',     act: editSnap },
          { ic: 'trash', lb: 'מחק',       act: editDelete }
        ] }
      ] }
    ],

    analysis: [
      { label: 'מדידה', cmds: [
        { ic: 'ruler', lb: 'מרחק', size: 'lg', group: 'measure', mode: 'distance', act: measure },
        { col: [
          { ic: 'area',    lb: 'שטח',  group: 'measure', mode: 'area',    act: measure },
          { ic: 'compass', lb: 'כיוון', group: 'measure', mode: 'bearing', act: measure },
          { ic: 'radius',  lb: 'רדיוס', group: 'measure', mode: 'radius',  act: measure }
        ] },
        { ic: 'trash', lb: 'נקה', size: 'lg', act: measureClear }
      ] },
      { label: 'סטטיסטיקה', cmds: [
        { ic: 'chart', lb: 'לוח נתונים', size: 'lg', act: function () { clickFab('stats-fab'); } }
      ] },
      { label: 'ניתוח מרחבי', cmds: [
        { ic: 'select', lb: 'בחירה לפי תכונה', size: 'lg', act: anlyAttr },
        { col: [
          { ic: 'target', lb: 'בחירה לפי מיקום', act: anlyLoc },
          { ic: 'buffer', lb: 'חיץ (Buffer)',   act: anlyBuffer },
          { ic: 'clear',  lb: 'נקה בחירה',       act: anlyClear }
        ] }
      ] }
    ],

    network: [
      { label: 'רשת מים', cmds: [
        { ic: 'valve', lb: 'בידוד מגופים', size: 'lg', act: traceIsolation }
      ] },
      { label: 'מעקב זרימה', cmds: [
        { ic: 'link', lb: 'מחוברים',    size: 'lg', act: traceConnected },
        { ic: 'arrow-down', lb: 'כיוון זרימה', act: function () { if (window.GISFlow) GISFlow.toggle(); else if (window.showToast) showToast('עדיין נטען…'); } }
      ] },
      { label: 'מונים', cmds: [
        { ic: 'link', lb: 'חיבור אוטומטי', size: 'lg', act: meterAutoConnect },
        { col: [
          { ic: 'edit', lb: 'ערוך חיבור',  act: meterEditConnect },
          { ic: 'node', lb: 'הצג חיבורים', act: meterShowConnectors }
        ] }
      ] },
      { label: 'ניקוי', cmds: [
        { ic: 'clear', lb: 'נקה תוצאה', size: 'lg', act: traceClearAll }
      ] }
    ],

    share: [
      { label: 'ייצוא', cmds: [
        { ic: 'download', lb: 'ייצא מפה', size: 'lg', act: function () { clickFab('exp-fab'); } }
      ] },
      { label: 'פריסת הדפסה', cmds: [
        { ic: 'print', lb: 'גיליון מפה', size: 'lg', act: printMap }
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
  function traceClearAll() { if (window.GISTrace) { window.GISTrace.clear(); } if (window.GISMeterConnect) { window.GISMeterConnect.clear(); } if (window.GISEdit) { window.GISEdit.disarm(); } }
  function meterAutoConnect() { if (window.GISMeterConnect) { window.GISMeterConnect.run(); } else { toast('מנוע חיבור המונים עדיין נטען…'); } }
  function meterEditConnect() { if (window.GISMeterConnect) { window.GISMeterConnect.editArm(); } else { toast('מנוע חיבור המונים עדיין נטען…'); } }
  function meterShowConnectors() { if (window.GISMeterConnect) { window.GISMeterConnect.toggleConnectors(); } else { toast('מנוע חיבור המונים עדיין נטען…'); } }
  function editAdd()        { if (window.GISEdit) { window.GISEdit.startAdd(); }       else { toast('מנוע העריכה עדיין נטען…'); } }
  function editGeom()       { if (window.GISEdit) { window.GISEdit.startEditGeom(); }  else { toast('מנוע העריכה עדיין נטען…'); } }
  function editDelete()     { if (window.GISEdit) { window.GISEdit.startDelete(); }    else { toast('מנוע העריכה עדיין נטען…'); } }
  function editSnap(_, b)   { if (window.GISEdit) { window.GISEdit.toggleSnap(b); }    else { toast('מנוע העריכה עדיין נטען…'); } }
  function toggleLegend() { if (window.GISSymbology) { window.GISSymbology.toggleLegend(); } else { toast('מנוע הסימבולוגיה עדיין נטען…'); } }
  function toggleLabels() { if (window.GISSymbology) { window.GISSymbology.toggleLabels(); } else { toast('מנוע הסימבולוגיה עדיין נטען…'); } }
  function anlyAttr() { if (window.GISAnalysis) { window.GISAnalysis.selectByAttribute(); } else { toast('מנוע הניתוח עדיין נטען…'); } }
  function anlyLoc() { if (window.GISAnalysis) { window.GISAnalysis.selectByLocation(); } else { toast('מנוע הניתוח עדיין נטען…'); } }
  function anlyBuffer() { if (window.GISAnalysis) { window.GISAnalysis.buffer(); } else { toast('מנוע הניתוח עדיין נטען…'); } }
  function anlyClear() {
    // Clear selection AND reset any armed map-click tools (meter-edit, trace) so
    // the cursor is freed to click features (meters/pipes) again.
    if (window.GISAnalysis) { window.GISAnalysis.clear(); }
    if (window.GISMeterConnect && window.GISMeterConnect.resetMouse) { window.GISMeterConnect.resetMouse(); }
    if (window.GISTrace && window.GISTrace.clear) { window.GISTrace.clear(); }
    if (window.GISEdit && window.GISEdit.disarm) { window.GISEdit.disarm(); }
    if (window.GISIdentify && window.GISIdentify.clear) { window.GISIdentify.clear(); }
    if (window.gMap) { window.gMap.getContainer().style.cursor = ''; }
  }
  function toggleBookmarks() { if (window.GISBookmarks) { window.GISBookmarks.toggle(); } else { toast('הסימניות עדיין נטענות…'); } }
  function toggleFind() { if (window.GISFind) { window.GISFind.toggle(); } else { toast('כלי האיתור עדיין נטען…'); } }
  function printMap() { if (window.GISPrint) { window.GISPrint.open(); } else { toast('כלי ההדפסה עדיין נטען…'); } }
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

  // ── icon set ──────────────────────────────────────────────────────────────
  // Monochrome line icons (feather-style). Each value is the inner SVG markup;
  // svgIcon() wraps it so every glyph inherits the ribbon text color and stays
  // crisp at any size — no emoji, no color noise.
  var ICONS = {
    extent:       '<path d="M4 9V5a1 1 0 0 1 1-1h4"/><path d="M20 9V5a1 1 0 0 0-1-1h-4"/><path d="M4 15v4a1 1 0 0 0 1 1h4"/><path d="M20 15v4a1 1 0 0 1-1 1h-4"/>',
    plus:         '<path d="M12 5v14M5 12h14"/>',
    minus:        '<path d="M5 12h14"/>',
    locate:       '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    satellite:    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"/>',
    layers:       '<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M2 13l10 5 10-5"/>',
    street:       '<path d="M5 20 9 4M19 20 15 4"/><path d="M12 6v2M12 11v2M12 16v2"/>',
    map:          '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
    panel:        '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M15 4v16"/>',
    grid:         '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    collapse:     '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12h8"/>',
    expand:       '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/>',
    pin:          '<path d="M12 21s-6-5.7-6-10a6 6 0 0 1 12 0c0 4.3-6 10-6 10z"/><circle cx="12" cy="11" r="2.3"/>',
    search:       '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    bookmark:     '<path d="M6 4h12v17l-6-4-6 4z"/>',
    legend:       '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.6" cy="6" r="1.4" fill="currentColor" stroke="none"/><rect x="3.3" y="10.6" width="2.8" height="2.8" fill="currentColor" stroke="none"/><path d="M4.6 16.3 6 18.8H3.2z" fill="currentColor" stroke="none"/>',
    tag:          '<path d="M3 5v6.5a2 2 0 0 0 .6 1.4l7 7a2 2 0 0 0 2.8 0l5.5-5.5a2 2 0 0 0 0-2.8l-7-7A2 2 0 0 0 11.5 3H5a2 2 0 0 0-2 2z"/><circle cx="7.5" cy="7.5" r="1.3" fill="currentColor" stroke="none"/>',
    alert:        '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    edit:         '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    snap:         '<path d="M6 3v7a6 6 0 0 0 12 0V3"/><path d="M6 3H3v7M18 3h3v7"/>',
    trash:        '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
    ruler:        '<path d="M4 18 20 6"/><circle cx="4" cy="18" r="1.7" fill="currentColor" stroke="none"/><circle cx="20" cy="6" r="1.7" fill="currentColor" stroke="none"/><path d="M8 11l2 2M12 9l2 2"/>',
    area:         '<path d="M5 5h14v14H5z" stroke-dasharray="3 2.6"/><path d="M5 5v14h14"/>',
    compass:      '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5 11 11l-2.5 4.5L13 13z" fill="currentColor" stroke="none"/>',
    radius:       '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><path d="M12 12h8"/>',
    chart:        '<path d="M3 21h18"/><rect x="5" y="11" width="3.2" height="8" fill="currentColor" stroke="none"/><rect x="10.4" y="6" width="3.2" height="13" fill="currentColor" stroke="none"/><rect x="15.8" y="14" width="3.2" height="5" fill="currentColor" stroke="none"/>',
    select:       '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6M8 11h6"/>',
    target:       '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    buffer:       '<rect x="7" y="7" width="10" height="10" rx="1"/><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2.6"/>',
    clear:        '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/>',
    valve:        '<circle cx="12" cy="13" r="6"/><path d="M12 7V3M9 3h6"/>',
    link:         '<path d="M9 15 15 9"/><path d="M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5"/><path d="M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5"/>',
    'arrow-up':   '<path d="M12 19V5M6 11l6-6 6 6"/>',
    'arrow-down': '<path d="M12 5v14M6 13l6 6 6-6"/>',
    node:         '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 8l8 8"/>',
    download:     '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
    print:        '<path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="8" rx="1"/><path d="M8 15h8v6H8z"/>'
  };
  function svgIcon(name) {
    var inner = ICONS[name];
    if (!inner) { return ''; }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }

  // ── render ────────────────────────────────────────────────────────────────
  function cmdButton(c) {
    var b = document.createElement('button');
    // every command renders as a uniform icon-over-label tile (ArcGIS-Pro look)
    b.className = 'ags-cmd ags-cmd-' + (c.size === 'sm' ? 'sm' : 'lg');
    b.innerHTML = '<span class="ags-ic">' + svgIcon(c.ic) + '</span><span class="ags-lb">' + c.lb + '</span>';
    if (c.disabled) { b.disabled = true; }
    if (c.group) { b.setAttribute('data-group', c.group); }
    b.addEventListener('click', function () { c.act(c, b); });
    return b;
  }
  function renderCmd(node, c) {
    // flatten any stacked column into individual uniform tiles in the row
    if (c.col) {
      c.col.forEach(function (sc) { node.appendChild(cmdButton(sc)); });
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
      tab.addEventListener('click', function () {
        // clicking a tab while the ribbon is minimized re-opens it
        if ($('ags-ribbon').classList.contains('collapsed')) { setRibbonCollapsed(false); }
        switchTab(t.id);
      });
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
        grp.appendChild(lbl);    /* group title on top, ArcGIS-Pro style */
        grp.appendChild(body);
        panel.appendChild(grp);
      });
      panelsEl.appendChild(panel);
    });

    // ribbon minimize/restore caret at the end of the tab strip
    var rtoggle = document.createElement('button');
    rtoggle.id = 'ags-ribbon-toggle';
    rtoggle.type = 'button';
    rtoggle.title = 'מזעור רצועת הכלים';
    rtoggle.setAttribute('aria-label', 'מזעור או הצגת רצועת הכלים');
    rtoggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';
    rtoggle.addEventListener('click', function () {
      setRibbonCollapsed(!$('ags-ribbon').classList.contains('collapsed'));
    });
    tabsEl.appendChild(rtoggle);

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
        h.innerHTML = '<span class="ico">' + svgIcon('panel') + '</span><span>תוכן · Contents</span>';
        sb.insertBefore(h, sb.firstChild);
      }
      // on phone/tablet the Contents pane is a drawer — start it closed so the map is full
      if (window.matchMedia && window.matchMedia('(max-width: 1024px)').matches) sb.classList.add('collapsed');
    }

    initStatusScale();
    relocateTopbar();
    cleanStatusBar();
  }

  // Strip status-bar clutter: drop the "|" separators + the "© 2025" span, and
  // push the readouts to the far end with a spacer → clean two-side footer.
  function cleanStatusBar() {
    var sb = $('statusbar'); if (!sb || sb.dataset.cleaned) return;
    Array.prototype.slice.call(sb.children).forEach(function (el) {
      var t = (el.textContent || '').trim();
      if (el.tagName === 'SPAN' && (t === '|' || t.indexOf('©') >= 0)) el.remove();
    });
    if (!$('ags-sb-spacer')) {
      var sp = document.createElement('span'); sp.id = 'ags-sb-spacer';
      var stats = $('ags-statusstats');
      if (stats && stats.nextSibling) sb.insertBefore(sp, stats.nextSibling);
      else sb.insertBefore(sp, sb.firstChild);
    }
    sb.dataset.cleaned = '1';
  }

  // Dissolve the old top panel: move its controls into the ribbon strip + status
  // bar (moving the NODES keeps every id, so index.js/auth.js wiring is intact),
  // then hide the now-empty bar.
  // Move the floating #search-bar (injected on #map-wrap by search-feature.js)
  // into the title bar, centered between the logo and the account cluster, so it
  // no longer hovers over the map. The bar injects asynchronously → retry briefly.
  function dockSearch(tries) {
    var title = $('ags-titlebar');
    if (!title) { return; }
    var bar = $('search-bar');
    if (!bar) {
      if ((tries || 0) < 30) { setTimeout(function () { dockSearch((tries || 0) + 1); }, 200); }
      return;
    }
    if (bar.dataset.docked) { return; }
    var account = $('ags-account');
    title.insertBefore(bar, account || null);
    var help = $('search-help');
    if (help) { bar.appendChild(help); }   // keep the help popover anchored to the bar
    bar.dataset.docked = '1';
  }

  function relocateTopbar() {
    var topbar = $('topbar'); if (!topbar || topbar.dataset.relocated) return;
    var ribbon = $('ags-ribbon'), statusbar = $('statusbar');

    // thin ArcGIS title bar ABOVE the tabs: app title (start) + account (end)
    if (ribbon) {
      var title = document.createElement('div'); title.id = 'ags-titlebar';
      var logo = topbar.querySelector('.logo'); if (logo) { logo.id = 'ags-logo'; title.appendChild(logo); }
      var cluster = document.createElement('div'); cluster.id = 'ags-account';
      ['realtime-dot', 'upload-link', 'admin-link', 'logs-link'].forEach(function (id) { var el = $(id); if (el) cluster.appendChild(el); });
      var ua = topbar.querySelector('.user-area'); if (ua) cluster.appendChild(ua);
      title.appendChild(cluster);
      ribbon.insertBefore(title, ribbon.firstChild);
      dockSearch(0);   // pull the floating map search box up into the title bar
    }

    // incident stats → status bar. SKIP the coords stat: #coords already shows
    // the same live coordinates in the status bar → avoid the duplicate.
    if (statusbar) {
      var wrap = document.createElement('span'); wrap.id = 'ags-statusstats';
      Array.prototype.slice.call(topbar.querySelectorAll('.stats .stat')).forEach(function (s) {
        if (!s.classList.contains('coords')) wrap.appendChild(s);
      });
      statusbar.insertBefore(wrap, statusbar.firstChild);
    }

    topbar.dataset.relocated = '1';
    topbar.style.display = 'none';
  }

  function switchTab(id) {
    document.querySelectorAll('.ags-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === id);
    });
    document.querySelectorAll('.ags-panel').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-panel') === id);
    });
  }

  // minimize/restore the ribbon command body (tab strip stays visible)
  function setRibbonCollapsed(collapsed) {
    var r = $('ags-ribbon'); if (!r) { return; }
    r.classList.toggle('collapsed', collapsed);
    var b = $('ags-ribbon-toggle');
    if (b) { b.title = collapsed ? 'הצגת רצועת הכלים' : 'מזעור רצועת הכלים'; }
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
