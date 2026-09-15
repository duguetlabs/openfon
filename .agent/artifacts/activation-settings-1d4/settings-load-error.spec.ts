import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';

const providerSave = (page: Page) => page.getByRole('button', { name: 'Save provider settings', exact: true });
const retrySettings = (page: Page) => page.getByRole('button', { name: 'Retry settings refresh', exact: true });
const alert = (page: Page, text: string) => page.getByRole('alert').filter({ hasText: text });
function latch() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { gate, release };
}
async function rendered(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function openSettings(page: Page, label: string, withProfile = false) {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`load-owner-${label}-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Load-Ownership-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Load ownership workshop');
  await page.getByLabel('What do you do?').fill('Synthetic load ownership validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const business = await (await page.request.get('/api/me/business')).json();
  let profileId = '';
  if (withProfile) {
    const response = await page.request.post(`/api/me/business/${business.id}/profiles`, {
      data: { name: 'Retained profile', engine: 'pipeline', language: 'fr', voice: '', llm_model: '' },
    });
    expect(response.status()).toBe(201); profileId = (await response.json()).id;
  }
  await page.goto('/settings');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Load ownership workshop');
  await expect(providerSave(page)).toBeEnabled();
  if (withProfile) await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  return { businessId: business.id as string, profileId };
}
// Installed only after Settings loaded. Each explicit provider refresh has a
// session GET first and effect-local Settings GET second. Every selected boundary
// is counted/awaited; APIRequestContext setup writes do not traverse page routes.
async function businessReads(page: Page, selected: Record<number, (route: Route) => Promise<void>>) {
  const state = { reads: 0, delivered: [] as number[] };
  await page.route('**/api/me/business', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const ordinal = ++state.reads;
    if (selected[ordinal]) await selected[ordinal](route);
    else { const response = await route.fetch(); await route.fulfill({ response }); }
    state.delivered.push(ordinal);
  });
  return state;
}
async function serverMarker(page: Page, businessId: string, marker: string) {
  expect((await page.request.put(`/api/me/business/${businessId}/agent`, { data: { agent_name: marker } })).ok()).toBe(true);
}

test('accepted automatic settings read clears only an earlier local load failure and retains drafts', async ({ page }) => {
  const { businessId } = await openSettings(page, 'clear');
  const reads = await businessReads(page, { 2: async route => { await route.fulfill({ status: 503, json: { error: 'Local load unavailable' } }); } });
  await providerSave(page).click();
  await expect(alert(page, 'Local load unavailable')).toBeVisible();
  await expect(retrySettings(page)).toBeVisible(); expect(reads.reads).toBe(2);
  await page.getByLabel('Name', { exact: true }).fill('Newer unsaved business draft');
  await serverMarker(page, businessId, 'Accepted later server assistant');
  await providerSave(page).click();
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Accepted later server assistant');
  await expect.poll(() => reads.delivered.includes(4)).toBe(true);
  console.log('settings-load-diagnostic', JSON.stringify({ reads: reads.reads, delivered: reads.delivered, loadAlerts: await alert(page, 'Local load unavailable').count() }));
  await expect(alert(page, 'Local load unavailable')).toHaveCount(0);
  await expect(retrySettings(page)).toHaveCount(0);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Newer unsaved business draft');
  expect((await (await page.request.get('/api/me/business')).json()).name).toBe('Load ownership workshop');
});

for (const late of ['success', 'failure'] as const) {
  test(`superseded local ${late} cannot change the newer load outcome`, async ({ page }) => {
    const { businessId } = await openSettings(page, `stale-${late}`);
    const hold = latch(); let captured = false;
    const reads = await businessReads(page, {
      2: async route => {
        const response = await route.fetch(); captured = true; await hold.gate;
        if (late === 'success') await route.fulfill({ response });
        else await route.fulfill({ status: 503, json: { error: 'Superseded load failure' } });
      },
      4: async route => {
        if (late === 'success') await route.fulfill({ status: 503, json: { error: 'Current load failure' } });
        else { const response = await route.fetch(); await route.fulfill({ response }); }
      },
    });
    try {
      await providerSave(page).click(); await expect.poll(() => captured).toBe(true);
      await serverMarker(page, businessId, 'New current assistant');
      await providerSave(page).click();
      if (late === 'success') await expect(alert(page, 'Current load failure')).toBeVisible();
      else await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('New current assistant');
      await expect.poll(() => reads.delivered.includes(4)).toBe(true);
      hold.release(); await expect.poll(() => reads.delivered.includes(2)).toBe(true); await rendered(page);
      expect(reads.reads).toBe(4);
      if (late === 'success') {
        await expect(alert(page, 'Current load failure')).toBeVisible(); await expect(retrySettings(page)).toBeVisible();
      } else {
        await expect(alert(page, 'Superseded load failure')).toHaveCount(0); await expect(retrySettings(page)).toHaveCount(0);
        await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('New current assistant');
      }
    } finally { hold.release(); }
  });
}

for (const mutation of ['create', 'rename'] as const) {
  test(`accepted settings read preserves a newer ${mutation} refusal with identical error text`, async ({ page }) => {
    const { businessId, profileId } = await openSettings(page, `mutation-${mutation}`, mutation === 'rename');
    const hold = latch(); let captured = false, writes = 0;
    const reads = await businessReads(page, {
      2: async route => { await route.fulfill({ status: 503, json: { error: 'Same ownership message' } }); },
      4: async route => { const response = await route.fetch(); captured = true; await hold.gate; await route.fulfill({ response }); },
    });
    try {
      await providerSave(page).click(); await expect(alert(page, 'Same ownership message')).toBeVisible();
      await serverMarker(page, businessId, 'Accepted after mutation error');
      await providerSave(page).click(); await expect.poll(() => captured).toBe(true);
      await page.route(mutation === 'create' ? `**/api/me/business/${businessId}/profiles` : `**/api/me/profiles/${profileId}`, async route => {
        if (route.request().method() !== (mutation === 'create' ? 'POST' : 'PUT')) return route.continue();
        writes++; await route.fulfill({ status: 503, json: { error: 'Same ownership message' } });
      });
      if (mutation === 'create') {
        await page.getByPlaceholder(/Save current setup as/).fill('Retained create draft');
        await page.getByRole('button', { name: 'Save profile', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
      } else {
        // The row input has no label; its acknowledged exact value identifies it.
        await page.locator('input[value="Retained profile"]').fill('Refused rename');
        await page.getByLabel('Name', { exact: true }).focus();
        await expect(page.locator('input[value="Retained profile"]')).toBeVisible();
      }
      await expect.poll(() => writes).toBe(1); await expect(alert(page, 'Same ownership message')).toBeVisible();
      await page.getByLabel('Name', { exact: true }).fill('Newer draft after refusal');
      hold.release(); await expect.poll(() => reads.delivered.includes(4)).toBe(true);
      await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Accepted after mutation error');
      await expect(alert(page, 'Same ownership message')).toBeVisible();
      await expect(retrySettings(page)).toHaveCount(0);
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Newer draft after refusal');
      if (mutation === 'create') await expect(page.getByPlaceholder(/Save current setup as/)).toHaveValue('Retained create draft');
      expect(writes).toBe(1);
    } finally { hold.release(); }
  });
}

for (const operation of ['apply', 'delete'] as const) {
  test(`independent accepted settings read retains confirmed ${operation} display recovery`, async ({ page }) => {
    const { businessId, profileId } = await openSettings(page, `profile-${operation}`, true);
    let writes = 0, failRead = false;
    await page.route(url => url.pathname.includes('/profiles') || url.pathname === '/api/me', async route => {
      const request = route.request();
      if (request.method() !== 'GET') {
        writes++; const response = await route.fetch(); expect(response.ok()).toBe(true); failRead = true;
        return route.fulfill({ response });
      }
      if (failRead && (operation === 'apply' ? new URL(request.url()).pathname === '/api/me' : request.url().includes('/profiles'))) {
        failRead = false; return route.fulfill({ status: 503, json: { error: 'Profile display unavailable' } });
      }
      return route.continue();
    });
    await page.getByRole('button', { name: operation === 'apply' ? 'Apply' : 'Delete profile', exact: true }).click();
    await expect(alert(page, 'The profile change was saved')).toBeVisible();
    await serverMarker(page, businessId, 'Independent accepted snapshot');
    await page.getByLabel('Name', { exact: true }).fill('Later unsaved workspace');
    await providerSave(page).click();
    await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Independent accepted snapshot');
    await expect(alert(page, 'The profile change was saved')).toBeVisible();
    const retry = page.getByRole('button', { name: 'Retry profile refresh', exact: true });
    await expect(retry).toBeEnabled(); expect(writes).toBe(1);
    await retry.click(); await expect(retry).toHaveCount(0);
    await expect(alert(page, 'The profile change was saved')).toHaveCount(0);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Later unsaved workspace'); expect(writes).toBe(1);
    if (operation === 'apply') expect((await (await page.request.get('/api/me/business')).json()).agent.language).toBe('fr');
    else expect((await (await page.request.get(`/api/me/business/${businessId}/profiles`)).json()).some((p: { id: string }) => p.id === profileId)).toBe(false);
  });
}

test('independent accepted settings read preserves accepted-write session recovery and baseline', async ({ page }) => {
  const { businessId } = await openSettings(page, 'session');
  let writes = 0, failSession = true;
  await page.route('**/api/me', async route => {
    if (failSession) { failSession = false; return route.fulfill({ status: 503, json: { error: 'Session unavailable' } }); }
    return route.continue();
  });
  await page.route(`**/api/me/business/${businessId}`, async route => {
    if (route.request().method() === 'PUT') writes++;
    return route.continue();
  });
  await page.getByLabel('Name', { exact: true }).fill('Confirmed saved business');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(alert(page, 'refreshing the page data failed')).toBeVisible(); expect(writes).toBe(1);
  await serverMarker(page, businessId, 'Independent session marker');
  await providerSave(page).click();
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Independent session marker');
  await expect(alert(page, 'refreshing the page data failed')).toBeVisible(); await expect(retrySettings(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await page.getByLabel('Name', { exact: true }).fill('New draft after accepted write');
  await retrySettings(page).click(); await expect(retrySettings(page)).toHaveCount(0);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('New draft after accepted write');
  expect(writes).toBe(1); expect((await (await page.request.get('/api/me/business')).json()).name).toBe('Confirmed saved business');
});
