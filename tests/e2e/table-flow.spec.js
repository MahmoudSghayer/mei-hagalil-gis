// Write-gated E2E: creates its own tiny 3-feature layer (same import helper
// as import-flow.spec.js), then drives the real attribute-table flow on the
// map: activate the layer → click a feature → "📋 טבלת עריכה" → the engine
// attribute table (js/gis-feature-table.js) → assert the server-pagination
// footer renders → edit one cell → assert it persisted after a server
// refetch → multi-select 2 rows → bulk-edit dialog → assert both updated →
// CSV export button downloads a file containing our data. Always cleans up.
//
// PRODUCTION SAFETY: double-gated, 3 features total, every row carries
// 'E2E-<runId>' in its asset_code, deleted in a finally block.
//
// If features_page/features_page_count/features_bulk_update are missing
// (2026-07-14 migrations not applied — see gis-engine/sql/migrations/
// 2026-07-14-feature-table-pagination.sql), the table's own error footer
// surfaces a Postgres "function ... does not exist" message instead of ever
// showing a pager — the assertion on `.gt-pager` below will fail with a
// timeout in that case; the footer's error text (asserted first) gives the
// actual diagnostic instead of a bare timeout.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const skipReason = H.writeGateReason();

test.describe('table-flow: attribute table open/edit/bulk-edit/export', () => {
  test.skip(!!skipReason, skipReason || '');

  test('open table, edit a cell, bulk-edit 2 rows, export CSV', async ({ page, request }) => {
    const runId = H.newRunId();
    let token;

    try {
      token = await H.restLogin(request, H.ADMIN_EMAIL, H.ADMIN_PASSWORD);
      await H.loginUI(page, H.ADMIN_EMAIL, H.ADMIN_PASSWORD);
      const fc = await H.uploadE2ELayer(page, runId);
      const rows = await H.waitForE2EFeatures(request, token, runId, 3, 20000);
      const layerId = rows[0].layer_id;

      // ── open the table via the real map → panel → "📋 טבלת עריכה" flow ──
      await H.openE2ETable(page, layerId, H.VILLAGE.name, fc.features[0]);

      // Footer renders server pagination (js/gis-feature-table.js renderPager():
      // "מציג A–B מתוך Z · עמוד X מתוך Y" — with 3 rows and a 500-row page size
      // that's page 1 of 1).
      const errFooter = page.locator('#gt-foot .er');
      if (await errFooter.count()) {
        throw new Error(
          'attribute table reported an error instead of paging — migration not applied? ' +
          (await errFooter.first().textContent())
        );
      }
      await expect(page.locator('.gt-pager')).toContainText('מתוך 3', { timeout: 15000 });
      await expect(page.locator('.gt-pager')).toContainText('עמוד 1 מתוך 1');

      // ── edit one cell: row whose "note" is e2e-<runId>-0 ────────────────
      // (identifying rows by their distinctive marker text, not position —
      // features_page's default sort is created_at ASC, and a single bulk
      // import commits all 3 rows in the SAME transaction, so created_at can
      // tie between them; row order on the page is therefore not guaranteed.)
      const editedNote = `edited-${runId}`;
      const row0 = page.locator('tr', { hasText: `e2e-${runId}-0` });
      await row0.locator('td.editable[data-col="note"]').dblclick();
      const cellInput = row0.locator('input.gt-cell-input');
      await cellInput.fill(editedNote);
      await cellInput.press('Enter');
      await expect(page.locator('#gt-foot')).toContainText('נשמר', { timeout: 10000 });

      // "assert persisted after page refetch" — force a real server refetch
      // via the search box (js/gis-feature-table.js #gt-search oninput →
      // state.page=0 + loadPage()), not just trust the optimistic re-render.
      await page.fill('#gt-search', 'E2E');
      await page.waitForTimeout(500);
      await page.fill('#gt-search', '');
      await page.waitForTimeout(500);
      await expect(page.locator('tr', { hasText: editedNote })).toBeVisible({ timeout: 10000 });

      // ── multi-select the other 2 rows → bulk edit "note" ────────────────
      const row1 = page.locator('tr', { hasText: `e2e-${runId}-1` });
      const row2 = page.locator('tr', { hasText: `e2e-${runId}-2` });
      await row1.locator('.gt-rowchk').check();
      await row2.locator('.gt-rowchk').check();
      await expect(page.locator('#gt-bulk')).toBeEnabled();
      await page.click('#gt-bulk');

      await expect(page.locator('#gtb-field')).toBeVisible({ timeout: 5000 });
      await page.selectOption('#gtb-field', 'note');
      const bulkNote = `bulk-${runId}`;
      await page.fill('#gtb-val', bulkNote);
      await page.click('#gtb-save');
      // openBulkEdit()'s #gtb-save handler calls GIS.features.bulkUpdate then
      // loadPage() then showToast('✓ עודכנו N שורות') (js/gis-feature-table.js:805-821)
      // — assert on the resulting row content (robust) rather than the
      // ephemeral toast (motion-utils.js auto-hides it after a few seconds).
      await expect(page.locator('tr', { hasText: bulkNote })).toHaveCount(2, { timeout: 15000 });

      // ── CSV export ───────────────────────────────────────────────────────
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.click('#gt-export')
      ]);
      expect(download.suggestedFilename()).toMatch(/\.csv$/);
      const csv = await H.readDownload(download);
      expect(csv).toContain(`E2E-${runId}`);
      expect(csv).toContain(editedNote);
      expect(csv).toContain(bulkNote);
    } finally {
      if (token) await H.cleanupE2E(request, token, runId);
    }
  });
});
