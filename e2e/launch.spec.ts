import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Local workerd accepts this edge header; each attempt gets its own production
// limiter bucket, including retries. No application limit or auth is bypassed.
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'CF-Connecting-IP': `e2e-${randomUUID()}` });
});

async function signup(page: Page) {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`qa-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Local-Test-Password-Only-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Workshop browser test');
  await page.getByLabel('What do you do?').fill('Bicycle repairs and tune-ups. Synthetic local test business.');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await expect(page).toHaveURL('/overview');
}

test('public page has usable examples, navigation and mobile layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A little more');
  await page.getByRole('button', { name: /callback request/ }).click();
  await expect(page.getByText('Could someone call me about a repair?')).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Does it answer my existing phone number?' }).click();
  await expect(page.getByText(/Not yet. Today, callers/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('landing-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('landing-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', { name: /Sign in/ }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('new workspace remains private, assistant edits persist, pause survives reload', async ({ page }) => {
  await signup(page);
  const bootstrap = await (await page.request.get('/api/me/bootstrap')).json();
  expect(bootstrap.assistants[0].state).toBe('draft');
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Assistants', exact: true }).click();
  await page.getByRole('link', { name: 'Configure →' }).first().click();
  await page.getByLabel('Opening greeting').fill('Hello from the workshop test.');
  await expect(page.getByRole('button', { name: 'Publish assistant' })).toBeDisabled();
  const editorUrl = page.url();
  const rejectDiscard = async (action: () => Promise<unknown>, type = 'confirm') => {
    const dialog = page.waitForEvent('dialog');
    const navigation = action().catch(() => undefined); // cancelled reload rejects navigation
    const prompt = await dialog;
    expect(prompt.type()).toBe(type);
    await prompt.dismiss();
    await navigation;
    await expect(page).toHaveURL(editorUrl);
    await expect(page.getByLabel('Opening greeting')).toHaveValue('Hello from the workshop test.');
  };
  await rejectDiscard(() => page.getByRole('link', { name: 'Open Test Studio →' }).click());
  await rejectDiscard(() => page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Knowledge', exact: true }).click());
  await rejectDiscard(() => page.goBack());
  await rejectDiscard(() => page.reload({ timeout: 1500 }), 'beforeunload');
  await rejectDiscard(() => page.getByRole('button', { name: 'Sign out', exact: true }).click());
  expect((await page.request.get('/api/me')).status()).toBe(200);

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Assistant saved' })).toBeVisible();
  // Explicit discard proceeds; cancelling above preserved the same draft.
  await page.getByLabel('Opening greeting').fill('This edit should be discarded.');
  page.once('dialog', dialog => void dialog.accept());
  await page.getByRole('link', { name: 'Manage knowledge →' }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await page.goBack();
  await expect(page.getByLabel('Opening greeting')).toHaveValue('Hello from the workshop test.');

  await page.reload();
  await expect(page.getByLabel('Opening greeting')).toHaveValue('Hello from the workshop test.');
  await page.getByRole('button', { name: 'Publish assistant' }).click();
  await expect(page.getByRole('button', { name: 'Pause assistant' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause assistant' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Publish assistant' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
});

test('knowledge draft, approval and attachment survive reload; all app menus work', async ({ page }) => {
  await signup(page);
  await page.goto('/knowledge');
  await page.getByLabel('New collection', { exact: true }).fill('Workshop services');
  await page.getByRole('button', { name: 'Create collection' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Collection created' })).toBeVisible();
  await page.getByRole('button', { name: 'Add knowledge' }).click();
  await page.getByLabel('Question', { exact: true }).fill('Do you fix punctures?');
  await page.getByLabel('Answer', { exact: true }).fill('Yes. Bring your bicycle during opening hours.');
  const knowledgeUrl = page.url();
  for (const action of [
    () => page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Assistants', exact: true }).click(),
    () => page.getByRole('combobox', { name: 'Collection', exact: true }).selectOption({ index: 0 }),
    () => page.getByRole('button', { name: 'Add knowledge' }).click(),
    () => page.goBack({ timeout: 1500 }),
    () => page.reload({ timeout: 1500 }),
  ]) {
    const dialog = page.waitForEvent('dialog');
    const navigation = action().catch(() => undefined);
    await (await dialog).dismiss();
    await navigation;
    await expect(page).toHaveURL(knowledgeUrl);
    await expect(page.getByLabel('Question', { exact: true })).toHaveValue('Do you fix punctures?');
  }
  await page.getByRole('button', { name: 'Save knowledge' }).click();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Alex', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Alex', exact: true })).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'Assistant knowledge updated' })).toBeVisible();
  await page.reload();
  await page.getByRole('combobox', { name: 'Collection', exact: true }).selectOption({ label: 'Workshop services (1 item)' });
  await expect(page.getByRole('checkbox', { name: 'Alex', exact: true })).toBeChecked();
  await expect(page.getByText('Do you fix punctures?', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('knowledge-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('knowledge-mobile.png'), fullPage: true });
  for (const [route, title] of [['/test', 'Test Studio'], ['/calls', 'Conversations'], ['/settings', 'Settings'], ['/account', 'Your account']]) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
});

test('account can change password, export data without credentials, and delete', async ({ page }) => {
  await signup(page);
  await page.goto('/account');
  await page.getByLabel('Current password', { exact: true }).fill('Local-Test-Password-Only-1234');
  await page.getByLabel('New password', { exact: true }).fill('Changed-Local-Test-Password-1234');
  await page.getByLabel('Repeat new password', { exact: true }).fill('Changed-Local-Test-Password-1234');
  await page.getByRole('button', { name: 'Update password', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Password updated' })).toBeVisible();
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
  await expect(page).toHaveURL('/auth');
  expect((await page.request.get('/api/me')).status()).toBe(401);
});


test('private test call traverses Worker websocket and persists transcript and summary', async ({ page }) => {
  await signup(page);
  const result = await page.evaluate(async () => {
    const bootstrap = await (await fetch('/api/me/bootstrap')).json();
    const assistantId = bootstrap.assistants[0].id;
    const saved = await fetch(`/api/me/assistants/${assistantId}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({engine:'pipeline'})});
    if (!saved.ok) throw new Error(`Assistant update failed: ${saved.status}`);
    const reserved = await fetch(`/api/me/assistants/${assistantId}/test-calls`, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
    if (!reserved.ok) throw new Error(`Call reservation failed: ${reserved.status}`);
    const {callId} = await reserved.json();
    const events = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws/call/${callId}`);
      const seen: Record<string, unknown>[] = [];
      const timer = setTimeout(() => { socket.close(); reject(new Error('Call timeout')); }, 15000);
      socket.onopen = () => socket.send(JSON.stringify({type:'start'}));
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Socket failed')); };
      socket.onmessage = event => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        seen.push(message);
        if (message.type === 'error') { clearTimeout(timer); socket.close(); reject(new Error(String(message.message))); }
        if (message.type === 'ready') socket.send(JSON.stringify({type:'text', text:'Do you repair bicycles?'}));
        if (message.type === 'agent_text') socket.send(JSON.stringify({type:'hangup'}));
        if (message.type === 'ended') { clearTimeout(timer); socket.close(); resolve(seen); }
      };
    });
    return {callId, events};
  });
  expect(result.events).toContainEqual(expect.objectContaining({type:'agent_text',text:'Yes, we repair bicycles during opening hours.'}));
  await expect.poll(async () => (await (await page.request.get(`/api/me/calls/${result.callId}`)).json()).status).toBe('completed');
  const call = await (await page.request.get(`/api/me/calls/${result.callId}`)).json();
  expect(call.environment).toBe('test');
  expect(call.summary).toBe('Caller asked about bicycle repairs.');
  expect(call.turns).toEqual(expect.arrayContaining([expect.objectContaining({role:'caller',text:'Do you repair bicycles?'}),expect.objectContaining({role:'agent',text:'Yes, we repair bicycles during opening hours.'})]));
  await page.goto(`/calls/${result.callId}`);
  await expect(page.getByText('Do you repair bicycles?', {exact:true})).toBeVisible();
});

test('cancel real pending test reservations on end and navigation', async ({ page }) => {
  await signup(page);
  for (const leave of ['end', 'navigate'] as const) {
    await test.step(leave, async () => {
      await page.goto('/test');
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let reservedId = '';
      await page.route('**/api/me/assistants/*/test-calls', async route => {
        const response = await route.fetch(); // Actual API reservation and database insert.
        expect(response.status()).toBe(201);
        reservedId = (await response.json()).callId;
        await held;
        await route.fulfill({ response });
      });
      await page.getByRole('button', { name: 'Start test call', exact: true }).click();
      await expect.poll(() => reservedId).not.toBe('');
      if (leave === 'end') {
        await page.getByRole('button', { name: 'End test call', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Start test call', exact: true })).toBeVisible();
      } else {
        await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Overview', exact: true }).click();
        await expect(page).toHaveURL('/overview');
      }
      release();
      await expect.poll(async () => (await page.request.get(`/api/me/calls/${reservedId}`)).status()).toBe(404);
      const calls = await (await page.request.get('/api/me/calls?environment=test')).json();
      expect(calls.items).toHaveLength(0);
      await page.unroute('**/api/me/assistants/*/test-calls');
    });
  }
});
