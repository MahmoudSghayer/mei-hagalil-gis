/* ══════════════════════════════════════════════════════════════════════════
   Mei HaGalil GIS — service worker (offline app shell).
   SAFE by design: only SAME-ORIGIN GET static assets are cached. Navigations
   are network-first with an index.html fallback; Supabase API, map tiles and
   CDN libs pass straight through to the network (never cached/intercepted).
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
var CACHE = 'mhg-shell-v1';
var SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL).catch(function () {}); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // leave Supabase/tiles/CDN alone

  if (req.mode === 'navigate') {                                   // page: network-first, cached shell fallback
    e.respondWith(fetch(req).catch(function () { return caches.match('/index.html'); }));
    return;
  }
  if (/\.(?:css|js|png|jpg|svg|webmanifest|woff2?)$/.test(url.pathname)) {  // static: stale-while-revalidate
    e.respondWith(caches.open(CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(function () { return hit; });
        return hit || net;
      });
    }));
  }
});
