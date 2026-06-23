// RBAC smoke — activates only when a viewer-role test account is provided as CI
// secrets (GitHub → repo → Settings → Secrets):
//   MGIS_VIEWER_EMAIL / MGIS_VIEWER_PASSWORD
// Asserts a 'viewer' does NOT see admin/upload/logs entry points. Without the
// secrets these tests skip, so CI stays green until a test account exists.
const { test, expect } = require('@playwright/test');

const EMAIL = process.env.MGIS_VIEWER_EMAIL;
const PASSWORD = process.env.MGIS_VIEWER_PASSWORD;

test.describe('RBAC: viewer has no admin entry points', () => {
  test.skip(!EMAIL || !PASSWORD, 'set MGIS_VIEWER_EMAIL / MGIS_VIEWER_PASSWORD to run');

  test('admin / upload / logs links stay hidden for a viewer', async ({ page }) => {
    await page.goto('/pages/login.html');
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('#login-btn');
    await page.waitForURL(/index|\/$/i, { timeout: 20000 }).catch(() => {});
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    for (const id of ['#admin-link', '#upload-link', '#logs-link']) {
      const el = page.locator(id);
      if (await el.count()) await expect(el).toBeHidden();
    }
  });
});
