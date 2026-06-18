/* ══════════════════════════════════════════════════════════════════════════
   GIS Coded-Value Domains — Phase 4 (ArcGIS-style editing).
   Maps integer attribute codes → human Hebrew labels, like an ArcGIS domain.
   The attribute panel + inline table render domain'd fields as LABELS for
   display and as DROPDOWNS for editing.

   Keyed by exact property/field name (names are consistent across layers in
   this national water schema). Admin overrides persist to localStorage so the
   code meanings can be corrected without a deploy (window.GISDomains.set / the
   built-in editor). Defaults below cover the codes we are confident about;
   the rest pass through unchanged until decoded.

   ⚠ Some default value labels are ASSUMED from the standard Israeli municipal
   water-GIS schema and flagged `assumed:true` — confirm with the utility.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // field name → { label, assumed?, values: { code: hebrewLabel } }
  var DEFAULTS = {
    Status:     { label: 'סטטוס',        assumed: true,  values: { 0: 'לא ידוע / מתוכנן', 1: 'קיים / פעיל', 4: 'מבוטל / נטוש' } },
    Enabled:    { label: 'מחובר לרשת',   assumed: true,  values: { 0: 'מנותק', 1: 'מחובר' } },
    NormalPosi: { label: 'מצב נורמלי',   assumed: false, values: { 1: 'פתוח', 2: 'סגור' } },
    Operable:   { label: 'ניתן להפעלה',  assumed: false, values: { 0: 'לא', 1: 'כן' } },
    Operable_:  { label: 'ניתן להפעלה',  assumed: false, values: { 0: 'לא', 1: 'כן' } }
    // Material / LineMateri, ValveType, Source, CoverType, MannerPlac … left as
    // pass-through (codes unknown) — add via the editor or GISDomains.set(...).
  };

  var LS_KEY = 'gis_domains_overrides_v1';
  var overrides = {};
  try { overrides = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { overrides = {}; }
  var remote = {};   // shared domains loaded from Supabase (gis_domains) — wins over defaults/local

  function merged() {
    var out = {};
    [DEFAULTS, overrides, remote].forEach(function (src) { Object.keys(src).forEach(function (k) { out[k] = src[k]; }); });
    return out;
  }
  var DOM = merged();
  function rebuild() { DOM = merged(); }

  function key(code) { return code == null ? '' : String(code).trim(); }

  var GISDomains = {
    // does this field have a coded-value domain?
    has: function (field) { var d = DOM[field]; return !!(d && d.values && Object.keys(d.values).length); },
    // label for a code (falls back to the raw code if unmapped)
    label: function (field, code) {
      var d = DOM[field]; if (!d || !d.values) return code;
      var lk = key(code); if (lk === '') return code;
      return (lk in d.values) ? d.values[lk] : code;
    },
    // [{code,label}] for a dropdown — includes the current value even if unknown
    options: function (field, current) {
      var d = DOM[field]; if (!d || !d.values) return [];
      var opts = Object.keys(d.values).map(function (c) { return { code: c, label: d.values[c] }; });
      var ck = key(current);
      if (ck !== '' && !(ck in d.values)) opts.unshift({ code: ck, label: ck + ' (לא מוגדר)' });
      return opts;
    },
    // are all codes numeric? (→ coerce edited value back to Number on save)
    numeric: function (field) {
      var d = DOM[field]; if (!d || !d.values) return false;
      return Object.keys(d.values).every(function (c) { return /^-?\d+(\.\d+)?$/.test(c); });
    },
    fieldLabel: function (field) { var d = DOM[field]; return (d && d.label) || field; },
    isAssumed: function (field) { var d = DOM[field]; return !!(d && d.assumed); },
    all: function () { return DOM; },

    // admin: set/replace a domain → persists to Supabase (shared) + localStorage
    set: function (field, valuesObj, label) {
      remote[field] = { label: label || (DOM[field] && DOM[field].label) || field, assumed: false, values: valuesObj || {} };
      overrides[field] = remote[field];
      try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)); } catch (e) {}
      rebuild();
      if (window.GIS && GIS.sb) {                                  // upsert to the shared table (admin RLS)
        try {
          var rows = Object.keys(valuesObj || {}).map(function (c) { return { field: field, code: String(c), label: valuesObj[c] }; });
          GIS.sb().from('gis_domains').delete().eq('field', field).then(function () { if (rows.length) GIS.sb().from('gis_domains').insert(rows); });
        } catch (e) {}
      }
    },
    reset: function (field) {
      if (field) { delete overrides[field]; delete remote[field]; } else { overrides = {}; remote = {}; }
      try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)); } catch (e) {}
      rebuild();
    },

    // load the shared domains from Supabase (called at boot; safe if table absent)
    reload: async function () {
      if (!(window.GIS && GIS.sb)) return;
      try {
        var r = await GIS.sb().from('gis_domains').select('field,code,label');
        if (r.error || !r.data) return;
        var m = {};
        r.data.forEach(function (row) {
          var d = m[row.field] || (m[row.field] = { label: (DEFAULTS[row.field] && DEFAULTS[row.field].label) || row.field, assumed: false, values: {} });
          d.values[String(row.code)] = row.label;
        });
        remote = m; rebuild();
      } catch (e) {}
    },

    // admin editor — pick/type a field, edit "code=label" lines, save
    openEditor: async function () {
      var role = window.GIS ? await GIS.currentRole() : null;
      if (role !== 'admin') { var t = document.getElementById('toast'); if (t) { t.textContent = 'עורך הקודים פתוח למנהל בלבד'; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2200); } return; }
      if (document.getElementById('gis-dom-bg')) return;
      var fields = Object.keys(DOM);
      var bg = document.createElement('div'); bg.id = 'gis-dom-bg';
      bg.style.cssText = 'position:fixed;inset:0;z-index:1750;background:rgba(7,30,48,.55);display:flex;align-items:center;justify-content:center;padding:16px';
      bg.innerHTML =
        '<div style="background:#fff;border-radius:14px;width:460px;max-width:95vw;direction:rtl;font-family:Rubik,sans-serif;overflow:hidden">' +
        '<div style="background:#0d3b5e;color:#fff;padding:12px 16px;font-weight:700;display:flex;justify-content:space-between">עורך קודים (Domains)<button id="gd-x" style="background:none;border:none;color:#fff;font-size:16px;cursor:pointer">✕</button></div>' +
        '<div style="padding:16px">' +
        '<div style="font-size:12px;color:#475569;margin-bottom:6px">שדה</div>' +
        '<input id="gd-field" list="gd-fields" placeholder="לדוגמה: Material" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;direction:ltr">' +
        '<datalist id="gd-fields">' + fields.map(function (f) { return '<option value="' + f + '">'; }).join('') + '</datalist>' +
        '<div style="font-size:12px;color:#475569;margin:10px 0 6px">ערכים — שורה לכל קוד: <code>code=תווית</code></div>' +
        '<textarea id="gd-vals" rows="7" placeholder="1=פלדה&#10;2=פוליאתילן" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;direction:rtl;font-family:monospace"></textarea>' +
        '<div style="display:flex;gap:8px;margin-top:14px"><button id="gd-save" style="flex:1;padding:10px;border:none;border-radius:9px;background:#0d3b5e;color:#fff;font-weight:700;cursor:pointer">שמור</button>' +
        '<button id="gd-cancel" style="padding:10px 16px;border:1px solid #cbd5e1;border-radius:9px;background:#f1f5f9;cursor:pointer">ביטול</button></div></div></div>';
      document.body.appendChild(bg);
      var fld = bg.querySelector('#gd-field'), vals = bg.querySelector('#gd-vals');
      function loadField() { var d = DOM[fld.value]; vals.value = d && d.values ? Object.keys(d.values).map(function (c) { return c + '=' + d.values[c]; }).join('\n') : ''; }
      fld.onchange = loadField; fld.oninput = loadField;
      function done() { bg.remove(); }
      bg.querySelector('#gd-x').onclick = done; bg.querySelector('#gd-cancel').onclick = done; bg.onclick = function (e) { if (e.target === bg) done(); };
      bg.querySelector('#gd-save').onclick = function () {
        var f = fld.value.trim(); if (!f) return;
        var obj = {};
        vals.value.split('\n').forEach(function (ln) { var i = ln.indexOf('='); if (i > 0) { obj[ln.slice(0, i).trim()] = ln.slice(i + 1).trim(); } });
        GISDomains.set(f, obj);
        done();
        var t = document.getElementById('toast'); if (t) { t.textContent = 'נשמרו קודים עבור ' + f; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2200); }
      };
    }
  };
  window.GISDomains = GISDomains;

  // load shared domains once the engine is ready
  var _tries = 0, _t = setInterval(function () { _tries++; if (window.GIS && GIS.sb) { clearInterval(_t); GISDomains.reload(); } else if (_tries > 60) clearInterval(_t); }, 250);
})();
