import { test, expect } from './fixtures';
import { pcmWav } from '../src/voice-preview';

test('voice samples use unsaved choices, stop on changes, ignore cancelled results and never save', async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`preview-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Preview-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Voice sample workshop');
  await page.getByLabel('What do you do?').fill('Synthetic preview validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page).toHaveURL('/overview');
  const { assistants } = await (await page.request.get('/api/me/bootstrap')).json();
  const id = assistants[0].id;
  expect((await page.request.put(`/api/me/assistants/${id}`, { data: { name: 'Preview assistant' } })).ok()).toBe(true);
  const before = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  await page.goto(`/assistants/${id}`);
  const preview = page.getByRole('button', { name: 'Preview voice', exact: true });
  const requests: any[] = []; let held: (() => Promise<void>) | undefined;
  let mode = 'held';
  // Real browser playback of synthetic WAV; provider fidelity is tested separately.
  const pcm = new Uint8Array(48000 * 4); const view = new DataView(pcm.buffer);
  for (let i = 0; i < pcm.length / 2; i++) view.setInt16(i * 2, Math.sin(i * 2 * Math.PI * 440 / 24000) * 200, true);
  const wav = Buffer.from(pcmWav(pcm));
  await page.route('**/voice-preview', async route => {
    requests.push(route.request().postDataJSON());
    const fulfill = () => route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }).catch(() => {});
    if (mode === 'held') held = fulfill;
    else if (mode === 'error') await route.fulfill({ status: 502, json: { error: 'Synthetic provider unavailable.' } });
    else await fulfill();
  });
  await page.getByLabel('Conversation engine', { exact: true }).selectOption('gpt-realtime-2.1-mini');
  await page.getByLabel('Default language', { exact: true }).selectOption('de');
  await page.getByLabel('Realtime voice', { exact: true }).selectOption('marin');
  await preview.click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ engine: 'realtime', language: 'de', realtime_model: 'gpt-realtime-2.1-mini', realtime_voice: 'marin' });
  await page.getByLabel('Realtime voice', { exact: true }).selectOption('cedar');
  await held!(); await expect(page.getByLabel('Selected voice sample')).toHaveCount(0);
  mode = 'success'; await preview.click();
  const audio = page.getByLabel('Selected voice sample');
  await expect(audio).toBeVisible();
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop preview', exact: true }).click();
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  await page.getByLabel('Default language', { exact: true }).selectOption('en');
  await expect(audio).toHaveCount(0);
  mode = 'error'; await preview.click(); await expect(page.getByRole('alert')).toContainText('Synthetic provider unavailable');
  mode = 'held'; await preview.click(); await expect.poll(() => requests.length).toBe(4);
  await page.getByRole('button', { name: 'Stop preview', exact: true }).click(); await held!();
  await expect(audio).toHaveCount(0); await expect(preview).toBeEnabled();
  expect(await (await page.request.get(`/api/me/assistants/${id}`)).json()).toEqual(before);
  await page.setViewportSize({ width: 390, height: 844 });
  mode = 'success'; await preview.click(); await expect(audio).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0);
  const playing = await audio.elementHandle();
  await page.getByLabel('Conversation engine', { exact: true }).selectOption('pipeline');
  expect(await playing!.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  const requestCount = requests.length;
  await page.evaluate(() => {
    const calls: { language?: string; text?: string; cancelled?: boolean } = {};
    Object.assign(window, { previewSpeech: calls });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speaking: false, pending: false,
      speak(item: SpeechSynthesisUtterance) { calls.language = item.lang; calls.text = item.text; },
      cancel() { calls.cancelled = true; },
    } });
  });
  await page.getByLabel('Default language', { exact: true }).selectOption('de');
  await preview.click();
  expect(await page.evaluate(() => (window as any).previewSpeech)).toMatchObject({ language: 'de', text: expect.stringContaining('Guten Tag') });
  await page.getByRole('button', { name: 'Stop preview', exact: true }).click();
  expect(await page.evaluate(() => (window as any).previewSpeech.cancelled)).toBe(true);
  expect(requests.length).toBe(requestCount);

});
