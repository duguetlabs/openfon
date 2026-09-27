import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, callbackMessage, callDate, RehearsalController, parseAssistantRecipe, exportAssistantRecipe, assistantRecipePatch, supportedLanguages, voiceChoicesFor } from '../web/src/cleanroom-runtime';
import type { VoiceEvent } from '../web/src/voice';
import type { ProviderCatalog } from '../web/src/cleanroom-runtime';
import { OPENAI_REALTIME_VOICES } from '../src/provider-settings';
import { PREVIEW_TEXT } from '../src/voice-preview-text';

afterEach(() => vi.unstubAllGlobals());

describe('model-scoped language and voice choices', () => {
  const catalog = { voices: { azure: [{ id: 'azure-voice', label: 'Azure voice' }], realtime: { 'gpt-live-1': [{ id: 'marin', label: 'Marin' }] }, native: [{ id: 'gateway-extra', label: 'Gateway only' }] } } as unknown as ProviderCatalog;
  const provider = { effective_realtime_provider: 'kataleptic', effective_realtime_model: 'kataleptic-realtime-hd', effective_tts_provider: 'browser', tts_model: '' };
  it('offers exactly server-supported preview languages', () => {
    expect(supportedLanguages.map(option => option.id).sort()).toEqual(Object.keys(PREVIEW_TEXT).sort());
  });
  it('uses effective blank model and HD speech voices', () => {
    expect(voiceChoicesFor({ engine: 'realtime', realtime_model: '' }, provider, catalog)).toEqual(catalog.voices.azure);
    expect(voiceChoicesFor({ engine: 'realtime', realtime_model: 'gpt-live-1' }, provider, catalog)).toEqual(catalog.voices.realtime['gpt-live-1']);
  });
  it('never offers gateway-specific voices to direct OpenAI or custom realtime', () => {
    expect(voiceChoicesFor({ engine: 'realtime', realtime_model: '' }, { ...provider, effective_realtime_provider: 'openai' }, catalog).map(v => v.id)).toEqual(OPENAI_REALTIME_VOICES);
    expect(voiceChoicesFor({ engine: 'realtime', realtime_model: 'gpt-live-1' }, { ...provider, effective_realtime_provider: 'custom' }, catalog)).toEqual([]);
  });
  it('keeps fallback voice contracts distinct when optional discovery is unavailable', () => {
    const ids = (model: string) => voiceChoicesFor({ engine: 'realtime', realtime_model: model }, provider, null).map(v => v.id);
    expect(ids('gpt-live-1')).toContain('breeze');
    for (const model of ['gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini']) {
      expect(ids(model)).toEqual(OPENAI_REALTIME_VOICES);
      expect(ids(model)).not.toContain('breeze');
    }
    expect(ids('kataleptic-realtime-hd')).toContain('de-DE-SeraphinaMultilingualNeural');
    expect(ids('unknown-custom-model')).toEqual([]);
    expect(voiceChoicesFor({engine:'realtime',realtime_model:'gpt-live-1'}, {...provider,effective_realtime_provider:'custom'}, null)).toEqual([]);
  });
  it('keeps legacy OpenAI speech voices separate from realtime and custom speech', () => {
    expect(voiceChoicesFor({ engine: 'pipeline', realtime_model: '' }, { ...provider, effective_tts_provider: 'openai', tts_model: 'tts-1' }, catalog).map(v => v.id)).toEqual(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
    expect(voiceChoicesFor({ engine: 'pipeline', realtime_model: '' }, { ...provider, effective_tts_provider: 'custom' }, catalog)).toEqual([]);
  });
});

describe('clean-room API failure contract', () => {
  it.each(['null', '{}', 'not-json'])('requires an explicit logout/deletion acknowledgment: %s', async body => {
    const fetch = vi.fn(async () => new Response(body));
    vi.stubGlobal('fetch', fetch);
    await expect(api.logout()).rejects.toThrow('did not confirm');
    await expect(api.deleteAccount({ currentPassword: 'synthetic-password', confirmation: 'DELETE' })).rejects.toThrow('did not confirm');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retains actionable authentication failure and never retries the mutation', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    await expect(api.saveAssistant('owned/id', { greeting: 'Changed' })).rejects.toMatchObject({ status: 401, message: 'Not signed in' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['/api/me/assistants/owned%2Fid', expect.objectContaining({ method: 'PUT', credentials: 'same-origin' })]);
  });
  it('preserves Retry-After and provider error messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Daily test-call limit reached.' }), { status: 429, headers: { 'Retry-After': '420' } })));
    await expect(api.reserveTest('a')).rejects.toMatchObject({ status: 429, retryAfter: '420', message: 'Daily test-call limit reached.' });
  });
  it('does not turn a non-JSON server failure into empty success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream unavailable', { status: 502 })));
    await expect(api.provider()).rejects.toBeInstanceOf(ApiError);
  });
  it('makes test inclusion explicit and safely encodes search/cursor', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null })));
    vi.stubGlobal('fetch', fetch);
    await api.calls({ environment: 'all', search: 'Ada & Eve', cursor: 'a+b=', limit: 30 });
    expect(fetch.mock.calls[0][0]).toBe('/api/me/calls?environment=all&search=Ada+%26+Eve&cursor=a%2Bb%3D&limit=30');
  });
  it('voice samples transfer only five draft fields and preserve binary audio', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'Content-Type': 'audio/wav' } }));
    vi.stubGlobal('fetch', fetch);
    const draft = { engine: 'pipeline' as const, language: 'en', voice: 'test', realtime_model: '', realtime_voice: '', apiKey: 'test-only-excluded' };
    const audio = await api.voicePreview('assistant', draft);
    expect(audio.type).toBe('audio/wav');
    expect(audio.size).toBe(4);
    const options = fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(options.body as string)).toEqual({ engine: 'pipeline', language: 'en', voice: 'test', realtime_model: '', realtime_voice: '' });
  });
  it('voice sample failure exposes retry guidance rather than a corrupt audio blob', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Voice preview limit reached.' }), { status: 429, headers: { 'Retry-After': '60' } })));
    await expect(api.voicePreview('assistant', { engine: 'realtime', language: 'en', voice: '', realtime_model: '', realtime_voice: '' })).rejects.toMatchObject({ status: 429, retryAfter: '60', message: 'Voice preview limit reached.' });
  });
});

describe('actual conversation meaning', () => {
  it('does not mistake contact details for a callback message', () => {
    expect(callbackMessage('{"caller_phone":"123","caller_name":"Ada","message":"  "}')?.message).toBeNull();
    expect(callbackMessage('{"message":" Please call about Tuesday. "}')?.message).toBe('Please call about Tuesday.');
    expect(callbackMessage('broken')).toBeNull();
    expect(callbackMessage('[]')).toBeNull();
  });
  it('interprets timezone-less SQLite call times as UTC', () => {
    expect(callDate('2026-09-27 12:30:00').toISOString()).toBe('2026-09-27T12:30:00.000Z');
  });
});

class FakeVoice {
  ended = false;
  hasMic = false;
  listener: (event: VoiceEvent) => void = () => {};
  on(listener: (event: VoiceEvent) => void) { this.listener = listener; }
  prepareAudio = vi.fn();
  connect = vi.fn(async (_id: string) => {});
  start = vi.fn(async (_slug: string) => {});
  sendText = vi.fn();
  hangup = vi.fn(() => { this.ended = true; this.listener({ type: 'status', status: 'ended' }); });
}
function fixture(reserve = vi.fn(async (_id: string) => ({ callId: 'ticket' }))) {
  const voice = new FakeVoice();
  const cancel = vi.fn(async (_id: string) => ({}));
  const events: VoiceEvent[] = [];
  const ended = vi.fn();
  const controller = new RehearsalController(event => events.push(event), ended, { create: () => voice, reserve, cancel });
  return { controller, voice, reserve, cancel, events, ended };
}
describe('rehearsal save and cancellation invariants', () => {
  it('cannot spend a ticket for unsaved edits', async () => {
    const f = fixture();
    await expect(f.controller.start('assistant', { dirty: true })).rejects.toThrow('Save your changes');
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.voice.prepareAudio).not.toHaveBeenCalled();
  });
  it('prepares audio before reserving and does not duplicate a pending start', async () => {
    const f = fixture();
    await Promise.all([f.controller.start('assistant'), f.controller.start('assistant')]);
    expect(f.voice.prepareAudio.mock.invocationCallOrder[0]).toBeLessThan(f.reserve.mock.invocationCallOrder[0]);
    expect(f.reserve).toHaveBeenCalledOnce();
    expect(f.voice.connect).toHaveBeenCalledWith('ticket');
  });
  it('retires a ticket arriving after cancellation without connecting', async () => {
    let resolve!: (value: { callId: string }) => void;
    const reserve = vi.fn((_id: string) => new Promise<{ callId: string }>(done => { resolve = done; }));
    const f = fixture(reserve);
    const start = f.controller.start('assistant');
    f.controller.stop();
    resolve({ callId: 'late' });
    await start;
    expect(f.cancel).toHaveBeenCalledWith('late');
    expect(f.voice.connect).not.toHaveBeenCalled();
    expect(f.ended).toHaveBeenCalledOnce();
  });
  it('keeps provider errors visible after transport teardown and retires unclaimed tickets', async () => {
    const f = fixture();
    await f.controller.start('assistant');
    f.voice.listener({ type: 'status', status: 'error', detail: 'Saved provider rejected this model.' });
    f.voice.hangup();
    expect(f.events.at(-1)).toEqual({ type: 'status', status: 'error', detail: 'Saved provider rejected this model.' });
    expect(f.cancel).toHaveBeenCalledWith('ticket');
    expect(f.ended).toHaveBeenCalledOnce();
  });
  it('cleans a failed connection once and allows a fresh attempt', async () => {
    const f = fixture();
    f.voice.connect.mockRejectedValueOnce(new Error('Socket blocked'));
    await f.controller.start('assistant');
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toMatchObject({ status: 'error', detail: 'Socket blocked' });
    await f.controller.start('assistant');
    expect(f.reserve).toHaveBeenCalledTimes(2);
  });
  it('ignores late events after the view is disposed', async () => {
    const f = fixture();
    await f.controller.start('assistant');
    f.controller.dispose();
    const length = f.events.length;
    f.voice.listener({ type: 'agent_text', text: 'Late reply' });
    expect(f.events).toHaveLength(length);
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.ended).not.toHaveBeenCalled();
  });
});

describe('recipe transfer remains a proposal', () => {
  it('does not persist or carry secrets and can keep destination speech choices', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const source = { name: 'Ada', greeting: 'Hello', persona: 'Helpful', language: 'de', voice: 'voice', take_messages: 1, custom_instructions: '', engine: 'pipeline', realtime_model: '', realtime_voice: '', llm_model: 'model', apiKey: 'test-only-not-a-real-secret', business_id: 'source' };
    const exported = exportAssistantRecipe(source);
    expect(exported).not.toContain(source.apiKey);
    expect(exported).not.toContain('business_id');
    const proposal = assistantRecipePatch(parseAssistantRecipe(exported), false);
    expect(proposal).not.toHaveProperty('engine');
    expect(proposal).not.toHaveProperty('language');
    expect(fetch).not.toHaveBeenCalled();
  });
});
