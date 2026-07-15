// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Layer Naming (standalone module)
//  קונבנציית שם השכבה במנוע: "<כפר> · <קטגוריה>" (מפריד ' · ' — נקודה
//  אמצעית מוקפת רווחים). מרכז את ההרכבה/הפירוק במקום אחד כדי שהמפריד
//  לא יהיה שכפול-קוד בכל קובץ שקורא/כותב שמות שכבה.
//
//  הערה: קבצים אחרים (כמו gis-engine/migrate.js) עדיין בונים/מפרקים את
//  השם inline ולא הועברו לכאן בשלב הזה — רק js/pages/upload.js.
//
//  PARITY REQUIREMENT (W5.2 — also documented in
//  gis-engine/sql/migrations/2026-07-15-layers-village-category.sql):
//  public.layers now carries real `village`/`category` columns, backfilled
//  and auto-maintained by a DB trigger using the SAME first-separator split
//  rule as parse() below (byte-for-byte: separator = ' · ', only the FIRST
//  occurrence splits, no-separator → village=null/category=name). If this
//  algorithm ever changes, the SQL migration's trigger + helper functions
//  must change with it, or the DB-derived columns and this client parse
//  will silently disagree for any newly-inserted/renamed layer.
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

// layer row → { village, category }. Prefers the DB columns
// (public.layers.village/category — added + backfilled + auto-maintained
// by gis-engine/sql/migrations/2026-07-15-layers-village-category.sql) when
// the row actually carries a non-null category; falls back to parsing
// `name` otherwise. The fallback matters for rows that came from a cache,
// an older RPC (e.g. features_geojson's embedded layer info, or any select
// string that doesn't enumerate village/category explicitly), or a DB that
// hasn't had the migration applied yet — all of which may hand us a layer
// object with no village/category keys at all.
LayerNaming.fromRow = function (layer) {
  if (layer && layer.category != null) {
    return { village: layer.village != null ? layer.village : null, category: layer.category };
  }
  return LayerNaming.parse(layer && layer.name);
};

})(window);
