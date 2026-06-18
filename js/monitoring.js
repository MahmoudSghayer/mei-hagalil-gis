// ════════════════════════════════════════════════════════════════════════
//  Client error monitoring (Sentry) — DSN-gated, inert until configured.
//
//  To enable: create a free Sentry "Browser JavaScript" project and paste its
//  DSN into the page <head>, next to GIS_VAPID_PUBLIC:
//      <script>window.GIS_SENTRY_DSN='https://<key>@o<org>.ingest.<rgn>.sentry.io/<proj>';</script>
//
//  With no DSN this file does nothing (no SDK download, no network). With a DSN
//  it loads Sentry's loader script (auto-tracks the current SDK version, so no
//  version to maintain) and initialises it — Sentry then captures uncaught
//  errors and unhandled promise rejections via its default global handlers.
// ════════════════════════════════════════════════════════════════════════
(function () {
  var DSN = window.GIS_SENTRY_DSN || '';
  if (!DSN) return; // inert until a DSN is set

  var key;
  try { key = DSN.split('@')[0].split('//')[1]; } catch (e) { return; }
  if (!key) return;

  // Define sentryOnLoad BEFORE the loader runs so it eagerly loads the SDK and
  // uses our config instead of its lazy default init.
  window.sentryOnLoad = function () {
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

  var s = document.createElement('script');
  s.src = 'https://js.sentry-cdn.com/' + key + '.min.js';
  s.crossOrigin = 'anonymous';
  document.head.appendChild(s);
})();
