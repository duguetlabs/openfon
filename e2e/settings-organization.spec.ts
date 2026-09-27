import { test, expect } from './fixtures';
import { signup, createWorkspace, connections, workspaceMenu, whoAnswers } from './cleanroom-helpers';

test('workspace details, shared connections and receptionist editing preserve their separate scopes', async ({
  page,
}) => {
  await signup(page, 'organization');
  await createWorkspace(page, 'Organization workshop');
  const original = await (await page.request.get('/api/me/business')).json();
  await workspaceMenu(page, 'Business details');
  await expect(page.getByLabel('Conversation engine')).toHaveCount(0);
  await expect(page.getByLabel('API key')).toHaveCount(0);
  await page.getByLabel('Business name', { exact: true }).fill('Unsaved shared business');
  page.once('dialog', (d) => d.dismiss());
  await workspaceMenu(page, 'Connections & portability');
  await expect(page.getByLabel('Business name', { exact: true })).toHaveValue('Unsaved shared business');
  await page.getByRole('button', { name: 'Close menu', exact: true }).click();
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  const saved = await (await page.request.get('/api/me/business')).json();
  expect(saved.name).toBe('Unsaved shared business');
  expect(saved.agent).toEqual(original.agent);
  await connections(page);
  const text = page
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: 'Text & reasoning' }) });
  await expect(page.locator('.of-presets')).not.toHaveAttribute('open');
  const key = text.getByLabel(/^Text API key/);
  await key.fill('synthetic-unsaved-component-key');
  await text.locator('summary').click();
  await text.locator('summary').click();
  await expect(key).toHaveValue('synthetic-unsaved-component-key');
  await key.fill('');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Back to your desk' }).click();
  await whoAnswers(page);
  await expect(page.getByLabel('Their first words')).toBeVisible();
  await expect(page.getByLabel('API key')).toHaveCount(0);
  await expect(page.getByLabel('Summary connection')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /What they know/ }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
