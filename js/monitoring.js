// ════════════════════════════════════════════════════════════════════════
//  Client error monitoring (Sentry) — DSN-gated, inert until configured.
//
//  To enable: create a free Sentry "Browser JavaScript" project and paste its
//  DSN into the page <head>, next to GIS_VAPID_PUBLIC:
//      <script>window.GIS_SENTRY_DSN='https://<key>@o<org>.ingest.<rgn>.sentry.io/<proj>';</script>
//
//  With no DSN this file does nothing (no SDK download, no network). With a DSN
//  it loads the Sentry browser SDK bundle directly from the CDN and initialises
//  it — Sentry then captures uncaught errors and unhandled promise rejections
//  via its default global handlers. (We load the versioned bundle rather than
//  the js.sentry-cdn.com loader, which depends on a per-project "Loader Script"
//  toggle that is off by default. Bump SDK_VER to upgrade.)
// ════════════════════════════════════════════════════════════════════════
(function () {
  var DSN = window.GIS_SENTRY_DSN || '';
  if (!DSN) return; // inert until a DSN is set

  var SDK_VER = '10.58.0';
  var s = document.createElement('script');
  s.src = 'https://browser.sentry-cdn.com/' + SDK_VER + '/bundle.min.js';
  s.crossOrigin = 'anonymous';
  s.onload = function () {
    if (!window.Sentry || !window.Sentry.init) return;
    try {
      window.Sentry.init({
        dsn: DSN,
        environment: /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'dev' : 'production',
        release: window.GIS_RELEASE || undefined
      });
      // Best-effort: attach the signed-in user once auth is available.
      if (window.gSb && window.gSb.auth && window.gSb.auth.getUser) {
        window.gSb.auth.getUser().then(function (r) {
          var u = r && r.data && r.data.user;
          if (u) window.Sentry.setUser({ id: u.id, email: u.email });
        }).catch(function () {});
      }
    } catch (e) { /* never let monitoring break the app */ }
  };
  document.head.appendChild(s);
})();
