import { signup, createWorkspace, connections } from './cleanroom-helpers';
import { test, expect, openSettingsSections } from './fixtures';

test('applying a voice setup preserves an independent summary draft without duplicate voice controls', async ({
  page,
}) => {
  await signup(page, 'profile-draft');
  const { assistant } = await createWorkspace(page, 'Profile baseline workshop');
  const created = await page.request.post('/api/me/engine-presets', {
    data: {
      name: 'German pipeline',
      engine: 'pipeline',
      language: 'de',
      voice: '',
      llm_model: '',
    },
  });
  expect(created.status()).toBe(201);
  let applies = 0;
  let assistantWrites = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/engine-presets\/[^/]+\/apply$/.test(new URL(request.url()).pathname)
    )
      applies++;
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === `/api/me/assistants/${assistant.id}`
    )
      assistantWrites++;
  });
  await connections(page);
  await openSettingsSections(page);
  const apply = page.getByRole('button', { name: 'Use setup', exact: true });
  const summary = page.getByLabel('Conversation summaries', { exact: true });
  await expect(apply).toBeEnabled();
  // Business now has its own screen. Summary settings are the independent draft
  // that shares this screen; applying a setup must neither consume nor save it.
  await expect(page.getByLabel('Language', { exact: true })).toHaveCount(1);
  await expect(page.getByLabel(/^Text model override/)).toHaveCount(1);
  await summary.getByLabel('Summary connection').selectOption('workspace');
  await summary.getByLabel(/^Model/).fill('unsaved-summary-model');
  await apply.click();
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('de');
  await expect(summary.getByLabel(/^Model/)).toHaveValue('unsaved-summary-model');
  expect(applies).toBe(1);
  expect((await (await page.request.get(`/api/me/assistants/${assistant.id}`)).json()).language).toBe('de');
  expect((await (await page.request.get('/api/me/business')).json()).name).toBe('Profile baseline workshop');
  expect((await (await page.request.get('/api/me/call-summaries')).json()).model).not.toBe(
    'unsaved-summary-model',
  );
  await summary.getByRole('button', { name: 'Save summary settings', exact: true }).click();
  await expect(summary.getByRole('status')).toContainText('Summary settings saved.');
  await page.reload();
  await openSettingsSections(page);
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('de');
  await expect(summary.getByLabel(/^Model/)).toHaveValue('unsaved-summary-model');
  expect(assistantWrites).toBe(0);
  expect(applies).toBe(1);
});
