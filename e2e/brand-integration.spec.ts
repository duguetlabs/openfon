import { test, expect } from './fixtures';
import { signup, createWorkspace, workspaceMenu, connections } from './cleanroom-helpers';
import type { Page } from '@playwright/test';

async function business(page: Page) {
  await page.getByRole('main').getByRole('button', { name: 'Business details', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your business', exact: true })).toBeVisible();
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
  await page.getByLabel('Monday opening time', { exact: true }).fill('08:30');
  await page.getByLabel('Closure 1 reason', { exact: true }).fill('New year closure');
  await page.getByLabel('Service 1 price', { exact: true }).fill('€25');
  await page.getByRole('textbox', { name: 'FAQ 1 answer', exact: true }).fill('Behind the workshop.');
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  const saved = (await (await page.request.get('/api/me/bootstrap')).json()).workspace;
  expect(JSON.parse(saved.hours_json)[0]).toMatchObject({ open: '08:30', note: 'Side entrance' });
  expect(JSON.parse(saved.closures_json)[0]).toMatchObject({ reason: 'New year closure', note: 'Annual' });
  expect(JSON.parse(saved.services_json)[0]).toMatchObject({ price: '€25', duration: '30 minutes', notes: 'Assessment first' });
  expect(JSON.parse(saved.faqs_json)[0]).toMatchObject({ a: 'Behind the workshop.', source: 'Owner' });
  await business(page);
  await page.getByLabel('Contact phone', { exact: true }).fill('+43 123 456');
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
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
  await expect(page).toHaveURL(/\/overview$/);
  expect(writes).toBe(2);
  expect((await (await page.request.get('/api/me/bootstrap')).json()).workspace.name).toBe('Newer unsaved name');
});

test('browser history, reload and deep links follow the current screen and protect dirty forms', async ({ page }) => {
  await signup(page, 'history'); await createWorkspace(page);
  await business(page); await expect(page).toHaveURL(/\/business$/);
  await connections(page); await expect(page).toHaveURL(/\/connections$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your connections', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Your business', exact: true })).toBeVisible();
  await page.getByLabel('Business name', { exact: true }).fill('Keep this draft');
  page.once('dialog', dialog => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(/\/business$/);
  await expect(page.getByLabel('Business name', { exact: true })).toHaveValue('Keep this draft');
  page.once('dialog', dialog => dialog.accept());
  await page.goBack(); await expect(page).toHaveURL(/\/overview$/);
  await page.goForward(); await expect(page).toHaveURL(/\/business$/);
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  await page.goto('/conversations');
  await expect(page.getByRole('heading', { name: /Messages|Conversations/ }).first()).toBeVisible();
});

test('integrated brand keeps business and connection controls usable on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  await page.screenshot({ path: '/tmp/openfon-brand-integration/welcome-desktop.png', fullPage: true });
  await signup(page, 'visual-integration'); await createWorkspace(page, 'Oak Street Workshop');
  await page.screenshot({ path: '/tmp/openfon-brand-integration/desk-desktop.png', fullPage: true });
  await business(page); await revealFacts(page);
  await page.screenshot({ path: '/tmp/openfon-brand-integration/business-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/openfon-brand-integration/business-mobile.png', fullPage: true });
  await connections(page);
  for (const details of await page.locator('.of-brand-connections details').all()) {
    if (await details.getAttribute('open') === null) await details.locator('summary').first().click();
  }
  const select = page.getByRole('combobox', { name: 'Conversation engine', exact: true });
  await expect(select).toBeVisible();
  expect(await select.evaluate(element => parseFloat(getComputedStyle(element).paddingRight))).toBeGreaterThanOrEqual(48);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/openfon-brand-integration/connections-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: '/tmp/openfon-brand-integration/connections-desktop.png', fullPage: true });
});
