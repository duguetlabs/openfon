import { test, expect, openSettingsSections } from './fixtures';
import { openAuth, signup, createWorkspace, connections } from './cleanroom-helpers';

for (const mode of ['signup', 'login'] as const) {
  test(`confirmed ${mode} retries session reads without repeating authentication`, async ({ page }) => {
    const email = `auth-confirm-${mode}-${Date.now()}@example.invalid`,
      password = 'Synthetic-Confirmation-Password-1234';
    if (mode === 'login') {
      expect((await page.request.post('/api/auth/signup', { data: { email, password } })).ok()).toBe(true);
      await page.request.post('/api/auth/logout');
    }
    await openAuth(page, mode);
    let mutations = 0,
      failRead = false;
    await page.route(
      (url) => url.pathname === `/api/auth/${mode}` || url.pathname === '/api/me/bootstrap',
      async (route) => {
        if (route.request().method() === 'POST') {
          mutations++;
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          failRead = true;
          return route.fulfill({ response });
        }
        if (failRead) {
          failRead = false;
          return route.fulfill({ status: 503, json: { error: 'Synthetic session refresh failure' } });
        }
        return route.continue();
      },
    );
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel(/^Password/).fill(password);
    await page
      .getByRole('button', { name: mode === 'signup' ? 'Create account' : 'Open your desk', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText('Synthetic session refresh failure');
    await expect(page.getByLabel(/^Password/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByLabel('Business name', { exact: true })).toBeVisible();
    expect(mutations).toBe(1);
  });
}

for (const action of ['Use setup', 'Delete setup'] as const) {
  test(`confirmed ${action} survives a display read failure without repeating its mutation`, async ({
    page,
  }) => {
    await signup(page, 'setup-confirm');
    await createWorkspace(page, 'Setup confirmation');
    expect(
      (
        await page.request.post('/api/me/engine-presets', {
          data: { name: 'French pipeline', engine: 'pipeline', language: 'fr' },
        })
      ).ok(),
    ).toBe(true);
    await connections(page);
    await openSettingsSections(page);
    await page.getByLabel('Summary connection').selectOption('workspace');
    await page
      .getByLabel('Conversation summaries', { exact: true })
      .getByLabel(/^Model/)
      .fill('Independent summary draft');
    let mutations = 0,
      fail = false;
    await page.route('**/api/me/engine-presets**', async (route) => {
      if (route.request().method() !== 'GET') {
        mutations++;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        fail = true;
        return route.fulfill({ response });
      }
      if (fail) return route.fulfill({ status: 503, json: { error: 'Synthetic setup display failure' } });
      return route.continue();
    });
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic setup display failure');
    await expect(page.getByRole('button', { name: 'Retry setup refresh', exact: true })).toHaveCount(1);
    expect(mutations).toBe(1);
    if (action === 'Delete setup')
      await expect(page.getByRole('button', { name: 'Delete setup', exact: true })).toHaveCount(0);
    else await expect(page.getByRole('button', { name: 'Use setup', exact: true })).toBeDisabled();
    fail = false;
    await page.getByRole('button', { name: 'Retry setup refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry setup refresh', exact: true })).toHaveCount(0);
    expect(mutations).toBe(1);
    await expect(page.getByLabel('Conversation summaries', { exact: true }).getByLabel(/^Model/)).toHaveValue(
      'Independent summary draft',
    );
    const presets = await (await page.request.get('/api/me/engine-presets')).json();
    expect(presets).toHaveLength(action === 'Use setup' ? 1 : 0);
    if (action === 'Use setup') {
      const boot = await (await page.request.get('/api/me/bootstrap')).json();
      expect(
        (await (await page.request.get(`/api/me/assistants/${boot.assistants[0].id}`)).json()).language,
      ).toBe('fr');
    }
  });
}

for (const failAgain of [false, true]) {
  test(`setup recovery serializes competing settings writes and retains newer connection draft (retry failure=${failAgain})`, async ({
    page,
  }) => {
    await signup(page, 'setup-read-order');
    await createWorkspace(page);
    await page.request.post('/api/me/engine-presets', {
      data: { name: 'French pipeline', engine: 'pipeline', language: 'fr' },
    });
    await connections(page);
    await openSettingsSections(page);
    let phase: 'fail' | 'hold' | 'ready' = 'fail',
      held: import('@playwright/test').Route | undefined;
    let writes = 0;
    await page.route('**/api/me/engine-presets', (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      if (phase === 'fail')
        return route.fulfill({ status: 503, json: { error: 'Initial setup list failure' } });
      if (phase === 'hold') {
        held = route;
        return;
      }
      return route.continue();
    });
    await page.getByRole('button', { name: 'Use setup', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry setup refresh', exact: true })).toBeVisible();
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().endsWith('/api/me/provider')) writes++;
    });
    phase = 'hold';
    try {
      await page.getByRole('button', { name: 'Retry setup refresh', exact: true }).click();
      await expect.poll(() => !!held).toBe(true);
      await page.getByLabel('Workspace text model', { exact: true }).fill('Newer connection draft');
      await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
      expect(writes).toBe(0);
      const route = held!;
      held = undefined;
      phase = 'ready';
      if (failAgain) await route.fulfill({ status: 503, json: { error: 'Held list failure' } });
      else await route.continue();
      await expect(page.getByLabel('Workspace text model', { exact: true })).toHaveValue(
        'Newer connection draft',
      );
      if (failAgain) {
        await expect(page.getByRole('alert')).toContainText('Held list failure');
        await expect(page.getByRole('button', { name: 'Use setup', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: 'Retry setup refresh', exact: true }).click();
      }
      await expect(page.getByRole('button', { name: 'Retry setup refresh', exact: true })).toHaveCount(0);
      expect(writes).toBe(0);
      await expect(page.getByLabel('Workspace text model', { exact: true })).toHaveValue(
        'Newer connection draft',
      );
    } finally {
      if (held) await held.abort();
    }
  });
}
