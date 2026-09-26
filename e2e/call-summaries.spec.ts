import { test, expect, openSettingsSections } from './fixtures';
import { fillCatalog } from './catalog-fields';

test.beforeEach(async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`summaries-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Summaries workshop');
  await page.getByLabel('What do you do?').fill('Synthetic configuration validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await expect(page).toHaveURL('/overview');
  await page.goto('/settings');
  await openSettingsSections(page);
});

test('workspace summary model is saved separately from voice profiles; custom keys are write-only and removable', async ({ page }) => {
  const section = page.getByRole('region', { name: 'Call summaries', exact: true });
  await expect(section.getByLabel('Summary provider', { exact: true })).toHaveValue('legacy');
  await section.getByLabel('Summary provider', { exact: true }).selectOption('openai');
  await expect(section.getByLabel('Summary model', { exact: true })).toHaveValue('gpt-4.1-mini');
  await section.getByLabel('Summary API key', { exact: true }).fill('synthetic-summary-private');
  await section.getByRole('button', { name: 'Save summary settings', exact: true }).click();
  await expect(section.getByRole('status')).toContainText('Call summary settings saved.');
  await expect(section.getByLabel('Summary API key', { exact: true })).toHaveValue('');
  await expect(section.getByRole('button', { name: 'Save summary settings', exact: true })).toBeDisabled();
  const view = await (await page.request.get('/api/me/call-summaries')).json();
  expect(view).toMatchObject({ mode: 'custom', model: 'gpt-4.1-mini', apiKeyConfigured: true });
  expect(JSON.stringify(view)).not.toContain('synthetic-summary-private');
  await section.getByLabel('Summary provider', { exact: true }).selectOption('workspace');
  await fillCatalog(page, 'Summary model', 'my-summary-only-model');
  await section.getByRole('button', { name: 'Save summary settings', exact: true }).click();
  await expect(section.getByRole('status')).toContainText('Call summary settings saved.');
  expect(await (await page.request.get('/api/me/call-summaries')).json()).toMatchObject({ mode: 'workspace', model: 'my-summary-only-model', apiKeyConfigured: false });
  const { assistants } = await (await page.request.get('/api/me/bootstrap')).json();
  expect(assistants[0].llm_model).not.toBe('my-summary-only-model');
  await page.goto(`/assistants/${assistants[0].id}`);
  await expect(page.getByLabel('Summary model', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Summary language model', { exact: true })).toHaveCount(0);
  await page.getByLabel('Conversation engine', { exact: true }).selectOption('pipeline');
  await expect(page.getByLabel('Language model', { exact: true })).toBeVisible();
});

test('stale summary saves keep the draft and allow an explicit read-only reload', async ({ page }) => {
  const section = page.getByRole('region', { name: 'Call summaries', exact: true });
  await section.getByLabel('Summary provider', { exact: true }).selectOption('workspace');
  await fillCatalog(page, 'Summary model', 'stale-draft');
  expect((await page.request.put('/api/me/call-summaries', { data: { mode: 'workspace', baseUrl: '', model: 'other-tab', apiKey: '', revision: null } })).status()).toBe(200);
  await section.getByRole('button', { name: 'Save summary settings', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('Summary settings changed');
  await expect(page.getByLabel('Custom summary model', { exact: true })).toHaveValue('stale-draft');
  let writes = 0;
  page.on('request', r => { if (r.url().endsWith('/api/me/call-summaries') && r.method() === 'PUT') writes++; });
  await section.getByRole('button', { name: 'Reload summary settings (discard edits)', exact: true }).click();
  await expect(page.getByLabel('Custom summary model', { exact: true })).toHaveValue('other-tab');
  await expect(section.getByRole('button', { name: 'Save summary settings', exact: true })).toBeDisabled();
  expect(writes).toBe(0);
});

test('acknowledged summary save needs no follow-up read and admits only one pending write', async ({ page }) => {
  const section = page.getByRole('region', { name: 'Call summaries', exact: true });
  await section.getByLabel('Summary provider', { exact: true }).selectOption('workspace');
  let writes = 0; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/me/call-summaries', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 503, json: { error: 'Read unavailable' } });
    writes++; await held; await route.continue();
  });
  const save = section.getByRole('button', { name: /^(Save summary settings|Saving…)$/ });
  await save.click();
  await expect(save).toBeDisabled();
  await expect.poll(() => writes).toBe(1);
  release();
  await expect(section.getByRole('status')).toContainText('Call summary settings saved.');
  await expect(save).toBeDisabled();
  expect(writes).toBe(1);
});

test('one navigation guard protects summary and provider drafts independently across saves', async ({ page }) => {
  const summary = page.getByRole('region', { name: 'Call summaries', exact: true });
  const overview = page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Overview', exact: true });
  await summary.getByLabel('Summary provider', { exact: true }).selectOption('workspace');
  async function cancelNavigation() {
    const dialog = page.waitForEvent('dialog');
    const navigate = overview.click();
    await (await dialog).dismiss(); await navigate;
    await expect(page).toHaveURL('/settings');
  }
  await cancelNavigation(); // A clean provider card cannot hide a summary draft.
  await fillCatalog(page, 'Workspace text model', 'unsaved-provider-model');
  await summary.getByRole('button', { name: 'Save summary settings', exact: true }).click();
  await expect(summary.getByRole('status')).toContainText('Call summary settings saved.');
  await cancelNavigation(); // Saving summaries must not clear the provider guard.
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByText('Provider settings saved.', { exact: false })).toBeVisible();
  let unexpectedDialogs = 0;
  page.on('dialog', async d => { unexpectedDialogs++; await d.dismiss(); });
  await overview.click();
  await expect(page).toHaveURL('/overview');
  expect(unexpectedDialogs).toBe(0);
});
