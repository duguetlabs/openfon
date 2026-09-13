import { test, expect, type Route } from '@playwright/test';

for (const newerEdit of [false, true]) {
  test(`failed profile rename preserves retry and newer edits (newer=${newerEdit})`, async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`profile-blur-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Profile blur workshop');
  await page.getByLabel('What do you do?').fill('Synthetic profile blur validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const business = await (await page.request.get('/api/me/business')).json();
  const response = await page.request.post(`/api/me/business/${business.id}/profiles`, { data: { name: 'Original profile', engine: 'pipeline', language: 'en' } });
  expect(response.ok()).toBe(true);
  const profile = await response.json();

    let held: Route | undefined;
    let writes = 0;
    await page.route(`**/api/me/profiles/${profile.id}`, route => {
      if (route.request().method() !== 'PUT') return route.continue();
      writes++;
      if (writes === 1) { held = route; return; }
      return route.continue();
    });
    await page.goto('/settings');
    const input = page.getByRole('button', { name: 'Apply', exact: true }).locator('..').locator('input');
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
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/me/profiles/${profile.id}`) && response.request().method() === 'PUT');
    await input.blur();
    expect((await saved).ok()).toBe(true);
    expect(writes).toBe(2);
    await input.focus(); await input.blur();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(writes).toBe(2);
    await page.reload();
    await expect(input).toHaveValue(desired);
  });
}
