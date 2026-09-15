import { test as base, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';

// Cleanup runs as fixture teardown, preserving the original test assertion if
// route cleanup also fails. Only this test's held route is ever aborted.
const test = base.extend<{ pendingRoutes: Route[] }>({
  pendingRoutes: async ({ page }, use) => {
    const routes: Route[] = [];
    await use(routes);
    for (const route of routes) await route.abort();
    await page.unrouteAll({ behavior: 'wait' });
  },
});

const key = 'openfon.logout-intent.v1';
const marker = JSON.stringify({ version: 1, id: '00112233-4455-4677-8899-aabbccddeeff', phase: 'unconfirmed' });

async function signedIn(page: Page, label: string) {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`logout-${label}-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Logout-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}
function authReads(page: Page) {
  const reads: string[] = [];
  // Page requests only. Explicit test-owned API checks are deliberately separate.
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && (path === '/api/me' || path.startsWith('/api/me/'))) reads.push(path);
  });
  return reads;
}
async function locked(page: Page, text: string) {
  await expect(page.getByRole('alert').filter({ hasText: text })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeDisabled();
  await expect(page.getByLabel('Password', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
}

// Real local Worker signup/session cookie; only the logout failure is injected.
// Each page.reload destroys App/coordinator and reuses actual sessionStorage.
test('[original] failed logout survives reload with a valid cookie and explicit repeated retry', async ({ page }) => {
  await signedIn(page, 'failed');
  let writes = 0;
  await page.route('**/api/auth/logout', route => {
    writes++;
    return writes <= 2 ? route.fulfill({ status: 503, json: { error: 'Synthetic revocation failure' } }) : route.continue();
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await locked(page, 'server sign-out was not confirmed');
  expect((await page.request.get('/api/me')).status()).toBe(200); // Still-valid real cookie.
  const reads = authReads(page);
  await page.reload();
  await locked(page, 'server sign-out was not confirmed'); // Original first intended failure.
  expect(reads).toEqual([]); expect(writes).toBe(1);
  await page.getByRole('button', { name: 'Retry sign-out', exact: true }).click();
  await expect.poll(() => writes).toBe(2);
  await expect(page.getByRole('button', { name: 'Retry sign-out', exact: true })).toBeEnabled();
  await locked(page, 'server sign-out was not confirmed');
  expect((await page.request.get('/api/me')).status()).toBe(200);
  await page.reload(); await locked(page, 'server sign-out was not confirmed');
  expect(reads).toEqual([]); expect(writes).toBe(2);
  await page.getByRole('button', { name: 'Retry sign-out', exact: true }).click();
  await expect(page.getByLabel('Email')).toBeEnabled();
  expect(writes).toBe(3); expect(reads).toEqual([]);
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
  expect((await page.request.get('/api/me')).status()).toBe(401);
});

test('[original] pending logout survives reload without automatic retry or authenticated reads', async ({ page, pendingRoutes }) => {
  await signedIn(page, 'pending');
  let writes = 0;
  // Keep a routed request unhandled, without a detached promise/timer. The
  // browser's reload aborts the document request; fixture teardown settles our route.
  await page.route('**/api/auth/logout', route => { writes++; pendingRoutes.push(route); });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Confirming server sign-out' })).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(200);
  const reads = authReads(page);
  await page.reload();
  await locked(page, 'server sign-out was not confirmed');
  expect(reads).toEqual([]); expect(writes).toBe(1);
  expect((await page.request.get('/api/me')).status()).toBe(200);
});

for (const mode of ['malformed', 'unsupported', 'unreadable'] as const) {
  test(`unknown ${mode} storage blocks initial authenticated reads until explicit recovery`, async ({ page }) => {
    await signedIn(page, mode);
    if (mode === 'unreadable') {
      await page.addInitScript(key => {
        const read = Storage.prototype.getItem;
        Storage.prototype.getItem = function (name) {
          if (name === key) throw new Error('Synthetic storage read failure');
          return read.call(this, name);
        };
      }, key);
    } else await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), {
      key, value: mode === 'malformed' ? '{' : marker.replace('"version":1', '"version":2'),
    });
    let writes = 0;
    await page.route('**/api/auth/logout', route => { writes++; return route.continue(); });
    const reads = authReads(page);
    await page.reload();
    await locked(page, 'could not read its sign-out status');
    expect(reads).toEqual([]); expect(writes).toBe(0);
    expect((await page.request.get('/api/me')).status()).toBe(200);
    await page.getByRole('button', { name: 'Retry sign-out', exact: true }).click();
    if (mode === 'unreadable') {
      await locked(page, 'Server sign-out succeeded');
      expect(writes).toBe(1);
      await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toBeEnabled();
      expect(writes).toBe(1); // Unknown storage remains blocked; no repeated server request.
    } else await expect(page.getByLabel('Email')).toBeEnabled();
    expect(reads).toEqual([]); expect(writes).toBe(1);
    expect((await page.request.get('/api/me')).status()).toBe(401);
  });
}

test('write failure retains local clear and the live coordinator memory gate', async ({ page }) => {
  await signedIn(page, 'write');
  await page.evaluate(key => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new Error('Synthetic storage write failure');
      return write.call(this, name, value);
    };
  }, key);
  let writes = 0;
  await page.route('**/api/auth/logout', route => { writes++; return route.fulfill({ status: 503, json: { error: 'Synthetic revocation failure' } }); });
  const reads = authReads(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await locked(page, 'server sign-out was not confirmed');
  expect(reads).toEqual([]); expect(writes).toBe(1);
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
  expect((await page.request.get('/api/me')).status()).toBe(200);
  // No reload protection claim when persistence itself failed.
});

test('confirmed revocation with removal failure reloads into local-only cleanup', async ({ page }) => {
  await signedIn(page, 'remove');
  await page.evaluate(key => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name) {
      if (name === key) throw new Error('Synthetic storage remove failure');
      return remove.call(this, name);
    };
  }, key);
  let writes = 0;
  await page.route('**/api/auth/logout', route => { writes++; return route.continue(); });
  const reads = authReads(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await locked(page, 'Server sign-out succeeded');
  expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), key))!).phase).toBe('confirmed');
  expect((await page.request.get('/api/me')).status()).toBe(401);
  await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry local cleanup', exact: true })).toBeEnabled();
  expect(writes).toBe(1);
  await page.reload(); // Prototype fault is gone; persisted confirmation remains.
  await locked(page, 'Server sign-out succeeded');
  expect(reads).toEqual([]); expect(writes).toBe(1);
  await page.getByRole('button', { name: 'Retry local cleanup', exact: true }).click();
  await expect(page.getByLabel('Email')).toBeEnabled();
  expect(writes).toBe(1); expect(reads).toEqual([]);
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
});

test('ordinary absent marker preserves signed-in reload and normal confirmed sign-out', async ({ page }) => {
  await signedIn(page, 'ordinary');
  const reads = authReads(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  expect(reads).toContain('/api/me');
  expect(reads).toContain('/api/me/business');
  expect(reads).toContain('/api/me/bootstrap');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Email')).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
  expect((await page.request.get('/api/me')).status()).toBe(401);
});
