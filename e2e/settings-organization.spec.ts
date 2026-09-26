import { test, expect } from './fixtures';

test('workspace settings separate shared configuration from assistant editing', async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`settings-organization-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Organization-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Organization workshop');
  await page.getByLabel('What do you do?').fill('Synthetic settings organization validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const original = await (await page.request.get('/api/me/business')).json();
  await page.goto('/settings');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Conversation engine', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Realtime model', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Text API key', { exact: true })).toBeHidden();
  await expect(page.locator('#saved-voice-setups')).not.toHaveAttribute('open');

  // Jumping between scopes keeps both forms mounted and preserves their drafts.
  await page.getByLabel('Name', { exact: true }).fill('Unsaved shared business');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'AI connections' }).click();
  const textConnection = page.locator('#providers details').filter({ has: page.locator('summary').filter({ hasText: 'Text generation' }) });
  await textConnection.locator('summary').click();
  await page.getByLabel('Text API key', { exact: true }).fill('synthetic-unsaved-component-key');
  await textConnection.locator('summary').click();
  await textConnection.locator('summary').click();
  await expect(page.getByLabel('Text API key', { exact: true })).toHaveValue('synthetic-unsaved-component-key');
  await page.getByLabel('Text API key', { exact: true }).fill('');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Business', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved shared business');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  const saved = await (await page.request.get('/api/me/business')).json();
  expect(saved.name).toBe('Unsaved shared business');
  expect(saved.agent).toEqual(original.agent);
  await page.getByRole('link', { name: 'Manage assistants →', exact: true }).click();
  await page.getByRole('link', { name: 'Configure →' }).first().click();
  await expect(page.getByLabel('Opening greeting')).toBeVisible();
  await expect(page.getByLabel('Conversation engine', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Text API key', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Summary model', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/knowledge');
  const navigation = page.getByRole('navigation', { name: 'Workspace' });
  await expect(navigation.getByRole('link', { name: 'Knowledge', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => navigation.evaluate(menu => {
    const active = menu.querySelector('[aria-current="page"]')!;
    const link = active.getBoundingClientRect(), container = menu.getBoundingClientRect();
    return link.left >= container.left - 1 && link.right <= container.right + 1;
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

});
