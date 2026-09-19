import { test, expect } from './fixtures';

test('saved voice persists and six calls release audio, including suspended playback recovery', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`playback-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Playback-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Audio recovery test');
  await page.getByLabel('What do you do?').fill('Synthetic audio validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  // Onboarding is already mounted at /overview; wait for its final save/refresh.
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await expect(page).toHaveURL('/overview');
  const { assistants } = await (await page.request.get('/api/me/bootstrap')).json();
  const id = assistants[0].id;
  await page.route('**/voice-preview', route => route.fulfill({ status: 503, json: { error: 'No provider in synthetic test' } }));
  await page.goto(`/assistants/${id}`);
  await page.getByLabel('Conversation engine', { exact: true }).selectOption('gpt-realtime-2');
  await page.getByLabel('Realtime voice', { exact: true }).selectOption('alloy');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Assistant saved' })).toBeVisible();
  const saved = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  expect(saved).toMatchObject({ realtime_model: 'gpt-realtime-2', realtime_voice: 'alloy' });
  await page.goto(`/test?assistant=${id}`);
  // Real Chrome AudioContext/source playback; synthetic socket and permission
  // denial isolate output behavior from provider timing and physical microphones.
  await page.evaluate(() => {
    const state = { contexts: [] as AudioContext[], starts: [] as boolean[], completed: 0, blocked: false, allow: false };
    Object.assign(window, { audioProbe: state });
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options); state.contexts.push(this); state.starts.push(navigator.userActivation.isActive);
      }
      resume() { return state.blocked && !state.allow ? new Promise<void>(() => {}) : super.resume(); }
      createBufferSource() {
        const source = super.createBufferSource(); source.addEventListener('ended', () => state.completed++); return source;
      }
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw Error('synthetic text mode'); } } });
    class Socket {
      static OPEN = 1; readyState = 1; binaryType = '';
      onopen: (() => void) | null = null; onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
      constructor() {
        setTimeout(() => {
          this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'ready', mode: 'realtime', ttsMode: 'server', engine: 'Synthetic realtime · alloy' }) });
          this.onmessage?.({ data: JSON.stringify({ type: 'agent_text', text: 'Synthetic audible answer' }) });
          const pcm = new Int16Array(12000);
          for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i * Math.PI / 30) * 300;
          this.onmessage?.({ data: pcm.buffer });
        }, 30);
      }
      send() {} close() { this.readyState = 3; }
    }
    window.WebSocket = Socket as unknown as typeof WebSocket;
  });
  await page.route('**/api/me/assistants/*/test-calls', async route => {
    // The context must already exist at this network boundary.
    expect(await page.evaluate(() => (window as any).audioProbe.contexts.length)).toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve, 100));
    await route.fulfill({ json: { callId: 'synthetic-only', assistantId: id, environment: 'test' } });
  });
  await page.route('**/api/me/test-calls/synthetic-only', route => route.fulfill({ json: { ok: true } }));
  for (let n = 1; n <= 6; n++) {
    await page.getByRole('button', { name: 'Start test call', exact: true }).click();
    await expect(page.getByText('Synthetic audible answer')).toBeVisible();
    if (n === 4) {
      // Explicitly suspend an existing real context to simulate OS/browser
      // interruption; this does not claim the user's historical failure cause.
      await page.evaluate(async () => {
        const state = (window as any).audioProbe; state.blocked = true;
        await state.contexts.at(-1).suspend();
      });
      await expect(page.getByRole('button', { name: 'Enable audio', exact: true })).toBeVisible();
      await page.evaluate(() => { (window as any).audioProbe.allow = true; });
      await page.getByRole('button', { name: 'Enable audio', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Enable audio', exact: true })).not.toBeVisible();
    }
    await expect.poll(() => page.evaluate(() => (window as any).audioProbe.completed)).toBe(n);
    await page.getByRole('button', { name: 'End test call', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).audioProbe.contexts.every((c: AudioContext) => c.state === 'closed'))).toBe(true);
  }
  expect(await page.evaluate(() => (window as any).audioProbe.contexts.length)).toBe(6);
  expect(await page.evaluate(() => (window as any).audioProbe.starts.every(Boolean))).toBe(true);
});
