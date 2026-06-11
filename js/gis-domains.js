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

  function merged() {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
    Object.keys(overrides).forEach(function (k) { out[k] = overrides[k]; });
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

    // admin: set/replace a domain and persist
    set: function (field, valuesObj, label) {
      overrides[field] = { label: label || (DOM[field] && DOM[field].label) || field, assumed: false, values: valuesObj || {} };
      try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)); } catch (e) {}
      rebuild();
    },
    reset: function (field) {
      if (field) { delete overrides[field]; } else { overrides = {}; }
      try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)); } catch (e) {}
      rebuild();
    }
  };
  window.GISDomains = GISDomains;
})();
