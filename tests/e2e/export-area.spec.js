// Write-gated E2E: creates its own tiny 3-feature layer, then drives the real
// export wizard (js/export-feature.js) through the draw-scope flow: open
// wizard → select only the E2E category → format CSV → scope "סמן אזור על
// המפה" → drag a rectangle over the layer's own extent (flown-to via the
// sidebar's "🔍 התמקד בשכבה" first, so the rectangle only needs to cover the
// current viewport) → area-summary modal shows a per-category count ≥ 1 →
// confirm → a CSV downloads containing our E2E asset codes. Always cleans up.
//
// PRODUCTION SAFETY: double-gated, 3 features total, deleted in a finally
// block. NOTE: the export wizard's category checkboxes are per-CATEGORY
// (aggregated across every village's same-category layer — see
// js/export-feature.js buildLayerModel()), so the "אחר" row's count can, in
// principle, include unrelated production "other"-category features that
// also happen to fall inside the drawn rectangle. The drawn rectangle here
// is the layer's own tiny extent (a few hundred metres), so that's
// astronomically unlikely — this is also exactly why the assertion below is
// "count >= 1" (per the task spec) rather than "count === 3".
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const skipReason = H.writeGateReason();

test.describe('export-area: draw-scope export wizard', () => {
  test.skip(!!skipReason, skipReason || '');

  test('select E2E category, draw over the layer extent, export CSV', async ({ page, request }) => {
    const runId = H.newRunId();
    let token;

    try {
      token = await H.restLogin(request, H.ADMIN_EMAIL, H.ADMIN_PASSWORD);
      await H.loginUI(page, H.ADMIN_EMAIL, H.ADMIN_PASSWORD);
      await H.uploadE2ELayer(page, runId);
      const rows = await H.waitForE2EFeatures(request, token, runId, 3, 20000);
      const layerId = rows[0].layer_id;

      // Fly the map to our layer's exact extent first (real UI action — the
      // sidebar's per-layer "🔍" button) so a corner-to-corner drag over the
      // CURRENT viewport is already a tight rectangle around just our 3 points.
      await H.focusE2ELayerOnMap(page, layerId, H.VILLAGE.name);

      // ── open the export wizard (js/export-feature.js openExportModal) ───
      const fab = page.locator('#exp-fab');
      await expect(fab).toBeVisible({ timeout: 20000 }); // lazy-loaded script (index.html LAZY list)
      await fab.click();
      await expect(page.locator('#exp-modal')).toHaveClass(/\bopen\b/, { timeout: 10000 });

      // Step 1: category selection + scope. Wait for the layer model to load
      // (buildLayerModel() populates gExp.layers, replacing the loading spinner).
      await expect(page.locator('#exp-body .exp-lrow')).not.toHaveCount(0, { timeout: 20000 });
      await page.locator('#exp-body .exp-sec-acts button', { hasText: 'נקה' }).click(); // deselect all
      const otherRow = page.locator('#exp-body .exp-lrow').filter({ has: page.locator('.exp-lname', { hasText: 'אחר' }) });
      await otherRow.locator('input[type=checkbox]').check();
      await page.locator('#exp-body .exp-scope-opt', { hasText: 'סמן אזור על המפה' }).click();
      await page.click('#exp-foot >> text=הבא');

      // Step 2: format = CSV.
      await page.locator('#exp-body .exp-fmt', { hasText: 'CSV' }).click();
      await page.click('#exp-foot >> text=הבא');

      // Step 3: review → "📥 ייצא" triggers expRun() → scope 'draw' → closes
      // the modal and starts draw mode (js/export-feature.js:566, startDrawMode).
      await page.click('#exp-foot >> text=ייצא');
      await expect(page.locator('#exp-banner')).toHaveClass(/\bshow\b/, { timeout: 10000 });

      // Drag a rectangle across the current viewport (already framed to our
      // layer's extent by focusE2ELayerOnMap above).
      const box = await page.locator('#map').boundingBox();
      await page.mouse.move(box.x + 15, box.y + 15);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 15, box.y + box.height - 15, { steps: 8 });
      await page.mouse.up();

      // finishDraw → startAreaSummary → export_area_summary RPC → reopens
      // #exp-modal with the area-summary rows (js/export-feature.js areaSummaryHTML).
      await expect(page.locator('#exp-modal')).toHaveClass(/\bopen\b/, { timeout: 15000 });
      await expect(page.locator('#exp-body')).toContainText('סיכום אזור מסומן', { timeout: 15000 });
      const areaRow = page.locator('#exp-body .exp-lrow').filter({ has: page.locator('.exp-lname', { hasText: 'אחר' }) });
      await expect(areaRow).toBeVisible();
      const countText = (await areaRow.locator('.exp-lcount').textContent()) || '0';
      const count = parseInt(countText.replace(/[^\d]/g, ''), 10);
      expect(count).toBeGreaterThanOrEqual(1);

      // ── confirm → generateAndDownload → CSV download ────────────────────
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        page.click('#exp-foot >> text=ייצא')
      ]);
      expect(download.suggestedFilename()).toMatch(/\.csv$/);
      const csv = await H.readDownload(download);
      // The wizard's CSV schema is village/category/lon/lat/geometry_type/text/
      // layer/properties_json (js/export-formats.js buildCSV()) — our Layer
      // property ("E2E-<runId>") lands verbatim in the 'layer' column, and
      // asset_code is inside properties_json — both contain the marker.
      expect(csv).toContain(`E2E-${runId}`);
    } finally {
      if (token) await H.cleanupE2E(request, token, runId);
    }
  });
});
