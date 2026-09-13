// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — core.js  (load FIRST)
//
//  The engine is the single brain between the Leaflet UI and Supabase.
//  The UI must NEVER call supabase directly — it calls GIS.* instead.
//
//      Frontend (Leaflet)  →  GIS Engine Layer  →  Supabase
//
//  Plain browser globals, no bundler. Each module attaches itself to the
//  global `GIS` object created here. Reuses the app's existing `gSb`
//  Supabase client (defined in js/auth.js) — does NOT create a new one.
// ════════════════════════════════════════════════════════════════════════
(function (window) {
  'use strict';

  var GIS = window.GIS || {};
  window.GIS = GIS;

  GIS.version = '1.0.0';

  // ── Configuration (override before use if needed) ──────────────────────
  GIS.config = {
    aradSyncUrl: null,        // optional Arad REST endpoint for syncMeters()
    aradSyncToken: null,      // optional bearer token for that endpoint
    linkRadiusMeters: 25,     // proximity fallback when linking a meter
    defaultFeatureLimit: 5000, // safety cap on feature reads
    importChunkSize: 300      // meters per import_meters RPC call (avoids DB statement_timeout)
  };

  // ── Supabase client resolver ───────────────────────────────────────────
  // Reuses the global `gSb` from js/auth.js. Throws a clear error if the
  // page forgot to load auth.js before the engine.
  GIS.sb = function () {
    var client = window.gSb || (window.supabase && window.supabase._lastClient);
    if (!client) {
      throw new Error('[GIS] Supabase client (gSb) not found. Load js/auth.js before the GIS engine.');
    }
    return client;
  };

  // ── Error normalisation ────────────────────────────────────────────────
  // Wraps a Supabase { data, error } result, throwing a friendly Error.
  GIS._unwrap = function (res, context) {
    if (res && res.error) {
      var msg = res.error.message || String(res.error);
      // Common RLS denial → human-friendly hint. NOTE: "permission denied"
      // (no "for") is intentionally NOT matched here — our own Edit Mode
      // RPCs (update_feature_geometry / create_feature, see
      // gis-engine/sql/migrations/2026-09-13-edit-mode-geometry.sql) raise
      // Hebrew messages ending in the stable suffix "(permission denied)"
      // that GIS.classifyError() below needs intact to classify the error;
      // a bare Postgres RLS denial always reads "permission denied for
      // <object>", so matching "permission denied for" still catches the
      // generic case without swallowing the classifiable one.
      if (/row-level security|permission denied for|violates row-level/i.test(msg)) {
        msg = 'Permission denied: your role is not allowed to ' + (context || 'do this') + '.';
      }
      var e = new Error('[GIS] ' + (context ? context + ': ' : '') + msg);
      e.cause = res.error;
      throw e;
    }
    return res ? res.data : null;
  };

  GIS._assert = function (cond, msg) {
    if (!cond) throw new Error('[GIS] ' + msg);
  };

  // Classifies a thrown/rejected error into a stable category so UI code can
  // branch on it without regex-matching Hebrew text itself. Recognises the
  // stable English suffixes the Edit Mode RPCs raise — (permission denied),
  // (conflict), (invalid geometry), (not found) — plus BOTH client-side
  // GIS._requireRole wordings ("not allowed to ..." for a signed-in user with
  // the wrong role, "must be signed in to ..." for no session at all — both
  // are authz rejections from the caller's point of view and should reach
  // the same 'forbidden' UI branch), and falls back to sniffing common
  // network-failure phrasing before giving up as 'unknown'.
  GIS.classifyError = function (e) {
    var m = (e && e.message) || String(e || '');
    if (/\(permission denied\)/.test(m) || /not allowed to/i.test(m) || /must be signed in/i.test(m)) return 'forbidden';
    if (/\(conflict\)/.test(m)) return 'conflict';
    if (/\(invalid geometry\)/.test(m)) return 'invalid';
    if (/\(not found\)/.test(m)) return 'not_found';
    if (/failed to fetch|networkerror|network/i.test(m)) return 'network';
    return 'unknown';
  };

  // ── Role / permissions (cached for the session) ────────────────────────
  GIS._roleCache = null;

  // Returns the current user's role ('admin'|'engineer'|'viewer') or null.
  GIS.currentRole = async function (force) {
    if (GIS._roleCache && !force) return GIS._roleCache;
    var sb = GIS.sb();
    var auth = await sb.auth.getUser();
    var user = auth && auth.data && auth.data.user;
    if (!user) return (GIS._roleCache = null);
    var res = await sb.from('profiles').select('role').eq('id', user.id).single();
    GIS._roleCache = res && res.data ? res.data.role : null;
    return GIS._roleCache;
  };

  // Role tiers:  viewer (field submitter) · engineer (edit + review) · admin (all).
  // Legacy role-based hints — kept for existing call sites. Prefer GIS.can(perm).
  GIS.permissions = {
    canEditGis:    function (role) { return role === 'admin' || role === 'engineer'; },
    canEditMeters: function (role) { return role === 'admin' || role === 'engineer'; },
    canExport:     function (role) { return role === 'admin' || role === 'engineer'; },
    canEditSchema: function (role) { return role === 'admin'; }
  };

  // ── Data-driven permissions (RBAC) — fetched once from my_permissions() ──
  // The real enforcement is DB RLS; this drives UI gating + new workflow code.
  GIS._perms = null;
  GIS.loadPermissions = async function (force) {
    if (GIS._perms && !force) return GIS._perms;
    try {
      var res = await GIS.sb().rpc('my_permissions');
      var rows = (res && res.data) || [];
      GIS._perms = new Set(rows.map(function (r) {
        return typeof r === 'string' ? r : (r.my_permissions || r.permission || r);
      }));
    } catch (e) { GIS._perms = new Set(); }
    return GIS._perms;
  };
  // Sync permission check (call after loadPermissions() has resolved at init).
  GIS.can = function (perm) { return !!(GIS._perms && GIS._perms.has(perm)); };

  // Optional early client-side guard (RLS is the real enforcement).
  GIS._requireRole = async function (allowed, action) {
    var role = await GIS.currentRole();
    if (!role) throw new Error('[GIS] You must be signed in to ' + action + '.');
    if (allowed.indexOf(role) === -1) {
      throw new Error('[GIS] Your role (' + role + ') is not allowed to ' + action + '.');
    }
    return role;
  };

  // ── GeoJSON helpers ────────────────────────────────────────────────────
  GIS.emptyFC = function () { return { type: 'FeatureCollection', features: [] }; };

})(window);
