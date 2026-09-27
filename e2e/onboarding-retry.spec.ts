import { test, expect } from './fixtures';
import { signup, signOut } from './cleanroom-helpers';

async function fresh(page: import('@playwright/test').Page) {
  await signup(page, 'setup-recovery');
  await page.getByLabel('Business name', { exact: true }).fill('Refresh Workshop');
  await page.getByLabel('What do you do?').fill('Original setup description.');
}
async function retry(page: import('@playwright/test').Page) {
  const setup = page.getByRole('button', { name: 'Retry opening your desk', exact: true });
  if (await setup.isVisible()) await setup.click();
  else await page.getByRole('button', { name: 'Try again', exact: true }).click();
}
const finish = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Meet your receptionist', exact: true });

for (const committed of [false, true]) {
  test(`single-step setup retry preserves one workspace after ${committed ? 'lost committed response' : 'rejected creation'}`, async ({
    page,
  }) => {
    await fresh(page);
    let calls = 0;
    const ids: string[] = [];
    await page.route('**/api/me/business', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      calls++;
      if (calls === 1 && !committed)
        return route.fulfill({ status: 503, json: { error: 'Synthetic creation failure' } });
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      ids.push((await response.json()).id);
      if (calls === 1) return route.abort('failed');
      return route.fulfill({ response });
    });
    await finish(page).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('Business name', { exact: true })).toHaveValue('Refresh Workshop');
    await finish(page).click();
    await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeVisible();
    expect(calls).toBe(2);
    expect(new Set(ids).size).toBe(1);
    const boot = await (await page.request.get('/api/me/bootstrap')).json();
    expect(boot.assistants).toHaveLength(1);
    expect(boot.assistants[0].state).toBe('draft');
  });
}

for (const target of ['bootstrap', 'assistant'] as const) {
  test(`acknowledged setup retries ${target} reads only and preserves newer peer edits`, async ({ page }) => {
    await fresh(page);
    let writes = 0,
      ack = false,
      failures = 2;
    await page.route('**/api/me/**', async (route) => {
      const r = route.request(),
        path = new URL(r.url()).pathname;
      if (r.method() === 'POST' && path === '/api/me/business') {
        writes++;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        ack = true;
        return route.fulfill({ response });
      }
      if (
        ack &&
        r.method() === 'GET' &&
        failures > 0 &&
        (target === 'bootstrap' ? path === '/api/me/bootstrap' : /^\/api\/me\/assistants\/[^/]+$/.test(path))
      ) {
        failures--;
        return route.fulfill({ status: 503, json: { error: 'Synthetic post-save read failure' } });
      }
      return route.continue();
    });
    await finish(page).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic post-save read failure');
    const boot = await (await page.request.get('/api/me/bootstrap')).json();
    const id = boot.assistants[0].id;
    expect(
      (
        await page.request.put(`/api/me/business/${boot.workspace.id}`, {
          data: { description: 'Newer peer description.' },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await page.request.put(`/api/me/assistants/${id}`, { data: { greeting: 'Newer peer greeting.' } })
      ).ok(),
    ).toBe(true);
    await retry(page);
    await expect.poll(() => failures).toBe(0);
    await expect(page.getByRole('alert')).toContainText('Synthetic post-save read failure');
    expect(writes).toBe(1);
    await retry(page);
    await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeVisible();
    expect(writes).toBe(1);
    expect((await (await page.request.get('/api/me/business')).json()).description).toBe(
      'Newer peer description.',
    );
    expect((await (await page.request.get(`/api/me/assistants/${id}`)).json()).greeting).toBe(
      'Newer peer greeting.',
    );
  });
}

test('onboarding freezes inputs while its acknowledged creation response is held', async ({ page }) => {
  await fresh(page);
  let held: import('@playwright/test').Route | undefined;
  let response: import('@playwright/test').APIResponse | undefined;
  await page.route('**/api/me/business', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    response = await route.fetch();
    held = route;
  });
  try {
    await finish(page).click();
    await expect.poll(() => !!held).toBe(true);
    await expect(page.getByLabel('Business name', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('What do you do?')).toBeDisabled();
    await held!.fulfill({ response: response! });
    held = undefined;
    await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeVisible();
  } finally {
    if (held) await held.abort();
  }
});

test('signout makes a pending setup acknowledgement obsolete without further writes or authenticated reads', async ({
  page,
}) => {
  await fresh(page);
  let held: import('@playwright/test').Route | undefined;
  let response: import('@playwright/test').APIResponse | undefined;
  await page.route('**/api/me/business', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    response = await route.fetch();
    held = route;
  });
  try {
    await finish(page).click();
    await expect.poll(() => !!held).toBe(true);
    await signOut(page);
    await expect(page.getByLabel('Email address')).toBeEnabled();
    const later: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/me')) later.push(r.method() + ' ' + r.url());
    });
    await held!.fulfill({ response: response! });
    held = undefined;
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    expect(later).toEqual([]);
    await expect(page.getByLabel('Email address')).toBeEnabled();
  } finally {
    if (held) await held.abort();
  }
});
