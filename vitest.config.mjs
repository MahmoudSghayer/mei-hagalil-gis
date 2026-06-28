import { defineConfig } from 'vitest/config';

// Unit tests live in test/**/*.test.js and run under Vitest (node env).
// The Playwright e2e specs live in tests/e2e/**/*.spec.js and are run by the
// separate, manual/weekly e2e.yml workflow via `npx playwright test` — they
// require @playwright/test, which is NOT a project dependency. Without this
// scoping, Vitest's default glob would pick up those .spec.js files and fail
// to import @playwright/test, breaking per-push CI.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
