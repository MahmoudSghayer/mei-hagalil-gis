// Write-gated E2E: creates its own tiny 3-feature layer, opens its attribute
// table in TWO independent browser contexts (same admin account), edits a
// cell in context A, and polls context B's table for the new value to arrive
// via Supabase Realtime (js/gis-realtime.js) within 8s. Always cleans up.
//
// PRODUCTION SAFETY: double-gated, 3 features total, deleted in a finally
// block.
//
// If the features-realtime migration isn't applied (gis-engine/sql/migrations/
// 2026-07-14-features-realtime.sql — publication membership + REPLICA IDENTITY
// FULL on public.features), context B's table never receives the
// postgres_changes event and the polling assertion below times out; the
// message on that failure calls that out explicitly instead of leaving a bare
// timeout.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const skipReason = H.writeGateReason();

test.describe('realtime: cross-browser table sync', () => {
  test.skip(!!skipReason, skipReason || '');

  test('an edit in one browser appears in another within 8s', async ({ browser, request }) => {
    const runId = H.newRunId();
    let token;
    let contextA, contextB;

    try {
      token = await H.restLogin(request, H.ADMIN_EMAIL, H.ADMIN_PASSWORD);

      // Set up the layer once, via context A (any authenticated admin page works).
      contextA = await browser.newContext();
      const pageA = await contextA.newPage();
      await H.loginUI(pageA, H.ADMIN_EMAIL, H.ADMIN_PASSWORD);
      const fc = await H.uploadE2ELayer(pageA, runId);
      const rows = await H.waitForE2EFeatures(request, token, runId, 3, 20000);
      const layerId = rows[0].layer_id;

      // Context A opens the table on the point whose note we'll edit.
      await H.openE2ETable(pageA, layerId, H.VILLAGE.name, fc.features[0]);

      // Context B: a second, independent browser session, same admin login,
      // opens the SAME layer's table (any of the 3 points works — GISTable.openLayer
      // loads the whole layer's page, not just the clicked feature).
      contextB = await browser.newContext();
      const pageB = await contextB.newPage();
      await H.loginUI(pageB, H.ADMIN_EMAIL, H.ADMIN_PASSWORD);
      await H.openE2ETable(pageB, layerId, H.VILLAGE.name, fc.features[1]);

      // ── context A edits the point-0 row's "note" cell ───────────────────
      const newValue = `rt-${runId}`;
      const row0A = pageA.locator('tr', { hasText: `e2e-${runId}-0` });
      await row0A.locator('td.editable[data-col="note"]').dblclick();
      const inputA = row0A.locator('input.gt-cell-input');
      await inputA.fill(newValue);
      await inputA.press('Enter');
      await expect(pageA.locator('#gt-foot')).toContainText('נשמר', { timeout: 10000 });

      // ── context B: poll for the new value (realtime channel → 2s debounce
      // (js/gis-realtime.js DEBOUNCE_MS) → loadPage() refetch) ────────────
      await expect(pageB.locator('tr', { hasText: newValue })).toBeVisible({ timeout: 8000 });
    } finally {
      if (contextA) await contextA.close();
      if (contextB) await contextB.close();
      if (token) await H.cleanupE2E(request, token, runId);
    }
  });
});
