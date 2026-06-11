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
      // Common RLS denial → human-friendly hint.
      if (/row-level security|permission denied|violates row-level/i.test(msg)) {
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

  // ── Role / permissions (cached for the session) ────────────────────────
  GIS._roleCache = null;

  // Returns the current user's role ('admin'|'engineer'|'office'|'user') or null.
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

  GIS.permissions = {
    canEditGis: function (role) { return role === 'admin' || role === 'engineer'; },
    canEditMeters: function (role) { return role === 'admin'; },
    canEditSchema: function (role) { return role === 'admin'; }
  };

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
