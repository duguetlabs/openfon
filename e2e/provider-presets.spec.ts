import { fillCatalog, expectCatalog } from './catalog-fields';
import { test, expect } from './fixtures';

test('provider alternatives persist, keep custom models, and require a new key when endpoints change', async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`presets-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Provider test workshop');
  await page.getByLabel('What do you do?').fill('Synthetic browser validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await expect(page).toHaveURL('/overview');
  await page.goto('/settings');
  await expect(page.getByText(/Kataleptic is operated by OpenFon/)).toBeVisible();
  const select = page.getByLabel('Text provider preset', { exact: true });
  for (const [preset, url] of [['kataleptic','https://api.kataleptic.com/v1'], ['openrouter','https://openrouter.ai/api/v1'], ['huggingface','https://router.huggingface.co/v1'], ['openai','https://api.openai.com/v1']]) {
    await select.selectOption(preset);
    await expect(page.getByLabel('Text base URL', { exact: true })).toHaveValue(url);
  }
  await select.selectOption('openrouter');
  await fillCatalog(page, 'Workspace text model', 'custom/model:route');
  await page.getByLabel('Text API key', { exact: true }).fill('synthetic-text-key');
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByText('Provider settings saved.', { exact: false })).toBeVisible();
  await page.reload();
  await expect(select).toHaveValue('openrouter');
  await expectCatalog(page, 'Workspace text model', 'custom/model:route');
  await expect(page.getByLabel('Text API key', { exact: true })).toHaveValue('');
  await page.getByLabel('Text base URL', { exact: true }).fill('https://different.example/v1');
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Endpoint changed');
  await page.getByLabel('Text API key', { exact: true }).fill('synthetic-new-key');
  await page.getByLabel('Realtime provider', { exact: true }).selectOption('openai');
  await page.getByLabel('Realtime API key', { exact: true }).fill('synthetic-realtime-key');
  await page.getByLabel('Transcription provider', { exact: true }).selectOption('openai');
  await page.getByLabel('Transcription API key', { exact: true }).fill('synthetic-stt-key');
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByText('Provider settings saved.', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Realtime provider', { exact: true })).toHaveValue('openai');
  await expect(page.getByLabel('Transcription provider', { exact: true })).toHaveValue('openai');
  await expect(page.getByLabel('Realtime API key', { exact: true })).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('provider-settings-mobile.png'), fullPage: true });
});

test('provider draft guards navigation and sign-out, then resets after discard or save', async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`provider-guard-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Provider guard workshop');
  await page.getByLabel('What do you do?').fill('Synthetic draft guard validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  const navigation = page.getByRole('navigation', { name: 'Workspace' });
  await expect(navigation).toBeVisible();
  await navigation.getByRole('link', { name: 'Settings', exact: true }).click();
  const key = page.getByLabel('Text API key', { exact: true });
  await expectCatalog(page, 'Workspace text model', '');

  // Ordinary edits are protected, and cancelling leaves the current draft intact.
  await fillCatalog(page, 'Workspace text model', 'unsaved-model');
  const cancelNavigation = page.waitForEvent('dialog');
  const navigate = navigation.getByRole('link', { name: 'Overview', exact: true }).click();
  await (await cancelNavigation).dismiss();
  await navigate;
  await expect(page).toHaveURL('/settings');
  await expectCatalog(page, 'Workspace text model', 'unsaved-model');

  // A replacement key alone must block sign-out before the session is deleted.
  await fillCatalog(page, 'Workspace text model', '');
  await key.fill('synthetic-unsaved-key');
  const cancelSignOut = page.waitForEvent('dialog');
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await (await cancelSignOut).dismiss();
  await signOut;
  await expect(page).toHaveURL('/settings');
  await expect(key).toHaveValue('synthetic-unsaved-key');
  expect((await page.request.get('/api/me')).status()).toBe(200);

  // Accepting navigation discards the draft without sending it to the provider API.
  const acceptNavigation = page.waitForEvent('dialog');
  const discard = navigation.getByRole('link', { name: 'Overview', exact: true }).click();
  await (await acceptNavigation).accept();
  await discard;
  await expect(page).toHaveURL('/overview');
  await navigation.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(key).toHaveValue('');
  await expectCatalog(page, 'Workspace text model', '');
  expect((await (await page.request.get('/api/me/provider')).json()).workspaceApiKeyConfigured).toBe(false);

  // Reverting a write-only input to its empty baseline must not create a warning.
  const unexpectedDialogs: string[] = [];
  const rejectUnexpected = async (dialog: import('@playwright/test').Dialog) => {
    unexpectedDialogs.push(dialog.type());
    await dialog.dismiss();
  };
  page.on('dialog', rejectUnexpected);
  await key.fill('synthetic-reverted-key');
  await key.fill('');
  await navigation.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL('/overview');
  await navigation.getByRole('link', { name: 'Settings', exact: true }).click();

  // Successful save replaces the baseline and clears the secret input, allowing
  // both navigation and sign-out without a stale dirty-state prompt.
  await fillCatalog(page, 'Workspace text model', 'saved-model');
  await key.fill('synthetic-saved-key');
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByText('Provider settings saved.', { exact: false })).toBeVisible();
  await expect(key).toHaveValue('');
  await navigation.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL('/overview');
  await navigation.getByRole('link', { name: 'Settings', exact: true }).click();
  await expectCatalog(page, 'Workspace text model', 'saved-model');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('/auth');
  expect(unexpectedDialogs).toEqual([]);
  page.off('dialog', rejectUnexpected);
  expect((await page.request.get('/api/me')).status()).toBe(401);
});

test('confirmed provider save survives a failed refresh without resending credentials', async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`provider-refresh-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Provider refresh workshop');
  await page.getByLabel('What do you do?').fill('Synthetic refresh failure validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  const navigation = page.getByRole('navigation', { name: 'Workspace' });
  await expect(navigation).toBeVisible();
  await navigation.getByRole('link', { name: 'Settings', exact: true }).click();
  const key = page.getByLabel('Text API key', { exact: true });
  await expectCatalog(page, 'Workspace text model', '');

  let writes = 0;
  let failWrite = true;
  let failRefresh = true;
  await page.route('**/api/me/provider', async route => {
    if (route.request().method() === 'PUT') {
      if (failWrite) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic write failure' }) });
        return;
      }
      writes++;
      await route.continue(); // Actual workerd persists the submitted key/model.
    } else if (failRefresh) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic read failure' }) });
    } else await route.continue();
  });
  await fillCatalog(page, 'Workspace text model', 'persisted-despite-refresh');
  await key.fill('synthetic-refresh-key');
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic write failure');
  await expect(page.getByText('Provider settings saved.', { exact: false })).toHaveCount(0);
  await expect(key).toHaveValue('synthetic-refresh-key');
  const cancel = page.waitForEvent('dialog');
  const leave = navigation.getByRole('link', { name: 'Overview', exact: true }).click();
  await (await cancel).dismiss();
  await leave;
  await expect(page).toHaveURL('/settings');
  expect(writes).toBe(0);
  failWrite = false;
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByText('Provider settings saved.', { exact: false })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Provider settings were saved, but the provider settings display could not refresh');
  await expect(page.getByRole('alert')).toContainText('do not need to save again or re-enter API keys');
  await expect(key).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save provider settings', exact: true })).toBeDisabled();
  const persisted = await (await page.request.get('/api/me/provider')).json();
  expect(persisted).toMatchObject({ model: 'persisted-despite-refresh', workspaceApiKeyConfigured: true });
  expect(writes).toBe(1);

  // The recovery action only rereads confirmed data; no key replacement/PUT.
  failRefresh = false;
  let failWorkspace = true;
  await page.route('**/api/me/business', async route => {
    if (failWorkspace && route.request().method() === 'GET') await route.fulfill({ status: 503, json: { error: 'Synthetic workspace refresh failure' } });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Refresh saved provider settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Provider settings were saved, but the workspace display could not refresh');
  await expect(navigation).toBeVisible();
  await expect(key).toHaveValue('');
  expect(writes).toBe(1);
  failWorkspace = false;
  await page.getByRole('button', { name: 'Refresh saved provider settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh saved provider settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectCatalog(page, 'Workspace text model', 'persisted-despite-refresh');
  await expect(key).toHaveValue('');
  expect(writes).toBe(1);

  // A second injected failure also leaves the acknowledged draft clean before
  // recovery: navigation must not suggest discarding changes already saved.
  failRefresh = true;
  await fillCatalog(page, 'Workspace text model', 'second-confirmed-model');
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Provider settings were saved');
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  await navigation.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL('/overview');
  expect(dialogs).toEqual([]);
  expect(writes).toBe(2);
  const latest = await (await page.request.get('/api/me/provider')).json();
  expect(latest).toMatchObject({ model: 'second-confirmed-model', workspaceApiKeyConfigured: true });

  // A genuine authentication denial still clears the private shell.
  failRefresh = false;
  await navigation.getByRole('link', { name: 'Settings', exact: true }).click();
  await expectCatalog(page, 'Workspace text model', 'second-confirmed-model');
  await page.route('**/api/me', route => route.fulfill({ status: 401, json: { error: 'Session expired' } }));
  await fillCatalog(page, 'Workspace text model', 'saved-before-auth-expired');
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page).toHaveURL('/auth');
  await expect(navigation).toHaveCount(0);
});

test('provider save refresh preserves sibling drafts while updating untouched assistant fields', async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`provider-siblings-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Sibling baseline workshop');
  await page.getByLabel('What do you do?').fill('Synthetic sibling draft validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const business = await (await page.request.get('/api/me/business')).json();
  expect((await page.request.put(`/api/me/business/${business.id}`, { data: {
    hours_json: JSON.stringify([{ day: 'Monday', open: '09:00', close: '17:00', closed: false }]),
    services_json: JSON.stringify([{ name: 'Repair', price: '€40' }]),
    faqs_json: JSON.stringify([{ q: 'Parking?', a: 'Outside' }]),
    closures_json: JSON.stringify([{ date: '2026-12-25', reason: 'Holiday' }]),
  } })).ok()).toBe(true);
  expect((await page.request.put(`/api/me/business/${business.id}/agent`, { data: {
    engine: 'realtime', realtime_model: 'kataleptic-realtime-hd', realtime_voice: 'azure-gateway-voice',
  } })).ok()).toBe(true);
  await page.goto('/settings');
  await expect(page.getByLabel('Realtime voice (optional)', { exact: true })).toHaveValue('azure-gateway-voice');
  await page.getByLabel('Name', { exact: true }).fill('Unsaved business name');
  await page.getByLabel('Monday opening time', { exact: true }).fill('10:30');
  await page.getByLabel('Service 1 price', { exact: true }).fill('€99');
  await page.getByLabel('FAQ 1 answer', { exact: true }).fill('Unsaved parking answer');
  await page.getByLabel('Closure 1 reason', { exact: true }).fill('Unsaved closure reason');
  await page.getByLabel('Agent name', { exact: true }).fill('Unsaved assistant name');
  await page.getByLabel('Personality', { exact: true }).fill('Unsaved assistant personality');

  await page.getByLabel('Realtime provider', { exact: true }).selectOption('openai');
  await page.getByLabel('Realtime API key', { exact: true }).fill('synthetic-sibling-key');
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByText('Provider settings saved.', { exact: false })).toBeVisible();
  // Wait for the sibling reload itself: untouched gateway voice adopts the
  // server's provider-switch cleanup while edited assistant fields survive.
  await expect(page.getByLabel('Realtime voice (optional)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved business name');
  await expect(page.getByLabel('Monday opening time', { exact: true })).toHaveValue('10:30');
  await expect(page.getByLabel('Service 1 price', { exact: true })).toHaveValue('€99');
  await expect(page.getByLabel('FAQ 1 answer', { exact: true })).toHaveValue('Unsaved parking answer');
  await expect(page.getByLabel('Closure 1 reason', { exact: true })).toHaveValue('Unsaved closure reason');
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Unsaved assistant name');
  await expect(page.getByLabel('Personality', { exact: true })).toHaveValue('Unsaved assistant personality');
  const unchanged = await (await page.request.get('/api/me/business')).json();
  expect(unchanged.name).toBe('Sibling baseline workshop');
  expect(JSON.parse(unchanged.services_json)[0].price).toBe('€40');
  expect(unchanged.agent.agent_name).not.toBe('Unsaved assistant name');

  const savedAssistant = page.waitForResponse(response => response.url().endsWith(`/api/me/business/${business.id}/agent`) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await savedAssistant).ok()).toBe(true);
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved business name');
  await expect(page.getByLabel('Monday opening time', { exact: true })).toHaveValue('10:30');
  await expect(page.getByLabel('Service 1 price', { exact: true })).toHaveValue('€99');
  await expect(page.getByLabel('FAQ 1 answer', { exact: true })).toHaveValue('Unsaved parking answer');
  await expect(page.getByLabel('Closure 1 reason', { exact: true })).toHaveValue('Unsaved closure reason');
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Unsaved assistant name');
  await expect(page.getByLabel('Personality', { exact: true })).toHaveValue('Unsaved assistant personality');
  await expect(page.getByLabel('Realtime voice (optional)', { exact: true })).toHaveValue('');
});

test('historical profile previews do not overwrite names and deletion reloads later entries', async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`profile-recovery-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Profile-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Profile recovery workshop');
  await page.getByLabel('What do you do?').fill('Synthetic profile recovery validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await expect(page).toHaveURL('/overview');
  let reads=0, renamed=0, deleted=false;
  await page.route('**/api/me/business/*/profiles', route => {
    reads++;
    return route.fulfill({json:[{id:deleted?'later':'old',name:deleted?'Later historical profile':'Historical preview',engine:'pipeline',language:'en',voice:'',realtime_voice:'',realtime_model:'',llm_model:'',llm_base_url:'',llm_api_key:'',preview_only:deleted?0:1}]});
  });
  await page.route('**/api/me/profiles/*', route => {
    if(route.request().method()==='PUT') renamed++;
    if(route.request().method()==='DELETE') deleted=true;
    return route.fulfill({json:{ok:true}});
  });
  await page.goto('/settings');
  const preview=page.locator('input[value="Historical preview"]');
  await expect(preview).toHaveAttribute('readonly','');
  await preview.focus();await page.getByRole('heading',{name:'Engine profiles'}).click();
  expect(renamed).toBe(0);
  await page.getByRole('button',{name:'Delete profile',exact:true}).click();
  await expect(page.locator('input[value="Later historical profile"]')).toBeVisible();
  expect(reads).toBe(2);expect(deleted).toBe(true);expect(renamed).toBe(0);
});
