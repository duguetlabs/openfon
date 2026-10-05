import { test, expect } from './fixtures';
import { signup, createWorkspace, workspaceMenu, connections, whoAnswers } from './cleanroom-helpers';
import type { Page } from '@playwright/test';

async function business(page: Page) {
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('heading', { name: 'My business', exact: true })).toBeVisible();
}
async function revealFacts(page: Page) {
  for (const details of await page.locator('.of-business-details').all()) {
    if (await details.getAttribute('open') === null) await details.locator('summary').click();
  }
}

test('existing business facts remain editable without dropping preserved row fields', async ({ page }) => {
  await signup(page, 'business-facts');
  const { business: workspace } = await createWorkspace(page);
  const facts = {
    hours_json: JSON.stringify([{ day: 'Monday', open: '09:00', close: '17:00', closed: false, note: 'Side entrance' }]),
    closures_json: JSON.stringify([{ date: '2027-01-01', reason: 'Holiday', note: 'Annual' }]),
    services_json: JSON.stringify([{ name: 'Repairs', price: '€20', duration: '30 minutes', notes: 'Assessment first' }]),
    faqs_json: JSON.stringify([{ q: 'Parking?', a: 'Outside.', source: 'Owner' }]),
  };
  expect((await page.request.put(`/api/me/business/${workspace.id}`, { data: facts })).ok()).toBe(true);
  await page.reload(); await business(page); await revealFacts(page);
  expect((await page.request.put(`/api/me/business/${workspace.id}`, { data: { phone: '+43 222 333' } })).ok()).toBe(true);
  await page.getByLabel('Monday opening time', { exact: true }).fill('08:30');
  await page.getByLabel('Closure 1 reason', { exact: true }).fill('New year closure');
  await page.getByLabel('Service 1 price', { exact: true }).fill('€25');
  await page.getByRole('textbox', { name: 'FAQ 1 answer', exact: true }).fill('Behind the workshop.');
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  await expect(page.getByText('Business details saved.',{exact:true})).toBeVisible();
  const saved = (await (await page.request.get('/api/me/bootstrap')).json()).workspace;
  expect(saved.phone).toBe('+43 222 333');
  expect(JSON.parse(saved.hours_json)[0]).toMatchObject({ open: '08:30', note: 'Side entrance' });
  expect(JSON.parse(saved.closures_json)[0]).toMatchObject({ reason: 'New year closure', note: 'Annual' });
  expect(JSON.parse(saved.services_json)[0]).toMatchObject({ price: '€25', duration: '30 minutes', notes: 'Assessment first' });
  expect(JSON.parse(saved.faqs_json)[0]).toMatchObject({ a: 'Behind the workshop.', source: 'Owner' });
  await business(page);
  await expect(page.getByLabel('Contact phone', { exact: true })).toHaveValue('+43 222 333');
  await page.getByLabel('Contact phone', { exact: true }).fill('+43 123 456');
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  await expect(page.getByText('Business details saved.',{exact:true})).toBeVisible();
  const later = (await (await page.request.get('/api/me/bootstrap')).json()).workspace;
  for (const key of Object.keys(facts)) expect(later[key]).toBe(saved[key]);
});

test('business save admits one write and keeps edits typed while acknowledgment is delayed', async ({ page }) => {
  await signup(page, 'business-ack');
  const { business: workspace } = await createWorkspace(page);
  await business(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  await page.route(`**/api/me/business/${workspace.id}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes++;
    if (writes > 1) return route.continue();
    const response = await route.fetch();
    await held; await route.fulfill({ response });
  });
  const input = page.getByLabel('Business name', { exact: true });
  await input.fill('First acknowledged name');
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await input.fill('Newer unsaved name');
  release();
  await expect(page.getByText('Business details saved.', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('Newer unsaved name');
  expect(writes).toBe(1);
  expect((await (await page.request.get('/api/me/bootstrap')).json()).workspace.name).toBe('First acknowledged name');
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  await expect(page.getByText('Business details saved.',{exact:true})).toBeVisible();
  expect(writes).toBe(2);
  expect((await (await page.request.get('/api/me/bootstrap')).json()).workspace.name).toBe('Newer unsaved name');
});

test('browser history, reload and deep links follow the current screen and protect dirty forms', async ({ page }) => {
  await signup(page, 'history'); await createWorkspace(page);
  await business(page); await expect(page).toHaveURL(/\/settings\/business$/);
  await connections(page); await expect(page).toHaveURL(/\/calls$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Call logs', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'My business', exact: true })).toBeVisible();
  await page.getByLabel('Business name', { exact: true }).fill('Keep this draft');
  page.once('dialog', dialog => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/business$/);
  await expect(page.getByLabel('Business name', { exact: true })).toHaveValue('Keep this draft');
  page.once('dialog', dialog => dialog.accept());
  await page.goBack(); await expect(page).toHaveURL(/\/settings\/assistants$/);
  await page.goForward(); await expect(page).toHaveURL(/\/settings\/business$/);
  await page.goto('/settings/account');
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  await page.goto('/calls');
  await expect(page.getByRole('heading', { name: 'Call logs' }).first()).toBeVisible();
});

test('integrated brand keeps business and connection controls usable on desktop and mobile', async ({ page }) => {
  await page.goto('/settings/assistants');
  await page.screenshot({ path: '/tmp/openfon-brand-integration/welcome-desktop.png', fullPage: true });
  await signup(page, 'visual-integration'); await createWorkspace(page, 'Oak Street Workshop');
  await page.screenshot({ path: '/tmp/openfon-brand-integration/desk-desktop.png', fullPage: true });
  await business(page); await revealFacts(page);
  await page.screenshot({ path: '/tmp/openfon-brand-integration/business-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/openfon-brand-integration/business-mobile.png', fullPage: true });
  await page.getByRole('navigation',{name:'Settings'}).getByRole('button',{name:'Assistants',exact:true}).click();
  await whoAnswers(page);
  const select=page.getByRole('combobox',{name:'Language',exact:true});
  await expect(select).toBeVisible();
  expect(await select.evaluate(element=>parseFloat(getComputedStyle(element).paddingRight))).toBeGreaterThanOrEqual(32);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('assistants-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:test.info().outputPath('assistants-desktop.png'),fullPage:true});
});


test('business refresh after an acknowledged save preserves concurrent fields and retries only reads', async ({ page }) => {
  await signup(page, 'business-read-recovery');
  const { business: workspace } = await createWorkspace(page);
  await business(page);
  let writes = 0, reads = 0;
  await page.route(`**/api/me/business/${workspace.id}`, async route => {
    if (route.request().method() === 'PUT') writes++;
    await route.continue();
  });
  await page.route('**/api/me/bootstrap', async route => {
    reads++;
    if (reads === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic refresh unavailable' } });
    await route.continue();
  });
  await page.getByLabel('Business name', { exact: true }).fill('  Canonical workshop  ');
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Business details were saved');
  await expect(page.getByRole('alert')).toContainText('Synthetic refresh unavailable');
  expect(writes).toBe(1);
  expect((await page.request.put(`/api/me/business/${workspace.id}`, { data: { phone: '+43 555 999' } })).ok()).toBe(true);
  await page.getByRole('textbox', { name: 'What you do', exact: true }).fill('Newer unsaved description');
  await expect(page.getByRole('button', { name: 'Save business details', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry business refresh', exact: true }).click();
  await expect(page.getByLabel('Business name', { exact: true })).toHaveValue('Canonical workshop');
  await expect(page.getByLabel('Contact phone', { exact: true })).toHaveValue('+43 555 999');
  await expect(page.getByRole('textbox', { name: 'What you do', exact: true })).toHaveValue('Newer unsaved description');
  expect(writes).toBe(1); expect(reads).toBe(2);
  await expect(page.getByRole('button', { name: 'Save business details', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  await expect(page.getByText('Business details saved.',{exact:true})).toBeVisible();
  expect(writes).toBe(2);
  await business(page);
  await expect(page.getByLabel('Contact phone', { exact: true })).toHaveValue('+43 555 999');
  await expect(page.getByRole('textbox', { name: 'What you do', exact: true })).toHaveValue('Newer unsaved description');
});


test('combined receptionist and knowledge drafts require only one navigation confirmation', async ({ page }) => {
  await signup(page, 'combined-drafts'); await createWorkspace(page);
  await page.getByLabel('Their first words').fill('Keep my receptionist draft.');
  await page.getByRole('button', { name: /What they know/ }).click();
  await page.getByRole('button', { name: 'Add business information', exact: true }).click();
  await page.getByLabel('What might a customer ask?', { exact: true }).fill('Keep my knowledge draft?');
  let dialogs = 0, accept = false;
  page.on('dialog', async dialog => { dialogs++; if (accept) await dialog.accept(); else await dialog.dismiss(); });
  await page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', { name: 'Call logs', exact: true }).click();
  expect(dialogs).toBe(1);
  await expect(page).toHaveURL(/\/settings\/assistants$/);
  await expect(page.getByLabel('What might a customer ask?', { exact: true })).toHaveValue('Keep my knowledge draft?');
  await expect(page.getByLabel('Their first words')).toHaveValue('Keep my receptionist draft.');
  accept = true;
  await page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', { name: 'Call logs', exact: true }).click();
  expect(dialogs).toBe(2);
  await expect(page).toHaveURL(/\/calls$/);
});

for (const refreshParent of [false, true]) {
  test(`editing a greeting preserves newer external receptionist fields (parent refresh=${refreshParent})`, async ({ page }) => {
    await signup(page, 'desk-peer-edits');
    const { assistant } = await createWorkspace(page);
    const path = `/api/me/assistants/${assistant.id}`;
    expect((await page.request.put(path, { data: {
      name: 'Ada', persona: 'Warm and clear', greeting: 'Original greeting.', engine: 'pipeline',
      language: 'en', voice: 'alloy', llm_model: 'gpt-4o-mini', custom_instructions: 'Original instructions.'
    } })).ok()).toBe(true);
    await page.reload();
    await whoAnswers(page);
    if (refreshParent) await page.getByLabel('Their first words').fill('Keep my newer greeting.');
    const peer = { language: 'fr', voice: 'coral', llm_model: 'gpt-4.1-mini', custom_instructions: 'Instructions saved by another tab.' };
    expect((await page.request.put(path, { data: peer })).ok()).toBe(true);
    if (refreshParent) {
      await page.getByRole('button', { name: /What they know/ }).click();
      const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === path);
      await page.getByRole('button', { name: 'Remove from receptionist', exact: true }).click();
      await (await refreshed).finished();
      await whoAnswers(page);
      await expect(page.getByLabel('Their first words')).toHaveValue('Keep my newer greeting.');
      await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('fr');
      await expect(page.getByRole('combobox', { name: 'Voice', exact: true })).toHaveValue('coral');
    } else await page.getByLabel('Their first words').fill('Keep my newer greeting.');
    const submitted: unknown[] = [];
    page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === path) submitted.push(request.postDataJSON()); });
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('Saved. Your next conversation will use this brief.', { exact: true })).toBeVisible();
    expect(submitted).toEqual([{ greeting: 'Keep my newer greeting.' }]);
    expect(await (await page.request.get(path)).json()).toMatchObject({ ...peer, greeting: 'Keep my newer greeting.' });
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  });
}

for (const refreshParent of [false, true]) {
  test(`restoring the original greeting during a pending save remains an unsaved draft (parent refresh=${refreshParent})`, async ({ page }) => {
    await signup(page, 'desk-original-draft');
    const { assistant } = await createWorkspace(page);
    const path = `/api/me/assistants/${assistant.id}`;
    expect((await page.request.put(path, { data: {
      name: 'Ada', persona: 'Warm and clear', greeting: 'Original greeting.', engine: 'pipeline'
    } })).ok()).toBe(true);
    await page.reload();
    await whoAnswers(page);
    let releaseSave!: () => void;
    const acknowledgement = new Promise<void>(resolve => { releaseSave = resolve; });
    const submitted: unknown[] = [];
    let savedOnServer = false;
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      submitted.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (submitted.length === 1) {
        savedOnServer = true;
        await acknowledgement;
      }
      await route.fulfill({ response });
    });
    const greeting = page.getByLabel('Their first words');
    const save = page.getByRole('button', { name: 'Save changes', exact: true });
    await greeting.fill('Submitted greeting.');
    await save.click();
    await expect.poll(() => savedOnServer).toBe(true);
    await greeting.fill('Original greeting.');
    if (refreshParent) {
      await page.getByRole('button', { name: /What they know/ }).click();
      const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === path);
      await page.getByRole('button', { name: 'Remove from receptionist', exact: true }).click();
      await (await refreshed).finished();
      await whoAnswers(page);
      await expect(greeting).toHaveValue('Original greeting.');
    }
    releaseSave();
    await expect(page.getByText('Saved. Your next conversation will use this brief.', { exact: true })).toBeVisible();
    await expect(greeting).toHaveValue('Original greeting.');
    await expect(save).toBeEnabled();
    expect(await (await page.request.get(path)).json()).toMatchObject({ greeting: 'Submitted greeting.' });
    await save.click();
    await expect(save).toHaveCount(0);
    expect(submitted).toEqual([{ greeting: 'Submitted greeting.' }, { greeting: 'Original greeting.' }]);
    expect(await (await page.request.get(path)).json()).toMatchObject({ greeting: 'Original greeting.' });
  });
}
