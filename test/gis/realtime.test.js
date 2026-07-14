// Unit tests for js/gis-realtime.js (window.GISRealtime) — W2.3 realtime
// map↔table sync: scoped postgres_changes channels on public.features,
// 2-channel LRU cap, 2s per-layer debounce/batching, mode switching
// (channels/poll/off), own-write suppression, and event normalization.
//
// Loaded into a Node vm context via the shared harness (see
// test/security/incidents-rt.test.js for the same channel-stub + fake-timer
// pattern used here) with a stubbed GIS.sb() that returns a fake Supabase
// client capturing every .channel()/.on()/.subscribe()/.unsubscribe()/
// .removeChannel() call so the channel lifecycle can be asserted on
// directly, without a real network/websocket.
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
      // test helpers, not part of the real Supabase channel API
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

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('watchLayer/unwatchLayer lifecycle', () => {
  it('opens exactly one channel, filtered to the layer, on the first watch', () => {
    const { GISRealtime, fake } = load();
    GISRealtime.watchLayer('L1');
    expect(fake.calls.channel).toEqual(['gis-rt-L1']);
    const chan = fake.channels['gis-rt-L1'];
    expect(chan._filterConfig).toEqual({ event: '*', schema: 'public', table: 'features', filter: 'layer_id=eq.L1' });
  });

  it('ref-counts repeat watches — a second watchLayer() does not open a second channel', () => {
    const { GISRealtime, fake } = load();
    GISRealtime.watchLayer('L1');
    GISRealtime.watchLayer('L1');   // e.g. table open + an edit session sharing the layer
    expect(fake.calls.channel).toEqual(['gis-rt-L1']);
    expect(GISRealtime.status().watched.L1.refCount).toBe(2);
  });

  it('only tears the channel down once the ref count reaches zero', () => {
    const { GISRealtime, fake } = load();
    GISRealtime.watchLayer('L1');
    GISRealtime.watchLayer('L1');
    GISRealtime.unwatchLayer('L1');
    expect(fake.calls.removeChannel).toEqual([]);          // still referenced once
    GISRealtime.unwatchLayer('L1');
    expect(fake.calls.removeChannel).toEqual(['gis-rt-L1']); // now torn down
    expect(GISRealtime.status().watched.L1).toBeUndefined();
  });

  it('unwatching a layer that was never watched is a harmless no-op', () => {
    const { GISRealtime, fake } = load();
    expect(() => GISRealtime.unwatchLayer('nope')).not.toThrow();
    expect(fake.calls.channel).toEqual([]);
  });
});

describe('2-channel LRU cap', () => {
  it('evicts the least-recently-watched channel when a 3rd distinct layer is watched', () => {
    const { GISRealtime, fake } = load();
    GISRealtime.watchLayer('L1');
    GISRealtime.watchLayer('L2');
    expect(fake.calls.channel).toEqual(['gis-rt-L1', 'gis-rt-L2']);
    GISRealtime.watchLayer('L3');
    expect(fake.calls.channel).toEqual(['gis-rt-L1', 'gis-rt-L2', 'gis-rt-L3']);
    expect(fake.calls.removeChannel).toEqual(['gis-rt-L1']);   // L1 was oldest
    expect(Object.keys(GISRealtime.status().channels).sort()).toEqual(['L2', 'L3']);
  });

  it('re-touching a layer (repeat watchLayer) protects it from being the next eviction victim', () => {
    const { GISRealtime, fake } = load();
    GISRealtime.watchLayer('L1');
    vi.advanceTimersByTime(10);
    GISRealtime.watchLayer('L2');
    vi.advanceTimersByTime(10);
    GISRealtime.watchLayer('L1');   // touch L1 again — now L2 is the oldest
    vi.advanceTimersByTime(10);
    GISRealtime.watchLayer('L3');   // forces an eviction
    expect(fake.calls.removeChannel).toEqual(['gis-rt-L2']);
  });
});

describe('debounce batching (trailing, 2s, per layer)', () => {
  it('coalesces a burst of events on the same layer into a single batch', () => {
    const { GISRealtime, fake } = load();
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('L1');
    const chan = fake.channels['gis-rt-L1'];
    chan._emit({ eventType: 'INSERT', new: { id: 'f1', layer_id: 'L1' }, old: {} });
    vi.advanceTimersByTime(1000);
    chan._emit({ eventType: 'UPDATE', new: { id: 'f1', layer_id: 'L1' }, old: { id: 'f1', layer_id: 'L1' } });
    expect(batches.length).toBe(0);            // still pending — the 2nd event reset the trailing timer
    vi.advanceTimersByTime(1999);
    expect(batches.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(batches.length).toBe(1);
    expect(batches[0].layerId).toBe('L1');
    expect(batches[0].events.length).toBe(2);
  });

  it('batches independently per layer', () => {
    const { GISRealtime, fake } = load();
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('L1');
    GISRealtime.watchLayer('L2');
    fake.channels['gis-rt-L1']._emit({ eventType: 'INSERT', new: { id: 'a', layer_id: 'L1' }, old: {} });
    vi.advanceTimersByTime(2000);
    expect(batches.length).toBe(1);
    expect(batches[0].layerId).toBe('L1');
    fake.channels['gis-rt-L2']._emit({ eventType: 'INSERT', new: { id: 'b', layer_id: 'L2' }, old: {} });
    vi.advanceTimersByTime(2000);
    expect(batches.length).toBe(2);
    expect(batches[1].layerId).toBe('L2');
  });
});

describe('mode switching (channels / poll / off)', () => {
  it("poll mode tears down channels and fires an empty-events batch every 30s per watched layer", () => {
    const { GISRealtime, fake } = load();
    GISRealtime.watchLayer('L1');
    expect(fake.calls.channel).toEqual(['gis-rt-L1']);
    GISRealtime.setMode('poll');
    expect(fake.calls.removeChannel).toContain('gis-rt-L1');
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    vi.advanceTimersByTime(29999);
    expect(batches.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(batches.length).toBe(1);
    expect(batches[0].layerId).toBe('L1');
    expect(batches[0].events).toEqual([]);
  });

  it('off mode tears everything down and stops delivering any batches', () => {
    const { GISRealtime, fake } = load();
    GISRealtime.watchLayer('L1');
    GISRealtime.setMode('off');
    expect(fake.calls.removeChannel).toContain('gis-rt-L1');
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    vi.advanceTimersByTime(60000);
    expect(batches.length).toBe(0);
  });

  it('a watchLayer() call while in off mode does not open a channel', () => {
    const { GISRealtime, fake } = load();
    GISRealtime.setMode('off');
    GISRealtime.watchLayer('L9');
    expect(fake.calls.channel).toEqual([]);
    expect(GISRealtime.status().watched.L9.refCount).toBe(1);   // still tracked, just not backed
  });

  it('switching back to channels mode re-provisions a still-watched layer', () => {
    const { GISRealtime, fake } = load();
    GISRealtime.watchLayer('L1');
    GISRealtime.setMode('poll');
    GISRealtime.setMode('channels');
    expect(fake.calls.channel).toEqual(['gis-rt-L1', 'gis-rt-L1']);   // closed once, opened again
  });

  it('setMode also updates GIS.config.realtimeMode (the documented config flag)', () => {
    const { GISRealtime, GIS } = load();
    GISRealtime.setMode('poll');
    expect(GIS.config.realtimeMode).toBe('poll');
  });
});

describe('own-write suppression (authorship-aware)', () => {
  it('drops an event from OUR OWN user id while inside the suppress window', () => {
    const { GISRealtime, fake } = load();
    GISRealtime._test.setMyUserId('me');
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('L1');
    GISRealtime.suppress('L1');
    fake.channels['gis-rt-L1']._emit({
      eventType: 'UPDATE',
      new: { id: 'f1', layer_id: 'L1', edited_by: 'me' },
      old: { id: 'f1', layer_id: 'L1', edited_by: 'me' },
    });
    vi.advanceTimersByTime(2000);
    expect(batches.length).toBe(0);
  });

  it('does NOT drop a genuine concurrent edit from a different author, even inside the window', () => {
    const { GISRealtime, fake } = load();
    GISRealtime._test.setMyUserId('me');
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('L1');
    GISRealtime.suppress('L1');
    fake.channels['gis-rt-L1']._emit({
      eventType: 'UPDATE',
      new: { id: 'f1', layer_id: 'L1', edited_by: 'someone-else' },
      old: {},
    });
    vi.advanceTimersByTime(2000);
    expect(batches.length).toBe(1);
    expect(batches[0].events[0].editedBy).toBe('someone-else');
  });

  it('delivers a same-author event again once the suppress window has expired', () => {
    const { GISRealtime, fake } = load();
    GISRealtime._test.setMyUserId('me');
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('L1');
    GISRealtime.suppress('L1', 500);
    vi.advanceTimersByTime(600);   // window elapsed
    fake.channels['gis-rt-L1']._emit({ eventType: 'UPDATE', new: { id: 'f1', layer_id: 'L1', edited_by: 'me' }, old: {} });
    vi.advanceTimersByTime(2000);
    expect(batches.length).toBe(1);
  });
});

describe('event normalization', () => {
  it('normalizes an INSERT payload (no old row → old: null)', () => {
    const { GISRealtime, fake } = load();
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('L1');
    fake.channels['gis-rt-L1']._emit({
      eventType: 'INSERT',
      new: { id: 'f1', layer_id: 'L1', edited_by: 'u1', properties: { x: 1 } },
      old: {},
    });
    vi.advanceTimersByTime(2000);
    const ev = batches[0].events[0];
    expect(ev.type).toBe('INSERT');
    expect(ev.id).toBe('f1');
    expect(ev.layerId).toBe('L1');
    expect(ev.editedBy).toBe('u1');
    expect(ev.new).toEqual({ id: 'f1', layer_id: 'L1', edited_by: 'u1', properties: { x: 1 } });
    expect(ev.old).toBeNull();
    expect(typeof ev.at).toBe('number');
  });

  it('normalizes a DELETE payload (no new row → new: null, id/layerId read from old)', () => {
    const { GISRealtime, fake } = load();
    const batches = [];
    GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('L1');
    fake.channels['gis-rt-L1']._emit({ eventType: 'DELETE', new: {}, old: { id: 'f2', layer_id: 'L1', edited_by: 'u1' } });
    vi.advanceTimersByTime(2000);
    const ev = batches[0].events[0];
    expect(ev.type).toBe('DELETE');
    expect(ev.id).toBe('f2');
    expect(ev.layerId).toBe('L1');
    expect(ev.new).toBeNull();
    expect(ev.old).toEqual({ id: 'f2', layer_id: 'L1', edited_by: 'u1' });
  });
});

describe('onChange / status', () => {
  it('onChange returns an unsubscribe handle', () => {
    const { GISRealtime, fake } = load();
    const batches = [];
    const off = GISRealtime.onChange((b) => batches.push(b));
    GISRealtime.watchLayer('L1');
    off();
    fake.channels['gis-rt-L1']._emit({ eventType: 'INSERT', new: { id: 'x', layer_id: 'L1' }, old: {} });
    vi.advanceTimersByTime(2000);
    expect(batches.length).toBe(0);
  });

  it('status() reports mode, watched ref counts and open channels', () => {
    const { GISRealtime } = load();
    GISRealtime.watchLayer('L1');
    const st = GISRealtime.status();
    expect(st.mode).toBe('channels');
    expect(st.watched.L1.refCount).toBe(1);
    expect(Object.keys(st.channels)).toEqual(['L1']);
  });

  it('status() reports a live suppression window and clears it after expiry', () => {
    const { GISRealtime } = load();
    GISRealtime.suppress('L1', 1000);
    expect(GISRealtime.status().suppressed.L1).toBeGreaterThan(0);
    vi.advanceTimersByTime(1001);
    expect(GISRealtime.status().suppressed.L1).toBeUndefined();
  });
});
