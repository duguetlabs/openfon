import { test as base, expect } from './fixtures';
import type { APIResponse, Page, Route } from '@playwright/test';

type Owned = { routes: Set<Route>; responses: APIResponse[] };
// Teardown is separate from assertions. All held routes belong to this fixture;
// report cleanup errors rather than silently treating them as a passing case.
const test = base.extend<{ owned: Owned }>({
  owned: async ({ page }, use) => {
    const owned: Owned = { routes: new Set(), responses: [] };
    try { await use(owned); }
    finally {
      const results = await Promise.allSettled([...owned.routes].map(route => route.abort()));
      results.push(...await Promise.allSettled(owned.responses.map(response => response.dispose())));
      results.push(...await Promise.allSettled([page.unrouteAll({ behavior: 'wait' })]));
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map(r => r.reason), 'Owned deletion fixture cleanup failed');
    }
  },
});
const key = 'openfon.logout-intent.v1';
const password = 'Synthetic-Deletion-Password-1234';

async function setup(page: Page) {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`deletion-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Synthetic deletion workshop');
  await page.getByLabel('What do you do?').fill('Synthetic local fixture.');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await page.getByLabel('Current password to confirm deletion').fill(password);
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
}
const submit = (page: Page) => page.getByRole('button', { name: 'Permanently delete account', exact: true }).click();
function writes(page: Page) {
  const counts = { deletes: 0, logouts: 0 };
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/me/account' && request.method() === 'DELETE') counts.deletes++;
    if (path === '/api/auth/logout' && request.method() === 'POST') counts.logouts++;
  });
  return counts;
}
function authReads(page: Page) {
  const reads: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && (path === '/api/me' || path.startsWith('/api/me/'))) reads.push(path);
  });
  return reads;
}
async function heldDelete(page: Page, owned: Owned) {
  const captured: Array<{ route: Route; response: APIResponse }> = [];
  await page.route('**/api/me/account', async route => {
    owned.routes.add(route);
    const response = await route.fetch({ timeout: 5_000 });
    owned.responses.push(response); captured.push({ route, response });
  });
  return {
    async ready() {
      await expect.poll(() => captured.length).toBe(1);
      expect(captured[0].response.status()).toBe(200);
    },
    async acknowledge() {
      const { route, response } = captured[0];
      await route.fulfill({ response }); owned.routes.delete(route);
    },
  };
}

test.describe('confirmed account deletion', () => {
for (const mode of ['rejected', 'pending'] as const) {
  test(`[original] confirmed deletion ignores a ${mode} redundant logout endpoint`, async ({ page, owned }) => {
    await setup(page); const count = writes(page);
    await page.route('**/api/auth/logout', route => {
      if (mode === 'pending') { owned.routes.add(route); return; }
      return route.fulfill({ status: 503, json: { error: 'Synthetic redundant logout failure' } });
    });
    await submit(page);
    await expect(page.getByLabel('Email')).toBeEnabled(); // Original finite first failure: locked Auth.
    expect(count).toEqual({ deletes: 1, logouts: 0 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect((await page.request.get('/api/me')).status()).toBe(401);
    await page.reload(); await expect(page.getByLabel('Email')).toBeEnabled();
    expect(count).toEqual({ deletes: 1, logouts: 0 });
    expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
  });
}

test('rejected DELETE retains the account screen, valid session and no logout intent', async ({ page }) => {
  await setup(page); const count = writes(page);
  await page.route('**/api/me/account', route => route.fulfill({ status: 503, json: { error: 'Synthetic deletion failure' } }));
  await submit(page);
  await expect(page.getByRole('alert')).toContainText('Synthetic deletion failure');
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  expect(count).toEqual({ deletes: 1, logouts: 0 });
  expect((await page.request.get('/api/me')).status()).toBe(200);
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
});

test('lost DELETE response does not invent confirmation or automatically retry', async ({ page, owned }) => {
  await setup(page); const count = writes(page);
  await page.route('**/api/me/account', async route => {
    owned.routes.add(route); const response = await route.fetch({ timeout: 5_000 }); owned.responses.push(response);
    expect(response.status()).toBe(200); await route.abort('failed'); owned.routes.delete(route);
  });
  await submit(page);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  expect(count).toEqual({ deletes: 1, logouts: 0 });
  expect((await page.request.get('/api/me')).status()).toBe(401); // Server completed; UI did not acknowledge it.
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
});

test('confirmed deletion with removal failure reloads into local-only cleanup', async ({ page }) => {
  await setup(page); const count = writes(page), reads = authReads(page);
  await page.evaluate(key => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name) {
      if (name === key) throw new Error('Synthetic deletion cleanup failure');
      return original.call(this, name);
    };
  }, key);
  await submit(page);
  await expect(page.getByRole('alert')).toContainText('Server sign-out succeeded');
  expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), key))!).phase).toBe('confirmed');
  await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toBeEnabled();
  expect(count).toEqual({ deletes: 1, logouts: 0 });
  await page.reload(); // Prototype fault disappears; actual confirmed sessionStorage survives.
  await expect(page.getByRole('alert')).toContainText('Server sign-out succeeded');
  expect(reads).toEqual([]);
  await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
  await expect(page.getByLabel('Email')).toBeEnabled();
  expect(count).toEqual({ deletes: 1, logouts: 0 }); expect(reads).toEqual([]);
  expect((await page.request.get('/api/me')).status()).toBe(401);
});

test('late DELETE acknowledgement preserves a newer failed sign-out intent', async ({ page, owned }) => {
  await setup(page); const count = writes(page), held = await heldDelete(page, owned);
  await page.route('**/api/auth/logout', route => route.fulfill({ status: 503, json: { error: 'Synthetic newer sign-out failure' } }));
  await submit(page); await held.ready();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('server sign-out was not confirmed');
  const newer = await page.evaluate(key => sessionStorage.getItem(key), key);
  expect(newer).not.toBeNull();
  const acknowledged = page.waitForResponse(response => response.url().endsWith('/api/me/account') && response.request().method() === 'DELETE');
  await held.acknowledge(); await (await acknowledged).finished();
  // Use a browser task boundary to observe settled fetch/coordinator callbacks.
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBe(newer);
  expect(count).toEqual({ deletes: 1, logouts: 1 });
  await expect(page.getByLabel('Email')).toBeDisabled();
});

test('failed confirmed-intent write with readable absence still clears locally', async ({ page }) => {
  await setup(page); const count = writes(page);
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new Error('Synthetic confirmation persistence failure');
      return original.call(this, name, value);
    };
  }, key);
  await submit(page); await expect(page.getByLabel('Email')).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(count).toEqual({ deletes: 1, logouts: 0 });
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
});

test('unreadable storage after acknowledged DELETE stays in live local-only recovery', async ({ page, owned }) => {
  await setup(page); const count = writes(page), held = await heldDelete(page, owned);
  await submit(page); await held.ready();
  await page.evaluate(key => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new Error('Synthetic unreadable status');
      return original.call(this, name);
    };
  }, key);
  await held.acknowledge();
  await expect(page.getByRole('alert')).toContainText('Server sign-out succeeded');
  await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Email')).toBeDisabled();
  expect(count).toEqual({ deletes: 1, logouts: 0 });
  expect((await page.request.get('/api/me')).status()).toBe(401);
});

});
