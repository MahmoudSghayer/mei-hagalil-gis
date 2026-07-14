// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Layer Naming (standalone module)
//  קונבנציית שם השכבה במנוע: "<כפר> · <קטגוריה>" (מפריד ' · ' — נקודה
//  אמצעית מוקפת רווחים). מרכז את ההרכבה/הפירוק במקום אחד כדי שהמפריד
//  לא יהיה שכפול-קוד בכל קובץ שקורא/כותב שמות שכבה.
//
//  הערה: קבצים אחרים (כמו gis-engine/migrate.js) עדיין בונים/מפרקים את
//  השם inline ולא הועברו לכאן בשלב הזה — רק js/pages/upload.js.
// ════════════════════════════════════════════════════════════════
(function (window) {
'use strict';

var LayerNaming = window.LayerNaming || {};
window.LayerNaming = LayerNaming;

var SEPARATOR = ' · ';
LayerNaming.SEPARATOR = SEPARATOR;

// (village, category) → "village · category"
LayerNaming.compose = function (village, category) {
  return String(village == null ? '' : village) + SEPARATOR + String(category == null ? '' : category);
};

// "village · category" → { village, category }
// Tolerant of a missing separator: { village: null, category: name } so
// callers can fall back to treating the whole name as the category/label.
// Category may itself contain spaces (or even further ' · ' sequences) —
// only the FIRST separator is significant, matching how compose() builds it.
LayerNaming.parse = function (name) {
  name = String(name == null ? '' : name);
  var idx = name.indexOf(SEPARATOR);
  if (idx === -1) return { village: null, category: name };
  return { village: name.slice(0, idx), category: name.slice(idx + SEPARATOR.length) };
};

})(window);
