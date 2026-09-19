import { test, expect } from './fixtures';
import { pcmWav } from '../src/voice-preview';

test('compact samples prefetch lazily, reuse cached audio, stop stale playback and preserve the draft', async ({ page }) => {
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
  const requests: any[] = []; let held: (() => Promise<void>) | undefined; let mode = 'held';
  // Real browser playback of synthetic WAV; provider fidelity is unchanged.
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
  await page.goto(`/assistants/${id}`);
  const engine = page.getByLabel('Conversation engine', { exact: true });
  const voice = page.getByLabel('Realtime voice', { exact: true });
  const play = page.getByRole('button', { name: 'Play voice sample', exact: true });
  const stop = page.getByRole('button', { name: 'Stop voice sample', exact: true });
  const audio = page.locator('audio');
  await engine.selectOption('gpt-realtime-2.1-mini');
  await page.getByLabel('Default language', { exact: true }).selectOption('de');
  await voice.selectOption('marin');
  await page.setViewportSize({ width: 1100, height: 400 });
  await page.getByRole('heading', { name: 'Personality & purpose', exact: true }).scrollIntoViewIfNeeded();
  await expect(play).not.toBeInViewport();
  await page.waitForTimeout(800); // exceeds the lazy prefetch delay while offscreen
  expect(requests).toHaveLength(0);
  await play.scrollIntoViewIfNeeded();
  await expect.poll(() => requests.length).toBe(1); // no play click required
  expect(requests[0]).toMatchObject({ language: 'de', realtime_model: 'gpt-realtime-2.1-mini', realtime_voice: 'marin' });
  await expect(play).toHaveText('');
  await expect(audio).toBeHidden(); await expect(audio).not.toHaveAttribute('controls');
  await play.click(); // shares the pending prefetch
  expect(requests).toHaveLength(1);
  await held!();
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0);
  await stop.click();
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  await play.click(); await stop.click(); expect(requests).toHaveLength(1);
  const baseline = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  // A finished prefetch must not autoplay. Returning to a prior choice is cached.
  mode = 'success'; await voice.selectOption('cedar');
  await expect.poll(() => requests.length).toBe(2);
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState)).toBe(4);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  await voice.selectOption('marin'); await play.click();
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0);
  expect(requests).toHaveLength(2);
  const playing = await audio.elementHandle();
  mode = 'held'; await voice.selectOption('ash');
  expect(await playing!.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  await expect.poll(() => requests.length).toBe(3);
  const stale = held!;
  await voice.selectOption('cedar'); await stale();
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  await play.click(); await stop.click(); expect(requests).toHaveLength(3);
  // Prefetch failures don't retry indefinitely; an explicit click can retry.
  mode = 'error'; await voice.selectOption('echo');
  await expect.poll(() => requests.length).toBe(4);
  await expect(play).toHaveAttribute('aria-busy', 'false');
  await play.click(); await expect(page.getByRole('alert')).toContainText('Synthetic provider unavailable');
  expect(requests).toHaveLength(5);
  mode = 'held'; await play.click(); await expect.poll(() => requests.length).toBe(6);
  await stop.click(); await held!();
  await expect(play).toHaveAttribute('aria-busy', 'false');
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  expect(await (await page.request.get(`/api/me/assistants/${id}`)).json()).toEqual(baseline);
  // Provider gender metadata, with an explicit unknown symbol for native voices.
  await expect(voice.locator('option[value="marin"]')).toHaveText('◇ marin');
  await expect(voice.locator('option[value="__custom"]')).toHaveText('◇ Custom ID…');
  await expect(voice.locator('option[value="__custom"]')).toHaveAttribute('aria-label', 'Custom ID, unspecified voice gender');
  await engine.selectOption('kataleptic-realtime-hd');
  await expect(voice.locator('option[value="en-US-AvaMultilingualNeural"]')).toHaveText('♀ en-US-AvaMultilingualNeural');
  await expect(voice.locator('option[value="it-IT-AlessioMultilingualNeural"]')).toHaveText('♂ it-IT-AlessioMultilingualNeural');
  await page.setViewportSize({ width: 390, height: 844 });
  await play.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('compact-voice-mobile.png'), fullPage: true });
  // Local speech never prefetches or contacts the server.
  await engine.selectOption('pipeline');
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
  await play.click();
  expect(await page.evaluate(() => (window as any).previewSpeech)).toMatchObject({ language: 'de', text: expect.stringContaining('Guten Tag') });
  await stop.click(); expect(await page.evaluate(() => (window as any).previewSpeech.cancelled)).toBe(true);
  expect(requests.length).toBe(requestCount);
});
