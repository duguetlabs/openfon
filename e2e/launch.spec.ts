import {
  signup as register,
  createWorkspace,
  connections,
  workspaceMenu,
  whoAnswers,
} from './cleanroom-helpers';
import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';

async function signup(page: Page) {
  await register(page, 'launch', 'Local-Test-Password-Only-1234');
  const context = await createWorkspace(page, 'Workshop browser test');
  expect(
    (
      await page.request.put(`/api/me/assistants/${context.assistant.id}`, {
        data: {
          name: 'Alex',
          persona: 'Warm and clear',
          greeting: 'Hello from the bicycle workshop.',
          engine: 'pipeline',
        },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeVisible();
  return context;
}
async function knowledge(page: Page) {
  await page.getByRole('button', { name: /What they know/ }).click();
  await page.locator('summary').filter({ hasText: 'Manage collections' }).click();
}
const collectionPicker = (page: Page) =>
  page.getByRole('combobox', { name: 'Information collection', exact: true });
async function dismiss(page: Page, action: () => Promise<unknown>) {
  const pending = page.waitForEvent('dialog');
  const changing = action().catch(() => undefined);
  await (await pending).dismiss();
  await changing;
}
async function selectCommittedReceptionist(page: Page, id: string, primary = false) {
  const picker = page.getByLabel('Receptionist', { exact: true });
  await picker.selectOption(id);
  // Selection is asynchronous. The URL changes only after the target snapshot
  // commits; opening another screen during the loader cancels that selection.
  await expect(page).toHaveURL(url => url.pathname === '/overview' &&
    url.searchParams.get('assistant') === (primary ? null : id));
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveValue(id);
}

test('public story examples, navigation and mobile layout remain usable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A warm welcome.');
  await page.getByRole('link', { name: 'How it works', exact: true }).click();
  await page.getByRole('button', { name: 'See how it answers' }).click();
  await expect(page.getByRole('heading', { name: 'Your details. A helpful answer.' })).toBeVisible();
  await expect(page.getByText('Illustrative example', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('landing-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('landing-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open your desk', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('new workspace remains private, protected receptionist edits persist, and pause survives reload', async ({
  page,
}) => {
  const { assistant } = await signup(page);
  expect((await (await page.request.get(`/api/me/assistants/${assistant.id}`)).json()).state).toBe('draft');
  await whoAnswers(page);
  await page.getByLabel('Their first words').fill('Hello from the workshop test.');
  await expect(page.getByRole('button', { name: 'Enable web calls' })).toBeDisabled();
  for (const action of [
    () => page.getByRole('button', { name: 'Messages', exact: true }).click(),
    () => page.getByRole('button', { name: 'Business details', exact: true }).click(),
    () => page.reload({ timeout: 1500 }),
    () => workspaceMenu(page, 'Sign out'),
  ]) {
    await dismiss(page, action);
    await expect(page.getByLabel('Their first words')).toHaveValue('Hello from the workshop test.');
  }
  expect((await page.request.get('/api/me')).status()).toBe(200);
  if (await page.getByRole('button', { name: 'Close menu', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Close menu', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Saved. Your next conversation will use this brief.')).toBeVisible();
  await page.getByLabel('Their first words').fill('This edit should be discarded.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Messages', exact: true }).click();
  await page.getByRole('button', { name: 'Back to your desk', exact: true }).click();
  await whoAnswers(page);
  await expect(page.getByLabel('Their first words')).toHaveValue('Hello from the workshop test.');
  await page.getByRole('button', { name: 'Enable web calls', exact: true }).click();
  await page.getByRole('button', { name: 'Pause web calls', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Enable web calls', exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/me/assistants/${assistant.id}`)).json()).state).toBe('paused');
});

test('knowledge drafts, approval, attachment and navigation guards survive reload', async ({ page }) => {
  const { assistant } = await signup(page);
  await knowledge(page);
  await page.getByLabel('New collection', { exact: true }).fill('Workshop services');
  await page.getByRole('button', { name: 'Create collection', exact: true }).click();
  await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue('Workshop services');
  const chosen = await collectionPicker(page).inputValue();
  await page.getByLabel(/^Collection description/).fill('Unsaved collection description');
  for (const action of [
    () => page.getByRole('button', { name: 'Messages', exact: true }).click(),
    () => collectionPicker(page).selectOption({ index: 0 }),
    () => page.reload({ timeout: 1500 }),
  ]) {
    await dismiss(page, action);
    await expect(page.getByLabel(/^Collection description/)).toHaveValue('Unsaved collection description');
  }
  await page.getByRole('button', { name: 'Save collection details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save collection details', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Add business information', exact: true }).click();
  await page.getByLabel('What might a customer ask?').fill('Do you fix punctures?');
  await page.getByLabel(/^The answer/).fill('Yes. Bring your bicycle during opening hours.');
  await page.getByLabel('Use this answer in conversations').uncheck();
  for (const action of [
    () => page.getByRole('button', { name: 'Messages', exact: true }).click(),
    () => collectionPicker(page).selectOption({ index: 0 }),
    () => page.reload({ timeout: 1500 }),
  ]) {
    await dismiss(page, action);
    await expect(page.getByLabel('What might a customer ask?')).toHaveValue('Do you fix punctures?');
  }
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  const row = page.getByRole('button', { name: /Do you fix punctures/ });
  await expect(row).toContainText('Draft');
  await row.click();
  await page.getByLabel('Use this answer in conversations').check();
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(row).toContainText('Active');
  await expect(page.getByRole('button', { name: 'Remove from receptionist', exact: true })).toBeVisible();
  await page.reload();
  await knowledge(page);
  await collectionPicker(page).selectOption(chosen);
  await expect(row).toContainText('Active');
  const stored = await (await page.request.get(`/api/me/knowledge/collections/${chosen}`)).json();
  expect(stored.description).toBe('Unsaved collection description');
  expect(stored.items[0]).toMatchObject({ question: 'Do you fix punctures?', status: 'active' });
  expect(
    (await (await page.request.get(`/api/me/assistants/${assistant.id}`)).json()).collectionIds,
  ).toContain(chosen);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const [path, title] of [
    ['/conversations', 'Messages & conversations'],
    ['/connections', 'Your connections'],
    ['/account', 'Your account'],
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
});

test('account can change password, export data without credentials, and delete', async ({
  page,
  request,
}) => {
  await signup(page);
  const copiedSession = (await page.context().cookies()).find((cookie) => cookie.name === 'ofs')!.value;
  await page.goto('/account');
  await page.getByLabel('Current password', { exact: true }).fill('Local-Test-Password-Only-1234');
  await page.getByLabel(/^New password/).fill('Changed-Local-Test-Password-1234');
  await page.getByLabel('Repeat new password', { exact: true }).fill('Changed-Local-Test-Password-1234');
  await page.getByRole('button', { name: 'Update password', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Password updated' })).toBeVisible();
  const replacement = (await page.context().cookies()).find((cookie) => cookie.name === 'ofs')!;
  expect(replacement.value).not.toBe(copiedSession);
  expect(replacement.httpOnly).toBe(true);
  expect(replacement.secure).toBe(true);
  expect((await request.get('/api/me', { headers: { Cookie: `ofs=${copiedSession}` } })).status()).toBe(401);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download data', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const exported = Buffer.concat(chunks).toString('utf8');
  expect(JSON.parse(exported).data.assistants[0].name).toBe('Alex');
  expect(exported).not.toMatch(/password_hash|llm_api_key|session.*token/);
  await page.getByLabel('Current password to confirm deletion').fill('Changed-Local-Test-Password-1234');
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Permanently delete account', exact: true }).click();
  await expect(page).toHaveURL('/login');
  expect((await page.request.get('/api/me')).status()).toBe(401);
});

test('private test call traverses Worker websocket and persists transcript and summary', async ({ page }) => {
  await signup(page);
  const result = await page.evaluate(async () => {
    const bootstrap = await (await fetch('/api/me/bootstrap')).json();
    const assistantId = bootstrap.assistants[0].id;
    const saved = await fetch(`/api/me/assistants/${assistantId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: 'pipeline' }),
    });
    if (!saved.ok) throw new Error(`Assistant update failed: ${saved.status}`);
    const reserved = await fetch(`/api/me/assistants/${assistantId}/test-calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!reserved.ok) throw new Error(`Call reservation failed: ${reserved.status}`);
    const { callId } = await reserved.json();
    const events = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws/call/${callId}`);
      const seen: Record<string, unknown>[] = [];
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Call timeout'));
      }, 15000);
      socket.onopen = () => socket.send(JSON.stringify({ type: 'start' }));
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Socket failed'));
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        seen.push(message);
        if (message.type === 'error') {
          clearTimeout(timer);
          socket.close();
          reject(new Error(String(message.message)));
        }
        if (message.type === 'ready')
          socket.send(JSON.stringify({ type: 'text', text: 'Do you repair bicycles?' }));
        if (message.type === 'agent_text') socket.send(JSON.stringify({ type: 'hangup' }));
        if (message.type === 'ended') {
          clearTimeout(timer);
          socket.close();
          resolve(seen);
        }
      };
    });
    return { callId, events };
  });
  expect(result.events).toContainEqual(
    expect.objectContaining({ type: 'agent_text', text: 'Yes, we repair bicycles during opening hours.' }),
  );
  await expect
    .poll(async () => (await (await page.request.get(`/api/me/calls/${result.callId}`)).json()).status)
    .toBe('completed');
  const call = await (await page.request.get(`/api/me/calls/${result.callId}`)).json();
  expect(call.environment).toBe('test');
  expect(call.summary).toBe('Caller asked about bicycle repairs.');
  expect(call.turns).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'caller', text: 'Do you repair bicycles?' }),
      expect.objectContaining({ role: 'agent', text: 'Yes, we repair bicycles during opening hours.' }),
    ]),
  );
  let detailReads = 0;
  await page.route(`**/api/me/calls/${result.callId}`, async (route) => {
    detailReads++;
    if (detailReads === 1)
      await route.fulfill({ json: { ...call, status: 'active', summary: null, turns: [] } });
    else await route.continue();
  });
  await page.goto(`/calls/${result.callId}`);
  await expect(page.getByText('active', { exact: true })).toBeVisible();
  await expect(page.getByText('Do you repair bicycles?', { exact: true })).toBeVisible();
  await expect(page.getByText('Caller asked about bicycle repairs.', { exact: true })).toBeVisible();
  expect(detailReads).toBeGreaterThan(1);
});

test('pending real test reservations are cancelled on end and navigation', async ({ page }) => {
  await signup(page);
  for (const leave of ['end', 'navigate'] as const) {
    await page.goto('/overview');
    let held: Route | undefined;
    let response: import('@playwright/test').APIResponse | undefined;
    let reservedId = '';
    await page.route('**/api/me/assistants/*/test-calls', async (route) => {
      response = await route.fetch();
      expect(response.status()).toBe(201);
      reservedId = (await response.json()).callId;
      held = route;
    });
    try {
      await page.getByRole('button', { name: 'Start browser conversation', exact: true }).click();
      await expect.poll(() => reservedId).not.toBe('');
      if (leave === 'end') {
        await page.getByRole('button', { name: 'End conversation', exact: true }).click();
        await expect(
          page.getByRole('button', { name: 'Start browser conversation', exact: true }),
        ).toBeVisible();
      } else await page.getByRole('button', { name: 'Messages', exact: true }).click();
      const route = held!;
      held = undefined;
      await route.fulfill({
        response: response!,
      });
      await expect
        .poll(async () => (await page.request.get(`/api/me/calls/${reservedId}`)).status())
        .toBe(404);
      expect((await (await page.request.get('/api/me/calls?environment=test')).json()).items).toHaveLength(0);
    } finally {
      if (held) await held.abort();
      await page.unroute('**/api/me/assistants/*/test-calls');
    }
  }
});

test('missing requested receptionist requires explicit replacement and retries its original target', async ({
  page,
}) => {
  const { assistant } = await signup(page);
  const created = await page.request.post('/api/me/assistants', { data: { name: 'Deleted selection' } });
  expect(created.status()).toBe(201);
  const deleted = await created.json();
  expect((await page.request.delete(`/api/me/assistants/${deleted.id}`)).ok()).toBe(true);
  await page.goto(`/overview?assistant=${deleted.id}`);
  await expect(page.getByRole('heading', { name: 'Receptionist unavailable' })).toBeVisible();
  const selector = page.getByLabel('Choose a replacement receptionist');
  await expect(selector).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Use selected receptionist' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry requested receptionist' }).click();
  await expect(page.getByRole('button', { name: 'Retry requested receptionist' })).toBeEnabled();
  await expect(selector).toHaveValue('');
  await selector.selectOption(assistant.id);
  await page.getByRole('button', { name: 'Use selected receptionist' }).click();
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeEnabled();
  await expect(page.getByLabel('Receptionist', { exact: true })).toHaveValue(assistant.id);
  await expect(page).not.toHaveURL(new RegExp(deleted.id));
  let fail = true;
  await page.route(`**/api/me/assistants/${assistant.id}`, (route) => {
    if (fail) {
      fail = false;
      return route.fulfill({ status: 503, json: { error: 'Temporary requested receptionist failure' } });
    }
    return route.continue();
  });
  await page.goto(`/overview?assistant=${assistant.id}`);
  await expect(page.getByRole('alert')).toContainText('Temporary requested receptionist failure');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeEnabled();
});

test('knowledge assistant-refresh recovery preserves a later answer draft', async ({ page }) => {
  const { assistant } = await signup(page);
  await knowledge(page);
  let fail = true;
  await page.route(`**/api/me/assistants/${assistant.id}`, (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: 'Temporary receptionist refresh failure' } })
      : route.continue(),
  );
  await page.getByRole('button', { name: 'Remove from receptionist', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Temporary receptionist refresh failure');
  await page.getByRole('button', { name: 'Add business information', exact: true }).click();
  await page.getByLabel('What might a customer ask?').fill('Unsaved question');
  await page.getByLabel(/^The answer/).fill('Unsaved answer');
  fail = false;
  await page.getByRole('button', { name: 'Retry knowledge refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry knowledge refresh', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('What might a customer ask?')).toHaveValue('Unsaved question');
  await expect(page.getByLabel(/^The answer/)).toHaveValue('Unsaved answer');
});

test('business settings save independently of an active receptionist', async ({ page }) => {
  const { assistant } = await signup(page);
  expect((await page.request.post(`/api/me/assistants/${assistant.id}/activate`, { data: {} })).ok()).toBe(
    true,
  );
  const before = await (await page.request.get(`/api/me/assistants/${assistant.id}`)).json();
  let writes = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === `/api/me/assistants/${assistant.id}`
    )
      writes++;
  });
  await page.getByRole('button', { name: 'Business details', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Updated business facts');
  await expect(page.getByLabel('Receptionist name', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  await expect(page).toHaveURL('/overview');
  expect((await (await page.request.get('/api/me/business')).json()).name).toBe('Updated business facts');
  expect(await (await page.request.get(`/api/me/assistants/${assistant.id}`)).json()).toEqual(before);
  expect(writes).toBe(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('late conversation searches cannot replace newer results or the current search draft', async ({
  page,
}) => {
  await signup(page);
  await page.goto('/conversations');
  let held: Route | undefined;
  const requests: string[] = [];
  let holdFirst = true;
  await page.route('**/api/me/calls?**', (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    if (url.searchParams.get('search') === 'first' && holdFirst) {
      holdFirst = false;
      held = route;
      return;
    }
    return route.fulfill({
      json: {
        items: [
          {
            id: 'current-result',
            status: 'completed',
            environment: 'live',
            started_at: '2026-09-13T00:00:00Z',
            summary: 'Current second result',
          },
        ],
        nextCursor: null,
      },
    });
  });
  try {
    await page.getByLabel('Search conversations').fill('first');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect.poll(() => !!held).toBe(true);
    await page.getByLabel('Search conversations').fill('second');
    await page.getByRole('combobox', { name: 'Conversation type' }).selectOption('live');
    await expect(page.getByText('Current second result', { exact: true })).toBeVisible();
    const route = held!;
    held = undefined;
    await route.fulfill({
      json: {
        items: [
          {
            id: 'obsolete',
            status: 'completed',
            environment: 'live',
            started_at: '2026-09-13T00:00:00Z',
            summary: 'Obsolete first result',
          },
        ],
        nextCursor: null,
      },
    });
    await expect(page.getByText('Obsolete first result', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Search conversations')).toHaveValue('second');
    expect(
      requests.some((query) => query.includes('search=second') && query.includes('environment=live')),
    ).toBe(true);
    await expect(page).toHaveURL(/search=second.*environment=live/);
    await page.goBack();
    await expect(page.getByLabel('Search conversations')).toHaveValue('first');
    await expect(page.getByRole('combobox', { name: 'Conversation type' })).toHaveValue('all');
    await page.goForward();
    await expect(page.getByLabel('Search conversations')).toHaveValue('second');
    await expect(page.getByRole('combobox', { name: 'Conversation type' })).toHaveValue('live');
    await page.reload();
    await expect(page.getByLabel('Search conversations')).toHaveValue('second');
    await expect(page.getByRole('combobox', { name: 'Conversation type' })).toHaveValue('live');
    await page.route('**/api/me/calls/current-result', (route) =>
      route.fulfill({
        json: {
          id: 'current-result',
          status: 'completed',
          environment: 'live',
          channel: 'web',
          started_at: '2026-09-13T00:00:00Z',
          summary: 'Current second result',
          turns: [],
        },
      }),
    );
    await page.getByRole('button', { name: /Current second result/ }).click();
    await expect(page.getByRole('heading', { name: 'The conversation', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/call=current-result/);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Messages & conversations', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/call=/);
    await page.goForward();
    await expect(page.getByRole('heading', { name: 'The conversation', exact: true })).toBeVisible();
    await expect(page.getByText('Current second result', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All conversations', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Messages & conversations', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/call=/);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Messages & conversations', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/call=/);
  } finally {
    if (held) await held.abort();
  }
});

test('call detail stops permanent errors and bounds transient retries with manual recovery', async ({
  page,
}) => {
  await signup(page);
  await page.clock.install();
  let count = 0;
  let status = 404;
  await page.route('**/api/me/calls/missing-call', async (route) => {
    count++;
    await route.fulfill({ status, json: { error: `Unavailable call ${count}` } });
  });
  await page.goto('/calls/missing-call');
  await expect(page.getByRole('alert')).toContainText('Unavailable call');
  await page.clock.runFor(10000);
  expect(count).toBe(1);
  status = 503;
  await page.getByRole('button', { name: 'Retry call' }).click();
  await expect.poll(() => count).toBe(2);
  await expect(page.getByRole('alert')).toContainText('Unavailable call 2');
  await page.clock.runFor(3001);
  await expect.poll(() => count).toBe(3);
  await expect(page.getByRole('alert')).toContainText('Unavailable call 3');
  await page.clock.runFor(3001);
  await expect.poll(() => count).toBe(4);
  await expect(page.getByRole('alert')).toContainText('Unavailable call 4');
  await page.clock.runFor(10000);
  expect(count).toBe(4);
  status = 404;
  await page.getByRole('button', { name: 'Retry call' }).click();
  await expect.poll(() => count).toBe(5);
  await expect(page.getByRole('alert')).toContainText('Unavailable call 5');
  await page.clock.runFor(10000);
  expect(count).toBe(5);
});

test('primary receptionists never offer deletion while a secondary draft remains deletable', async ({ page }) => {
  const { assistant } = await signup(page);
  const bootstrap = await (await page.request.get('/api/me/bootstrap')).json();
  const primary = await (await page.request.get(`/api/me/assistants/${assistant.id}`)).json();
  expect(primary).toMatchObject({
    business_id: bootstrap.workspace.id, public_slug: bootstrap.workspace.slug, state: 'draft'
  });
  const remove = page.getByRole('button', { name: 'Delete receptionist', exact: true });
  await expect(remove).toHaveCount(0);
  await page.getByRole('button', { name: 'Enable web calls', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause web calls', exact: true })).toBeEnabled();
  await expect(remove).toHaveCount(0);
  await page.getByRole('button', { name: 'Pause web calls', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable web calls', exact: true })).toBeEnabled();
  await expect(remove).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Enable web calls', exact: true })).toBeEnabled();
  await expect(remove).toHaveCount(0);
  expect((await (await page.request.get(`/api/me/assistants/${assistant.id}`)).json()).state).toBe('paused');
  const created = await page.request.post('/api/me/assistants', { data: {
    name: 'Secondary draft', language: 'en', persona: 'Warm and clear',
    greeting: 'Hello from the secondary receptionist.', engine: 'pipeline'
  } });
  expect(created.status()).toBe(201);
  const secondary = await created.json();
  expect(secondary.state).toBe('draft');
  expect(secondary.public_slug).not.toBe(primary.public_slug);
  await page.goto(`/overview?assistant=${secondary.id}`);
  await whoAnswers(page);
  await expect(page.getByLabel('Receptionist name', { exact: true })).toHaveValue('Secondary draft');
  await expect(remove).toBeEnabled();
  await page.getByLabel('Receptionist', { exact: true }).selectOption(primary.id);
  await whoAnswers(page);
  await expect(page.getByLabel('Receptionist name', { exact: true })).toHaveValue('Alex');
  await expect(remove).toHaveCount(0);
});

test('historical receptionists are discoverable, deduplicated, selected correctly and safely deleted', async ({
  page,
}) => {
  const { assistant } = await signup(page);
  const created = await page.request.post('/api/me/assistants', {
    data: {
      name: 'Historical page two',
      language: 'de',
      persona: 'Warm and clear',
      greeting: 'Hello from the selected receptionist.',
      engine: 'pipeline',
    },
  });
  expect(created.status()).toBe(201);
  const target = await created.json();
  const bootstrap = await (await page.request.get('/api/me/bootstrap')).json();
  const primary = bootstrap.assistants.find((item: { id: string }) => item.id === assistant.id);
  const firstPage = [
    primary,
    ...Array.from({ length: 31 }, (_, i) => ({ ...primary, id: `historical-${i}`, name: `Historical ${i}` })),
  ];
  await page.route('**/api/me/bootstrap', (route) =>
    route.fulfill({ json: { ...bootstrap, assistants: firstPage } }),
  );
  let failPage = true;
  const offsets: string[] = [];
  await page.route(/\/api\/me\/assistants(?:\?.*)?$/, (route) => {
    const offset = new URL(route.request().url()).searchParams.get('offset') || '0';
    offsets.push(offset);
    if (offset === '0') return route.fulfill({ json: firstPage });
    if (failPage) {
      failPage = false;
      return route.fulfill({ status: 503, json: { error: 'Temporary pagination failure' } });
    }
    return route.fulfill({ json: [primary, target] });
  });
  await page.goto('/overview');
  await connections(page);
  await page.getByRole('button', { name: 'Back to your desk', exact: true }).click();
  const select = page.getByLabel('Receptionist', { exact: true });
  await expect(select.locator('option')).toHaveCount(32);
  await page.getByRole('button', { name: 'Find more receptionists', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Temporary pagination failure');
  await page.getByRole('button', { name: 'Find more receptionists', exact: true }).click();
  await expect(select.locator('option')).toHaveCount(33);
  await expect(select.locator(`option[value="${primary.id}"]`)).toHaveCount(1);
  await expect(select.locator(`option[value="${target.id}"]`)).toHaveCount(1);
  expect(offsets).toContain('32');
  await select.selectOption(target.id);
  await expect(select).toHaveValue(target.id);
  let requested = '';
  await page.route('**/api/me/assistants/*/test-calls', (route) => {
    requested = new URL(route.request().url()).pathname;
    return route.fulfill({ status: 409, json: { error: 'Synthetic admission probe; no call created' } });
  });
  await page.getByRole('button', { name: 'Start browser conversation', exact: true }).click();
  await expect(page.getByText('Synthetic admission probe; no call created', { exact: false })).toBeVisible();
  expect(requested).toBe(`/api/me/assistants/${target.id}/test-calls`);
  await connections(page);
  await expect(page).toHaveURL(new RegExp(`assistant=${target.id}`));
  await page.getByRole('button', { name: 'Back to your desk', exact: true }).click();
  await page.reload();
  await expect(select).toHaveValue(target.id);
  // Reset the current bootstrap to its first page, then traverse older entries.
  // History must fetch the requested owned target even when it is no longer cached.
  await select.selectOption(primary.id);
  await expect(select).toHaveValue(primary.id);
  await expect(select.locator(`option[value="${target.id}"]`)).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Your connections', exact: true })).toBeVisible();
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('de');
  await page.goBack();
  await expect(select).toHaveValue(target.id);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Your connections', exact: true })).toBeVisible();
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('en');
  await page.goForward();
  await expect(select).toHaveValue(target.id);
  await page.getByRole('button', { name: 'Enable web calls', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause web calls', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Delete receptionist', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Pause web calls', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete receptionist', exact: true })).toBeEnabled();
  let deletions = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'DELETE' &&
      new URL(request.url()).pathname === `/api/me/assistants/${target.id}`
    )
      deletions++;
  });
  await dismiss(page, () => page.getByRole('button', { name: 'Delete receptionist', exact: true }).click());
  expect(deletions).toBe(0);
  await expect(select).toHaveValue(target.id);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete receptionist', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Receptionist deleted', exact: true })).toBeVisible();
  expect(deletions).toBe(1);
  expect((await page.request.get(`/api/me/assistants/${target.id}`)).status()).toBe(404);
  await expect(page.getByLabel('Choose a replacement receptionist')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Use selected receptionist', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start browser conversation', exact: true })).toHaveCount(0);
  await page.getByLabel('Choose a replacement receptionist').selectOption(primary.id);
  await page.getByRole('button', { name: 'Use selected receptionist', exact: true }).click();
  await expect(select).toHaveValue(primary.id);
});

test('successful active-call polling preserves a rejected knowledge save until retry', async ({ page }) => {
  await signup(page);
  await page.clock.install();
  let reads = 0;
  let saves = 0;
  await page.route('**/api/me/calls/action-error-call', async (route) => {
    reads++;
    await route.fulfill({
      json: {
        id: 'action-error-call',
        status: 'active',
        channel: 'web',
        started_at: '2026-09-13T00:00:00Z',
        connected_at: '2026-09-13T00:00:00Z',
        duration_s: null,
        summary: null,
        intent: null,
        message_json: null,
        turns: [{ id: 1, role: 'caller', text: 'Do you repair bicycles?', ts: '2026-09-13T00:00:01Z' }],
      },
    });
  });
  await page.route('**/api/me/knowledge/drafts/from-turn', async (route) => {
    saves++;
    await route.fulfill(
      saves === 1
        ? { status: 429, json: { error: 'Knowledge allowance exhausted.' } }
        : { json: { id: 'saved-draft' } },
    );
  });
  await page.goto('/calls/action-error-call');
  await page.getByRole('button', { name: 'Save as a question to answer' }).click();
  await expect(page.getByRole('alert').first()).toHaveText('Knowledge allowance exhausted.');
  const before = reads;
  await page.clock.runFor(3001);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(page.getByRole('alert').first()).toHaveText('Knowledge allowance exhausted.');
  expect(saves).toBe(1);
  await page.getByRole('button', { name: 'Save as a question to answer' }).click();
  await expect(page.getByText('Saved as a draft question.', { exact: false })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(saves).toBe(2);
});

test('a queued search navigation cannot overwrite a newer typed draft', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeChannel = window.MessageChannel;
    const queued: Array<() => void> = [];
    let held = false;
    (window as any).holdReactTasks = () => {
      held = true;
    };
    (window as any).releaseReactTasks = () => {
      held = false;
      queued.splice(0).forEach((run) => run());
    };
    window.MessageChannel = class extends NativeChannel {
      constructor() {
        super();
        const post = this.port2.postMessage.bind(this.port2);
        this.port2.postMessage = (...args: any[]) => {
          const send = () => (post as any)(...args);
          if (held) queued.push(send);
          else send();
        };
      }
    };
  });
  await signup(page);
  await page.goto('/conversations');
  await page.getByLabel('Search conversations').fill('first');
  // Hold React's scheduled navigation commit while the next discrete input
  // arrives, reproducing the ordering observed in both failed CI traces.
  await page.evaluate(() => (window as any).holdReactTasks());
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search conversations').fill('second');
  const applied = page.waitForResponse(
    (r) => r.url().includes('/api/me/calls?') && r.url().includes('search=first'),
  );
  await page.evaluate(() => (window as any).releaseReactTasks());
  await applied;
  await expect(page.getByLabel('Search conversations')).toHaveValue('second');
  await page.getByRole('combobox', { name: 'Conversation type' }).selectOption('live');
  await expect(page).toHaveURL(/search=second.*environment=live/);
  await page.goBack();
  await expect(page.getByLabel('Search conversations')).toHaveValue('first');
  await page.goForward();
  await expect(page.getByLabel('Search conversations')).toHaveValue('second');
});

test('loading another conversation page uses the committed search while retaining an unsubmitted draft', async ({
  page,
}) => {
  await signup(page);
  const queries: URLSearchParams[] = [];
  await page.route('**/api/me/calls?**', (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const pageTwo = query.has('cursor');
    const submittedSecond = query.get('search') === 'second';
    const summary = submittedSecond
      ? 'Submitted second search'
      : pageTwo
        ? 'Second page of first search'
        : 'First page of first search';
    return route.fulfill({
      json: {
        items: [
          {
            id: summary,
            status: 'completed',
            environment: 'live',
            started_at: '2026-09-13T00:00:00Z',
            summary,
          },
        ],
        nextCursor: !pageTwo && !submittedSecond ? 'next-page-token' : null,
      },
    });
  });
  await page.goto('/conversations?search=first');
  await expect(page.getByText('First page of first search', { exact: true })).toBeVisible();
  await page.getByLabel('Search conversations').fill('second');
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.getByText('Second page of first search', { exact: true })).toBeVisible();
  await expect(page.getByText('First page of first search', { exact: true })).toBeVisible();
  const continuation = queries.find((query) => query.has('cursor'))!;
  expect(continuation.get('search')).toBe('first');
  expect(continuation.get('cursor')).toBe('next-page-token');
  await expect(page.getByLabel('Search conversations')).toHaveValue('second');
  await expect(page).toHaveURL(/search=first/);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('Submitted second search', { exact: true })).toBeVisible();
  await expect(page.getByText('First page of first search', { exact: true })).toHaveCount(0);
  expect(queries.at(-1)?.has('cursor')).toBe(false);
  await page.getByLabel('Search conversations').fill('all');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/search=all/);
  await expect.poll(() => queries.at(-1)?.get('search')).toBe('all');
});

test('historic receptionist and status conversation filters survive edits, history and reload', async ({
  page,
}) => {
  const { assistant } = await signup(page);
  const created = await page.request.post('/api/me/assistants', { data: { name: 'Filter target' } });
  expect(created.status()).toBe(201);
  const target = await created.json();
  const queries: URLSearchParams[] = [];
  await page.route('**/api/me/calls?**', (route) => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto(`/calls?assistantId=${target.id}&status=failed`);
  const receptionist = page.getByRole('combobox', { name: 'Receptionist filter', exact: true });
  const status = page.getByRole('combobox', { name: 'Call status', exact: true });
  await expect(receptionist).toHaveValue(target.id);
  await expect(status).toHaveValue('failed');
  await expect
    .poll(() =>
      queries.some((query) => query.get('assistantId') === target.id && query.get('status') === 'failed'),
    )
    .toBe(true);
  await status.selectOption('completed');
  await expect(page).toHaveURL(/status=completed/);
  await receptionist.selectOption(assistant.id);
  await expect.poll(() => queries.at(-1)?.get('assistantId')).toBe(assistant.id);
  expect(queries.at(-1)?.get('status')).toBe('completed');
  await page.goBack();
  await expect(receptionist).toHaveValue(target.id);
  await expect(status).toHaveValue('completed');
  await page.goBack();
  await expect(receptionist).toHaveValue(target.id);
  await expect(status).toHaveValue('failed');
  await page.goForward();
  await expect(status).toHaveValue('completed');
  await page.reload();
  await expect(receptionist).toHaveValue(target.id);
  await expect(status).toHaveValue('completed');
  await expect.poll(() => queries.at(-1)?.get('assistantId')).toBe(target.id);
  expect(queries.at(-1)?.get('status')).toBe('completed');
  await page.screenshot({
    path: '/tmp/openfon-brand-integration/conversation-filters-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: '/tmp/openfon-brand-integration/conversation-filters-mobile.png',
    fullPage: true,
  });
});

test('confirmed history navigation between receptionists resets the previous connection draft', async ({
  page,
}) => {
  const { assistant: primary } = await signup(page);
  const created = await page.request.post('/api/me/assistants', {
    data: {
      name: 'Other receptionist',
      persona: 'Warm and clear',
      greeting: 'Hello from the other receptionist.',
      engine: 'pipeline',
      language: 'fr',
    },
  });
  expect(created.status()).toBe(201);
  const other = await created.json();
  await page.reload();
  await selectCommittedReceptionist(page, other.id);
  await connections(page);
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('fr');
  await page.getByRole('button', { name: 'Back to your desk', exact: true }).click();
  await selectCommittedReceptionist(page, primary.id, true);
  await connections(page);
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('en');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && /\/api\/me\/assistants\//.test(request.url()))
      writes.push(new URL(request.url()).pathname);
  });
  await page.getByLabel('Language', { exact: true }).fill('de');
  let held: Route | undefined;
  let holdNext = true;
  await page.route(`**/api/me/assistants/${other.id}`, (route) => {
    if (route.request().method() === 'GET' && holdNext) {
      holdNext = false;
      held = route;
      return;
    }
    return route.continue();
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.evaluate(() => history.go(-2));
  await expect(page).toHaveURL(new RegExp(`assistant=${other.id}`));
  await expect.poll(() => !!held).toBe(true);
  await expect(page.getByRole('heading', { name: 'Your connections', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start browser conversation', exact: true })).toHaveCount(0);
  const response = held!;
  held = undefined;
  await response.fulfill({ status: 503, json: { error: 'Target temporarily unavailable' } });
  await expect(page.getByRole('alert').filter({ hasText: 'Target temporarily unavailable' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Receptionist unavailable', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start browser conversation', exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Retry requested receptionist', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your connections', exact: true })).toBeVisible();
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('fr');
  await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
  await page.getByLabel('Language', { exact: true }).fill('es');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByText('Connections saved.', { exact: false })).toBeVisible();
  expect(writes).toEqual([`/api/me/assistants/${other.id}`]);
  expect((await (await page.request.get(`/api/me/assistants/${primary.id}`)).json()).language).toBe('en');
  expect((await (await page.request.get(`/api/me/assistants/${other.id}`)).json()).language).toBe('es');
  await page.evaluate(() => history.go(2));
  await expect(page.getByRole('heading', { name: 'Your connections', exact: true })).toBeVisible();
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('en');
  await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toBeDisabled();
  expect(writes).toEqual([`/api/me/assistants/${other.id}`]);
});

for (const path of ['/call/%E0%A4', '/widget/%E0%A4']) {
  test(`malformed public link ${path} shows an unavailable state without a render crash`, async ({
    page,
  }) => {
    const errors: string[] = [];
    let privateReads = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/me')) privateReads++;
    });
    // The HTTP server escapes malformed percent bytes before serving the app.
    // Install the raw history URL before React mounts to exercise its decoder.
    await page.addInitScript((malformedPath) => history.replaceState(history.state, '', malformedPath), path);
    await page.goto('/call/malformed-test-link');
    expect(await page.evaluate(() => location.pathname)).toBe(path);
    await expect(page.getByRole('alert')).toContainText(/invalid|unavailable/i);
    await expect(page.getByRole('button', { name: 'Start browser conversation', exact: true })).toHaveCount(
      0,
    );
    expect(errors).toEqual([]);
    expect(privateReads).toBe(0);
  });
}

async function prepareDelayedHistory(page: Page) {
  const { assistant: primary } = await signup(page);
  const created = await page.request.post('/api/me/assistants', {
    data: {
      name: 'Delayed history target',
      persona: 'Warm and clear',
      greeting: 'Hello from the delayed target.',
      engine: 'pipeline',
      language: 'fr',
    },
  });
  expect(created.status()).toBe(201);
  const other = await created.json();
  await page.reload();
  await selectCommittedReceptionist(page, other.id);
  await connections(page);
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('fr');
  await page.getByRole('button', { name: 'Back to your desk', exact: true }).click();
  await selectCommittedReceptionist(page, primary.id, true);
  await connections(page);
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('en');
  return { primary, other };
}

for (const { leave, failLate } of [
  { leave: 'forward', failLate: false },
  { leave: 'home', failLate: false },
  { leave: 'forward', failLate: true },
] as const) {
  test(`a pending historical receptionist load cannot override newer ${leave} navigation (late failure=${failLate})`, async ({
    page,
  }) => {
    const { primary, other } = await prepareDelayedHistory(page);
    let held: Route | undefined;
    let response: import('@playwright/test').APIResponse | undefined;
    let holdNext = true;
    await page.route(`**/api/me/assistants/${other.id}`, async (route) => {
      if (route.request().method() === 'GET' && holdNext) {
        holdNext = false;
        response = await route.fetch();
        held = route;
        return;
      }
      return route.continue();
    });
    try {
      await page.evaluate(() => history.go(-2));
      await expect.poll(() => !!held).toBe(true);
      await expect(page).toHaveURL(new RegExp(`assistant=${other.id}`));
      await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toHaveCount(0);
      if (leave === 'forward') await page.evaluate(() => history.go(2));
      else await page.getByRole('button', { name: 'OpenFon home', exact: true }).click();
      await expect(page).not.toHaveURL(new RegExp(other.id));
      if (leave === 'forward') await expect(page.getByLabel('Language', { exact: true })).toHaveValue('en');
      else await expect(page.getByLabel('Receptionist', { exact: true })).toHaveValue(primary.id);
      const lateResponse = page.waitForResponse(
        (request) => new URL(request.url()).pathname === `/api/me/assistants/${other.id}`,
      );
      const route = held!;
      held = undefined;
      await route.fulfill(
        failLate ? { status: 503, json: { error: 'Obsolete target failure' } } : { response: response! },
      );
      await (await lateResponse).finished();
      // Wait for every late response continuation and render, including any
      // wrongly started follow-up read, before checking the selected target.
      await page.waitForLoadState('networkidle');
      await expect(page).not.toHaveURL(new RegExp(other.id));
      await expect(page.getByRole('alert')).toHaveCount(0);
      if (leave === 'forward') {
        await expect(page.getByLabel('Language', { exact: true })).toHaveValue('en');
        await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toBeDisabled();
      } else await expect(page.getByLabel('Receptionist', { exact: true })).toHaveValue(primary.id);
    } finally {
      if (held) await held.abort();
    }
  });
}

test('the newer visit to the same receptionist wins when an earlier visit finishes last', async ({
  page,
}) => {
  const { other } = await prepareDelayedHistory(page);
  const held: { route: Route; response: import('@playwright/test').APIResponse; released: boolean }[] = [];
  await page.route(`**/api/me/assistants/${other.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    held.push({ route, response, released: false });
  });
  try {
    await page.evaluate(() => history.go(-2));
    await expect.poll(() => held.length).toBe(1);
    await page.evaluate(() => history.go(2));
    await expect(page.getByLabel('Language', { exact: true })).toHaveValue('en');
    expect(
      (await page.request.put(`/api/me/assistants/${other.id}`, { data: { language: 'es' } })).ok(),
    ).toBe(true);
    await page.evaluate(() => history.go(-2));
    await expect.poll(() => held.length).toBe(2);
    held[1].released = true;
    await held[1].route.fulfill({ response: held[1].response });
    await expect(page.getByLabel('Language', { exact: true })).toHaveValue('es');
    const lateResponse = page.waitForResponse((response) => response.request() === held[0].route.request());
    held[0].released = true;
    await held[0].route.fulfill({ response: held[0].response });
    await (await lateResponse).finished();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(new RegExp(`assistant=${other.id}`));
    await expect(page.getByLabel('Language', { exact: true })).toHaveValue('es');
    await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    for (const entry of held) if (!entry.released) await entry.route.abort();
  }
});
