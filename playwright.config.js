// Playwright E2E config for Mei HaGalil GIS.
// Runs against the DEPLOYED app (BASE_URL, default = production). Smoke specs
// need no credentials; RBAC specs auto-skip unless MGIS_*_EMAIL/PASSWORD are set
// (see tests/e2e/rbac.spec.js). Run via `.github/workflows/e2e.yml` (manual /
// weekly) — kept out of the per-push CI so it never blocks deploys.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 7000 },
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.BASE_URL || 'https://mei-hagalil-gis.vercel.app',
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
