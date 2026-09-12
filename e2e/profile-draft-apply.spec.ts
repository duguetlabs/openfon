import { test, expect } from '@playwright/test';

test('profile Apply blocks conflicting drafts and preserves unrelated drafts', async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`profile-draft-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Profile baseline workshop');
  await page.getByLabel('What do you do?').fill('Synthetic profile draft validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const business = await (await page.request.get('/api/me/business')).json();
  const created = await page.request.post(`/api/me/business/${business.id}/profiles`, { data: {
    name: 'German pipeline', engine: 'pipeline', language: 'de', voice: '', llm_model: '',
  } });
  expect(created.ok()).toBe(true);
  let applies = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/profiles\/[^/]+\/apply$/.test(request.url())) applies++; });
  await page.goto('/settings');
  const language = page.getByRole('combobox', { name: 'Language', exact: true });
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(language).toHaveValue('en');
  await expect(apply).toBeEnabled();
  await language.selectOption('fr');
  await page.getByLabel('Name', { exact: true }).fill('Unsaved business');
  await page.getByLabel('Agent name', { exact: true }).fill('Unsaved assistant');
  await expect(apply).toBeDisabled();
  await expect(page.getByText('Save or revert your engine, model, language, and voice edits before applying a profile.', { exact: true })).toBeVisible();
  expect(applies).toBe(0);
  expect((await (await page.request.get('/api/me/business')).json()).agent.language).toBe('en');

  // Revert only the conflicting draft; unrelated fields remain unsaved.
  await language.selectOption('en');
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(language).toHaveValue('de');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved business');
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Unsaved assistant');
  expect(applies).toBe(1);
  const applied = await (await page.request.get('/api/me/business')).json();
  expect(applied.agent.language).toBe('de');
  expect(applied.name).toBe('Profile baseline workshop');
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/me/business/${business.id}/agent`) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  await page.reload();
  await expect(language).toHaveValue('de');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved business');
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Unsaved assistant');
});
