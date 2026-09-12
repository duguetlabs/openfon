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
  await page.getByLabel('Workspace text model', { exact: true }).fill('custom/model:route');
  await page.getByLabel('Text API key', { exact: true }).fill('synthetic-text-key');
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(page.getByText('Provider settings saved.', { exact: false })).toBeVisible();
  await page.reload();
  await expect(select).toHaveValue('openrouter');
  await expect(page.getByLabel('Workspace text model', { exact: true })).toHaveValue('custom/model:route');
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
