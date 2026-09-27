import { openAuth, connections, workspaceMenu, whoAnswers } from './cleanroom-helpers';
import { test, expect, openSettingsSections } from './fixtures';
import type { Route } from '@playwright/test';

for (const newerEdit of [false, true]) {
  test(`failed profile rename preserves retry and newer edits (newer=${newerEdit})`, async ({ page }) => {
  await openAuth(page);
  await page.getByLabel('Email').fill(`profile-blur-${Date.now()}@example.invalid`);
  await page.getByLabel(/^Password/).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Profile blur workshop');
  await page.getByLabel('What do you do?').fill('Synthetic profile blur validation');
  await page.getByRole('button', { name: 'Meet your receptionist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeVisible();
  const business = await (await page.request.get('/api/me/business')).json();
  const response = await page.request.post(`/api/me/engine-presets`, { data: { name: 'Original profile', engine: 'pipeline', language: 'en' } });
  expect(response.ok()).toBe(true);
  const profile = await response.json();

    let held: Route | undefined;
    let writes = 0;
    await page.route(`**/api/me/engine-presets/${profile.id}`, route => {
      if (route.request().method() !== 'PUT') return route.continue();
      writes++;
      if (writes === 1) { held = route; return; }
      return route.continue();
    });
    await connections(page);
  await openSettingsSections(page);
    const input = page.getByRole('button', { name: 'Use setup', exact: true }).locator('..').locator('input');
    await expect(input).toHaveValue('Original profile');
    await input.fill('Attempted rename'); await input.blur();
    await expect.poll(() => Boolean(held)).toBe(true);
    if (newerEdit) await input.fill('Newer edit');
    await held!.fulfill({ status: 503, json: { error: 'Synthetic rename failure' } });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (newerEdit) {
      await expect(input).toHaveValue('Newer edit');
    } else {
      await expect(input).toHaveValue('Original profile');
      await expect(page.getByText('Synthetic rename failure', { exact: true })).toBeVisible();
      await input.fill('Attempted rename');
    }
    const desired = newerEdit ? 'Newer edit' : 'Attempted rename';
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/me/engine-presets/${profile.id}`) && response.request().method() === 'PUT');
    await input.blur();
    expect((await saved).ok()).toBe(true);
    expect(writes).toBe(2);
    await input.focus(); await input.blur();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(writes).toBe(2);
    await page.reload();
  await openSettingsSections(page);
    await expect(input).toHaveValue(desired);
  });
}


for (const firstSucceeds of [false, true]) {
  test(`overlapping rename failures restore confirmed saved name (first succeeds=${firstSucceeds})`, async ({ page }) => {
  await openAuth(page);
  await page.getByLabel('Email').fill(`profile-blur-${Date.now()}@example.invalid`);
  await page.getByLabel(/^Password/).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Profile blur workshop');
  await page.getByLabel('What do you do?').fill('Synthetic profile blur validation');
  await page.getByRole('button', { name: 'Meet your receptionist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeVisible();
  const business = await (await page.request.get('/api/me/business')).json();
  const response = await page.request.post(`/api/me/engine-presets`, { data: { name: 'Original profile', engine: 'pipeline', language: 'en' } });
  expect(response.ok()).toBe(true);
  const profile = await response.json();

    const held: Route[] = [];
    let writes = 0;
    await page.route(`**/api/me/engine-presets/${profile.id}`, route => {
      if (route.request().method() !== 'PUT') return route.continue();
      writes++;
      if (writes <= 2) { held.push(route); return; }
      return route.continue();
    });
    await connections(page);
  await openSettingsSections(page);
    const input = page.getByRole('button', { name: 'Use setup', exact: true }).locator('..').locator('input');
    await expect(input).toHaveValue('Original profile');
    await input.fill('Pending B'); await input.blur();
    await expect.poll(() => held.length).toBe(1);
    await input.focus(); await input.fill('Pending C'); await input.blur();
    // Resolve B after C has been blurred. The original allows both requests in
    // flight; the fix queues C until B establishes the next persisted baseline.
    const firstResponse = page.waitForResponse(response => response.url().endsWith(`/api/me/engine-presets/${profile.id}`) && response.request().postDataJSON()?.name === 'Pending B');
    if (firstSucceeds) await held[0].continue();
    else await held[0].fulfill({ status: 503, json: { error: 'Synthetic first rename failure' } });
    expect((await firstResponse).status()).toBe(firstSucceeds ? 200 : 503);
    await expect.poll(() => held.length).toBe(2);
    await expect(input).toHaveValue('Pending C');
    await held[1].fulfill({ status: 503, json: { error: 'Synthetic second rename failure' } });
    const confirmed = firstSucceeds ? 'Pending B' : 'Original profile';
    await expect(input).toHaveValue(confirmed);
    await expect(page.getByText('Synthetic second rename failure', { exact: true })).toBeVisible();
    const persisted = await (await page.request.get(`/api/me/engine-presets`)).json();
    expect(persisted.find((row: { id: string }) => row.id === profile.id).name).toBe(confirmed);
    await input.focus(); await input.blur();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(writes).toBe(2);
    await input.fill('Pending C');
    const retry = page.waitForResponse(response => response.url().endsWith(`/api/me/engine-presets/${profile.id}`) && response.request().method() === 'PUT');
    await input.blur();
    expect((await retry).ok()).toBe(true);
    expect(writes).toBe(3);
    await page.reload();
  await openSettingsSections(page);
    await expect(input).toHaveValue('Pending C');
  });
}
