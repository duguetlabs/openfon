import { PREVIEW_TEXT } from '../src/voice-preview-text';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';

async function seed(page: Page) {
  const email = `cleanroom-${randomUUID()}@example.test`;
  expect((await page.request.post('/api/auth/signup', { data: { email, password: 'Local-only-fixture-2026' } })).ok()).toBeTruthy();
  expect((await page.request.post('/api/me/business', { data: { name: 'Harbour Bicycle Workshop', description: 'Local bicycle repairs and maintenance.' } })).ok()).toBeTruthy();
  const boot = await (await page.request.get('/api/me/bootstrap')).json();
  const id = boot.assistants[0].id;
  expect((await page.request.put(`/api/me/assistants/${id}`, { data: { name: 'Ada', persona: 'Warm and concise', language: 'en', greeting: 'Hello from Harbour Bicycle Workshop. How can I help?', engine: 'pipeline' } })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'More time for your business.' })).toBeVisible();
  return { id, email };
}
async function menu(page: Page, action: string) {
  await page.getByRole('button', { name: /Harbour Bicycle Workshop/ }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
}

test('new account completes a business introduction and saves the primary receptionist', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create your receptionist', exact: true }).click();
  await page.getByLabel('Email address').fill(`first-${randomUUID()}@example.test`);
  await page.getByLabel(/^Password/).fill('Local-only-fixture-2026');
  await page.getByRole('button', { name: /Create account/ }).click();
  await expect(page.getByRole('heading', { name: /Who are we/ })).toBeVisible();
  await page.getByLabel('Business name').fill('Harbour Bicycle Workshop');
  await page.getByLabel('What do you do?').fill('Bicycle repair and maintenance.');
  await page.getByRole('button', { name: /Meet your receptionist/ }).click();
  await page.getByLabel('Receptionist name').fill('Ada');
  await page.getByLabel('Their first words').fill('Welcome to Harbour. How can I help?');
  await page.getByLabel('Tone and personality').fill('Warm, clear and concise.');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Saved. Your next conversation will use this brief.')).toBeVisible();
  const boot = await (await page.request.get('/api/me/bootstrap')).json();
  expect(boot.assistants).toHaveLength(1);
  expect(boot.assistants[0].name).toBe('Ada');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Browser rehearsal' }).getByText('“Welcome to Harbour. How can I help?”', { exact: true })).toBeVisible();
});

test('an unsaved brief survives cue changes, declined navigation and a rejected save', async ({ page }) => {
  const { id } = await seed(page);
  await page.getByRole('button', { name: /Who answers/ }).click();
  await page.getByLabel('Their first words').fill('A revised welcome that is not saved yet.');
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeDisabled();
  await page.getByRole('button', { name: /How they help/ }).click();
  await page.getByRole('button', { name: /Who answers/ }).click();
  await expect(page.getByLabel('Their first words')).toHaveValue('A revised welcome that is not saved yet.');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Messages', exact: true }).click();
  await expect(page.getByLabel('Their first words')).toHaveValue('A revised welcome that is not saved yet.');
  await page.route(`**/api/me/assistants/${id}`, async route => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Assistant changed. Reload and retry.' }) });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Assistant changed');
  await expect(page.getByLabel('Their first words')).toHaveValue('A revised welcome that is not saved yet.');
  await page.unroute(`**/api/me/assistants/${id}`);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Saved. Your next conversation will use this brief.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Browser rehearsal' }).getByText('“A revised welcome that is not saved yet.”', { exact: true })).toBeVisible();
});

test('knowledge drafts are durable without invented answers and publish deliberately', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: /What they know/ }).click();
  await page.getByRole('button', { name: 'Add business information' }).click();
  await page.getByLabel('What might a customer ask?').fill('Are you open on Sunday?');
  await page.getByLabel('Use this answer in conversations').uncheck();
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(page.getByText('Draft saved. It will not be used in conversations until you activate it.')).toBeVisible();
  await page.getByRole('button', { name: /Are you open on Sunday/ }).click();
  await expect(page.getByLabel('The answer', { exact: true })).toHaveValue('');
  await page.getByLabel('The answer', { exact: true }).fill('We are closed on Sundays.');
  await page.getByLabel('Use this answer in conversations').check();
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(page.getByText('Saved and connected. Eligible for your receptionist’s next conversation.')).toBeVisible();
  const groups = await (await page.request.get('/api/me/knowledge/collections')).json();
  const collection = await (await page.request.get(`/api/me/knowledge/collections/${groups[0].id}`)).json();
  expect(collection.items).toHaveLength(1);
  expect(collection.items[0]).toMatchObject({ status: 'active', answer: 'We are closed on Sundays.' });
});

test('a real Worker conversation supports typed fallback and persists its transcript', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { throw new DOMException('Denied for test', 'NotAllowedError'); } }); });
  await seed(page);
  await page.getByRole('button', { name: 'Start browser conversation' }).click();
  await expect(page.getByText('Microphone unavailable · text-only conversation.')).toBeVisible({ timeout: 15000 });
  await page.getByLabel('Type your message').fill('Do you repair bicycles?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Yes, we repair bicycles during opening hours.', { exact: false })).toBeVisible({ timeout: 15000 });
  // The responsive desk moves keyed editor/rehearsal siblings. Preserve the
  // connected session and its unsent input as the operator changes the view.
  const beforeLayoutChange = await (await page.request.get('/api/me/calls?environment=test')).json();
  await page.getByLabel('Type your message').fill('An unfinished follow-up for the same conversation.');
  await page.getByRole('button', { name: /Who answers/ }).click();
  await expect(page.getByLabel('Type your message')).toHaveValue('An unfinished follow-up for the same conversation.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Who answers/ }).click();
  await expect(page.getByRole('button', { name: 'End conversation' })).toBeEnabled();
  await expect(page.getByLabel('Type your message')).toHaveValue('An unfinished follow-up for the same conversation.');
  await page.getByRole('button', { name: /How they help/ }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: /How they help/ }).click();
  await expect(page.getByLabel('Type your message')).toHaveValue('An unfinished follow-up for the same conversation.');
  const afterLayoutChange = await (await page.request.get('/api/me/calls?environment=test')).json();
  expect(afterLayoutChange.items.map((call: { id: string }) => call.id)).toEqual(beforeLayoutChange.items.map((call: { id: string }) => call.id));
  await page.getByRole('button', { name: 'End conversation' }).click();
  await expect.poll(async () => {
    const calls = await (await page.request.get('/api/me/calls?environment=test')).json();
    return calls.items[0]?.status;
  }).toBe('completed');
  const calls = await (await page.request.get('/api/me/calls?environment=test')).json();
  const detail = await (await page.request.get(`/api/me/calls/${calls.items[0].id}`)).json();
  expect(detail.turns).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'caller', text: 'Do you repair bicycles?' }), expect.objectContaining({ role: 'agent', text: 'Yes, we repair bicycles during opening hours.' })]));
  await page.getByRole('button', { name: 'Messages', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Messages & conversations' })).toBeVisible();
  await page.getByRole('button', { name: /Caller asked about bicycle repairs/ }).click();
  await expect(page.getByRole('heading', { name: 'What was said' })).toBeVisible();
  await expect(page.getByText('Do you repair bicycles?', { exact: true })).toBeVisible();
});

test('portable recipes exclude connections and the fresh layout fits desktop and mobile', async ({ page }) => {
  const { id } = await seed(page);
  const directory = '/tmp/openfon-cleanroom-qa';
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: /Who answers/ }).click();
  const startBounds = await page.getByRole('button', { name: 'Start browser conversation' }).boundingBox();
  expect(startBounds).not.toBeNull();
  expect(startBounds!.y + startBounds!.height).toBeLessThanOrEqual(800);
  await expect(page.getByRole('button', { name: 'Listen to a sample' })).toBeEnabled();
  await page.screenshot({ path: `${directory}/desktop-expanded.png`, fullPage: true });
  await page.getByRole('button', { name: /Who answers/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${directory}/mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await menu(page, 'Connections & portability');
  await expect(page.getByRole('heading', { name: 'Your connections' })).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recipe' }).click();
  const download = await downloadEvent;
  const recipe = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(Object.keys(recipe).sort()).toEqual(['assistant', 'format', 'version']);
  expect(recipe.assistant).not.toHaveProperty('apiKey');
  expect(recipe.assistant).not.toHaveProperty('baseUrl');
  recipe.assistant.greeting = 'An imported welcome.';
  await page.locator('input[type=file]').setInputFiles({ name: 'fixture.openfon.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(recipe)) });
  const before = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  expect(before.greeting).not.toBe(recipe.assistant.greeting);
  await page.getByRole('button', { name: 'Save this recipe' }).click();
  await expect(page.getByText('Recipe imported into this receptionist.')).toBeVisible();
  const saved = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  expect(saved.greeting).toBe(recipe.assistant.greeting);
  await page.screenshot({ path: `${directory}/connections.png`, fullPage: true });
});

test('web availability is an explicit action and pausing withdraws the public assistant', async ({ page }) => {
  const { id } = await seed(page);
  const assistant = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  expect((await page.request.get(`/api/public/agent/${assistant.public_slug}`)).status()).toBe(404);
  await page.getByRole('button', { name: 'Enable web calls', exact: true }).click();
  await expect(page.getByText('Available on the web', { exact: true })).toBeVisible();
  expect((await page.request.get(`/api/public/agent/${assistant.public_slug}`)).ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Pause web calls', exact: true }).click();
  await expect(page.getByText('Web calls paused', { exact: true })).toBeVisible();
  expect((await page.request.get(`/api/public/agent/${assistant.public_slug}`)).status()).toBe(404);
});

test('saved text connection checks and reusable voice setups use the current configuration', async ({ page }) => {
  await seed(page);
  await menu(page, 'Connections & portability');
  await page.getByRole('button', { name: 'Check saved connection', exact: true }).click();
  await expect(page.getByText(/Connection check passed for/)).toBeVisible();
  await page.getByText('Reusable voice setups', { exact: true }).click();
  await page.getByLabel('Name a reusable setup').fill('Everyday conversation');
  await page.getByRole('button', { name: 'Save current voice setup', exact: true }).click();
  await expect(page.getByText('Reusable voice setup saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use setup', exact: true }).click();
  await expect(page.getByText('Applied “Everyday conversation” to this receptionist.')).toBeVisible();
});

for (const language of ['de', 'de-DE']) {
  test(`voice sampling previews a local draft without saving or reserving a conversation (${language})`, async ({ page }) => {
    await page.addInitScript(() => {
      const samples: { text: string; lang: string }[] = [];
      Object.defineProperty(window, '__cleanroomSamples', { value: samples });
      Object.defineProperty(window, 'speechSynthesis', { value: {
        cancel() {}, getVoices: () => [],
        speak(utterance: SpeechSynthesisUtterance) {
          samples.push({ text: utterance.text, lang: utterance.lang });
          queueMicrotask(() => utterance.onend?.(new Event('end') as SpeechSynthesisEvent));
        },
      } });
    });
    const { id } = await seed(page);
    if (language === 'de-DE') {
      expect((await page.request.put(`/api/me/assistants/${id}`, { data: { language } })).ok()).toBe(true);
      await page.reload();
    }
    const writes: string[] = [];
    page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(request.url()); });
    await page.getByRole('button', { name: /Who answers/ }).click();
    await page.getByLabel('Their first words').fill('A sample from my unsaved greeting.');
    const picker = page.getByRole('combobox', { name: 'Language', exact: true });
    if (language === 'de') await picker.selectOption(language);
    await expect(picker).toHaveValue(language);
    await page.getByRole('button', { name: 'Listen to a sample' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __cleanroomSamples: unknown[] }).__cleanroomSamples)).toEqual([{ text: PREVIEW_TEXT.de, lang: language }]);
    expect(writes).toEqual([]);
    const persisted = await (await page.request.get(`/api/me/assistants/${id}`)).json();
    expect(persisted.language).toBe(language === 'de-DE' ? language : 'en');
    expect(persisted.greeting).not.toContain('unsaved');
    await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeDisabled();
  });
}

test('browser samples select native voices by locale and preserve the provider voice across speech modes', async ({ page }) => {
  await page.addInitScript(() => {
    const samples: { text: string; lang: string; voice: string }[] = [];
    const voices = [{ name: 'Austrian native', lang: 'de-AT' }, { name: 'German native', lang: 'de-DE' }];
    Object.defineProperty(window, '__nativeVoiceTest', { value: { samples, voices } });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class {
      text: string;
      lang = '';
      voice: { name: string; lang: string } | null = null;
      onend: (() => void) | null = null;
      constructor(text: string) { this.text = text; }
    } });
    Object.defineProperty(window, 'speechSynthesis', { value: {
      cancel() {}, getVoices: () => voices,
      speak(utterance: { text: string; lang: string; voice: { name: string } | null; onend?: () => void }) {
        samples.push({ text: utterance.text, lang: utterance.lang, voice: utterance.voice?.name || '' });
        queueMicrotask(() => utterance.onend?.());
      },
    } });
  });
  const { id } = await seed(page);
  expect((await page.request.put(`/api/me/assistants/${id}`, {
    data: { language: 'de-DE', voice: 'saved-provider-voice' },
  })).ok()).toBe(true);
  let mode: 'browser' | 'openai' = 'browser';
  await page.route('**/api/me/provider', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), effective_tts_provider: mode } });
  });
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(request.url()); });
  await page.reload();
  await page.getByRole('button', { name: /Who answers/ }).click();
  const voice = page.getByRole('combobox', { name: 'Voice', exact: true });
  await expect(voice).toBeDisabled();
  await expect(voice).toHaveValue('saved-provider-voice');
  await expect(voice.locator('option')).toHaveText(['Browser default (language-based)']);
  await page.getByRole('button', { name: 'Listen to a sample', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __nativeVoiceTest: { samples: unknown[] } }).__nativeVoiceTest.samples)).toEqual([
    { text: PREVIEW_TEXT.de, lang: 'de-DE', voice: 'German native' },
  ]);
  await page.evaluate(() => (window as unknown as { __nativeVoiceTest: { voices: unknown[] } }).__nativeVoiceTest.voices.pop());
  await page.getByRole('button', { name: 'Listen to a sample', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __nativeVoiceTest: { samples: unknown[] } }).__nativeVoiceTest.samples)).toEqual([
    { text: PREVIEW_TEXT.de, lang: 'de-DE', voice: 'German native' },
    { text: PREVIEW_TEXT.de, lang: 'de-DE', voice: 'Austrian native' },
  ]);
  mode = 'openai';
  await page.reload();
  await page.getByRole('button', { name: /Who answers/ }).click();
  await expect(page.getByRole('button', { name: 'Listen to a sample', exact: true })).toBeEnabled();
  await expect(voice).toBeEnabled();
  await expect(voice).toHaveValue('saved-provider-voice');
  await expect(voice.locator('option:checked')).toHaveText('saved-provider-voice');
  mode = 'browser';
  await page.reload();
  await page.getByRole('button', { name: /Who answers/ }).click();
  await expect(voice).toBeDisabled();
  await expect(voice).toHaveValue('saved-provider-voice');
  await expect(voice.locator('option:checked')).toHaveText('Browser default (language-based)');
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(await (await page.request.get(`/api/me/assistants/${id}`)).json()).toMatchObject({
    language: 'de-DE', voice: 'saved-provider-voice',
  });
});

test('a save acknowledgement preserves edits typed while the request was in flight', async ({ page }) => {
  const { id } = await seed(page);
  await page.getByRole('button', { name: /Who answers/ }).click();
  await page.getByLabel('Their first words').fill('The submitted greeting.');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  await page.route(`**/api/me/assistants/${id}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    arrived(); await gate; await route.continue();
  });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await started;
  await page.getByLabel('Their first words').fill('A later unsaved greeting.');
  release();
  await expect(page.getByText('Saved. Your next conversation will use this brief.')).toBeVisible();
  await expect(page.getByLabel('Their first words')).toHaveValue('A later unsaved greeting.');
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeDisabled();
  const persisted = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  expect(persisted.greeting).toBe('The submitted greeting.');
});
