import { signup, createWorkspace, connections } from './cleanroom-helpers';
import { test, expect, openSettingsSections } from './fixtures';

test('custom pipeline saves separate BYOK components and guided voices without exposing keys', async ({ page }) => {
  await signup(page, 'guided'); await createWorkspace(page, 'Guided voice workshop');
  await connections(page); await openSettingsSections(page);
  await expect(page.locator('#of-text-models option[value="llama-3.3-70b"]')).toHaveCount(0);
  await page.getByLabel('Workspace text model', { exact: true }).fill('previous-custom-model');
  await page.getByRole('combobox', { name: 'Provider preset', exact: true }).selectOption('openai');
  await expect(page.getByLabel('Workspace text model', { exact: true })).toHaveValue('gpt-4.1-mini');
  await page.getByLabel(/^Text API key/).fill('synthetic-text-private');
  await page.getByRole('combobox', { name: 'Transcription provider', exact: true }).selectOption('openai');
  await page.getByLabel(/^Transcription API key/).fill('synthetic-stt-private');
  await page.getByRole('combobox', { name: 'Voice provider', exact: true }).selectOption('azure');
  await expect(page.getByLabel('Speech API URL', { exact: true })).toHaveValue('');
  await page.getByLabel(/^Speech API key/).fill('synthetic-azure-key');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Speech URL');
  await page.getByRole('combobox', { name: 'Voice provider', exact: true }).selectOption('openai');
  await expect(page.getByLabel('Speech model', { exact: true })).toHaveValue('gpt-4o-mini-tts');
  await page.getByLabel(/^Speech API key/).fill('synthetic-speech-private');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByText(/^Connections saved/)).toBeVisible();
  await page.reload(); await openSettingsSections(page);
  for (const name of ['Text','Transcription','Speech']) await expect(page.getByLabel(new RegExp(`^${name} API key`))).toHaveValue('');
  const view = await (await page.request.get('/api/me/provider')).json();
  expect(view).toMatchObject({ stt_provider: 'openai', tts_provider: 'openai', tts_api_key_configured: true });
  expect(JSON.stringify(view)).not.toContain('-private');
  await page.route('**/api/me/provider/catalog', route => route.fulfill({ status: 503, json: { error: 'Synthetic catalog outage' } }));
  await page.reload(); await openSettingsSections(page);
  await expect(page.getByText(/live Kataleptic catalog is temporarily unavailable/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Conversation engine', exact: true }).selectOption('pipeline');
  await page.getByLabel('Language', { exact: true }).fill('de');
  await expect(page.locator('#of-voices option[value="coral"]')).toHaveCount(1);
  await page.getByLabel('Voice', { exact: true }).fill('coral');
  await page.getByLabel(/^Text model override/).fill('gpt-4o-mini');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByText(/^Connections saved/)).toBeVisible();
  await page.reload(); await openSettingsSections(page);
  await expect(page.getByLabel('Voice', { exact: true })).toHaveValue('coral');
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('de');
  await page.getByLabel(/^Text model override/).fill('future-custom-model');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByText(/^Connections saved/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toBeDisabled();
  await page.reload(); await openSettingsSections(page);
  await expect(page.getByLabel(/^Text model override/)).toHaveValue('future-custom-model');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('combobox', { name: 'Voice provider', exact: true }).selectOption('browser');
  await page.getByRole('button', { name: 'Save connections', exact: true }).click();
  await expect(page.getByText(/^Connections saved/)).toBeVisible();
  expect(await (await page.request.get('/api/me/provider')).json()).toMatchObject({ tts_provider: 'browser', tts_api_key_configured: false });
});

test('guided Kataleptic tiers show matching voices and preserve unknown saved values', async ({ page }) => {
  await signup(page, 'tiers'); await createWorkspace(page, 'Tier workshop');
  const models = ['gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-live-1'];
  const distinctVoice = (model: string) => model === 'gpt-live-1' ? 'breeze' : `${model}-exclusive`;
  await page.route('**/api/me/provider/catalog', route => route.fulfill({ json: {
    models: [], live: true, voices: { native: [{ id: 'wrong-shared-voice', label: 'wrong-shared-voice' }], azure: [{id:'de-DE-SeraphinaMultilingualNeural',label:'Seraphina'}], hdDefault: '',
      realtime: Object.fromEntries(models.map(id => [id, [{ id: 'marin', label: 'marin' }, { id: distinctVoice(id), label: distinctVoice(id) }]])), cataloguedModels: models },
  } }));
  await connections(page); await openSettingsSections(page);
  await page.getByRole('combobox', { name:'Realtime provider',exact:true }).selectOption('kataleptic');
  await page.getByLabel(/^Realtime API key/).fill('synthetic-kataleptic-key');
  await page.getByRole('button', {name:'Save connections',exact:true}).click();
  await expect(page.getByText(/^Connections saved/)).toBeVisible();
  await page.getByRole('combobox', { name:'Conversation engine',exact:true }).selectOption('realtime');
  const model = page.getByLabel('Realtime model', {exact:true});
  const voice = page.getByLabel('Realtime voice', {exact:true});
  await model.fill('kataleptic-realtime-hd');
  await expect(page.locator('#of-realtime-voices option[value="de-DE-SeraphinaMultilingualNeural"]')).toHaveCount(1);
  for (const id of models) {
    await model.fill(id);
    await expect(page.locator(`#of-realtime-voices option[value="${distinctVoice(id)}"]`)).toHaveCount(1);
    await expect(page.locator('#of-realtime-voices option[value="wrong-shared-voice"]')).toHaveCount(0);
    await voice.fill('old-family-custom-voice');
    await expect(voice).toHaveValue('old-family-custom-voice');
  }
  await voice.fill('future-voice');
  await page.getByRole('button', {name:'Save connections',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText(/voice/i);
  await voice.fill('marin');
  await page.getByRole('button', {name:'Save connections',exact:true}).click();
  await expect(page.getByText(/^Connections saved/)).toBeVisible();
  await page.reload(); await openSettingsSections(page);
  await expect(voice).toHaveValue('marin');
  await page.route('**/api/me/provider/catalog', route => route.fulfill({ status:503,json:{error:'Synthetic catalog outage'} }));
  await page.reload(); await openSettingsSections(page);
  for (const id of ['arbor','breeze','cove','ember','juniper','maple','sol','spruce','vale']) await expect(page.locator(`#of-realtime-voices option[value="${id}"]`)).toHaveCount(1);
  await voice.fill('breeze');
  await page.getByRole('button', {name:'Save connections',exact:true}).click();
  await expect(page.getByText(/^Connections saved/)).toBeVisible();
  await page.reload(); await openSettingsSections(page);
  await expect(voice).toHaveValue('breeze');
  await model.fill('gpt-realtime-2');
  await expect(page.locator('#of-realtime-voices option[value="breeze"]')).toHaveCount(0);
  await expect(voice).toHaveValue('breeze'); // Custom/saved values remain explicit until the owner repairs them.
});
