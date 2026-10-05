import { signup, createWorkspace, connections } from './cleanroom-helpers';
import { test, expect, openSettingsSections } from './fixtures';

test('instance speech hides workspace keys and clears explicit keys when saved', async ({ page }) => {
  await signup(page, 'instance-speech'); await createWorkspace(page);
  await connections(page); await openSettingsSections(page);
  const original = await (await page.request.get('/api/me/provider')).json();
  for (const [capability, label, display] of [['realtime', 'Realtime', 'realtime'], ['stt', 'Transcription', 'transcription']]) {
    await expect(page.getByLabel(new RegExp(`^${label} API key`))).toHaveCount(0);
    const status = original[`${capability}_api_key_configured`]
      ? 'An operator key is configured; connection not verified.' : 'No operator key is configured.';
    await expect(page.getByText(`Instance ${display} uses the operator’s key. ${status}`, { exact: true })).toBeVisible();
    await page.getByRole('combobox', {name:`${label} provider`, exact:true}).selectOption('openai');
    const key = page.getByLabel(new RegExp(`^${label} API key`));
    await expect(key).toHaveAttribute('placeholder', 'Paste API key');
    await key.fill(`synthetic-${capability}-key`);
  }
  await page.getByRole('button', {name:'Save connections',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Connections saved'})).toBeVisible();
  await page.reload(); await connections(page); await openSettingsSections(page);
  await expect(page.getByLabel(/^Realtime API key/)).toHaveAttribute('placeholder', '•••••••• · stored');
  for (const label of ['Realtime', 'Transcription']) {
    await page.getByRole('combobox', {name:`${label} provider`,exact:true}).selectOption('instance');
    await expect(page.getByLabel(new RegExp(`^${label} API key`))).toHaveCount(0);
  }
  await expect(page.getByText(/Save to use the instance configuration and remove the saved workspace key/)).toHaveCount(2);
  await page.getByRole('button', {name:'Save connections',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Connections saved'})).toBeVisible();
  await page.reload(); await connections(page); await openSettingsSections(page);
  await expect(page.getByLabel(/^Realtime API key/)).toHaveCount(0);
  const view = await (await page.request.get('/api/me/provider')).json();
  expect(view).toMatchObject({ realtime_provider:'instance',stt_provider:'instance',
    realtime_api_key_configured:original.realtime_api_key_configured, stt_api_key_configured:original.stt_api_key_configured });
  expect(JSON.stringify(view)).not.toContain('synthetic-');
  expect((await page.request.put('/api/me/provider', {data:{realtime_provider:'openai',realtime_base_url:'wss://api.openai.com/v1/realtime'}})).status()).toBe(400);
});
