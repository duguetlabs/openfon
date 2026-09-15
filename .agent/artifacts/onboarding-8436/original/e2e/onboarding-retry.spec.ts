import { test, expect } from './fixtures';

for (const failure of ['workspace update', 'assistant list', 'assistant update']) {
  test(`onboarding resumes after ${failure} fails after workspace creation`, async ({ page }) => {
    let created = false;
    let failed = false;
    const createdIds: string[] = [];
    await page.route('**/api/me/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/me/business' && request.method() === 'POST') {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        createdIds.push((await response.json()).id);
        created = true;
        return route.fulfill({ response });
      }
      const target = failure === 'workspace update' ? request.method() === 'PUT' && path.startsWith('/api/me/business/')
        : failure === 'assistant list' ? request.method() === 'GET' && path === '/api/me/assistants'
        : request.method() === 'PUT' && path.startsWith('/api/me/assistants/');
      if (created && !failed && target) {
        failed = true;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected setup interruption' }) });
      }
      return route.continue();
    });
    await page.goto('/auth');
    await page.getByLabel('Email').fill(`retry-${Date.now()}-${Math.random()}@example.invalid`);
    await page.getByLabel('Password', { exact: true }).fill('Local-Test-Password-Only-1234');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByLabel('Business name', { exact: true }).fill('Retry Workshop');
    await page.getByLabel('What do you do?').fill('Synthetic local repair workshop.');
    await page.getByRole('button', { name: 'Continue →' }).click();
    await page.getByRole('button', { name: 'Continue →' }).click();
    const finish = page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i });
    await finish.click();
    await expect(page.getByText('Injected setup interruption')).toBeVisible();
    expect(failed).toBe(true);
    await finish.click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    await expect(page).toHaveURL('/overview');
    expect(createdIds).toHaveLength(2);
    expect(createdIds[1]).toBe(createdIds[0]);
    const bootstrap = await (await page.request.get('/api/me/bootstrap')).json();
    expect(bootstrap.assistants).toHaveLength(1);
    expect(bootstrap.assistants[0].state).toBe('draft');
  });
}
