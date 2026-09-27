import { openAuth, connections, workspaceMenu, whoAnswers } from './cleanroom-helpers';
import { test, expect, openSettingsSections } from './fixtures';

test('unchanged profile name blurs spend no writes while real rename persists once', async ({ page }) => {
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
  let writes = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith(`/api/me/engine-presets/${profile.id}`)) writes++; });
  await connections(page);
  await openSettingsSections(page);
  const input = page.getByRole('button', { name: 'Use setup', exact: true }).locator('..').locator('input');
  await expect(input).toBeVisible();
  for (let i = 0; i < 3; i++) { await input.focus(); await input.blur(); }
  await input.fill('Temporary edit'); await input.fill('Original profile'); await input.blur();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(writes).toBe(0);
  await input.fill('Renamed profile');
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/me/engine-presets/${profile.id}`) && response.request().method() === 'PUT');
  await page.locator('input[value="Renamed profile"]').blur();
  expect((await saved).ok()).toBe(true);
  expect(writes).toBe(1);
  const renamed = page.locator('input[value="Renamed profile"]');
  await renamed.focus(); await renamed.blur();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(writes).toBe(1);
  await page.reload();
  await openSettingsSections(page);
  await expect(page.locator('input[value="Renamed profile"]')).toBeVisible();
});
