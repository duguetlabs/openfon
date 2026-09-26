import { test, expect, openSettingsSections } from './fixtures';

test('profile Apply preserves independent business drafts without duplicate voice controls', async ({ page }) => {
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
  await openSettingsSections(page);
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeEnabled();
  // Voice edits live only in Assistants. Applying a saved setup must not consume
  // or persist the independent business draft still being edited here.
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveCount(0);
  await page.getByLabel('Name', { exact: true }).fill('Unsaved business');
  await apply.click();
  await expect(page.getByLabel('Current primary assistant setup')).toContainText(' · de · ');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved business');
  expect(applies).toBe(1);
  const applied = await (await page.request.get('/api/me/business')).json();
  expect(applied.agent.language).toBe('de'); expect(applied.name).toBe('Profile baseline workshop');
  let assistantWrites = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/agent')) assistantWrites++; });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await page.reload(); await openSettingsSections(page);
  await expect(page.getByLabel('Current primary assistant setup')).toContainText(' · de · ');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved business');
  expect(assistantWrites).toBe(0);
});
