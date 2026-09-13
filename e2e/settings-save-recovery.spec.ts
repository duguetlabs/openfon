import { test, expect } from './fixtures';

for (const failure of ['refresh', 'assistant'] as const) {
  test(`settings resumes confirmed stages after ${failure} failure`, async ({ page }) => {
    await page.goto('/auth');
    await page.getByLabel('Email').fill(`settings-recovery-${failure}-${Date.now()}@example.invalid`);
    await page.getByLabel('Password', { exact: true }).fill('Synthetic-Settings-Password-1234');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByLabel('Business name', { exact: true }).fill('Settings recovery workshop');
    await page.getByLabel('What do you do?').fill('Synthetic settings recovery validation');
    await page.getByRole('button', { name: 'Continue →' }).click();
    await page.getByRole('button', { name: 'Continue →' }).click();
    await page.getByRole('button', { name: /Save.*studio/i }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const business = await (await page.request.get('/api/me/business')).json();
    await page.goto('/settings');
    const save = page.getByRole('button', { name: 'Save changes', exact: true });
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(business.name);
    let businessWrites = 0;
    let assistantWrites = 0;
    let failRefresh = false;
    await page.route('**/api/me/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === `/api/me/business/${business.id}` && request.method() === 'PUT') businessWrites++;
      if (path === `/api/me/business/${business.id}/agent` && request.method() === 'PUT') {
        assistantWrites++;
        if (failure === 'assistant' && assistantWrites === 1) {
          return route.fulfill({ status: 503, json: { error: 'Synthetic assistant interruption' } });
        }
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        if (failure === 'refresh') failRefresh = true;
        return route.fulfill({ response });
      }
      if (path === '/api/me/business' && request.method() === 'GET' && failRefresh) {
        failRefresh = false;
        return route.fulfill({ status: 503, json: { error: 'Synthetic refresh interruption' } });
      }
      return route.continue();
    });
    await page.getByLabel('Name', { exact: true }).fill('Confirmed business');
    await page.getByLabel('Agent name', { exact: true }).fill('Confirmed assistant');
    await save.click();
    await expect(page.getByRole('alert').filter({ hasText: failure === 'refresh' ? 'refreshing the page data failed' : 'Assistant save failed' })).toBeVisible();
    expect(businessWrites).toBe(1);
    expect(assistantWrites).toBe(1);
    if (failure === 'assistant') {
      await save.click();
      await expect(save).toBeDisabled();
      expect(businessWrites).toBe(1);
      expect(assistantWrites).toBe(2);
    } else {
      await expect(save).toBeDisabled();
      // A later draft must survive the read-only recovery without being written.
      await page.getByLabel('Name', { exact: true }).fill('Later business draft');
      await page.getByLabel('Agent name', { exact: true }).fill('Later assistant draft');
      await page.getByRole('button', { name: 'Retry settings refresh', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry settings refresh', exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Later business draft');
      await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Later assistant draft');
      await expect(save).toBeEnabled();
      expect(businessWrites).toBe(1);
      expect(assistantWrites).toBe(1);
    }
    const persisted = await (await page.request.get('/api/me/business')).json();
    expect(persisted.name).toBe('Confirmed business');
    expect(persisted.agent.agent_name).toBe('Confirmed assistant');
  });
}
