// Write-gated E2E: admin uploads a tiny self-marked GeoJSON through the real
// upload page (pages/upload.html → js/pages/upload.js), walks the auto
// village-detection + layer-mapping + confirm flow, asserts the success UI,
// then verifies the features actually landed in the GIS engine (via
// Supabase REST with the admin's own session token). Always cleans up
// everything it created, even on assertion failure.
//
// PRODUCTION SAFETY: double-gated (admin creds + MGIS_E2E_WRITE=1 — see
// tests/e2e/helpers.js writeGateReason()), creates exactly 3 points inside
// one real village, every row it writes carries 'E2E-<runId>' in its
// asset_code, and every row is deleted in a finally block below.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const skipReason = H.writeGateReason();

test.describe('import-flow: admin uploads a GeoJSON layer', () => {
  test.skip(!!skipReason, skipReason || '');

  test('upload → auto-detect → confirm → features exist in the engine', async ({ page, request }) => {
    const runId = H.newRunId();
    let token;

    try {
      token = await H.restLogin(request, H.ADMIN_EMAIL, H.ADMIN_PASSWORD);

      await H.loginUI(page, H.ADMIN_EMAIL, H.ADMIN_PASSWORD);

      // Drives pages/upload.html end-to-end: file drop → detection card
      // accepts (village = סחנין, 100%) → single-row layer-mapping table
      // (category defaults to 'other') → #upload-btn → success text.
      await H.uploadE2ELayer(page, runId);

      // Independently confirm via REST (not just the UI toast) that the 3
      // features really landed in public.features, all under one layer.
      const rows = await H.waitForE2EFeatures(request, token, runId, 3, 20000);
      expect(rows.length).toBe(3);
      const layerIds = new Set(rows.map((r) => r.layer_id));
      expect(layerIds.size).toBe(1); // all 3 in the same '<village> · other' engine layer

      for (const row of rows) {
        expect(row.asset_code).toContain(`E2E-${runId}`);
        expect(row.properties.Layer).toBe(`E2E-${runId}`);
        expect(row.properties._category).toBe('other');
      }

      // "Existing layers" panel on the upload page should now list סחנין
      // with at least one layer (js/pages/upload.js loadLayers()/renderLayers()).
      await page.goto('/pages/upload.html');
      await expect(page.locator('#layers-list')).toContainText('סחנין', { timeout: 15000 });
    } finally {
      if (token) {
        const result = await H.cleanupE2E(request, token, runId);
        expect(result.deletedFeatures).toBeGreaterThanOrEqual(0); // cleanup ran without throwing
      }
    }
  });
});
