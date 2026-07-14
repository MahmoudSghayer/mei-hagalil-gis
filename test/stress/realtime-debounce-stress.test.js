// Stress test (Worker W3.2): js/gis-realtime.js (window.GISRealtime) pushed
// past the handful-of-events scale that test/gis/realtime.test.js covers —
// same fake-channel + fake-timer harness, but:
//   1. A 500-event burst across 3 layers within a 2s window.
//   2. 50 rapid watch/unwatch churn cycles, asserting the 2-channel hard cap
//      (js/gis-realtime.js: MAX_CHANNELS=2) is NEVER exceeded and internal
//      bookkeeping (Maps) never leaks.
//   3. Suppress-window correctness under interleaved own-writes (many
//      suppress() calls racing many own/other-author events).
//
// IMPORTANT — reconciling "3 layers" with the real MAX_CHANNELS=2 hard cap:
// gis-realtime.js allows only 2 concurrently BACKED (real-channel) layers —
// watching a 3rd forces an LRU eviction of the channel (see
// evictOldestChannel() in the module). So "500 events across 3 layers" is
// tested as: watch L1, L2, L3 (L1's channel gets evicted, L2+L3 stay backed);
// fire the 500-event burst across the two CURRENTLY BACKED layers (L2, L3);
// then re-watch L1 (fresh channel) and prove its debounce/batching is clean
// (not contaminated by the earlier eviction) with its own event. That is a
// faithful "one batch per watched layer" proof that also respects the
// documented hard cap, rather than silently assuming a 3rd concurrent
// channel that the module deliberately disallows.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function makeSb() {
  var calls = { channel: [], subscribe: [], unsubscribe: [], removeChannel: [] };
  var channels = {};
  function makeChannel(name) {
    var handlers = [];
    var statusCb = null;
    var chan = {
      _name: name,
      _filterConfig: null,
      on: function (event, config, cb) { chan._filterConfig = config; handlers.push(cb); return chan; },
      subscribe: function (cb) { calls.subscribe.push(name); statusCb = cb; if (cb) cb('SUBSCRIBED'); return chan; },
      unsubscribe: function () { calls.unsubscribe.push(name); return Promise.resolve('ok'); },
      _emit: function (payload) { handlers.forEach(function (h) { h(payload); }); },
      _setStatus: function (s) { if (statusCb) statusCb(s); },
    };
    channels[name] = chan;
    return chan;
  }
  var client = {
    channel: function (name) { calls.channel.push(name); return makeChannel(name); },
    removeChannel: function (ch) { calls.removeChannel.push(ch && ch._name); return Promise.resolve('ok'); },
    auth: { getUser: function () { return Promise.resolve({ data: { user: null } }); } },
  };
  return { client: client, calls: calls, channels: channels };
}

function load() {
  const fake = makeSb();
  const GIS = { sb: function () { return fake.client; }, config: {} };
  const ctx = loadBrowserGlobals(['js/gis-realtime.js'], { GIS: GIS });
  return { GISRealtime: ctx.window.GISRealtime, fake: fake, GIS: GIS };
}

function emitEvent(chan, id, layerId, editedBy) {
  chan._emit({ eventType: 'UPDATE', new: { id: id, layer_id: layerId, edited_by: editedBy || null }, old: { id: id, layer_id: layerId } });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('realtime stress: 500 events across 3 layers within 2s -> exactly one batch per watched+backed layer', () => {
  it('coalesces a 500-event burst spread across L2/L3 (L1 evicted by the 2-channel cap) into exactly one batch each', () => {
    const { GISRealtime, fake } = load();
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));

    GISRealtime.watchLayer('L1');
    GISRealtime.watchLayer('L2');
    GISRealtime.watchLayer('L3');   // forces L1's channel to be evicted (LRU)
    expect(fake.calls.removeChannel).toEqual(['gis-rt-L1']);
    expect(Object.keys(GISRealtime.status().channels).sort()).toEqual(['L2', 'L3']);

    const chanL2 = fake.channels['gis-rt-L2'];
    const chanL3 = fake.channels['gis-rt-L3'];
    let n2 = 0, n3 = 0;
    for (let i = 0; i < 500; i++) {
      // Deterministic-but-mixed distribution, interleaved arrival order — the
      // debounce/batching logic must key strictly off layerId, not arrival slot.
      if (i % 3 === 0) { emitEvent(chanL3, 'l3-' + i, 'L3'); n3++; }
      else { emitEvent(chanL2, 'l2-' + i, 'L2'); n2++; }
      vi.advanceTimersByTime(1); // 500 events spread across ~500ms — well inside the 2s trailing debounce
    }
    expect(n2 + n3).toBe(500);

    vi.advanceTimersByTime(2000); // let both trailing debounces fire
    expect(batches.length).toBe(2);
    const byLayer = Object.fromEntries(batches.map((b) => [b.layerId, b]));
    expect(byLayer.L2.events.length).toBe(n2);
    expect(byLayer.L3.events.length).toBe(n3);

    // Re-watching the evicted L1 opens a fresh channel and its own debounce is
    // clean — proves the eviction didn't leave stale batching state behind.
    GISRealtime.watchLayer('L1');
    expect(fake.calls.channel.filter((n) => n === 'gis-rt-L1').length).toBe(2); // opened, evicted, re-opened
    emitEvent(fake.channels['gis-rt-L1'], 'l1-fresh', 'L1');
    vi.advanceTimersByTime(2000);
    expect(batches.length).toBe(3);
    expect(batches[2].layerId).toBe('L1');
    expect(batches[2].events.length).toBe(1);
  });

  it('a burst confined to a single layer never spills a second batch, even at 500 events', () => {
    const { GISRealtime, fake } = load();
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('SOLO');
    const chan = fake.channels['gis-rt-SOLO'];
    for (let i = 0; i < 500; i++) {
      emitEvent(chan, 'e' + i, 'SOLO');
      vi.advanceTimersByTime(2); // ~1s total — still inside the 2s trailing window
    }
    vi.advanceTimersByTime(2000);
    expect(batches.length).toBe(1);
    expect(batches[0].events.length).toBe(500);
  });
});

describe('realtime stress: 50 rapid watch/unwatch churn cycles never exceed the 2-channel cap', () => {
  it('cycling watch immediately followed by unwatch across many distinct layers keeps the channel count bounded and leaves no dangling state', () => {
    const { GISRealtime, fake } = load();
    for (let i = 0; i < 50; i++) {
      const id = 'churn-' + i;
      GISRealtime.watchLayer(id);
      expect(fake.calls.channel.length).toBeGreaterThan(0); // opened (or reused capacity)
      expect(Object.keys(GISRealtime.status().channels).length).toBeLessThanOrEqual(2); // hard cap, never exceeded mid-churn
      GISRealtime.unwatchLayer(id);
      expect(GISRealtime.status().watched[id]).toBeUndefined(); // fully torn down, ref count back to 0
    }
    // After 50 full watch->unwatch cycles, nothing should still be tracked.
    const finalStatus = GISRealtime.status();
    expect(Object.keys(finalStatus.watched).length).toBe(0);
    expect(Object.keys(finalStatus.channels).length).toBe(0);
    expect(finalStatus.pendingLayers.length).toBe(0);
  });

  it('cycling watch/unwatch on a ROTATING set of 3 layer ids (never more than 2 watched at once) never exceeds the channel cap and re-provisions correctly each time', () => {
    const { GISRealtime, fake } = load();
    const ids = ['A', 'B', 'C'];
    for (let cycle = 0; cycle < 50; cycle++) {
      const id = ids[cycle % 3];
      GISRealtime.watchLayer(id);
      expect(Object.keys(GISRealtime.status().channels).length).toBeLessThanOrEqual(2);
      // Unwatch the one watched 2 cycles ago so at most 2 are ever concurrently live.
      if (cycle >= 1) GISRealtime.unwatchLayer(ids[(cycle - 1) % 3]);
    }
    const finalOpenCount = fake.calls.channel.length - fake.calls.removeChannel.length;
    expect(finalOpenCount).toBe(Object.keys(GISRealtime.status().channels).length); // every open was eventually closed except the still-live ones
    expect(finalOpenCount).toBeLessThanOrEqual(2);
  });

  it('rapid repeat watchLayer() on the SAME layer 50 times in a row ref-counts instead of opening 50 channels', () => {
    const { GISRealtime, fake } = load();
    for (let i = 0; i < 50; i++) GISRealtime.watchLayer('HOT');
    expect(fake.calls.channel).toEqual(['gis-rt-HOT']); // opened exactly once
    expect(GISRealtime.status().watched.HOT.refCount).toBe(50);
    for (let i = 0; i < 49; i++) GISRealtime.unwatchLayer('HOT');
    expect(fake.calls.removeChannel).toEqual([]); // still referenced once
    GISRealtime.unwatchLayer('HOT');
    expect(fake.calls.removeChannel).toEqual(['gis-rt-HOT']); // torn down on the 50th matching unwatch
  });
});

describe('realtime stress: suppress-window correctness under interleaved own-writes', () => {
  it('across 40 interleaved own/other-author events on 2 layers, only the OTHER-author events ever survive suppression', () => {
    const { GISRealtime, fake } = load();
    GISRealtime._test.setMyUserId('me');
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('L1');
    GISRealtime.watchLayer('L2');
    const chan1 = fake.channels['gis-rt-L1'];
    const chan2 = fake.channels['gis-rt-L2'];

    let expectedL1Other = 0, expectedL2Other = 0;
    for (let i = 0; i < 40; i++) {
      const layer = i % 2 === 0 ? 'L1' : 'L2';
      const chan = layer === 'L1' ? chan1 : chan2;
      const isOwn = i % 3 !== 0; // 2/3 of events are our own write's echo
      // Re-open (or refresh) the suppression window right before "our" write's
      // echo would land — mirrors gis-engine/features.js calling suppress()
      // immediately after a successful write, interleaved with genuinely
      // concurrent edits from other users that must NEVER be swallowed.
      if (isOwn) GISRealtime.suppress(layer, 3000);
      emitEvent(chan, 'ev' + i, layer, isOwn ? 'me' : 'someone-else');
      if (!isOwn) { if (layer === 'L1') expectedL1Other++; else expectedL2Other++; }
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(2000);

    const byLayer = Object.fromEntries(batches.map((b) => [b.layerId, b]));
    // Only the "someone-else" events should have survived per layer — every
    // own-authored echo was suppressed regardless of how many suppress()
    // calls were interleaved with genuine concurrent edits.
    expect(byLayer.L1 ? byLayer.L1.events.length : 0).toBe(expectedL1Other);
    expect(byLayer.L2 ? byLayer.L2.events.length : 0).toBe(expectedL2Other);
    (batches.flatMap((b) => b.events)).forEach((ev) => expect(ev.editedBy).toBe('someone-else'));
  });

  it('a suppress() window that expires mid-burst lets same-author events after expiry back through, while events before expiry stay suppressed', () => {
    const { GISRealtime, fake } = load();
    GISRealtime._test.setMyUserId('me');
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('L1');
    const chan = fake.channels['gis-rt-L1'];

    GISRealtime.suppress('L1', 500);
    emitEvent(chan, 'inside-1', 'L1', 'me');
    vi.advanceTimersByTime(200);
    emitEvent(chan, 'inside-2', 'L1', 'me');
    vi.advanceTimersByTime(400); // window (500ms) has now elapsed since suppress() was called
    emitEvent(chan, 'after-expiry', 'L1', 'me'); // same author, but window is gone -> passes through
    vi.advanceTimersByTime(2000);

    expect(batches.length).toBe(1);
    expect(batches[0].events.length).toBe(1);
    expect(batches[0].events[0].id).toBe('after-expiry');
  });

  it('repeated suppress() calls on a busy layer (20 back-to-back own-writes) never let a same-author echo through mid-stream', () => {
    const { GISRealtime, fake } = load();
    GISRealtime._test.setMyUserId('me');
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('BUSY');
    const chan = fake.channels['gis-rt-BUSY'];

    for (let i = 0; i < 20; i++) {
      GISRealtime.suppress('BUSY', 1000); // refreshed before every echo, as the real write-then-suppress call site does
      emitEvent(chan, 'own' + i, 'BUSY', 'me');
      vi.advanceTimersByTime(50); // 20 * 50ms = 1s of continuous own-writes, always re-suppressed in time
    }
    // One genuine concurrent edit slips in right after the last own-write's suppress window.
    vi.advanceTimersByTime(1100); // let the last suppress() (1000ms) fully expire
    emitEvent(chan, 'concurrent', 'BUSY', 'someone-else');
    vi.advanceTimersByTime(2000);

    const all = batches.flatMap((b) => b.events);
    expect(all.length).toBe(1);
    expect(all[0].id).toBe('concurrent');
  });
});
