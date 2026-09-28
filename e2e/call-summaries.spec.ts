import { test, expect } from './fixtures';
import { signup, createWorkspace, connections, workspaceMenu } from './cleanroom-helpers';

test.beforeEach(async ({ page }) => {
  await signup(page, 'summaries');
  await createWorkspace(page, 'Summaries workshop');
  await connections(page);
  await page.locator('summary').filter({ hasText: 'Conversation summaries' }).click();
});

test('workspace summary model is saved separately from voice setups; custom keys are write-only and removable', async ({
  page,
}) => {
  const section = page.getByLabel('Conversation summaries', { exact: true });
  await expect(section.getByLabel('Summary connection')).toHaveValue('legacy');
  await section.getByLabel('Summary connection').selectOption('custom');
  await section.getByLabel('API URL').fill('https://api.openai.com/v1');
  await section.getByLabel(/^Model/).fill('gpt-4.1-mini');
  await section.getByLabel(/^API key/).fill('synthetic-summary-private');
  await section.getByRole('button', { name: 'Save summary settings', exact: true }).click();
  await expect(section.getByRole('status')).toContainText('Summary settings saved.');
  await expect(section.getByLabel(/^API key/)).toHaveValue('');
  await expect(section.getByRole('button', { name: 'Save summary settings', exact: true })).toBeDisabled();
  expect(await (await page.request.get('/api/me/call-summaries')).json()).toMatchObject({
    mode: 'custom',
    model: 'gpt-4.1-mini',
    apiKeyConfigured: true,
  });
  expect(await (await page.request.get('/api/me/call-summaries')).text()).not.toContain(
    'synthetic-summary-private',
  );
  await section.getByLabel('Summary connection').selectOption('workspace');
  await section.getByLabel(/^Model/).fill('my-summary-only-model');
  await section.getByRole('button', { name: 'Save summary settings', exact: true }).click();
  await expect(section.getByRole('status')).toContainText('Summary settings saved.');
  expect(await (await page.request.get('/api/me/call-summaries')).json()).toMatchObject({
    mode: 'workspace',
    model: 'my-summary-only-model',
    apiKeyConfigured: false,
  });
  const { assistants } = await (await page.request.get('/api/me/bootstrap')).json();
  expect(assistants[0].llm_model).not.toBe('my-summary-only-model');
  await page.getByRole('button', { name: 'Back to your desk' }).click();
  await expect(page.getByLabel('Summary connection')).toHaveCount(0);
});

test('stale summary saves keep the draft and allow an explicit read-only reload', async ({ page }) => {
  const section = page.getByLabel('Conversation summaries', { exact: true });
  await section.getByLabel('Summary connection').selectOption('workspace');
  await section.getByLabel(/^Model/).fill('stale-draft');
  expect(
    (
      await page.request.put('/api/me/call-summaries', {
        data: { mode: 'workspace', baseUrl: '', model: 'other-tab', apiKey: '', revision: null },
      })
    ).status(),
  ).toBe(200);
  await section.getByRole('button', { name: 'Save summary settings', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('Summary settings changed');
  await expect(section.getByLabel(/^Model/)).toHaveValue('stale-draft');
  let writes = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/me/call-summaries') && r.method() === 'PUT') writes++;
  });
  await section.getByRole('button', { name: 'Reload summary settings (discard edits)', exact: true }).click();
  await expect(section.getByLabel(/^Model/)).toHaveValue('other-tab');
  await expect(section.getByRole('button', { name: 'Save summary settings', exact: true })).toBeDisabled();
  expect(writes).toBe(0);
});

test('acknowledged summary save needs no follow-up read and admits only one pending write', async ({
  page,
}) => {
  const section = page.getByLabel('Conversation summaries', { exact: true });
  await section.getByLabel('Summary connection').selectOption('workspace');
  let writes = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/me/call-summaries', async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ status: 503, json: { error: 'Read unavailable' } });
    writes++;
    await held;
    await route.continue();
  });
  const save = section.getByRole('button', { name: 'Save summary settings', exact: true });
  try {
    await save.click();
    await expect(save).toBeDisabled();
    await expect.poll(() => writes).toBe(1);
    release();
    await expect(section.getByRole('status')).toContainText('Summary settings saved.');
    await expect(save).toBeDisabled();
    expect(writes).toBe(1);
  } finally {
    release();
  }
});

test('one navigation guard protects summary and provider drafts independently across saves', async ({
  page,
}) => {
  const summary = page.getByLabel('Conversation summaries', { exact: true });
  await summary.getByLabel('Summary connection').selectOption('workspace');
  async function cancelNavigation() {
    page.once('dialog', (d) => d.dismiss());
    await page.getByRole('button', { name: 'Messages', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your connections' })).toBeVisible();
  }
  await cancelNavigation();
  await page.getByLabel('Workspace text model', { exact: true }).fill('unsaved-provider-model');
  await summary.getByRole('button', { name: 'Save summary settings', exact: true }).click();
  await expect(summary.getByRole('status')).toContainText('Summary settings saved.');
  await cancelNavigation();
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByText('Connections saved.', { exact: false })).toBeVisible();
  let unexpectedDialogs = 0;
  page.on('dialog', async (d) => {
    unexpectedDialogs++;
    await d.dismiss();
  });
  await page.getByRole('button', { name: 'Messages', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Messages & conversations' })).toBeVisible();
  expect(unexpectedDialogs).toBe(0);
});
