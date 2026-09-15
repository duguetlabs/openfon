import { test, expect } from './fixtures';

for (const failure of ['workspace update', 'assistant list', 'assistant update']) {
  test(`onboarding resumes after ${failure} fails after workspace creation`, async ({ page }) => {
    let created = false;
    let failed = false;
    const createdIds: string[] = [];
    await page.route('**/api/me/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/me/business' && request.method() === 'POST') {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        createdIds.push((await response.json()).id);
        created = true;
        return route.fulfill({ response });
      }
      const target = failure === 'workspace update' ? request.method() === 'PUT' && path.startsWith('/api/me/business/')
        : failure === 'assistant list' ? request.method() === 'GET' && path === '/api/me/assistants'
        : request.method() === 'PUT' && path.startsWith('/api/me/assistants/');
      if (created && !failed && target) {
        failed = true;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected setup interruption' }) });
      }
      return route.continue();
    });
    await page.goto('/auth');
    await page.getByLabel('Email').fill(`retry-${Date.now()}-${Math.random()}@example.invalid`);
    await page.getByLabel('Password', { exact: true }).fill('Local-Test-Password-Only-1234');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByLabel('Business name', { exact: true }).fill('Retry Workshop');
    await page.getByLabel('What do you do?').fill('Synthetic local repair workshop.');
    await page.getByRole('button', { name: 'Continue →' }).click();
    await page.getByRole('button', { name: 'Continue →' }).click();
    const finish = page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i });
    await finish.click();
    await expect(page.getByText('Injected setup interruption')).toBeVisible();
    expect(failed).toBe(true);
    await finish.click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    await expect(page).toHaveURL('/overview');
    expect(createdIds).toHaveLength(2);
    expect(createdIds[1]).toBe(createdIds[0]);
    const bootstrap = await (await page.request.get('/api/me/bootstrap')).json();
    expect(bootstrap.assistants).toHaveLength(1);
    expect(bootstrap.assistants[0].state).toBe('draft');
  });
}

async function openFreshSetup(page: import('@playwright/test').Page) {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`refresh-${Date.now()}-${Math.random()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Local-Test-Password-Only-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Refresh Workshop');
  await page.getByLabel('What do you do?').fill('Original setup description.');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByLabel('Greeting (optional)').fill('Original setup greeting.');
}

test('acknowledged onboarding retries only reads and preserves later server edits [onboarding-refresh]', async ({ page }) => {
  const writes = { create: 0, business: 0, assistant: 0 };
  let businessId = '';
  let assistantId = '';
  let acknowledged = false;
  let refreshFailures = 2;
  await page.route('**/api/me**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (acknowledged && request.method() === 'GET' && path === '/api/me' && refreshFailures > 0) {
      refreshFailures--;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected post-save refresh failure' }) });
    }
    if (path === '/api/me/business' && request.method() === 'POST') {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      writes.create++;
      businessId = (await response.json()).id;
      return route.fulfill({ response });
    }
    if (path.startsWith('/api/me/business/') && request.method() === 'PUT') {
      writes.business++;
    }
    if (path.startsWith('/api/me/assistants/') && request.method() === 'PUT') {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      writes.assistant++;
      assistantId = path.split('/').at(-1)!;
      acknowledged = true;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await openFreshSetup(page);
  await page.getByRole('button', { name: 'Save and open studio →', exact: true }).click();
  const failure = page.getByText(/Injected post-save refresh failure|Workspace saved, but the studio could not be loaded/);
  await expect(failure).toBeVisible();
  expect(writes).toEqual({ create: 1, business: 1, assistant: 1 });
  // APIRequestContext bypasses the page route and represents another editor.
  expect((await page.request.put(`/api/me/business/${businessId}`, { data: { description: 'Newer peer description.' } })).ok()).toBe(true);
  expect((await page.request.put(`/api/me/assistants/${assistantId}`, { data: { greeting: 'Newer peer greeting.' } })).ok()).toBe(true);
  const recovery = page.getByRole('button', { name: /^(Retry opening studio|Save and open studio →)$/ }).and(page.locator(':enabled'));
  await recovery.click();
  await expect(failure).toBeVisible();
  await expect.poll(() => refreshFailures).toBe(0);
  const afterBusiness = await (await page.request.get('/api/me/business')).json();
  const afterAssistant = await (await page.request.get(`/api/me/assistants/${assistantId}`)).json();
  console.log(JSON.stringify({ phase: 'after-second-refresh-failure', writes, description: afterBusiness.description, greeting: afterAssistant.greeting }));
  // Original reaches this assertion after repeating both acknowledged mutations.
  expect(writes).toEqual({ create: 1, business: 1, assistant: 1 });
  expect(afterBusiness.description).toBe('Newer peer description.');
  expect(afterAssistant.greeting).toBe('Newer peer greeting.');
  await expect(page.getByRole('button', { name: 'Save and open studio →', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Agent name', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry opening studio', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await expect(page).toHaveURL('/overview');
  expect(writes).toEqual({ create: 1, business: 1, assistant: 1 });
  expect((await (await page.request.get('/api/me/business')).json()).description).toBe('Newer peer description.');
  expect((await (await page.request.get(`/api/me/assistants/${assistantId}`)).json()).greeting).toBe('Newer peer greeting.');
});

test('onboarding freezes draft controls while an acknowledged save response is held [onboarding-refresh]', async ({ page }) => {
  let release!: () => void;
  let observed!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { observed = resolve; });
  await page.route('**/api/me/assistants/*', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    observed();
    await held;
    return route.fulfill({ response });
  });
  try {
    await openFreshSetup(page);
    await page.getByRole('button', { name: 'Save and open studio →', exact: true }).click();
    await reached;
    await expect(page.getByLabel('Agent name', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('Greeting (optional)')).toBeDisabled();
    release();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    await expect(page).toHaveURL('/overview');
  } finally { release(); }
});

test('signout prevents later setup stages after an in-flight creation response [onboarding-refresh]', async ({ page }) => {
  let release!: () => void;
  let observed!: () => void;
  let returned!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { observed = resolve; });
  const responseReturned = new Promise<void>(resolve => { returned = resolve; });
  let laterPuts = 0;
  await page.route('**/api/me/business**', async route => {
    if (route.request().method() === 'PUT') laterPuts++;
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    observed();
    await held;
    await route.fulfill({ response });
    returned();
  });
  try {
    await openFreshSetup(page);
    await page.getByRole('button', { name: 'Save and open studio →', exact: true }).click();
    await reached;
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL('/auth');
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeEnabled();
    release();
    await responseReturned;
    // Bounded absence observation after the obsolete response is delivered;
    // no timer is added to production. Original continues into another PUT.
    await page.waitForTimeout(250);
    expect(laterPuts).toBe(0);
    await expect(page).toHaveURL('/auth');
  } finally { release(); }
});
