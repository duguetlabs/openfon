import { test, expect } from './fixtures';

test('instance speech hides workspace keys and clears explicit keys when saved', async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`instance-speech-${Date.now()}@example.invalid`);
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
  for (const label of ['Realtime', 'Transcription']) {
    await expect(page.getByLabel(`${label} API key`, { exact: true })).toHaveCount(0);
  }
  const original = await (await page.request.get('/api/me/provider')).json();
  for (const [capability, label, display] of [['realtime', 'Realtime', 'realtime'], ['stt', 'Transcription', 'transcription']]) {
    const status = original[`${capability}_api_key_configured`]
      ? 'An operator key is configured; connection not verified.' : 'No operator key is configured.';
    await expect(page.getByText(`Instance ${display} uses the operator’s key. ${status}`, { exact: true })).toBeVisible();
    await page.getByLabel(`${label} provider`, { exact: true }).selectOption('openai');
    await expect(page.getByLabel(`${label} API key`, { exact: true })).toHaveAttribute('placeholder', 'Separate key required for explicit provider');
    await page.getByLabel(`${label} API key`, { exact: true }).fill(`synthetic-${capability}-key`);
  }
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByText('Provider settings saved.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save provider settings', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('Realtime API key', { exact: true })).toHaveAttribute('placeholder', 'Saved — leave blank to keep');
  for (const label of ['Realtime', 'Transcription']) {
    await page.getByLabel(`${label} provider`, { exact: true }).selectOption('instance');
    await expect(page.getByLabel(`${label} API key`, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText(/Save to use the instance configuration and remove the saved workspace key/)).toHaveCount(2);
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByText('Provider settings saved.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save provider settings', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('Realtime API key', { exact: true })).toHaveCount(0);
  const view = await (await page.request.get('/api/me/provider')).json();
  expect(view).toMatchObject({ realtime_provider: 'instance', stt_provider: 'instance',
    realtime_api_key_configured: original.realtime_api_key_configured, stt_api_key_configured: original.stt_api_key_configured });
  // An explicit provider selected afterward must supply a new workspace key.
  const rejected = await page.request.put('/api/me/provider', { data: { realtime_provider: 'openai', realtime_base_url: 'wss://api.openai.com/v1/realtime' } });
  expect(rejected.status()).toBe(400);
});
