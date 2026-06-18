/* ══════════════════════════════════════════════════════════════════════════
   PWA glue — registers the service worker and tracks online/offline.
   On reconnect it flushes the viewer's offline submission queue (GISField).
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (e) { console.warn('[pwa] SW register failed', e); });
    });
  }
  function setOnline() { if (document.body) document.body.classList.toggle('is-offline', !navigator.onLine); }
  window.addEventListener('online', function () { setOnline(); if (window.GISField && GISField.flushQueue) GISField.flushQueue(); });
  window.addEventListener('offline', setOnline);
  setOnline();
})();
