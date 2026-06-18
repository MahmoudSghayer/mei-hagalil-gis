/* ══════════════════════════════════════════════════════════════════════════
   Web Push (C4) — client subscribe. Asks permission, subscribes via the SW's
   PushManager, and stores the subscription per user (push_subscriptions table).

   SETUP REQUIRED: set window.GIS_VAPID_PUBLIC to your VAPID public key (e.g. an
   inline <script> in index.html or a config endpoint). Sending the actual push
   is a backend job — a Supabase Edge Function using the VAPID PRIVATE key +
   web-push, triggered on assignment/approval. Until the key is set, enable()
   explains that push needs configuration.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  function sb() { return window.GIS ? GIS.sb() : window.gSb; }
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.className = 'show'; setTimeout(function () { t.className = ''; }, 2800); }
  function b64ToUint8(s) {
    var pad = '='.repeat((4 - s.length % 4) % 4);
    var raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function enable() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast('התראות דחיפה אינן נתמכות בדפדפן זה'); return; }
    var VAPID = window.GIS_VAPID_PUBLIC || '';
    if (!VAPID) { toast('התראות דחיפה דורשות הגדרת מפתח VAPID (ראה gis-push.js)'); return; }
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('ההרשאה להתראות נדחתה'); return; }
    try {
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(VAPID) });
      var u = (await sb().auth.getUser()).data.user;
      if (u) await sb().from('push_subscriptions').upsert([{ endpoint: sub.endpoint, user_id: u.id, subscription: sub.toJSON() }], { onConflict: 'endpoint' });
      toast('🔔 התראות הופעלו במכשיר זה');
    } catch (e) { toast('שגיאה בהפעלת התראות: ' + (e.message || e)); }
  }

  window.GISPush = { enable: enable };
})();
