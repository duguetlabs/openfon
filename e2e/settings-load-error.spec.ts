import { signup, createWorkspace, connections, workspaceMenu } from './cleanroom-helpers';
import { test, expect, openSettingsSections } from './fixtures';
import type { Page } from '@playwright/test';
const save = (page: Page) => page.getByRole('button', { name: 'Save connections', exact: true });
const retry = (page: Page) => page.getByRole('button', { name: 'Retry connections refresh', exact: true });
async function setup(page: Page, label: string, preset = false) {
  await signup(page, `load-${label}`);
  const context = await createWorkspace(page, 'Load workshop');
  let profileId = '';
  if (preset) {
    const response = await page.request.post('/api/me/engine-presets', {
      data: { name: 'Retained setup', engine: 'pipeline', language: 'fr', voice: '', llm_model: '' },
    });
    expect(response.status()).toBe(201);
    profileId = (await response.json()).id;
  }
  await connections(page);
  await openSettingsSections(page);
  return { ...context, profileId };
}
function latch() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { release, gate };
}

test('failed initial connection load retries reads without overwriting independently saved business data', async ({
  page,
}) => {
  await signup(page, 'load-initial');
  await createWorkspace(page, 'Load baseline');
  let fail = true,
    reads = 0,
    writes = 0;
  await page.route('**/api/me/provider', async (route) => {
    if (route.request().method() === 'GET') {
      reads++;
      if (fail) return route.fulfill({ status: 503, json: { error: 'Provider temporarily unavailable' } });
    } else writes++;
    return route.continue();
  });
  await workspaceMenu(page, 'Connections & portability');
  await expect(page.getByRole('alert')).toContainText('Provider temporarily unavailable');
  await expect(retry(page)).toBeEnabled();
  fail = false;
  await retry(page).click();
  await expect(save(page)).toBeDisabled();
  await expect(retry(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(reads).toBe(2);
  expect(writes).toBe(0);
  expect((await (await page.request.get('/api/me/business')).json()).name).toBe('Load baseline');
});

for (const late of ['success', 'failure'] as const)
  test(`unmounted ${late} connection read cannot overwrite a newer screen`, async ({ page }) => {
    await setup(page, `stale-${late}`);
    await workspaceMenu(page, 'Messages & conversations');
    const hold = latch();
    let captured = false,
      delivered = false,
      reads = 0;
    await page.route('**/api/me/provider', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      reads++;
      if (reads !== 1) return route.continue();
      const response = await route.fetch();
      captured = true;
      await hold.gate;
      if (late === 'success') await route.fulfill({ response });
      else await route.fulfill({ status: 503, json: { error: 'Obsolete read error' } });
      delivered = true;
    });
    try {
      await workspaceMenu(page, 'Connections & portability');
      await expect.poll(() => captured).toBe(true);
      await workspaceMenu(page, 'Messages & conversations');
      expect(
        (await page.request.put('/api/me/provider', { data: { model: 'new-current-model' } })).ok(),
      ).toBe(true);
      await connections(page);
      await expect(page.getByLabel('Workspace text model', { exact: true })).toHaveValue('new-current-model');
      await page.getByLabel('Workspace text model', { exact: true }).fill('newer-unsaved-model');
      hold.release();
      await expect.poll(() => delivered).toBe(true);
      await expect(page.getByLabel('Workspace text model', { exact: true })).toHaveValue(
        'newer-unsaved-model',
      );
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(reads).toBe(2);
    } finally {
      hold.release();
    }
  });

for (const mutation of ['create', 'rename'] as const)
  test(`connection refresh serializes ${mutation} and retains its later refusal`, async ({ page }) => {
    await setup(page, mutation, mutation === 'rename');
    const hold = latch();
    let captured = false,
      writes = 0;
    await page.route('**/api/me/provider', async (route) => {
      if (route.request().method() === 'GET') {
        const response = await route.fetch();
        captured = true;
        await hold.gate;
        return route.fulfill({ response });
      }
      return route.continue();
    });
    try {
      await page.getByLabel('Workspace text model', { exact: true }).fill('confirmed-before-setup');
      await save(page).click();
      await expect.poll(() => captured).toBe(true);
      if (mutation === 'create') {
        await page.getByLabel('Name a reusable setup', { exact: true }).fill('Retained create draft');
        await expect(
          page.getByRole('button', { name: 'Save current voice setup', exact: true }),
        ).toBeDisabled();
      } else await expect(page.getByLabel('Setup name', { exact: true })).toHaveAttribute('readonly', '');
      hold.release();
      await expect(page.getByText(/^Connections saved/)).toBeVisible();
      await page.route('**/api/me/engine-presets{,/*}', (route) => route.continue());
      await page.route(
        (url) => url.pathname.startsWith('/api/me/engine-presets'),
        async (route) => {
          if (route.request().method() === (mutation === 'create' ? 'POST' : 'PUT')) {
            writes++;
            return route.fulfill({ status: 503, json: { error: 'Same ownership message' } });
          }
          return route.continue();
        },
      );
      if (mutation === 'create')
        await page.getByRole('button', { name: 'Save current voice setup', exact: true }).click();
      else {
        await page.getByLabel('Setup name', { exact: true }).fill('Refused rename');
        await page.getByRole('heading', { name: 'Your connections' }).click();
      }
      await expect(page.getByRole('alert')).toContainText('Same ownership message');
      await page.getByLabel('Workspace text model', { exact: true }).fill('Newer unsaved model');
      await expect(page.getByRole('alert')).toContainText('Same ownership message');
      if (mutation === 'create')
        await expect(page.getByLabel('Name a reusable setup', { exact: true })).toHaveValue(
          'Retained create draft',
        );
      else await expect(page.getByLabel('Setup name', { exact: true })).toHaveValue('Retained setup');
      expect(writes).toBe(1);
    } finally {
      hold.release();
    }
  });

for (const operation of ['apply', 'delete'] as const)
  test(`confirmed setup ${operation} has read-only recovery and blocks another write`, async ({ page }) => {
    const { assistant, profileId } = await setup(page, operation, true);
    let writes = 0,
      failRead = false;
    await page.route('**/api/me/**', async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path.startsWith(`/api/me/engine-presets/${profileId}`) && req.method() !== 'GET') {
        writes++;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        failRead = true;
        return route.fulfill({ response });
      }
      if (
        failRead &&
        req.method() === 'GET' &&
        path === (operation === 'apply' ? `/api/me/assistants/${assistant.id}` : '/api/me/engine-presets')
      )
        return route.fulfill({ status: 503, json: { error: 'Setup display unavailable' } });
      return route.continue();
    });
    await page
      .getByRole('button', { name: operation === 'apply' ? 'Use setup' : 'Delete setup', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText('The setup change was saved');
    await page.getByLabel('Workspace text model', { exact: true }).fill('Later unsaved model');
    await expect(save(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save current voice setup', exact: true })).toBeDisabled();
    expect(writes).toBe(1);
    failRead = false;
    await page.getByRole('button', { name: 'Retry setup refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry setup refresh', exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel('Workspace text model', { exact: true })).toHaveValue('Later unsaved model');
    expect(writes).toBe(1);
    if (operation === 'apply')
      expect((await (await page.request.get(`/api/me/assistants/${assistant.id}`)).json()).language).toBe(
        'fr',
      );
    else
      expect(
        (await (await page.request.get('/api/me/engine-presets')).json()).some(
          (row: { id: string }) => row.id === profileId,
        ),
      ).toBe(false);
  });

test('repeated failed reads retain acknowledged provider baseline and do not resend the saved key', async ({
  page,
}) => {
  await setup(page, 'read-only');
  let writes = 0,
    failRead = true;
  await page.route('**/api/me/provider', async (route) => {
    if (route.request().method() === 'PUT') writes++;
    else if (failRead) return route.fulfill({ status: 503, json: { error: 'Display unavailable' } });
    return route.continue();
  });
  await page.getByLabel('Workspace text model', { exact: true }).fill('confirmed-model');
  await page.getByLabel(/^Text API key/).fill('synthetic-key');
  await save(page).click();
  await expect(page.getByRole('alert')).toContainText('Provider connections were saved');
  await expect(page.getByLabel(/^Text API key/)).toHaveValue('');
  await retry(page).click();
  await expect(page.getByRole('alert')).toContainText('Display unavailable');
  expect(writes).toBe(1);
  await page.getByLabel('Workspace text model', { exact: true }).fill('new-unsaved-model');
  failRead = false;
  await retry(page).click();
  await expect(retry(page)).toHaveCount(0);
  await expect(page.getByLabel('Workspace text model', { exact: true })).toHaveValue('new-unsaved-model');
  expect(writes).toBe(1);
  expect((await (await page.request.get('/api/me/provider')).json()).model).toBe('confirmed-model');
});
