import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';

async function setup(page: Page, count = 1) {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`rename-actions-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Rename action workshop');
  await page.getByLabel('What do you do?').fill('Synthetic pending profile rename validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const business = await (await page.request.get('/api/me/business')).json();
  const profiles: { id: string; name: string }[] = [];
  for (let i = 0; i < count; i++) {
    const response = await page.request.post(`/api/me/business/${business.id}/profiles`, {
      data: { name: `Original ${i}`, engine: 'pipeline', language: 'en' },
    });
    expect(response.ok()).toBe(true); profiles.push(await response.json());
  }
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(count);
  return { business, profiles };
}
const rows = (page: Page) => page.getByRole('button', { name: 'Apply', exact: true }).locator('..');
const frames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function gateRenames(page: Page) {
  const held: Route[] = [], outstanding = new Set<Route>();
  await page.route('**/api/me/profiles/*', route => {
    if (route.request().method() !== 'PUT') return route.continue();
    held.push(route); outstanding.add(route);
  });
  return {
    held,
    async settle(index: number, error?: string) {
      const route = held[index]; outstanding.delete(route);
      if (error) await route.fulfill({ status: 503, json: { error } });
      else await route.continue();
    },
    async dispose() { for (const route of outstanding) await route.abort().catch(() => {}); outstanding.clear(); },
  };
}
async function expectGated(page: Page, count: number) {
  await expect(page.getByRole('status').filter({ hasText: 'Saving profile names…' })).toBeVisible();
  for (let i = 0; i < count; i++) {
    await expect(rows(page).nth(i).getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await expect(rows(page).nth(i).getByRole('button', { name: 'Delete profile', exact: true })).toBeDisabled();
  }
}

for (const action of ['Apply', 'Delete profile'] as const) {
  test(`blur then ${action} sends no action while rename is pending; explicit later click works`, async ({ page }) => {
    const { business, profiles } = await setup(page), id = profiles[0].id;
    const gate = await gateRenames(page);
    let actions = 0;
    page.on('request', request => {
      if ((request.method() === 'POST' && request.url().endsWith(`/profiles/${id}/apply`)) ||
          (request.method() === 'DELETE' && request.url().endsWith(`/profiles/${id}`))) actions++;
    });
    try {
      const row = rows(page).first(), input = row.locator('input'), button = row.getByRole('button', { name: action, exact: true });
      await expect(button).toBeEnabled();
      // Real mouse order: mousedown blurs the input before click. Do not use
      // locator.click(), whose disabled-button retry could queue the test action.
      await button.scrollIntoViewIfNeeded(); const box = await button.boundingBox(); expect(box).not.toBeNull();
      await input.fill('Renamed before action');
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expect.poll(() => gate.held.length).toBe(1); await frames(page);
      expect(actions).toBe(0); await expectGated(page, 1);
      const saved = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/profiles/${id}`));
      await gate.settle(0); expect((await saved).ok()).toBe(true);
      await expect(button).toBeEnabled(); expect(actions).toBe(0);
      const acted = page.waitForResponse(response => response.url().endsWith(`/profiles/${id}${action === 'Apply' ? '/apply' : ''}`) && response.request().method() === (action === 'Apply' ? 'POST' : 'DELETE'));
      await button.click(); expect((await acted).ok()).toBe(true); expect(actions).toBe(1);
      const persisted = await (await page.request.get(`/api/me/business/${business.id}/profiles`)).json() as { id: string; name: string }[];
      if (action === 'Apply') expect(persisted.find(p => p.id === id)?.name).toBe('Renamed before action');
      else expect(persisted.some(p => p.id === id)).toBe(false);
    } finally { await gate.dispose(); }
  });
}

test('all profiles stay gated until both per-id queues and newer queued draft settle', async ({ page }) => {
  const { business } = await setup(page, 2), gate = await gateRenames(page);
  try {
    const first = rows(page).nth(0).locator('input'), second = rows(page).nth(1).locator('input');
    await first.fill('First pending'); await first.blur(); await expect.poll(() => gate.held.length).toBe(1);
    await first.fill('First newest'); await first.blur();
    await second.fill('Second pending'); await second.blur(); await expect.poll(() => gate.held.length).toBe(2);
    await expectGated(page, 2);
    await gate.settle(0); await expect.poll(() => gate.held.length).toBe(3);
    await expect(first).toHaveValue('First newest'); await expectGated(page, 2);
    await gate.settle(1); await frames(page); await expectGated(page, 2);
    const last = page.waitForResponse(response => response.request().method() === 'PUT' && response.request().postDataJSON()?.name === 'First newest');
    await gate.settle(2); expect((await last).ok()).toBe(true);
    await expect(page.getByRole('status').filter({ hasText: 'Saving profile names…' })).toHaveCount(0);
    for (let i = 0; i < 2; i++) {
      await expect(rows(page).nth(i).getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
      await expect(rows(page).nth(i).getByRole('button', { name: 'Delete profile', exact: true })).toBeEnabled();
    }
    await first.focus(); await first.blur(); await second.focus(); await second.blur(); await frames(page);
    expect(gate.held.length).toBe(3);
    const persisted = await (await page.request.get(`/api/me/business/${business.id}/profiles`)).json() as { name: string }[];
    expect(persisted.map(p => p.name).sort()).toEqual(['First newest', 'Second pending']);
  } finally { await gate.dispose(); }
});

test('failed rename releases actions with error and confirmed baseline, then retry gates again', async ({ page }) => {
  await setup(page); const gate = await gateRenames(page);
  try {
    const input = rows(page).first().locator('input');
    await input.fill('Attempted'); await input.blur(); await expect.poll(() => gate.held.length).toBe(1);
    await expectGated(page, 1); await gate.settle(0, 'Synthetic rename refusal');
    await expect(input).toHaveValue('Original 0');
    await expect(page.getByText('Synthetic rename refusal', { exact: true })).toBeVisible();
    await expect(rows(page).first().getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    await input.focus(); await input.blur(); await frames(page); expect(gate.held.length).toBe(1);
    await input.fill('Retry'); await input.blur(); await expect.poll(() => gate.held.length).toBe(2); await expectGated(page, 1);
    // A newer unblurred draft must survive the pending request's acknowledgement.
    await input.fill('Newer draft'); await gate.settle(1);
    await expect(rows(page).first().getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    await expect(input).toHaveValue('Newer draft');
    await input.blur(); await expect.poll(() => gate.held.length).toBe(3); await expectGated(page, 1);
    await gate.settle(2); await expect(rows(page).first().getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    await page.reload(); await expect(rows(page).first().locator('input')).toHaveValue('Newer draft');
  } finally { await gate.dispose(); }
});


test('profile action retry guidance stays visible before during and after rename', async ({ page }) => {
  await setup(page); const gate = await gateRenames(page);
  const guidance = page.getByText('If you click Apply or Delete profile while a name is saving, click it again after saving finishes.', { exact: true });
  try {
    await expect(guidance).toBeVisible();
    const input = rows(page).first().locator('input');
    await input.fill('Guided rename'); await input.blur();
    await expect.poll(() => gate.held.length).toBe(1);
    await expectGated(page, 1); await expect(guidance).toBeVisible();
    await gate.settle(0);
    await expect(rows(page).first().getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    await expect(guidance).toBeVisible(); await expect(input).toHaveValue('Guided rename');
  } finally { await gate.dispose(); }
});
