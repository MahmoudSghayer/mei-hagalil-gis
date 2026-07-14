// Unit tests for the incidents realtime subscription scoping (js/pages/index.js,
// subscribeRT / _incidentsChannelVillages / _renderAllDebounced).
//
// Loading index.js under the test harness's stub DOM is viable (it only
// registers a `window.addEventListener('load', ...)` at the top level, which
// never fires here — no map/Supabase/DOM calls run just from importing the
// file), so this loads the REAL file rather than re-implementing the logic.
//
// Today one unfiltered 'inc-rt' channel is shared by every signed-in user,
// and isVisibleToMe() narrows what's rendered client-side. The scoping added
// here narrows the SERVER-SIDE subscription itself for viewer profiles that
// carry an assigned_villages list — a field the current profiles data model
// doesn't populate yet, so in production this stays a no-op (everyone still
// gets the single unfiltered channel) until that field exists. These tests
// cover the decision function directly so the behavior is pinned regardless.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function makeSb() {
  var channels = [];
  return {
    _channels: channels,
    channel: function (name) {
      var chan = {
        name: name,
        config: null,
        cb: null,
        on: function (event, config, cb) { chan.config = config; chan.cb = cb; return chan; },
        subscribe: function () { chan.subscribed = true; return chan; },
      };
      channels.push(chan);
      return chan;
    },
  };
}

function load(extra) {
  // index.js's top level does `window.addEventListener('load', ...)` — the
  // harness's default sandbox has no window-level addEventListener (only
  // document's), so stub it. It's never fired here, so the handler itself
  // (map/Supabase init) never runs.
  return loadBrowserGlobals(['js/pages/index.js'], Object.assign(
    { gSb: makeSb(), addEventListener: function () {}, removeEventListener: function () {} },
    extra || {}
  ));
}

describe('_incidentsChannelVillages (js/pages/index.js)', () => {
  it('returns null with no profile', () => {
    const ctx = load();
    expect(ctx._incidentsChannelVillages(null)).toBeNull();
  });

  it('returns null for admin/engineer regardless of assigned_villages — they always get everything', () => {
    const ctx = load();
    expect(ctx._incidentsChannelVillages({ role: 'admin', assigned_villages: ['סחנין'] })).toBeNull();
    expect(ctx._incidentsChannelVillages({ role: 'engineer', assigned_villages: ['סחנין'] })).toBeNull();
  });

  it("returns null for a viewer with no assigned_villages field (today's only real case)", () => {
    const ctx = load();
    expect(ctx._incidentsChannelVillages({ role: 'viewer' })).toBeNull();
  });

  it('returns null for a viewer with an empty assigned_villages array', () => {
    const ctx = load();
    expect(ctx._incidentsChannelVillages({ role: 'viewer', assigned_villages: [] })).toBeNull();
  });

  it('returns the village list for a viewer with assigned_villages', () => {
    const ctx = load();
    expect(ctx._incidentsChannelVillages({ role: 'viewer', assigned_villages: ['סחנין', 'נחף'] }))
      .toEqual(['סחנין', 'נחף']);
  });

  it('de-dupes and drops falsy entries', () => {
    const ctx = load();
    expect(ctx._incidentsChannelVillages({ role: 'viewer', assigned_villages: ['סחנין', 'סחנין', '', null, 'נחף'] }))
      .toEqual(['סחנין', 'נחף']);
  });
});

describe('subscribeRT channel selection (js/pages/index.js)', () => {
  it('subscribes one unfiltered channel when gProfile has no village assignment (current behavior)', () => {
    const ctx = load();
    ctx.gProfile = { role: 'viewer' };
    ctx.subscribeRT();
    expect(ctx.gSb._channels.length).toBe(1);
    expect(ctx.gSb._channels[0].name).toBe('inc-rt');
    expect(ctx.gSb._channels[0].config.filter).toBeUndefined();
    expect(ctx.gSb._channels[0].subscribed).toBe(true);
  });

  it('subscribes one unfiltered channel for admin even if assigned_villages were ever set', () => {
    const ctx = load();
    ctx.gProfile = { role: 'admin', assigned_villages: ['סחנין'] };
    ctx.subscribeRT();
    expect(ctx.gSb._channels.length).toBe(1);
    expect(ctx.gSb._channels[0].config.filter).toBeUndefined();
  });

  it('subscribes one server-filtered channel per assigned village for a scoped viewer', () => {
    const ctx = load();
    ctx.gProfile = { role: 'viewer', assigned_villages: ['סחנין', 'נחף'] };
    ctx.subscribeRT();
    expect(ctx.gSb._channels.length).toBe(2);
    expect(ctx.gSb._channels.map(function (c) { return c.config.filter; }))
      .toEqual(['village=eq.סחנין', 'village=eq.נחף']);
    ctx.gSb._channels.forEach(function (c) { expect(c.subscribed).toBe(true); });
  });
});

describe('_renderAllDebounced (js/pages/index.js)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces a burst of calls into a single trailing renderAll() after 300ms', () => {
    const ctx = load();
    const spy = vi.fn();
    ctx.renderAll = spy;
    ctx._renderAllDebounced();
    ctx._renderAllDebounced();
    ctx._renderAllDebounced();
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('mutates gIncidents synchronously per event even while renders are debounced', () => {
    const ctx = load();
    ctx.gProfile = { role: 'viewer' };
    ctx.renderAll = vi.fn();
    ctx.showToast = vi.fn();   // real showToast touches the DOM; stub it like renderAll
    ctx.gIncidents = [];
    ctx.subscribeRT();
    const chan = ctx.gSb._channels[0];
    chan.cb({ eventType: 'INSERT', new: { id: 1, title: 'x', village: 'סחנין' } });
    chan.cb({ eventType: 'INSERT', new: { id: 2, title: 'y', village: 'סחנין' } });
    // both inserts applied immediately, even though the render is still pending
    expect(ctx.gIncidents.map(function (i) { return i.id; }).sort()).toEqual([1, 2]);
    expect(ctx.renderAll).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(ctx.renderAll).toHaveBeenCalledTimes(1);
  });
});
