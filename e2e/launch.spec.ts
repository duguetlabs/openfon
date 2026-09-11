import { test, expect, type Page } from '@playwright/test';

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
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Assistant saved');
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
  await expect(page.getByRole('status')).toContainText('Collection created');
  await page.getByRole('button', { name: 'Add knowledge' }).click();
  await page.getByLabel('Question', { exact: true }).fill('Do you fix punctures?');
  await page.getByLabel('Answer', { exact: true }).fill('Yes. Bring your bicycle during opening hours.');
  await page.getByRole('button', { name: 'Save knowledge' }).click();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Alex', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Alex', exact: true })).toBeChecked();
  await expect(page.getByRole('status')).toContainText('Assistant knowledge updated');
  await page.reload();
  await page.getByRole('combobox', { name: 'Collection', exact: true }).selectOption({ label: 'Workshop services (1 items)' });
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
  await expect(page.getByRole('status')).toContainText('Password updated');
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
