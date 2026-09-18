import { test, expect } from './fixtures';

for (const operation of ['save', 'publish', 'pause'] as const) {
  test(`successful assistant ${operation} survives refresh failure without repeating mutation`, async ({ page }) => {
    await page.goto('/auth');
    await page.getByLabel('Email').fill(`assistant-refresh-${operation}-${Date.now()}@example.invalid`);
    await page.getByLabel('Password', { exact: true }).fill('Synthetic-Refresh-Password-1234');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByLabel('Business name', { exact: true }).fill('Assistant refresh workshop');
    await page.getByLabel('What do you do?').fill('Synthetic assistant refresh validation');
    await page.getByRole('button', { name: 'Continue →' }).click();
    await page.getByRole('button', { name: 'Continue →' }).click();
    await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const bootstrap = await (await page.request.get('/api/me/bootstrap')).json();
    const assistant = await (await page.request.get(`/api/me/assistants/${bootstrap.assistants[0].id}`)).json();
    const path = `/api/me/assistants/${assistant.id}`;
    if (operation === 'pause') expect((await page.request.post(`${path}/activate`, { data: {} })).ok()).toBe(true);
    await page.goto(`/assistants/${assistant.id}`);
    await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
    let mutations = 0;
    let failReads = 0;
    await page.route(url => url.pathname === path || url.pathname.startsWith(`${path}/`), async route => {
      const request = route.request();
      if (request.method() === 'GET') {
        if (failReads > 0) {
          failReads--;
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic refresh unavailable' }) });
        }
        return route.continue();
      }
      mutations++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      failReads = 1;
      await route.fulfill({ response });
    });
    if (operation === 'save' || operation === 'pause') await page.getByLabel('Opening greeting').fill('A draft greeting to preserve.');
    await page.getByRole('button', { name: operation === 'save' ? 'Save changes' : operation === 'publish' ? 'Publish assistant' : 'Pause assistant', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Your changes were saved, but the assistant could not be refreshed.' })).toBeVisible();
    expect(mutations).toBe(1);
    if (operation === 'save') {
      await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
      await expect(page.getByText('You have unsaved changes. Save before testing or publishing.')).toHaveCount(0);
    } else {
      await expect(page.getByRole('button', { name: operation === 'publish' ? 'Pause assistant' : 'Publish assistant', exact: true })).toBeVisible();
    }
    // Retry only the read; changes made after the failed read stay as a draft.
    await page.getByLabel('Opening greeting').fill('Newer draft after refresh failure.');
    await page.getByRole('button', { name: 'Retry assistant refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry assistant refresh', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Opening greeting')).toHaveValue('Newer draft after refresh failure.');
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
    expect(mutations).toBe(1);
    const persisted = await (await page.request.get(path)).json();
    expect(persisted.state).toBe(operation === 'publish' ? 'active' : operation === 'pause' ? 'paused' : 'draft');
    if (operation === 'save') expect(persisted.greeting).toBe('A draft greeting to preserve.');
    else expect(persisted.greeting).toBe(assistant.greeting);
  });
}
