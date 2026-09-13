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

async function openSettings(page: import('@playwright/test').Page, label: string) {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`settings-${label}-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Settings-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Read order workshop');
  await page.getByLabel('What do you do?').fill('Synthetic read ordering validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Save.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Read order workshop');
}

for (const timing of ['before', 'during'] as const) {
 test(`a settings read started ${timing} the mutation cannot replace confirmed writes or newer drafts`, async ({ page }) => {
  await openSettings(page, `stale-${timing}`);
  let writePending = false;
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  if (timing === 'during') await page.route('**/api/me/business/*', async route => {
    if (route.request().method() === 'PUT' && !route.request().url().endsWith('/agent')) {
      writePending = true;
      await writeGate;
    }
    return route.continue();
  });
  let reads = 0;
  let captured = false;
  let finalRead = false;
  let staleDelivered = false;
  let releaseStale!: () => void;
  let releaseFinal!: () => void;
  const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
  const finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
  await page.route('**/api/me/business', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    reads++;
    if (reads === 2) {
      const response = await route.fetch();
      captured = true;
      await staleGate;
      await route.fulfill({ response });
      staleDelivered = true;
      return;
    }
    if (reads === 3) {
      finalRead = true;
      await finalGate;
      return route.fulfill({ status: 503, json: { error: 'Final refresh unavailable' } });
    }
    return route.continue();
  });
  // Hold a read started either before Save or while its first write is pending.
  await page.getByLabel('Name', { exact: true }).fill('Confirmed later business');
  await page.getByLabel('Agent name', { exact: true }).fill('Confirmed later assistant');
  if (timing === 'during') {
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => writePending).toBe(true);
  }
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect.poll(() => captured).toBe(true);
  if (timing === 'before') await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  else releaseWrite();
  await expect.poll(() => finalRead).toBe(true);
  await page.getByLabel('Agent name', { exact: true }).fill('Newest unsaved assistant');
  releaseStale();
  await expect.poll(() => staleDelivered).toBe(true);
  releaseFinal();
  await expect(page.getByRole('alert').filter({ hasText: 'refreshing the page data failed' })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Confirmed later business');
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Newest unsaved assistant');
  await expect(page.getByRole('button', { name: 'Retry settings refresh', exact: true })).toBeVisible();
  const persisted = await (await page.request.get('/api/me/business')).json();
  expect(persisted.name).toBe('Confirmed later business');
  expect(persisted.agent.agent_name).toBe('Confirmed later assistant');
});
}

test('a failed second settings read retains refresh-only recovery', async ({ page }) => {
  await openSettings(page, 'second');
  let reads = 0;
  let writes = 0;
  await page.route('**/api/me/**', async route => {
    const request = route.request();
    if (request.method() === 'PUT') writes++;
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/me/business' && ++reads === 2) {
      return route.fulfill({ status: 503, json: { error: 'Second settings read unavailable' } });
    }
    return route.continue();
  });
  await page.getByLabel('Name', { exact: true }).fill('Second read confirmed');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Second settings read unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  const confirmedWrites = writes;
  await page.getByRole('button', { name: 'Retry settings refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry settings refresh', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Second read confirmed');
  expect(writes).toBe(confirmedWrites);
});
