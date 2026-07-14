// ════════════════════════════════════════════════════════════════════════
//  מי הגליל GIS — Realtime map↔table sync   →   window.GISRealtime   (W2.3)
//  ──────────────────────────────────────────────────────────────────────
//  UI never calls Supabase directly — this is the ONE place that opens
//  `postgres_changes` channels on public.features (mirrors how
//  js/gis-notifications.js owns its own channel). SQL prerequisites:
//  gis-engine/sql/migrations/2026-07-14-features-realtime.sql (publication
//  membership + REPLICA IDENTITY FULL — read that file for why FULL).
//
//  Design (locked):
//    • Scoped channels, open only while needed. ONE postgres_changes
//      channel per watched layer, server-side filtered `layer_id=eq.<id>`,
//      watched via ref-counted watchLayer()/unwatchLayer() — a layer is
//      "watched" while its attribute table is open (this wave's only
//      caller: js/gis-feature-table.js) or, in future, an edit session is
//      active on it (watchLayer/unwatchLayer are generic and ref-counted
//      so a second, independent caller can share a layer's channel).
//    • Hard cap of 2 concurrent channels — opening a 3rd evicts the LRU
//      one (least recently (re)watched). The evicted layer simply stops
//      getting realtime pushes until it's unwatched and watched again.
//    • Own writes: the app already refreshes itself after its own write,
//      so suppress(layerId, ms) — called centrally from
//      gis-engine/features.js right after each successful write (covers
//      js/gis-feature-table.js AND js/gis-edit.js call sites, since both
//      funnel through GIS.features.*) — opens a short window in which the
//      inevitable realtime ECHO of that same write is dropped instead of
//      triggering a second refresh. The window is authorship-aware: once
//      this session knows its own user id (primed once via
//      auth.getUser()), an event from a DIFFERENT user's edited_by is
//      NEVER suppressed even if it lands inside the window — a genuine
//      concurrent edit is never swallowed.
//    • Poll fallback behind GIS.config.realtimeMode ('channels' default |
//      'poll' | 'off'). 'poll': no channels at all — a 30s interval per
//      watched layer fires a synthetic empty-events batch (no per-row
//      diff available), which is enough to drive "just refetch" consumers
//      (the table integration below doesn't inspect event contents to
//      decide WHETHER to refetch, only to detect an in-progress-edit
//      conflict — see js/gis-feature-table.js). 'off': no channels, no
//      poll timer — today's manual-refresh-only behaviour.
//    • Remote changes are collected per-layer and fired as ONE batch after
//      a 2s trailing debounce (classic reset-on-each-event debounce, same
//      meaning as `_renderAllDebounced` in js/pages/index.js) so a burst
//      (e.g. a bulk edit) coalesces into a single refresh/invalidate.
//    • Map invalidation: on every fired batch, if GISEngineSidebar is
//      present AND the layer is one of its currently active (rendered)
//      layers, GISEngineSidebar.reload(layerId) is called. That is
//      FULL-layer invalidation (gis-tile-loader.js: clears the tile/
//      feature cache and refetches the current viewport; gis-mvt-layer.js:
//      cache-busts and rebuilds the vector-tile layer) — see the
//      "invalidation granularity" note near the bottom of this file for
//      why a genuinely bbox-scoped call isn't wired in this wave despite
//      gis-tile-loader.js now exposing one.
// ════════════════════════════════════════════════════════════════════════
(function (window) {
  'use strict';

  var GIS = window.GIS || (window.GIS = {});
  if (!GIS.config) GIS.config = {};
  if (GIS.config.realtimeMode === undefined) GIS.config.realtimeMode = 'channels';

  var MAX_CHANNELS      = 2;
  var DEBOUNCE_MS        = 2000;
  var POLL_MS             = 30000;
  var DEFAULT_SUPPRESS_MS = 3000;
  var MAX_RETRIES         = 5;
  var RETRY_BASE_MS       = 1000;
  var RETRY_MAX_MS        = 30000;

  var _mode        = GIS.config.realtimeMode;
  var _watched     = new Map();   // layerId -> { refCount, lastUsedAt }
  var _channels    = new Map();   // layerId -> { channel, retries, retryTimer, subscribedAt }
  var _pollTimers  = new Map();   // layerId -> intervalId
  var _pending     = new Map();   // layerId -> { events:[], timer }
  var _suppressUntil = new Map(); // layerId -> epoch ms
  var _listeners   = [];          // onChange callbacks
  var _myUserId    = null;

  function sb() { return GIS.sb(); }  // throws if auth.js/core.js aren't loaded yet — every caller catches it
  function warn(msg) { if (window.console) console.warn('[GISRealtime] ' + msg); }

  // Resolve our own user id ONCE (best-effort) so own-write suppression can
  // tell "my echo" apart from "someone else's genuine concurrent edit".
  // Retried lazily from watchLayer() while it hasn't resolved yet.
  function primeUserId() {
    if (_myUserId) return;
    try {
      var client = sb();
      if (client && client.auth && client.auth.getUser) {
        client.auth.getUser().then(function (r) {
          _myUserId = (r && r.data && r.data.user && r.data.user.id) || _myUserId;
        }).catch(function () {});
      }
    } catch (e) { /* GIS.sb() not ready yet — retried on the next watchLayer() */ }
  }

  // ── event normalisation: postgres_changes payload → a small, stable shape.
  // `new`/`old` arrive as {} (not null/undefined) when not applicable
  // (INSERT has no old row, DELETE has no new row) — normalised to null so
  // callers can do a plain truthy check instead of an emptiness check.
  function nz(row) { return row && Object.keys(row).length ? row : null; }
  function normalizeEvent(payload, fallbackLayerId) {
    var row = nz(payload.new), old = nz(payload.old);
    return {
      type: payload.eventType,
      id: (row && row.id) || (old && old.id) || null,
      layerId: (row && row.layer_id) || (old && old.layer_id) || fallbackLayerId || null,
      new: row,
      old: old,
      editedBy: (row && row.edited_by) || (old && old.edited_by) || null,
      at: Date.now()
    };
  }

  // ── own-write suppression ──────────────────────────────────────────────
  function isSuppressed(ev) {
    var until = _suppressUntil.get(ev.layerId);
    if (!until || Date.now() >= until) return false;
    // Authorship-aware: a confirmed OTHER author always passes through,
    // even inside our own suppression window (never hide a real conflict).
    if (_myUserId && ev.editedBy && ev.editedBy !== _myUserId) return false;
    return true;
  }
  function suppress(layerId, ms) {
    if (!layerId) return;
    _suppressUntil.set(layerId, Date.now() + (ms || DEFAULT_SUPPRESS_MS));
  }

  // ── per-layer trailing debounce / batching (2s) ────────────────────────
  function queueEvent(ev) {
    var p = _pending.get(ev.layerId);
    if (!p) { p = { events: [] }; _pending.set(ev.layerId, p); }
    p.events.push(ev);
    clearTimeout(p.timer);
    p.timer = setTimeout(function () {
      var events = p.events;
      _pending.delete(ev.layerId);
      fireBatch(ev.layerId, events);
    }, DEBOUNCE_MS);
  }

  // Fan-out to onChange() subscribers + built-in map invalidation. Runs for
  // BOTH the channels path (real per-row events) and the poll path
  // (synthetic empty-events "just refetch" ticks).
  function fireBatch(layerId, events) {
    var batch = { layerId: layerId, events: events, at: Date.now() };
    try {
      var sidebar = window.GISEngineSidebar;
      if (sidebar && typeof sidebar.activeLayers === 'function' && typeof sidebar.reload === 'function') {
        var actives = sidebar.activeLayers() || [];
        var isActive = actives.some(function (a) { return a && (a.id === layerId || a === layerId); });
        if (isActive) sidebar.reload(layerId);   // full-layer invalidate — see file header
      }
    } catch (e) { warn('שגיאה ברענון המפה: ' + (e && e.message || e)); }
    _listeners.slice().forEach(function (cb) {
      try { cb(batch); } catch (e) { warn('שגיאה במאזין realtime: ' + (e && e.message || e)); }
    });
  }

  // ── channel transport (mode:'channels') ────────────────────────────────
  function makeHandler(layerId) {
    return function (payload) {
      var ev = normalizeEvent(payload, layerId);
      if (isSuppressed(ev)) return;
      queueEvent(ev);
    };
  }
  function onChannelStatus(layerId, status) {
    var info = _channels.get(layerId);
    if (!info) return;   // already torn down (unwatch/eviction/mode-switch) — ignore a late callback
    if (status === 'SUBSCRIBED') { info.retries = 0; return; }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') scheduleReconnect(layerId);
  }
  function openChannel(layerId) {
    var client;
    try { client = sb(); }
    catch (e) { warn('לא ניתן להתחבר ל-Supabase (שכבה ' + layerId + '): ' + (e && e.message || e)); return; }
    var ch = client.channel('gis-rt-' + layerId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'features', filter: 'layer_id=eq.' + layerId }, makeHandler(layerId))
      .subscribe(function (status) { onChannelStatus(layerId, status); });
    _channels.set(layerId, { channel: ch, retries: 0, retryTimer: null, subscribedAt: Date.now() });
  }
  function closeChannelObject(layerId) {
    var info = _channels.get(layerId);
    if (!info) return;
    if (info.retryTimer) clearTimeout(info.retryTimer);
    try {
      var client = sb();
      if (client.removeChannel) client.removeChannel(info.channel);
      else if (info.channel && info.channel.unsubscribe) info.channel.unsubscribe();
    } catch (e) {
      try { if (info.channel && info.channel.unsubscribe) info.channel.unsubscribe(); } catch (e2) {}
    }
    _channels.delete(layerId);
  }
  // Exponential backoff (1s,2s,4s,8s,16s, cap 30s), MAX_RETRIES attempts,
  // Hebrew console.warn only — never a user-facing toast (no toast spam on
  // a flaky connection; the table/map simply fall a little behind until it
  // recovers, same as any other transient network hiccup in this app).
  function scheduleReconnect(layerId) {
    var info = _channels.get(layerId);
    if (!info || !_watched.has(layerId) || _mode !== 'channels') return;
    if (info.retries >= MAX_RETRIES) {
      warn('ויתור על חיבור מחדש לשכבה ' + layerId + ' אחרי ' + MAX_RETRIES + ' ניסיונות');
      return;
    }
    info.retries++;
    var attempt = info.retries;
    var delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, attempt - 1));
    warn('החיבור לשכבה ' + layerId + ' נותק — ניסיון חיבור מחדש ' + attempt + '/' + MAX_RETRIES + ' בעוד ' + Math.round(delay / 1000) + 'ש׳');
    info.retryTimer = setTimeout(function () {
      closeChannelObject(layerId);
      if (_watched.has(layerId) && _mode === 'channels') {
        openChannel(layerId);
        var fresh = _channels.get(layerId);
        if (fresh) fresh.retries = attempt;   // preserve the counter across the reconnect attempt
      }
    }, delay);
  }
  // LRU eviction: closes whichever currently-open channel was least
  // recently (re)watched. watchLayer() bumps lastUsedAt on every call
  // (fresh watch OR a repeat watch of an already-watched layer), so a
  // layer whose table the user keeps interacting with stays "hot".
  function evictOldestChannel() {
    var oldestId = null, oldestTs = Infinity;
    _channels.forEach(function (info, id) {
      var w = _watched.get(id);
      var ts = (w && w.lastUsedAt) || info.subscribedAt || 0;
      if (ts < oldestTs) { oldestTs = ts; oldestId = id; }
    });
    if (oldestId != null) closeChannelObject(oldestId);
  }

  // ── poll transport (mode:'poll') — no granular diff, just "go refetch" ──
  function startPoll(layerId) {
    if (_pollTimers.has(layerId)) return;
    var t = setInterval(function () { fireBatch(layerId, []); }, POLL_MS);
    _pollTimers.set(layerId, t);
  }
  function stopPoll(layerId) {
    var t = _pollTimers.get(layerId);
    if (t) { clearInterval(t); _pollTimers.delete(layerId); }
  }

  function provisionBacking(layerId) {
    if (_mode === 'off') return;
    if (_mode === 'poll') { startPoll(layerId); return; }
    if (_channels.size >= MAX_CHANNELS) evictOldestChannel();
    openChannel(layerId);
  }
  function teardownBacking(layerId) {
    closeChannelObject(layerId);
    stopPoll(layerId);
  }

  // ── public API ──────────────────────────────────────────────────────────
  function watchLayer(layerId) {
    if (!layerId) return;
    primeUserId();
    var w = _watched.get(layerId);
    if (w) { w.refCount++; w.lastUsedAt = Date.now(); }
    else { w = { refCount: 1, lastUsedAt: Date.now() }; _watched.set(layerId, w); }
    // Re-provision if this layer has no live backing yet — covers both a
    // fresh watch AND a re-watch of a layer that was LRU-evicted earlier.
    if (!_channels.has(layerId) && !_pollTimers.has(layerId)) provisionBacking(layerId);
  }
  function unwatchLayer(layerId) {
    if (!layerId) return;
    var w = _watched.get(layerId);
    if (!w) return;
    w.refCount--;
    if (w.refCount > 0) return;
    _watched.delete(layerId);
    teardownBacking(layerId);
    var p = _pending.get(layerId);
    if (p) { clearTimeout(p.timer); _pending.delete(layerId); }
    _suppressUntil.delete(layerId);
  }
  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    _listeners.push(cb);
    return function () {   // convenience unsubscribe handle
      var i = _listeners.indexOf(cb);
      if (i >= 0) _listeners.splice(i, 1);
    };
  }
  function setMode(mode) {
    if (mode !== 'channels' && mode !== 'poll' && mode !== 'off') return;
    if (mode === _mode) return;
    _mode = mode;
    GIS.config.realtimeMode = mode;
    var ids = [];
    _watched.forEach(function (w, id) { ids.push(id); });
    ids.forEach(teardownBacking);                          // drop the old transport for every still-watched layer
    if (mode !== 'off') ids.forEach(provisionBacking);      // ...and re-provision under the new one
  }
  function status() {
    var watched = {}, channels = {}, poll = [], suppressed = {};
    _watched.forEach(function (w, id) { watched[id] = { refCount: w.refCount, lastUsedAt: w.lastUsedAt }; });
    _channels.forEach(function (info, id) { channels[id] = { subscribedAt: info.subscribedAt, retries: info.retries }; });
    _pollTimers.forEach(function (t, id) { poll.push(id); });
    _suppressUntil.forEach(function (until, id) { if (Date.now() < until) suppressed[id] = until - Date.now(); });
    return { mode: _mode, watched: watched, channels: channels, pollLayers: poll, suppressed: suppressed, pendingLayers: Array.from(_pending.keys()) };
  }

  window.GISRealtime = {
    watchLayer: watchLayer,
    unwatchLayer: unwatchLayer,
    onChange: onChange,
    setMode: setMode,
    suppress: suppress,
    status: status,
    // Test-only — lets test/gis/realtime.test.js pin down own-write dedupe
    // deterministically instead of racing the real async auth.getUser()
    // call. No runtime callers (mirrors GISTable._test's convention).
    _test: { setMyUserId: function (id) { _myUserId = id; } }
  };

  // ── invalidation granularity, and why bbox-scoping isn't wired this wave ─
  // js/gis-tile-loader.js now exposes invalidateBBox(bbox) on every
  // controller it creates: it evicts + refetches only the cached tiles that
  // intersect the changed area (the rest of the map's rendered tiles are
  // left completely alone — no flash/redraw elsewhere), vs. invalidate()'s
  // full clear+refetch of the current viewport. js/gis-mvt-layer.js also
  // exposes invalidateBBox(bbox), but documents that it's an ALIAS for a
  // full cache-busted rebuild — Leaflet.VectorGrid's canvas tiles aren't
  // individually addressable from outside, so there is no cheaper correct
  // option on that path (matches the locked decision's own escape hatch).
  //
  // GISRealtime does NOT call invalidateBBox() itself this wave, for two
  // compounding reasons:
  //   1) js/gis-engine-sidebar.js (which privately owns the layerId →
  //      controller map) is out of scope for this worker/wave — its public
  //      surface is reload(layerId)/reloadAll()/activeLayers(), none of
  //      which accept or forward a bbox. Reaching a live controller's
  //      invalidateBBox from here would need a small follow-up there
  //      (e.g. reload(layerId, bbox) or an exposed getController(layerId)).
  //   2) Even with that seam, a real bbox needs the changed feature's
  //      GEOMETRY. public.features.geometry is a PostGIS `geometry` column;
  //      over logical replication (what postgres_changes streams) it comes
  //      through as raw EWKB (hex-encoded binary), NOT GeoJSON — there is
  //      no WKB decoder in this codebase, and adding one is out of scope
  //      here. A real bbox would need an extra fetch per changed feature id
  //      (e.g. GIS.features.getFeatureById, which DOES return GeoJSON).
  // So today: GISEngineSidebar.reload(layerId) (full-layer invalidate) is
  // the actual call, with the 2s per-layer debounce as the cost control —
  // exactly the fallback the locked decision anticipates. invalidateBBox()
  // is a ready, tested primitive for whoever picks up (1)+(2) next.

})(window);
