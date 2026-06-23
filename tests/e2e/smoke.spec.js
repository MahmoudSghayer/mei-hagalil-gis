// Credential-free smoke tests: the deployment is up, the login page renders,
// and the app is auth-gated to anonymous users. No secrets required.
const { test, expect } = require('@playwright/test');

test('login page renders with email, password and submit', async ({ page }) => {
  await page.goto('/pages/login.html');
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('#password')).toBeVisible();
  await expect(page.locator('#login-btn')).toBeVisible();
});

test('unauthenticated visit to the app requires login', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // The client-side auth guard (js/auth.js) either redirects anonymous users to
  // the login page or surfaces the login form — accept either as "gated".
  const gated = /login/i.test(page.url()) || (await page.locator('#login-btn').count()) > 0;
  expect(gated).toBeTruthy();
});
