import { openAuth, connections, workspaceMenu, whoAnswers } from './cleanroom-helpers';
import { test, expect, openSettingsSections } from './fixtures';
import type { APIResponse, Locator, Page, Request, Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Production browser/HTTP, with synthetic request/response holds. No provider inference.
async function setup(page: Page) {
  await openAuth(page);
  await page.getByLabel('Email').fill(`create-profile-${randomUUID()}@example.invalid`);
  await page.getByLabel(/^Password/).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Create profile workshop');
  await page.getByLabel('What do you do?').fill('Synthetic profile creation validation');
  await page.getByRole('button', { name: 'Meet your receptionist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeVisible();
  const business = await (await page.request.get('/api/me/business')).json();
  const response = await page.request.post(`/api/me/engine-presets`, {
    data: { name: 'Original profile', engine: 'pipeline', language: 'en' },
  });
  expect(response.ok()).toBe(true);
  const profile = await response.json();
  await connections(page);
  await openSettingsSections(page);
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toBeVisible();
  await newName(page).fill('Created profile');
  return { business, profile, path: `/api/me/engine-presets` };
}
const summaryModel = (page: Page) =>
  page.getByLabel('Conversation summaries', { exact: true }).getByLabel(/^Model/);
async function summaryDraft(page: Page, text: string) {
  await page.getByLabel('Summary connection').selectOption('workspace');
  await summaryModel(page).fill(text);
}
const rows = (page: Page) => page.getByRole('button', { name: 'Use setup', exact: true }).locator('..');
const newName = (page: Page) => page.getByLabel('Name a reusable setup', { exact: true });
const create = (page: Page) => page.getByRole('button', { name: /^(Save current voice setup)$/ });
const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
const matches = (request: Request, method: string, path: string) =>
  request.method() === method && new URL(request.url()).pathname === path;
async function mouseClick(page: Page, locator: Locator, twice = false) {
  // Do not let locator.click retry a disabled action until it becomes enabled.
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (twice) await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2);
  else await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}
async function hold(page: Page, match: (request: Request) => boolean, committed = false) {
  const pending = new Set<Route>();
  const held: { route: Route; response?: APIResponse }[] = [];
  let disposed = false;
  const handler = async (route: Route) => {
    if (!match(route.request())) return route.fallback();
    pending.add(route);
    const response = committed ? await route.fetch() : undefined;
    if (disposed) {
      await route.abort().catch(() => {});
      return;
    }
    if (response) expect(response.ok()).toBe(true);
    held.push({ route, response });
  };
  await page.route('**/api/**', handler);
  return {
    held,
    async release(index: number, error?: string) {
      const entry = held[index];
      pending.delete(entry.route);
      if (error) await entry.route.fulfill({ status: 503, json: { error } });
      else if (entry.response) await entry.route.fulfill({ response: entry.response });
      else await entry.route.continue();
    },
    async dispose() {
      disposed = true;
      for (const route of pending) await route.abort().catch(() => {});
      pending.clear();
      await page.unroute('**/api/**', handler);
      for (const entry of held) await entry.response?.dispose();
    },
  };
}
async function persisted(page: Page, path: string) {
  const response = await page.request.get(path);
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: string; name: string; llm_model: string }[];
}

test('one pending create admits one POST and one persisted id with confirmed no-op blur', async ({
  page,
}) => {
  const { path } = await setup(page);
  const gate = await hold(page, (request) => matches(request, 'POST', path), true);
  let listReads = 0,
    renameWrites = 0,
    postRequests = 0;
  page.on('request', (request) => {
    if (matches(request, 'GET', path)) listReads++;
    if (matches(request, 'POST', path)) postRequests++;
    if (request.method() === 'PUT' && new URL(request.url()).pathname.startsWith('/api/me/engine-presets/'))
      renameWrites++;
  });
  try {
    await create(page).dblclick();
    await expect.poll(() => gate.held.length).toBeGreaterThan(0);
    await frames(page);
    // Wait for all observed POST responses to reach the hold, including an original duplicate.
    await expect.poll(() => gate.held.length).toBe(postRequests);
    // Let every actually sent create settle before the original's first assertion.
    const sent = gate.held.length;
    for (let i = 0; i < sent; i++) await gate.release(i);
    await expect(rows(page)).toHaveCount(1 + sent);
    const saved = await persisted(page, path);
    console.log(
      'create-duplicate-diagnostic',
      JSON.stringify({ sent, saved: saved.map((p) => ({ id: p.id, name: p.name })), listReads }),
    );
    expect(sent).toBe(1);
    expect(saved.filter((p) => p.name === 'Created profile')).toHaveLength(1);
    expect(listReads).toBe(0);
    await expect(page.getByText('Reusable voice setup saved.', { exact: true })).toBeVisible();
    await expect(newName(page)).toHaveValue('');
    const input = rows(page).last().locator('input');
    await input.focus();
    await input.blur();
    await frames(page);
    expect(renameWrites).toBe(0);
  } finally {
    await gate.dispose();
  }
});

for (const draft of ['Newer name', 'Created profile']) {
  test(`create acknowledgement preserves later name revision and independent summary draft (${draft})`, async ({
    page,
  }) => {
    const { path, business } = await setup(page);
    // Configuration is now edited only in Assistants; seed its saved snapshot.
    const boot = await (await page.request.get('/api/me/bootstrap')).json();
    expect(
      (
        await page.request.put(`/api/me/assistants/${boot.assistants[0].id}`, {
          data: { engine: 'pipeline', llm_model: 'captured-model' },
        })
      ).ok(),
    ).toBe(true);
    await page.reload();
    await openSettingsSections(page);
    await newName(page).fill('Created profile');
    await expect(page.getByLabel(/^Text model override/)).toHaveValue('captured-model');
    await summaryDraft(page, 'Independent summary draft');
    const gate = await hold(page, (request) => matches(request, 'POST', path));
    try {
      await create(page).click();
      await expect.poll(() => gate.held.length).toBe(1);
      const submitted = gate.held[0].route.request().postDataJSON();
      expect(submitted.name).toBe('Created profile');
      expect(submitted.llm_model).toBe('captured-model');
      await newName(page).fill('Intermediate draft');
      await newName(page).fill(draft);

      await gate.release(0);
      await expect(rows(page)).toHaveCount(2);
      await expect(newName(page)).toHaveValue(draft);
      await expect(page.getByLabel(/^Text model override/)).toHaveValue('captured-model');
      await expect(summaryModel(page)).toHaveValue('Independent summary draft');
      expect((await persisted(page, path)).find((p) => p.name === 'Created profile')?.llm_model).toBe(
        'captured-model',
      );
    } finally {
      await gate.dispose();
    }
  });
}

for (const action of ['Use setup', 'Delete setup'] as const) {
  test(`pending create blocks ${action}, rename and Settings save until explicit later action`, async ({
    page,
  }) => {
    const { path, profile } = await setup(page);
    const gate = await hold(page, (request) => matches(request, 'POST', path));
    let competingWrites = 0;
    page.on('request', (request) => {
      if (request.method() !== 'GET' && !matches(request, 'POST', path)) competingWrites++;
    });
    try {
      await summaryDraft(page, 'Editable independent draft');
      await create(page).click();
      await expect.poll(() => gate.held.length).toBe(1);
      const row = rows(page).first(),
        input = row.locator('input');
      await mouseClick(page, row.getByRole('button', { name: action, exact: true }));
      await frames(page);
      // Original Delete may already have removed this row; discriminate before touching its input.
      console.log('create-competing-action-diagnostic', JSON.stringify({ action, competingWrites }));
      expect(competingWrites).toBe(0);
      await input.focus();
      await page.keyboard.press('End');
      await page.keyboard.type(' must not rename');
      await input.blur();
      await mouseClick(page, page.getByRole('button', { name: 'Save summary settings', exact: true }));
      await frames(page);
      expect(competingWrites).toBe(0);
      await expect(input).toHaveValue('Original profile');
      await gate.release(0);
      await expect(rows(page)).toHaveCount(2);
      await frames(page);
      expect(competingWrites).toBe(0);
      const response = page.waitForResponse((r) =>
        matches(
          r.request(),
          action === 'Use setup' ? 'POST' : 'DELETE',
          `/api/me/engine-presets/${profile.id}${action === 'Use setup' ? '/apply' : ''}`,
        ),
      );
      await row.getByRole('button', { name: action, exact: true }).click();
      expect((await response).ok()).toBe(true);
      await expect(create(page)).toBeDisabled(); // Name was cleared, not a queued create.
      await expect(rows(page)).toHaveCount(action === 'Use setup' ? 2 : 1);
      await expect(summaryModel(page)).toHaveValue('Editable independent draft');
    } finally {
      await gate.dispose();
    }
  });

  test(`pending ${action} blocks create and allows a later explicit create`, async ({ page }) => {
    const { path, profile } = await setup(page);
    const actionPath = `/api/me/engine-presets/${profile.id}${action === 'Use setup' ? '/apply' : ''}`;
    const gate = await hold(page, (request) =>
      matches(request, action === 'Use setup' ? 'POST' : 'DELETE', actionPath),
    );
    let creates = 0;
    page.on('request', (request) => {
      if (matches(request, 'POST', path)) creates++;
    });
    try {
      await rows(page).first().getByRole('button', { name: action, exact: true }).click();
      await expect.poll(() => gate.held.length).toBe(1);
      await mouseClick(page, create(page));
      await frames(page);
      expect(creates).toBe(0);
      await gate.release(0);
      await expect(create(page)).toBeEnabled();
      expect(creates).toBe(0);
      await create(page).click();
      await expect.poll(() => creates).toBe(1);
      await expect(rows(page)).toHaveCount(action === 'Use setup' ? 2 : 1);
      expect((await persisted(page, path)).filter((p) => p.name === 'Created profile')).toHaveLength(1);
    } finally {
      await gate.dispose();
    }
  });
}

test('blur then create stays blocked through the final queued rename and requires another click', async ({
  page,
}) => {
  const { path, profile } = await setup(page);
  const gate = await hold(page, (request) => matches(request, 'PUT', `/api/me/engine-presets/${profile.id}`));
  let creates = 0;
  page.on('request', (request) => {
    if (matches(request, 'POST', path)) creates++;
  });
  try {
    const input = rows(page).first().locator('input');
    await input.fill('First rename');
    await mouseClick(page, create(page));
    await expect.poll(() => gate.held.length).toBe(1);
    await frames(page);
    expect(creates).toBe(0);
    await input.fill('Newest rename');
    await input.blur();
    await gate.release(0);
    await expect.poll(() => gate.held.length).toBe(2);
    await mouseClick(page, create(page));
    await frames(page);
    expect(creates).toBe(0);
    await gate.release(1);
    await expect(create(page)).toBeEnabled();
    expect(creates).toBe(0);
    await create(page).click();
    await expect(rows(page)).toHaveCount(2);
    expect(creates).toBe(1);
    expect((await persisted(page, path)).find((p) => p.id === profile.id)?.name).toBe('Newest rename');
  } finally {
    await gate.dispose();
  }
});

// The current screen serializes refresh/create instead of admitting the old
// background Settings refresh. Exercise that reachable exclusion boundary.
for (const afterCommit of [false, true]) {
  test(`setup refresh blocks create until its authoritative list arrives (server committed=${afterCommit})`, async ({
    page,
  }) => {
    const { path, profile } = await setup(page);
    const gate = await hold(page, (r) => matches(r, 'GET', path), afterCommit);
    let creates = 0;
    page.on('request', (r) => {
      if (matches(r, 'POST', path)) creates++;
    });
    try {
      await rows(page).first().getByRole('button', { name: 'Use setup', exact: true }).click();
      await expect.poll(() => gate.held.length).toBe(1);
      await mouseClick(page, create(page));
      await frames(page);
      expect(creates).toBe(0);
      await gate.release(0);
      await expect(create(page)).toBeEnabled();
      await create(page).click();
      await expect(rows(page)).toHaveCount(2);
      expect(creates).toBe(1);
      expect((await persisted(page, path)).some((p) => p.id === profile.id)).toBe(true);
      expect((await persisted(page, path)).filter((p) => p.name === 'Created profile')).toHaveLength(1);
    } finally {
      await gate.dispose();
    }
  });
}

test('refused create preserves newer input and releases admission for one explicit retry', async ({
  page,
}) => {
  const { path } = await setup(page);
  const gate = await hold(page, (r) => matches(r, 'POST', path));
  try {
    await create(page).click();
    await expect.poll(() => gate.held.length).toBe(1);
    await newName(page).fill('Retry draft');
    await gate.release(0, 'Synthetic create refusal');
    await expect(page.getByRole('alert')).toContainText('Synthetic create refusal');
    await expect(newName(page)).toHaveValue('Retry draft');
    await expect(create(page)).toBeEnabled();
    expect(await persisted(page, path)).toHaveLength(1);
    await create(page).click();
    await expect.poll(() => gate.held.length).toBe(2);
    await gate.release(1);
    await expect(rows(page)).toHaveCount(2);
    await expect(newName(page)).toHaveValue('');
    expect((await persisted(page, path)).filter((p) => p.name === 'Retry draft')).toHaveLength(1);
  } finally {
    await gate.dispose();
  }
});

test('pending summary save excludes setup creation without repeating accepted writes', async ({ page }) => {
  const { path } = await setup(page);
  await summaryDraft(page, 'Accepted summary model');
  const gate = await hold(page, (r) => matches(r, 'PUT', '/api/me/call-summaries'));
  let creates = 0;
  page.on('request', (r) => {
    if (matches(r, 'POST', path)) creates++;
  });
  try {
    await page.getByRole('button', { name: 'Save summary settings', exact: true }).click();
    await expect.poll(() => gate.held.length).toBe(1);
    await mouseClick(page, create(page));
    await frames(page);
    expect(creates).toBe(0);
    await gate.release(0);
    await expect(create(page)).toBeEnabled();
    expect((await (await page.request.get('/api/me/call-summaries')).json()).model).toBe(
      'Accepted summary model',
    );
    await create(page).click();
    await expect(rows(page)).toHaveCount(2);
    expect(creates).toBe(1);
  } finally {
    await gate.dispose();
  }
});

for (const action of ['Use setup', 'Delete setup'] as const) {
  test(`failed ${action} display refresh excludes create and retries only reads`, async ({ page }) => {
    const { path } = await setup(page);
    let fail = true,
      mutations = 0;
    await summaryDraft(page, 'Unrelated summary draft');
    await page.route('**/api/me/engine-presets**', async (route) => {
      if (route.request().method() === 'GET' && fail)
        return route.fulfill({ status: 503, json: { error: 'Synthetic list refresh failure' } });
      if (route.request().method() !== 'GET') mutations++;
      return route.continue();
    });
    await rows(page).first().getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry setup refresh', exact: true })).toBeVisible();
    await expect(create(page)).toBeDisabled();
    expect(mutations).toBe(1);
    await expect(summaryModel(page)).toHaveValue('Unrelated summary draft');
    fail = false;
    await page.getByRole('button', { name: 'Retry setup refresh', exact: true }).click();
    await expect(create(page)).toBeEnabled();
    expect(mutations).toBe(1);
    await create(page).click();
    await expect(rows(page)).toHaveCount(action === 'Use setup' ? 2 : 1);
    expect(mutations).toBe(2);
    expect((await persisted(page, path)).filter((p) => p.name === 'Created profile')).toHaveLength(1);
  });
}
