import { test, expect } from './fixtures';

for (const mode of ['signup', 'login'] as const) {
  test(`confirmed ${mode} retries session reads without repeating authentication`, async ({ page }) => {
    const email = `auth-confirm-${mode}-${Date.now()}@example.invalid`;
    const password = 'Synthetic-Confirmation-Password-1234';
    if (mode === 'login') {
      expect((await page.request.post('/api/auth/signup', { data: { email, password } })).ok()).toBe(true);
      await page.request.post('/api/auth/logout');
    }
    await page.goto(`/auth${mode === 'login' ? '?mode=login' : ''}`);
    let mutations = 0;
    let failRead = false;
    await page.route(url => url.pathname === `/api/auth/${mode}` || url.pathname === '/api/me', async route => {
      if (route.request().method() === 'POST') {
        mutations++;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        failRead = true;
        return route.fulfill({ response });
      }
      if (failRead) {
        failRead = false;
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic session refresh failure"}' });
      }
      return route.continue();
    });
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: mode === 'signup' ? 'Create account' : 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Your account request succeeded');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Email')).toBeDisabled();
    await page.getByRole('button', { name: 'Retry account refresh', exact: true }).click();
    await expect(page.getByLabel('Business name', { exact: true })).toBeVisible();
    expect(mutations).toBe(1);
  });
}

for (const operation of ['apply', 'delete'] as const) {
  test(`confirmed profile ${operation} survives refresh failure and retries reads only`, async ({ page }) => {
    await page.goto('/auth');
    await page.getByLabel('Email').fill(`profile-confirm-${operation}-${Date.now()}@example.invalid`);
    await page.getByLabel('Password', { exact: true }).fill('Synthetic-Confirmation-Password-1234');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByLabel('Business name', { exact: true }).fill('Profile confirmation');
    await page.getByLabel('What do you do?').fill('Synthetic confirmation validation');
    await page.getByRole('button', { name: 'Continue →' }).click();
    await page.getByRole('button', { name: 'Continue →' }).click();
    await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const business = await (await page.request.get('/api/me/business')).json();
    const profile = await (await page.request.post(`/api/me/business/${business.id}/profiles`, { data: { name: 'French pipeline', engine: 'pipeline', language: 'fr', voice: '', llm_model: '' } })).json();
    await page.goto('/settings');
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    let mutations = 0;
    let failRead = false;
    await page.route(url => url.pathname.includes('/profiles') || url.pathname === '/api/me', async route => {
      const request = route.request();
      if (request.method() !== 'GET') {
        mutations++;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        failRead = true;
        return route.fulfill({ response });
      }
      if (failRead && (operation === 'apply' ? new URL(request.url()).pathname === '/api/me' : request.url().includes('/profiles'))) {
        failRead = false;
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic profile refresh failure"}' });
      }
      return route.continue();
    });
    await page.getByRole('button', { name: operation === 'apply' ? 'Apply' : 'Delete profile', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('The profile change was saved');
    if (operation === 'delete') await expect(page.getByRole('button', { name: 'Delete profile', exact: true })).toHaveCount(0);
    else await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await page.getByLabel('Name', { exact: true }).fill('Newer unsaved workspace name');
    await page.getByRole('button', { name: 'Retry profile refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry profile refresh', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Newer unsaved workspace name');
    expect(mutations).toBe(1);
    const stored = await (await page.request.get('/api/me/business')).json();
    if (operation === 'apply') {
      expect(stored.agent.language).toBe('fr');
      await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('fr');
    } else {
      expect((await (await page.request.get(`/api/me/business/${business.id}/profiles`)).json()).some((row: { id: string }) => row.id === profile.id)).toBe(false);
    }
  });
}
