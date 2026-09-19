import { test, expect } from './fixtures';
import type { APIResponse, Locator, Page, Request, Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Production browser/HTTP, with synthetic request/response holds. No provider inference.
async function setup(page: Page) {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`create-profile-${randomUUID()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Create profile workshop');
  await page.getByLabel('What do you do?').fill('Synthetic profile creation validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const business = await (await page.request.get('/api/me/business')).json();
  const response = await page.request.post(`/api/me/business/${business.id}/profiles`, {
    data: { name: 'Original profile', engine: 'pipeline', language: 'en' },
  });
  expect(response.ok()).toBe(true);
  const profile = await response.json();
  await page.goto('/settings');
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Save provider settings', exact: true })).toBeEnabled();
  await newName(page).fill('Created profile');
  return { business, profile, path: `/api/me/business/${business.id}/profiles` };
}
const rows = (page: Page) => page.getByRole('button', { name: 'Apply', exact: true }).locator('..');
const newName = (page: Page) => page.getByPlaceholder('Save current setup as… e.g. "Realtime HD English (Emma)"');
const create = (page: Page) => page.getByRole('button', { name: /^(Save profile|Saving profile…)$/ });
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const matches = (request: Request, method: string, path: string) => request.method() === method && new URL(request.url()).pathname === path;
async function mouseClick(page: Page, locator: Locator, twice = false) {
  // Do not let locator.click retry a disabled action until it becomes enabled.
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox(); expect(box).not.toBeNull();
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
    if (disposed) { await route.abort().catch(() => {}); return; }
    if (response) expect(response.ok()).toBe(true);
    held.push({ route, response });
  };
  await page.route('**/api/**', handler);
  return {
    held,
    async release(index: number, error?: string) {
      const entry = held[index]; pending.delete(entry.route);
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
  const response = await page.request.get(path); expect(response.ok()).toBe(true);
  return await response.json() as { id: string; name: string; llm_model: string }[];
}

test('one pending create admits one POST and one persisted id with confirmed no-op blur', async ({ page }) => {
  const { path } = await setup(page);
  const gate = await hold(page, request => matches(request, 'POST', path), true);
  let listReads = 0, renameWrites = 0, postRequests = 0;
  page.on('request', request => {
    if (matches(request, 'GET', path)) listReads++;
    if (matches(request, 'POST', path)) postRequests++;
    if (request.method() === 'PUT' && new URL(request.url()).pathname.startsWith('/api/me/profiles/')) renameWrites++;
  });
  try {
    await create(page).dblclick();
    await expect.poll(() => gate.held.length).toBeGreaterThan(0); await frames(page);
    // Wait for all observed POST responses to reach the hold, including an original duplicate.
    await expect.poll(() => gate.held.length).toBe(postRequests);
    // Let every actually sent create settle before the original's first assertion.
    const sent = gate.held.length;
    for (let i = 0; i < sent; i++) await gate.release(i);
    await expect(rows(page)).toHaveCount(1 + sent);
    const saved = await persisted(page, path);
    console.log('create-duplicate-diagnostic', JSON.stringify({ sent, saved: saved.map(p => ({ id: p.id, name: p.name })), listReads }));
    expect(sent).toBe(1);
    expect(saved.filter(p => p.name === 'Created profile')).toHaveLength(1);
    expect(listReads).toBe(0);
    await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
    await expect(newName(page)).toHaveValue('');
    const input = rows(page).last().locator('input');
    await input.focus(); await input.blur(); await frames(page);
    expect(renameWrites).toBe(0);
  } finally { await gate.dispose(); }
});

for (const draft of ['Newer name', 'Created profile']) {
  test(`create acknowledgement preserves later name revision and assistant draft (${draft})`, async ({ page }) => {
    const { path } = await setup(page);
    await page.getByRole('radio', { name: /^Pipeline/ }).check();
    await page.getByLabel('Assistant text model override', { exact: true }).fill('captured-model');
    const gate = await hold(page, request => matches(request, 'POST', path));
    try {
      await create(page).click(); await expect.poll(() => gate.held.length).toBe(1);
      const submitted = gate.held[0].route.request().postDataJSON();
      expect(submitted.name).toBe('Created profile'); expect(submitted.llm_model).toBe('captured-model');
      await newName(page).fill('Intermediate draft'); await newName(page).fill(draft);
      await page.getByLabel('Assistant text model override', { exact: true }).fill('newer-model');
      await page.getByLabel('Name', { exact: true }).fill('Newer workspace draft');
      await gate.release(0); await expect(rows(page)).toHaveCount(2);
      await expect(newName(page)).toHaveValue(draft);
      await expect(page.getByLabel('Assistant text model override', { exact: true })).toHaveValue('newer-model');
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Newer workspace draft');
      expect((await persisted(page, path)).find(p => p.name === 'Created profile')?.llm_model).toBe('captured-model');
    } finally { await gate.dispose(); }
  });
}

for (const action of ['Apply', 'Delete profile'] as const) {
  test(`pending create blocks ${action}, rename and Settings save until explicit later action`, async ({ page }) => {
    const { path, profile } = await setup(page);
    const gate = await hold(page, request => matches(request, 'POST', path));
    let competingWrites = 0;
    page.on('request', request => {
      if (request.method() !== 'GET' && !matches(request, 'POST', path)) competingWrites++;
    });
    try {
      await create(page).click(); await expect.poll(() => gate.held.length).toBe(1);
      await page.getByLabel('Name', { exact: true }).fill('Editable business draft');
      const row = rows(page).first(), input = row.locator('input');
      await mouseClick(page, row.getByRole('button', { name: action, exact: true }));
      await frames(page);
      // Original Delete may already have removed this row; discriminate before touching its input.
      console.log('create-competing-action-diagnostic', JSON.stringify({ action, competingWrites }));
      expect(competingWrites).toBe(0);
      await input.focus(); await page.keyboard.press('End'); await page.keyboard.type(' must not rename'); await input.blur();
      await mouseClick(page, page.getByRole('button', { name: /^(Save changes|Saving…)$/ })); await frames(page);
      expect(competingWrites).toBe(0);
      await expect(input).toHaveValue('Original profile');
      await gate.release(0); await expect(rows(page)).toHaveCount(2); await frames(page);
      expect(competingWrites).toBe(0);
      const response = page.waitForResponse(r => matches(r.request(), action === 'Apply' ? 'POST' : 'DELETE', `/api/me/profiles/${profile.id}${action === 'Apply' ? '/apply' : ''}`));
      await row.getByRole('button', { name: action, exact: true }).click(); expect((await response).ok()).toBe(true);
      await expect(create(page)).toBeDisabled(); // Name was cleared, not a queued create.
      await expect(rows(page)).toHaveCount(action === 'Apply' ? 2 : 1);
      await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Editable business draft');
    } finally { await gate.dispose(); }
  });

  test(`pending ${action} blocks create and allows a later explicit create`, async ({ page }) => {
    const { path, profile } = await setup(page);
    const actionPath = `/api/me/profiles/${profile.id}${action === 'Apply' ? '/apply' : ''}`;
    const gate = await hold(page, request => matches(request, action === 'Apply' ? 'POST' : 'DELETE', actionPath));
    let creates = 0; page.on('request', request => { if (matches(request, 'POST', path)) creates++; });
    try {
      await rows(page).first().getByRole('button', { name: action, exact: true }).click();
      await expect.poll(() => gate.held.length).toBe(1);
      await mouseClick(page, create(page)); await frames(page); expect(creates).toBe(0);
      await gate.release(0); await expect(create(page)).toBeEnabled(); expect(creates).toBe(0);
      await create(page).click(); await expect.poll(() => creates).toBe(1);
      await expect(rows(page)).toHaveCount(action === 'Apply' ? 2 : 1);
      expect((await persisted(page, path)).filter(p => p.name === 'Created profile')).toHaveLength(1);
    } finally { await gate.dispose(); }
  });
}

test('blur then create stays blocked through the final queued rename and requires another click', async ({ page }) => {
  const { path, profile } = await setup(page);
  const gate = await hold(page, request => matches(request, 'PUT', `/api/me/profiles/${profile.id}`));
  let creates = 0; page.on('request', request => { if (matches(request, 'POST', path)) creates++; });
  try {
    const input = rows(page).first().locator('input');
    await input.fill('First rename'); await mouseClick(page, create(page));
    await expect.poll(() => gate.held.length).toBe(1); await frames(page);
    expect(creates).toBe(0);
    await input.fill('Newest rename'); await input.blur();
    await gate.release(0); await expect.poll(() => gate.held.length).toBe(2);
    await mouseClick(page, create(page)); await frames(page); expect(creates).toBe(0);
    await gate.release(1); await expect(create(page)).toBeEnabled(); expect(creates).toBe(0);
    await create(page).click(); await expect(rows(page)).toHaveCount(2);
    expect(creates).toBe(1);
    expect((await persisted(page, path)).find(p => p.id === profile.id)?.name).toBe('Newest rename');
  } finally { await gate.dispose(); }
});

test('independent Settings refresh suppresses list dispatch during committed create and preserves drafts', async ({ page }) => {
  const { path, business } = await setup(page);
  const gate = await hold(page, request => matches(request, 'POST', path), true);
  let listReads = 0;
  page.on('request', request => { if (matches(request, 'GET', path)) listReads++; });
  try {
    await create(page).click(); await expect.poll(() => gate.held.length).toBe(1);
    // This accepted external edit makes completion of the independent Settings read observable.
    expect((await page.request.put(`/api/me/business/${business.id}/agent`, { data: { agent_name: 'Independent refresh marker' } })).ok()).toBe(true);
    await page.getByLabel('Name', { exact: true }).fill('Retained workspace draft');
    await newName(page).fill('Next profile draft');
    await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
    await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Independent refresh marker');
    await frames(page);
    // Do not wait for a GET which fixed code intentionally does not dispatch.
    console.log('create-read-suppression-diagnostic', JSON.stringify({ listReads, acknowledged: false }));
    expect(listReads).toBe(0);
    await gate.release(0); await expect(rows(page)).toHaveCount(2);
    await expect(newName(page)).toHaveValue('Next profile draft');
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Retained workspace draft');
    await frames(page); expect(listReads).toBe(0);
    // Later independent reads remain authoritative; no create response replays.
    await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
    await expect.poll(() => listReads).toBeGreaterThan(0);
    await expect(rows(page)).toHaveCount(2);
  } finally { await gate.dispose(); }
});

test('a pre-create list response is not adopted while create is pending', async ({ page }) => {
  const { path, profile } = await setup(page);
  expect((await page.request.put(`/api/me/profiles/${profile.id}`, { data: { name: 'External list marker' } })).ok()).toBe(true);
  const readGate = await hold(page, request => matches(request, 'GET', path), true);
  const createGate = await hold(page, request => matches(request, 'POST', path), true);
  try {
    await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
    await expect.poll(() => readGate.held.length).toBe(1);
    expect((await readGate.held[0].response!.json())[0].name).toBe('External list marker');
    await create(page).click(); await expect.poll(() => createGate.held.length).toBe(1);
    await readGate.release(0); await frames(page);
    await expect(rows(page).first().locator('input')).toHaveValue('Original profile');
    await createGate.release(0); await expect(rows(page)).toHaveCount(2);
    expect((await persisted(page, path)).find(p => p.id === profile.id)?.name).toBe('External list marker');
  } finally { await createGate.dispose(); await readGate.dispose(); }
});

test('a pre-create list response cannot remove the acknowledged row after creation settles', async ({ page }) => {
  const { path } = await setup(page);
  const readGate = await hold(page, request => matches(request, 'GET', path), true);
  try {
    await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
    await expect.poll(() => readGate.held.length).toBe(1);
    expect((await readGate.held[0].response!.json()).length).toBe(1);
    await create(page).click(); await expect(rows(page)).toHaveCount(2);
    await readGate.release(0); await frames(page);
    await expect(rows(page)).toHaveCount(2);
    expect((await persisted(page, path)).filter(p => p.name === 'Created profile')).toHaveLength(1);
  } finally { await readGate.dispose(); }
});

test('refused create preserves newer input and releases admission for one explicit retry', async ({ page }) => {
  const { path } = await setup(page);
  const gate = await hold(page, request => matches(request, 'POST', path));
  try {
    await create(page).click(); await expect.poll(() => gate.held.length).toBe(1);
    await newName(page).fill('Retry draft');
    await gate.release(0, 'Synthetic create refusal');
    await expect(page.getByRole('alert')).toContainText('Synthetic create refusal');
    await expect(newName(page)).toHaveValue('Retry draft'); await expect(create(page)).toBeEnabled();
    expect(await persisted(page, path)).toHaveLength(1);
    await create(page).click(); await expect.poll(() => gate.held.length).toBe(2);
    await gate.release(1); await expect(rows(page)).toHaveCount(2);
    await expect(newName(page)).toHaveValue('');
    expect((await persisted(page, path)).filter(p => p.name === 'Retry draft')).toHaveLength(1);
  } finally { await gate.dispose(); }
});

test('pending Settings save excludes create without changing accepted save stages', async ({ page }) => {
  const { path, business } = await setup(page);
  const gate = await hold(page, request => matches(request, 'PUT', `/api/me/business/${business.id}`));
  let creates = 0; page.on('request', request => { if (matches(request, 'POST', path)) creates++; });
  try {
    await page.getByLabel('Name', { exact: true }).fill('Accepted workspace name');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => gate.held.length).toBe(1);
    await mouseClick(page, create(page)); await frames(page); expect(creates).toBe(0);
    await gate.release(0); await expect(create(page)).toBeEnabled(); expect(creates).toBe(0);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Accepted workspace name');
    await create(page).click(); await expect(rows(page)).toHaveCount(2); expect(creates).toBe(1);
  } finally { await gate.dispose(); }
});

async function failSettingsRefresh(page: Page) {
  let fail = true;
  const handler = (route: Route) => {
    if (fail && matches(route.request(), 'GET', '/api/me')) {
      fail = false;
      return route.fulfill({ status: 503, json: { error: 'Synthetic accepted-save refresh failure' } });
    }
    return route.fallback();
  };
  await page.route('**/api/me', handler);
  await page.getByLabel('Name', { exact: true }).fill('Saved before failed refresh');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry settings refresh', exact: true })).toBeEnabled();
  await page.unroute('**/api/me', handler);
}

for (const first of ['create', 'retry'] as const) {
  test(`Settings retry and create exclude each other (${first} first)`, async ({ page }) => {
    const { path } = await setup(page); await failSettingsRefresh(page);
    const gate = await hold(page, request => first === 'create' ? matches(request, 'POST', path) : matches(request, 'GET', '/api/me'));
    let creates = 0, sessionReads = 0;
    page.on('request', request => {
      if (matches(request, 'POST', path)) creates++;
      if (matches(request, 'GET', '/api/me')) sessionReads++;
    });
    try {
      const retry = page.getByRole('button', { name: 'Retry settings refresh', exact: true });
      await (first === 'create' ? create(page) : retry).click();
      await expect.poll(() => gate.held.length).toBe(1);
      await mouseClick(page, first === 'create' ? retry : create(page)); await frames(page);
      expect(first === 'create' ? sessionReads : creates).toBe(0);
      await gate.release(0);
      if (first === 'create') {
        await expect(rows(page)).toHaveCount(2); await expect(retry).toBeEnabled();
        expect(sessionReads).toBe(0); await retry.click(); await expect(retry).toHaveCount(0);
      } else {
        await expect(create(page)).toBeEnabled(); expect(creates).toBe(0);
        await create(page).click(); await expect(rows(page)).toHaveCount(2);
      }
      expect(creates).toBe(1);
    } finally { await gate.dispose(); }
  });
}
