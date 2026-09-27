import { openAuth, connections, workspaceMenu, whoAnswers } from './cleanroom-helpers';
import { fillCatalog, expectCatalog } from './catalog-fields';
import { test, expect, openSettingsSections } from './fixtures';

test('provider alternatives persist, keep custom models, and require a new key when endpoints change', async ({ page }) => {
  await openAuth(page);
  await page.getByLabel('Email').fill(`presets-${Date.now()}@example.invalid`);
  await page.getByLabel(/^Password/).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Provider test workshop');
  await page.getByLabel('What do you do?').fill('Synthetic browser validation');
  await page.getByRole('button', { name: 'Meet your receptionist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeVisible();
  await expect(page).toHaveURL('/overview');
  await connections(page);
  await openSettingsSections(page);
  await expect(page.getByRole('heading', { name: 'Your connections', exact: true })).toBeVisible();
  const select = page.getByRole('combobox', { name: 'Provider preset', exact: true });
  for (const [preset, url] of [['kataleptic','https://api.kataleptic.com/v1'], ['openrouter','https://openrouter.ai/api/v1'], ['huggingface','https://router.huggingface.co/v1'], ['openai','https://api.openai.com/v1']]) {
    await select.selectOption(preset);
    await expect(page.getByLabel('Compatible API URL', { exact: true })).toHaveValue(url);
  }
  await select.selectOption('openrouter');
  await page.getByLabel('Workspace text model', {exact:true}).fill('custom/model:route');
  await page.getByLabel(/^Text API key/).fill('synthetic-text-key');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByText('Connections saved.', { exact: false })).toBeVisible();
  await page.reload();
  await openSettingsSections(page);
  await expect(page.getByLabel('Compatible API URL', {exact:true})).toHaveValue('https://openrouter.ai/api/v1');
  await expectCatalog(page, 'Workspace text model', 'custom/model:route');
  await expect(page.getByLabel(/^Text API key/)).toHaveValue('');
  await page.getByLabel('Compatible API URL', { exact: true }).fill('https://different.example/v1');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Endpoint changed');
  await page.getByLabel(/^Text API key/).fill('synthetic-new-key');
  await page.getByRole('combobox', { name: 'Realtime provider', exact: true }).selectOption('openai');
  await page.getByLabel(/^Realtime API key/).fill('synthetic-realtime-key');
  await page.getByRole('combobox', { name: 'Transcription provider', exact: true }).selectOption('openai');
  await page.getByLabel(/^Transcription API key/).fill('synthetic-stt-key');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByText('Connections saved.', { exact: false })).toBeVisible();
  await page.reload();
  await openSettingsSections(page);
  await expect(page.getByRole('combobox', { name: 'Realtime provider', exact: true })).toHaveValue('openai');
  await expect(page.getByRole('combobox', { name: 'Transcription provider', exact: true })).toHaveValue('openai');
  await expect(page.getByLabel(/^Realtime API key/)).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('provider-settings-mobile.png'), fullPage: true });
});

test('provider draft guards navigation and sign-out, then resets after discard or save', async ({ page }) => {
  await openAuth(page);
  await page.getByLabel('Email').fill(`provider-guard-${Date.now()}@example.invalid`);
  await page.getByLabel(/^Password/).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Provider guard workshop');
  await page.getByLabel('What do you do?').fill('Synthetic draft guard validation');
  await page.getByRole('button', { name: 'Meet your receptionist', exact: true }).click();
  const navigation = page.locator('.of-workspace-button');
  await expect(navigation).toBeVisible();
  await connections(page);
  await openSettingsSections(page);
  const key = page.getByLabel(/^Text API key/);
  await expectCatalog(page, 'Workspace text model', '');

  // Ordinary edits are protected, and cancelling leaves the current draft intact.
  await page.getByLabel('Workspace text model', {exact:true}).fill('unsaved-model');
  const cancelNavigation = page.waitForEvent('dialog');
  const navigate = workspaceMenu(page, 'Messages & conversations');
  await (await cancelNavigation).dismiss();
  await navigate;
  await expect(page).toHaveURL('/connections');
  await expectCatalog(page, 'Workspace text model', 'unsaved-model');

  // A replacement key alone must block sign-out before the session is deleted.
  await page.getByLabel('Workspace text model', {exact:true}).fill('');
  await key.fill('synthetic-unsaved-key');
  const cancelSignOut = page.waitForEvent('dialog');
  const signOut = workspaceMenu(page, 'Sign out');
  await (await cancelSignOut).dismiss();
  await signOut;
  await expect(page).toHaveURL('/connections');
  await expect(key).toHaveValue('synthetic-unsaved-key');
  expect((await page.request.get('/api/me')).status()).toBe(200);

  // Accepting navigation discards the draft without sending it to the provider API.
  const acceptNavigation = page.waitForEvent('dialog');
  const discard = workspaceMenu(page, 'Messages & conversations');
  await (await acceptNavigation).accept();
  await discard;
  await expect(page).toHaveURL('/conversations');
  await connections(page);
  await openSettingsSections(page);
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
  await workspaceMenu(page, 'Messages & conversations');
  await expect(page).toHaveURL('/conversations');
  await connections(page);
  await openSettingsSections(page);

  // Successful save replaces the baseline and clears the secret input, allowing
  // both navigation and sign-out without a stale dirty-state prompt.
  await page.getByLabel('Workspace text model', {exact:true}).fill('saved-model');
  await key.fill('synthetic-saved-key');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByText('Connections saved.', { exact: false })).toBeVisible();
  await expect(key).toHaveValue('');
  await workspaceMenu(page, 'Messages & conversations');
  await expect(page).toHaveURL('/conversations');
  await connections(page);
  await openSettingsSections(page);
  await expectCatalog(page, 'Workspace text model', 'saved-model');
  await workspaceMenu(page, 'Sign out');
  await expect(page.getByLabel('Email address')).toBeVisible();
  expect(unexpectedDialogs).toEqual([]);
  page.off('dialog', rejectUnexpected);
  expect((await page.request.get('/api/me')).status()).toBe(401);
});

test('confirmed provider save survives a failed refresh without resending credentials', async ({ page }) => {
  await openAuth(page);
  await page.getByLabel('Email').fill(`provider-refresh-${Date.now()}@example.invalid`);
  await page.getByLabel(/^Password/).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Provider refresh workshop');
  await page.getByLabel('What do you do?').fill('Synthetic refresh failure validation');
  await page.getByRole('button', { name: 'Meet your receptionist', exact: true }).click();
  const navigation = page.locator('.of-workspace-button');
  await expect(navigation).toBeVisible();
  await connections(page);
  await openSettingsSections(page);
  const key = page.getByLabel(/^Text API key/);
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
  await page.getByLabel('Workspace text model', {exact:true}).fill('persisted-despite-refresh');
  await key.fill('synthetic-refresh-key');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic write failure');
  await expect(page.getByText('Connections saved.', { exact: false })).toHaveCount(0);
  await expect(key).toHaveValue('synthetic-refresh-key');
  const cancel = page.waitForEvent('dialog');
  const leave = workspaceMenu(page, 'Messages & conversations');
  await (await cancel).dismiss();
  await leave;
  await page.getByRole('button',{name:'Close menu',exact:true}).click();
  await expect(page).toHaveURL('/connections');
  expect(writes).toBe(0);
  failWrite = false;
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Provider connections were saved');
  await expect(key).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toBeDisabled();
  const persisted = await (await page.request.get('/api/me/provider')).json();
  expect(persisted).toMatchObject({ model: 'persisted-despite-refresh', workspaceApiKeyConfigured: true });
  expect(writes).toBe(1);

  // The recovery action only rereads confirmed data; no key replacement/PUT.
  failRefresh = false;
  let failWorkspace = true;
  await page.route('**/api/me/assistants/*', async route => {
    if (failWorkspace && route.request().method() === 'GET') await route.fulfill({ status: 503, json: { error: 'Synthetic workspace refresh failure' } });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Retry connections refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic workspace refresh failure');
  await expect(navigation).toBeVisible();
  await expect(key).toHaveValue('');
  expect(writes).toBe(1);
  failWorkspace = false;
  await page.getByRole('button', { name: 'Retry connections refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry connections refresh', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectCatalog(page, 'Workspace text model', 'persisted-despite-refresh');
  await expect(key).toHaveValue('');
  expect(writes).toBe(1);

  // A second injected failure also leaves the acknowledged draft clean before
  // recovery: navigation must not suggest discarding changes already saved.
  failRefresh = true;
  await page.getByLabel('Workspace text model', {exact:true}).fill('second-confirmed-model');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Provider connections were saved');
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  await workspaceMenu(page, 'Messages & conversations');
  await expect(page).toHaveURL('/conversations');
  expect(dialogs).toEqual([]);
  expect(writes).toBe(2);
  const latest = await (await page.request.get('/api/me/provider')).json();
  expect(latest).toMatchObject({ model: 'second-confirmed-model', workspaceApiKeyConfigured: true });

  // A genuine authentication denial still clears the private shell.
  failRefresh = false;
  await connections(page);
  await openSettingsSections(page);
  await expectCatalog(page, 'Workspace text model', 'second-confirmed-model');
  await page.route('**/api/me/assistants/*', route => route.fulfill({ status: 401, json: { error: 'Session expired' } }));
  await page.getByLabel('Workspace text model', {exact:true}).fill('saved-before-auth-expired');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(navigation).toHaveCount(0);
});

test('separate business drafts are guarded and provider switching leaves saved business rows intact', async ({ page }) => {
  await openAuth(page);
  await page.getByLabel('Email address').fill(`provider-business-${Date.now()}@example.invalid`);
  await page.getByLabel(/^Password/).fill('Synthetic-Presets-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact:true }).fill('Sibling baseline workshop');
  await page.getByLabel('What do you do?').fill('Synthetic sibling validation');
  await page.getByRole('button', {name:'Meet your receptionist',exact:true}).click();
  await expect(page.getByRole('button', {name:'Start browser conversation'})).toBeVisible();
  const business = await (await page.request.get('/api/me/business')).json();
  const rows = {
    hours_json: JSON.stringify([{day:'Monday',open:'09:00',close:'17:00',closed:false}]),
    services_json: JSON.stringify([{name:'Repair',price:'€40'}]),
    faqs_json: JSON.stringify([{q:'Parking?',a:'Outside'}]),
    closures_json: JSON.stringify([{date:'2026-12-25',reason:'Holiday'}]),
  };
  expect((await page.request.put(`/api/me/business/${business.id}`,{data:rows})).ok()).toBe(true);
  expect((await page.request.put('/api/me/provider',{data:{realtime_provider:'kataleptic',realtime_base_url:'wss://api.kataleptic.com/v1/realtime',realtime_model:'kataleptic-realtime-hd',realtime_api_key:'synthetic-gateway-key'}})).ok()).toBe(true);
  const seeded = await page.request.put(`/api/me/business/${business.id}/agent`, {data:{agent_name:'Alex',persona:'Friendly and concise',language:'en',engine:'realtime',realtime_model:'kataleptic-realtime-hd',realtime_voice:'en-US-AvaMultilingualNeural'}});
  expect(seeded.ok(), await seeded.text()).toBe(true);
  await page.reload(); await workspaceMenu(page, 'Business details');
  while (await page.locator('details:not([open]) > summary').count()) await page.locator('details:not([open]) > summary').first().click();
  await page.getByLabel('Business name',{exact:true}).fill('Saved business name');
  await page.getByLabel('Monday opening time',{exact:true}).fill('10:30');
  await page.getByLabel('Service 1 price',{exact:true}).fill('€99');
  await page.getByRole('textbox',{name:'FAQ 1 answer',exact:true}).fill('Updated parking answer');
  await page.getByLabel('Closure 1 reason',{exact:true}).fill('Updated closure reason');
  const cancel = page.waitForEvent('dialog');
  const leave = workspaceMenu(page, 'Connections & portability');
  await (await cancel).dismiss(); await leave;
  await page.getByRole('button',{name:'Close menu',exact:true}).click();
  await expect(page.getByLabel('Business name',{exact:true})).toHaveValue('Saved business name');
  expect(await (await page.request.get('/api/me/business')).json()).toMatchObject(rows);
  await page.getByRole('button',{name:'Save business details',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start browser conversation'})).toBeVisible();
  const saved = await (await page.request.get('/api/me/business')).json();
  await connections(page); await openSettingsSections(page);
  await expect(page.getByLabel('Realtime voice',{exact:true})).toHaveValue('en-US-AvaMultilingualNeural');
  await page.getByRole('combobox',{name:'Realtime provider',exact:true}).selectOption('openai');
  await page.getByLabel(/^Realtime API key/).fill('synthetic-sibling-key');
  await page.getByRole('button',{name:'Save connections',exact:true}).click();
  await expect(page.getByText(/^Connections saved/)).toBeVisible();
  await expect(page.getByLabel('Realtime voice',{exact:true})).not.toHaveValue('en-US-AvaMultilingualNeural');
  const after = await (await page.request.get('/api/me/business')).json();
  for (const key of ['name','hours_json','services_json','faqs_json','closures_json']) expect(after[key]).toBe(saved[key]);
  await workspaceMenu(page,'Business details');
  while (await page.locator('details:not([open]) > summary').count()) await page.locator('details:not([open]) > summary').first().click();
  await expect(page.getByLabel('Business name',{exact:true})).toHaveValue('Saved business name');
  await expect(page.getByLabel('Monday opening time',{exact:true})).toHaveValue('10:30');
  await expect(page.getByLabel('Service 1 price',{exact:true})).toHaveValue('€99');
  await expect(page.getByRole('textbox',{name:'FAQ 1 answer',exact:true})).toHaveValue('Updated parking answer');
  await expect(page.getByLabel('Closure 1 reason',{exact:true})).toHaveValue('Updated closure reason');
});

test('historical profile previews do not overwrite names and deletion reloads later entries', async ({ page }) => {
  await openAuth(page);
  await page.getByLabel('Email').fill(`profile-recovery-${Date.now()}@example.invalid`);
  await page.getByLabel(/^Password/).fill('Synthetic-Profile-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Profile recovery workshop');
  await page.getByLabel('What do you do?').fill('Synthetic profile recovery validation');
  await page.getByRole('button', { name: 'Meet your receptionist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeVisible();
  await expect(page).toHaveURL('/overview');
  let reads=0, renamed=0, deleted=false;
  await page.route('**/api/me/engine-presets', route => {
    reads++;
    return route.fulfill({json:[{id:deleted?'later':'old',name:deleted?'Later historical profile':'Historical preview',engine:'pipeline',language:'en',voice:'',realtime_voice:'',realtime_model:'',llm_model:'',llm_base_url:'',llm_api_key:'',preview_only:deleted?0:1}]});
  });
  await page.route('**/api/me/engine-presets/*', route => {
    if(route.request().method()==='PUT') renamed++;
    if(route.request().method()==='DELETE') deleted=true;
    return route.fulfill({json:{ok:true}});
  });
  await connections(page);
  await openSettingsSections(page);
  const preview=page.locator('input[value="Historical preview"]');
  await expect(preview).toHaveAttribute('readonly','');
  await preview.focus();await page.getByRole('heading',{name:'Your connections'}).click();
  expect(renamed).toBe(0);
  await page.getByRole('button',{name:'Delete setup',exact:true}).click();
  await expect(page.locator('input[value="Later historical profile"]')).toBeVisible();
  expect(reads).toBe(2);expect(deleted).toBe(true);expect(renamed).toBe(0);
});
