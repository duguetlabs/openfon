import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';
const rendered = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const inputFor = (page: Page) => page.getByRole('button', { name: 'Apply', exact: true }).locator('..').locator('input');
async function setup(page: Page) {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`normalized-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Normalization-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Normalization workshop');
  await page.getByLabel('What do you do?').fill('Synthetic rename validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const business = await (await page.request.get('/api/me/business')).json();
  const response = await page.request.post(`/api/me/business/${business.id}/profiles`, { data: { name: 'Original profile', engine: 'pipeline', language: 'en' } });
  expect(response.status()).toBe(201); const profile = await response.json();
  await page.goto('/settings'); await expect(inputFor(page)).toHaveValue('Original profile');
  return { businessId: business.id as string, profileId: profile.id as string };
}
const persistedName = async (page: Page, businessId: string, profileId: string) =>
  (await (await page.request.get(`/api/me/business/${businessId}/profiles`)).json()).find((row: { id: string }) => row.id === profileId).name;

for (const [label, raw] of [['empty', ''], ['whitespace', '   '], ['padded unchanged', '  Original profile  ']]) {
  test(`normalization no-op reconciles ${label} without a write`, async ({ page }) => {
    const { businessId, profileId } = await setup(page); let writes = 0;
    page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith(`/api/me/profiles/${profileId}`)) writes++; });
    const input = inputFor(page); await input.fill(raw); await input.blur(); await rendered(page);
    console.log('rename-normalization-diagnostic', JSON.stringify({ label, writes, displayed: await input.inputValue(), persisted: await persistedName(page, businessId, profileId) }));
    await expect(input).toHaveValue('Original profile'); expect(writes).toBe(0);
    await input.focus(); await input.blur(); await rendered(page); expect(writes).toBe(0);
  });
}

test('successful normalized acknowledgement remains clean through a provider refresh', async ({ page }) => {
  const { businessId, profileId } = await setup(page); let writes = 0, listReads = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith(`/api/me/profiles/${profileId}`)) writes++; });
  const input = inputFor(page); await input.fill('  Accepted name  ');
  const response = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/api/me/profiles/${profileId}`));
  await input.blur(); expect((await response).status()).toBe(200); await rendered(page);
  console.log('rename-ack-diagnostic', JSON.stringify({ writes, displayed: await input.inputValue(), persisted: await persistedName(page, businessId, profileId) }));
  await expect(input).toHaveValue('Accepted name'); expect(writes).toBe(1);
  await page.getByLabel('Name', { exact: true }).fill('Newer business draft');
  await page.route(`**/api/me/business/${businessId}/profiles`, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const result = await route.fetch(); await route.fulfill({ response: result }); listReads++;
  });
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect.poll(() => listReads).toBeGreaterThan(0); await rendered(page);
  await expect(input).toHaveValue('Accepted name'); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Newer business draft');
  await input.focus(); await input.blur(); await rendered(page); expect(writes).toBe(1);
});

for (const awayBack of [false, true]) {
  test(`acknowledgement preserves newer edit version (away-back=${awayBack})`, async ({ page }) => {
    const { businessId, profileId } = await setup(page); let held: Route | undefined, writes = 0, released = false;
    await page.route(`**/api/me/profiles/${profileId}`, route => {
      if (route.request().method() !== 'PUT') return route.continue();
      writes++; if (writes === 1) { held = route; return; } return route.continue();
    });
    try {
      const input = inputFor(page); await input.fill('  Accepted name  '); await input.blur(); await expect.poll(() => Boolean(held)).toBe(true);
      await input.fill('Newer edit'); if (awayBack) await input.fill('  Accepted name  ');
      const expected = awayBack ? '  Accepted name  ' : 'Newer edit';
      const response = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/api/me/profiles/${profileId}`));
      released = true; await held!.continue(); expect((await response).status()).toBe(200); await rendered(page);
      await expect(input).toHaveValue(expected); expect(writes).toBe(1);
      expect(await persistedName(page, businessId, profileId)).toBe('Accepted name');
      await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
      // No automatic second rename or action; a newer raw draft remains intentional.
    } finally { if (held && !released) await held.abort().catch(() => {}); }
  });
}

test('queued normalized no-op uses the preceding successful baseline', async ({ page }) => {
  const { businessId, profileId } = await setup(page); let held: Route | undefined, writes = 0, released = false;
  await page.route(`**/api/me/profiles/${profileId}`, route => {
    if (route.request().method() !== 'PUT') return route.continue(); writes++;
    if (writes === 1) { held = route; return; } return route.continue();
  });
  try {
    const input = inputFor(page); await input.fill('  Accepted name  '); await input.blur(); await expect.poll(() => Boolean(held)).toBe(true);
    await input.fill(' Accepted name '); await input.blur();
    const response = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/api/me/profiles/${profileId}`));
    released = true; await held!.continue(); expect((await response).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled(); await rendered(page);
    console.log('rename-queue-diagnostic', JSON.stringify({ writes, displayed: await input.inputValue(), persisted: await persistedName(page, businessId, profileId) }));
    await expect(input).toHaveValue('Accepted name'); expect(writes).toBe(1);
  } finally { if (held && !released) await held.abort().catch(() => {}); }
});

test('failed queued rename restores the normalized acknowledged baseline', async ({ page }) => {
  const { businessId, profileId } = await setup(page); const held: Route[] = []; const released = new Set<Route>(); let writes = 0;
  await page.route(`**/api/me/profiles/${profileId}`, route => {
    if (route.request().method() !== 'PUT') return route.continue(); writes++; held.push(route);
  });
  try {
    const input = inputFor(page); await input.fill('  Accepted name  '); await input.blur(); await expect.poll(() => held.length).toBe(1);
    await input.fill('  Rejected name  '); await input.blur(); released.add(held[0]); await held[0].continue();
    await expect.poll(() => held.length).toBe(2); released.add(held[1]); await held[1].fulfill({ status: 503, json: { error: 'Synthetic queued rename refusal' } });
    await expect(input).toHaveValue('Accepted name'); await expect(page.getByText('Synthetic queued rename refusal', { exact: true })).toBeVisible();
    expect(await persistedName(page, businessId, profileId)).toBe('Accepted name'); expect(writes).toBe(2);
    await input.focus(); await input.blur(); await rendered(page); expect(writes).toBe(2);
  } finally { for (const route of held) if (!released.has(route)) await route.abort().catch(() => {}); }
});
