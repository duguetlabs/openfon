import { test, expect, openSettingsSections } from './fixtures';
import { openAuth, signup, createWorkspace, connections } from './cleanroom-helpers';

for (const mode of ['signup', 'login'] as const) {
  test(`confirmed ${mode} retries session reads without repeating authentication`, async ({ page }) => {
    const email = `auth-confirm-${mode}-${Date.now()}@example.invalid`,
      password = 'Synthetic-Confirmation-Password-1234';
    if (mode === 'login') {
      expect((await page.request.post('/api/auth/signup', { data: { email, password } })).ok()).toBe(true);
      await page.request.post('/api/auth/logout');
    }
    await openAuth(page, mode);
    let mutations = 0,
      failRead = false;
    await page.route(
      (url) => url.pathname === `/api/auth/${mode}` || url.pathname === '/api/me/bootstrap',
      async (route) => {
        if (route.request().method() === 'POST') {
          mutations++;
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          failRead = true;
          return route.fulfill({ response });
        }
        if (failRead) {
          failRead = false;
          return route.fulfill({ status: 503, json: { error: 'Synthetic session refresh failure' } });
        }
        return route.continue();
      },
    );
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel(/^Password/).fill(password);
    await page
      .getByRole('button', { name: mode === 'signup' ? 'Create account' : 'Open your desk', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText('Synthetic session refresh failure');
    await expect(page.getByLabel(/^Password/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByLabel('Business name', { exact: true })).toBeVisible();
    expect(mutations).toBe(1);
  });
}
