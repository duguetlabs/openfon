import { signup, createWorkspace, whoAnswers } from './cleanroom-helpers';
import { test, expect } from './fixtures';
import { pcmWav } from '../src/voice-preview';

test('explicit samples preserve identity, cancel stale playback, bound audio and never save the draft', async ({ page }) => {
  await signup(page, 'preview');
  const { assistant } = await createWorkspace(page, 'Voice sample workshop');
  const id = assistant.id;
  expect((await page.request.put(`/api/me/assistants/${id}`, { data: {
    name: 'Preview assistant', greeting:'Hello from the preview fixture.', persona:'Helpful', language:'en', engine: 'realtime', realtime_model: 'gpt-realtime-2.1-mini', realtime_voice: 'marin',
  } })).ok()).toBe(true);
  const baseline = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  const requests: any[] = [];
  let held: (() => Promise<void>) | undefined;
  let mode = 'held';
  const pcm = new Uint8Array(48000 * 4), view = new DataView(pcm.buffer);
  for (let i = 0; i < pcm.length / 2; i++) view.setInt16(i * 2, Math.sin(i * 2 * Math.PI * 440 / 24000) * 200, true);
  const wav = Buffer.from(pcmWav(pcm));
  await page.route('**/voice-preview', async route => {
    requests.push(route.request().postDataJSON());
    const fulfill = () => route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }).catch(() => {});
    if (mode === 'held') held = fulfill;
    else if (mode === 'error') await route.fulfill({ status: 502, json: { error: 'Synthetic provider unavailable.' } });
    else if (mode === 'oversize') await route.fulfill({ status: 200, contentType: 'audio/wav', body: Buffer.alloc(960045) });
    else await fulfill();
  });
  await page.goto(`/assistants/${id}`);
  await whoAnswers(page);
  const voice = page.getByRole('combobox', {name:'Voice', exact:true});
  const listen = page.getByRole('button', { name: 'Listen to a sample', exact: true });
  const stop = page.getByRole('button', { name: 'Stop sample', exact: true });
  const audio = page.locator('.of-sample-result audio');
  await page.getByRole('combobox', {name:'Language', exact:true}).selectOption('de');
  await voice.selectOption('marin');
  // Paid previews are deliberately explicit in the remake. Visibility and
  // changing a voice must not spend provider requests or start speech.
  await page.setViewportSize({ width: 1100, height: 400 });
  await page.getByRole('heading', { name: 'More time for your business.' }).scrollIntoViewIfNeeded();
  await expect(listen).not.toBeInViewport();
  await page.waitForTimeout(800);
  expect(requests).toHaveLength(0);
  await listen.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  expect(requests).toHaveLength(0);
  await listen.click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({ engine: 'realtime', language: 'de', voice: baseline.voice,
    realtime_model: 'gpt-realtime-2.1-mini', realtime_voice: 'marin' });
  await stop.click(); await held!();
  await expect(listen).toBeEnabled(); await expect(audio).toHaveCount(0);

  mode = 'success'; await listen.click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(audio).toBeVisible(); await expect(audio).toHaveAttribute('controls', '');
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState)).toBe(4);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  await audio.evaluate((el: HTMLAudioElement) => el.play());
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0);
  const playing = await audio.elementHandle();
  await voice.selectOption('cedar');
  expect(await playing!.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  await expect(audio).toHaveCount(0); expect(requests).toHaveLength(2);
  await listen.click();
  await expect.poll(() => requests.length).toBe(3);
  await expect(audio).toBeVisible();
  expect(requests[2].realtime_voice).toBe('cedar');
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);

  mode = 'held'; await voice.selectOption('ash'); await listen.click();
  await expect.poll(() => requests.length).toBe(4);
  const stale = held!;
  await voice.selectOption('marin'); await stale();
  await expect(audio).toHaveCount(0); await expect(listen).toBeEnabled();
  mode = 'error'; await listen.click();
  await expect(page.getByRole('alert')).toContainText('Synthetic provider unavailable');
  expect(requests).toHaveLength(5);
  await page.waitForTimeout(800); expect(requests).toHaveLength(5);
  mode = 'oversize'; await listen.click();
  await expect(page.getByRole('alert')).toContainText('Voice sample is too large');
  expect(requests).toHaveLength(6); await expect(audio).toHaveCount(0);
  mode = 'success'; await listen.click(); await expect(audio).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await listen.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('voice-sample-mobile.png'), fullPage: true });
  expect(await (await page.request.get(`/api/me/assistants/${id}`)).json()).toEqual(baseline);
  await expect(voice.locator('option[value="marin"]')).toHaveText('marin');
  await expect(voice.locator('option[value="marin"]')).not.toHaveAttribute('aria-label');

  // A new saved pipeline setup uses local speech only. No backend generation.
  expect((await page.request.put(`/api/me/assistants/${id}`, { data: { engine: 'pipeline', language: 'de' } })).ok()).toBe(true);
  page.on('dialog', dialog => dialog.accept());
  await page.reload(); await whoAnswers(page);
  const requestCount = requests.length;
  await page.evaluate(() => {
    const calls: { language?: string; text?: string; cancelled?: boolean } = {};
    Object.assign(window, { previewSpeech: calls });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speaking: false, pending: false, getVoices: () => [],
      speak(item: SpeechSynthesisUtterance) { calls.language = item.lang; calls.text = item.text; },
      cancel() { calls.cancelled = true; },
    } });
  });
  await listen.click();
  expect(await page.evaluate(() => (window as any).previewSpeech)).toMatchObject({ language: 'de', text: expect.stringContaining('Guten Tag') });
  await stop.click();
  expect(await page.evaluate(() => (window as any).previewSpeech.cancelled)).toBe(true);
  await expect(listen).toBeEnabled(); expect(requests.length).toBe(requestCount);
});
