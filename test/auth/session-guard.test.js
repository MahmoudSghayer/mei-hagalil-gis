// Unit tests for the session guard added to js/auth.js (validateSession /
// initSessionGuard / isDeadSessionError / claimSessionRedirect).
//
// Background (the bug this guards against): supabase-js's getSession() only
// reads the cached token from localStorage — it never talks to the server.
// When a refresh token goes stale (long-lived tab), getSession() keeps
// "succeeding" while every real request (getUser(), RLS-protected reads)
// comes back 401/403. The app then looks logged-in but is actually dead —
// a "zombie session" that nothing detects or redirects away from. The guard
// closes that gap: whenever a local session exists, it double-checks with
// the server via getUser() and only signs out + redirects on a genuine 4xx
// auth rejection, never on a network hiccup (5xx, thrown fetch errors).
//
// auth.js expects window.supabase.createClient(...) to exist (it's normally
// the CDN UMD build loaded before this script) and self-boots at the bottom
// of the file (DOMContentLoaded-or-immediate, same pattern as
// startIdleTracker). The harness's stub document has no readyState, so that
// boot code runs immediately as soon as the file loads under vm — meaning
// every load() call below already fires one fire-and-forget validateSession()
// pass before the test gets control. Each test flushes that pass, resets
// counters/state via window.__authTest, then drives the scenario explicitly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function makeSb() {
  var calls = { getSession: 0, getUser: 0, signOut: 0 };
  var state = {
    hasSession: true,
    userError: null,       // e.g. { status: 403, name: 'AuthApiError' }
    getUserThrows: false,  // simulates a thrown network failure
    signOutThrows: false,
  };
  var authStateCb = null;
  var client = {
    auth: {
      getSession: function () {
        calls.getSession++;
        return Promise.resolve(
          state.hasSession
            ? { data: { session: { user: { id: 'u1' } } }, error: null }
            : { data: { session: null }, error: null }
        );
      },
      getUser: function () {
        calls.getUser++;
        if (state.getUserThrows) return Promise.reject(new Error('network down'));
        if (state.userError) return Promise.resolve({ data: { user: null }, error: state.userError });
        return Promise.resolve({ data: { user: { id: 'u1' } }, error: null });
      },
      signOut: function () {
        calls.signOut++;
        if (state.signOutThrows) return Promise.reject(new Error('dead token — signOut failed'));
        return Promise.resolve({ error: null });
      },
      onAuthStateChange: function (cb) {
        authStateCb = cb;
        return { data: { subscription: { unsubscribe: function () {} } } };
      },
    },
  };
  return {
    client: client,
    calls: calls,
    state: state,
    fireAuthStateChange: function (event) { if (authStateCb) authStateCb(event); },
  };
}

function makeLocation(pathname) {
  return {
    pathname: pathname,
    search: '',
    replaceCalls: [],
    replace: function (url) { this.replaceCalls.push(url); },
  };
}

// Drains the microtask queue so chained `await`s inside async functions
// running under the vm sandbox (getSession -> getUser -> signOut -> replace)
// have settled before assertions run.
async function flush() {
  for (var i = 0; i < 10; i++) await Promise.resolve();
}

async function load(pathname) {
  const sb = makeSb();
  const loc = makeLocation(pathname || '/index.html');
  const ctx = loadBrowserGlobals(['js/auth.js'], {
    supabase: { createClient: function () { return sb.client; } },
    location: loc,
    addEventListener: function () {},
    removeEventListener: function () {},
  });
  // Let the boot-time fire-and-forget validateSession() (called from
  // initSessionGuard at the bottom of auth.js) settle before tests take over.
  await flush();
  return { ctx: ctx, sb: sb, loc: loc };
}

function resetCounters(sb, loc) {
  sb.calls.getSession = 0;
  sb.calls.getUser = 0;
  sb.calls.signOut = 0;
  loc.replaceCalls.length = 0;
}

describe('session guard (js/auth.js)', () => {
  it('no session → no action (getUser never called, no redirect)', async () => {
    const { ctx, sb, loc } = await load('/index.html');
    sb.state.hasSession = false;
    ctx.__authTest.reset();
    resetCounters(sb, loc);

    await ctx.__authTest.validateSession();

    expect(sb.calls.getUser).toBe(0);
    expect(sb.calls.signOut).toBe(0);
    expect(loc.replaceCalls.length).toBe(0);
    expect(ctx.__authTest.isRedirected()).toBe(false);
  });

  it('session + getUser OK → no action', async () => {
    const { ctx, sb, loc } = await load('/index.html');
    ctx.__authTest.reset();
    resetCounters(sb, loc);

    await ctx.__authTest.validateSession();

    expect(sb.calls.getUser).toBe(1);
    expect(sb.calls.signOut).toBe(0);
    expect(loc.replaceCalls.length).toBe(0);
    expect(ctx.__authTest.isRedirected()).toBe(false);
  });

  it('session + getUser 403 AuthError → signOut called + redirect to login with ?expired=1', async () => {
    const { ctx, sb, loc } = await load('/index.html');
    ctx.__authTest.reset();
    resetCounters(sb, loc);
    sb.state.userError = { status: 403, name: 'AuthApiError', message: 'bad_jwt' };

    await ctx.__authTest.validateSession();

    expect(sb.calls.signOut).toBe(1);
    expect(loc.replaceCalls).toEqual(['pages/login.html?expired=1']);
    expect(ctx.__authTest.isRedirected()).toBe(true);
  });

  it('session + getUser 401 AuthError also counts as a dead session', async () => {
    const { ctx, sb, loc } = await load('/pages/admin.html');
    ctx.__authTest.reset();
    resetCounters(sb, loc);
    sb.state.userError = { status: 401, name: 'AuthApiError', message: 'invalid token' };

    await ctx.__authTest.validateSession();

    expect(sb.calls.signOut).toBe(1);
    // pathname includes '/pages/' -> getLoginPath() returns the same-dir form
    expect(loc.replaceCalls).toEqual(['login.html?expired=1']);
  });

  it('session + thrown network error from getUser → NO signOut, NO redirect', async () => {
    const { ctx, sb, loc } = await load('/index.html');
    ctx.__authTest.reset();
    resetCounters(sb, loc);
    sb.state.getUserThrows = true;

    await ctx.__authTest.validateSession();

    expect(sb.calls.signOut).toBe(0);
    expect(loc.replaceCalls.length).toBe(0);
    expect(ctx.__authTest.isRedirected()).toBe(false);
  });

  it('session + non-4xx error (5xx / no status, e.g. AuthRetryableFetchError) → NO signOut, NO redirect', async () => {
    const { ctx, sb, loc } = await load('/index.html');
    ctx.__authTest.reset();
    resetCounters(sb, loc);
    sb.state.userError = { status: 500, name: 'AuthRetryableFetchError', message: 'fetch failed' };

    await ctx.__authTest.validateSession();

    expect(sb.calls.signOut).toBe(0);
    expect(loc.replaceCalls.length).toBe(0);
    expect(ctx.__authTest.isRedirected()).toBe(false);
  });

  it('session + error with no numeric status at all → treated as network-ish, NO redirect', async () => {
    const { ctx, sb, loc } = await load('/index.html');
    ctx.__authTest.reset();
    resetCounters(sb, loc);
    sb.state.userError = { name: 'AuthRetryableFetchError', message: 'offline' };

    await ctx.__authTest.validateSession();

    expect(sb.calls.signOut).toBe(0);
    expect(loc.replaceCalls.length).toBe(0);
  });

  it('one-shot flag prevents a second redirect (including a racing SIGNED_OUT from our own signOut())', async () => {
    const { ctx, sb, loc } = await load('/index.html');
    ctx.__authTest.reset();
    resetCounters(sb, loc);
    sb.state.userError = { status: 401, name: 'AuthApiError' };

    await ctx.__authTest.validateSession();
    expect(loc.replaceCalls.length).toBe(1);
    expect(sb.calls.signOut).toBe(1);

    // Calling validateSession again short-circuits immediately (flag already set) —
    // no further network calls, no further redirects.
    await ctx.__authTest.validateSession();
    expect(loc.replaceCalls.length).toBe(1);
    expect(sb.calls.signOut).toBe(1);

    // A SIGNED_OUT event racing in afterwards (e.g. from our own signOut() call
    // notifying the auth-state listener) must not overwrite the ?expired=1 redirect
    // with a second, plain one.
    sb.fireAuthStateChange('SIGNED_OUT');
    expect(loc.replaceCalls.length).toBe(1);
    expect(loc.replaceCalls[0]).toBe('pages/login.html?expired=1');
  });

  it('login-page pathname → guard is inert (no boot-time calls, validateSession is a no-op)', async () => {
    const { ctx, sb, loc } = await load('/pages/login.html');

    // isAuthExcludedPage() should have kept initSessionGuard from ever calling
    // validateSession() at boot.
    expect(sb.calls.getSession).toBe(0);
    expect(sb.calls.getUser).toBe(0);

    await ctx.__authTest.validateSession();

    expect(sb.calls.getSession).toBe(0);
    expect(sb.calls.getUser).toBe(0);
    expect(loc.replaceCalls.length).toBe(0);
  });

  it('reset-page pathname → guard is inert too (same exclusion pattern as the idle tracker)', async () => {
    const { ctx, sb, loc } = await load('/pages/reset.html');
    expect(sb.calls.getSession).toBe(0);
    await ctx.__authTest.validateSession();
    expect(sb.calls.getUser).toBe(0);
    expect(loc.replaceCalls.length).toBe(0);
  });

  it('SIGNED_OUT from another tab (no prior dead-session redirect) → plain redirect, no ?expired=1', async () => {
    const { ctx, sb, loc } = await load('/index.html');
    ctx.__authTest.reset();
    resetCounters(sb, loc);

    sb.fireAuthStateChange('SIGNED_OUT');

    expect(loc.replaceCalls).toEqual(['pages/login.html']);
    expect(ctx.__authTest.isRedirected()).toBe(true);
  });

  describe('focus-throttle', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-15T09:00:00Z'));
    });
    afterEach(() => { vi.useRealTimers(); });

    it('two focus events within 2 minutes → only one validation runs', async () => {
      const { ctx, sb } = await load('/index.html');
      ctx.__authTest.reset();
      sb.calls.getUser = 0;

      ctx.__authTest.handleFocus();
      await flush();
      expect(sb.calls.getUser).toBe(1);

      // Still inside the 2-minute throttle window — second focus is a no-op.
      vi.advanceTimersByTime(60 * 1000);
      ctx.__authTest.handleFocus();
      await flush();
      expect(sb.calls.getUser).toBe(1);

      // Past the 2-minute window — a focus event validates again.
      vi.advanceTimersByTime(61 * 1000);
      ctx.__authTest.handleFocus();
      await flush();
      expect(sb.calls.getUser).toBe(2);
    });
  });
});
