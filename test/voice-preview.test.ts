import type { AgentSettings, Env } from '../src/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generateVoicePreview, realtimePreview, pcmWav, PREVIEW_MAX_BYTES, PREVIEW_DEADLINE_MS } from '../src/voice-preview';
import type { RealtimeConfig } from '../src/realtime-providers';

class Socket extends EventTarget {
  sent: any[] = [];
  accept = vi.fn(); close = vi.fn();
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}
const config: RealtimeConfig = { provider: 'kataleptic', protocol: 'gateway', baseUrl: 'wss://api.kataleptic.com/v1/realtime', apiKey: 'private-test-key', model: 'gpt-realtime-2.1-mini' };
let ws: Socket;
beforeEach(() => { ws = new Socket(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 101, webSocket: ws })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function start(signal = new AbortController().signal) {
  const promise = realtimePreview(config, 'marin', 'Guten Tag!', signal);
  await Promise.resolve();
  return { promise };
}
function acknowledge() {
  ws.message({ type: 'session.updated', session: { instructions: ws.sent[0].session.instructions } });
  ws.message({ type: 'response.created', response: { id: 'r1' } });
}
it('uses selected model/voice and server authorization; waits for the applied prompt before generating', async () => {
  const { promise } = await start();
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('model=gpt-realtime-2.1-mini'), expect.objectContaining({ headers: { Upgrade: 'websocket', Authorization: 'Bearer private-test-key' }, redirect: 'manual' }));
  expect(ws.sent[0].session.audio.output).toEqual({ format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' });
  ws.message({ type: 'session.updated', session: { instructions: 'default' } }); expect(ws.sent).toHaveLength(1);
  acknowledge();
  expect(ws.sent.map(x => x.type)).toEqual(['session.update', 'conversation.item.create', 'response.create']);
  ws.message({ type: 'response.output_audio.delta', response_id: 'r1', delta: btoa('\0\0\x01\0') });
  ws.message({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  const wav = await promise; expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
  expect(new DataView(wav).getUint32(40, true)).toBe(4); expect(ws.close).toHaveBeenCalledOnce();
});
it.each(['empty', 'wrong-id', 'failed', 'invalid-json', 'oversize', 'event-flood', 'odd-pcm'])('rejects %s and closes provider without exposing its errors', async mode => {
  const { promise } = await start(); const rejected = expect(promise).rejects.toThrow('Voice preview failed'); acknowledge();
  if (mode === 'wrong-id') ws.message({ type: 'response.output_audio.delta', response_id: 'other', delta: 'AAA=' });
  if (mode === 'invalid-json') ws.dispatchEvent(new MessageEvent('message', { data: '{secret' }));
  if (mode === 'oversize') for (let i = 0; i < 3; i++) ws.message({ type: 'response.output_audio.delta', response_id: 'r1', delta: btoa('\0'.repeat(480000)) });
  if (mode === 'event-flood') for (let i = 0; i < 1501; i++) ws.message({ type: 'ping' });
  if (mode === 'odd-pcm') ws.message({ type: 'response.output_audio.delta', response_id: 'r1', delta: 'AA==' });
  ws.message({ type: 'response.done', response: { id: 'r1', status: mode === 'failed' ? 'failed' : 'completed' } });
  await rejected; expect(ws.close).toHaveBeenCalledOnce();
});
it('deadline covers a stalled upgrade and disposes a late socket', async () => {
  vi.useFakeTimers(); let resolve!: (value: unknown) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise(r => { resolve = r; }) as any);
  const { promise } = await start(); const rejected = expect(promise).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(PREVIEW_DEADLINE_MS); await rejected;
  resolve({ status: 101, webSocket: ws }); await Promise.resolve();
  expect(ws.close).toHaveBeenCalledOnce(); expect(ws.sent).toEqual([]);
});
it('caller cancellation closes a running preview and ignores subsequent output', async () => {
  const controller = new AbortController(); const { promise } = await start(controller.signal);
  const rejected = expect(promise).rejects.toThrow(); controller.abort(); await rejected;
  ws.message({ type: 'session.updated', session: ws.sent[0].session });
  expect(ws.sent).toHaveLength(1); expect(ws.close).toHaveBeenCalledOnce();
});
it('rejects already cancelled requests before connecting and bounds PCM duration', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(realtimePreview(config, '', 'Hi', controller.signal)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  expect(() => pcmWav(new Uint8Array(PREVIEW_MAX_BYTES + 2))).toThrow();
});
it('bounds aggregate non-audio messages and closes a silent established socket at deadline', async () => {
  const { promise } = await start(); const rejected = expect(promise).rejects.toThrow();
  for (let i = 0; i < 5; i++) ws.message({ type: 'unknown', text: 'a'.repeat(900000) });
  await rejected; expect(ws.close).toHaveBeenCalledOnce();
});
it('established silent session times out', async () => {
  vi.useFakeTimers(); const { promise } = await start(); const rejected = expect(promise).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(PREVIEW_DEADLINE_MS); await rejected; expect(ws.close).toHaveBeenCalledOnce();
});
it('Pipeline synthesizes the localized sample with its own model/key and wraps PCM for browser playback', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array([1, 0, 2, 0])));
  const settings = { engine: 'pipeline', language: 'de', voice: 'nova', tts_provider: 'openai',
    tts_base_url: 'https://api.openai.com/v1', tts_api_key: 'speech-key', tts_model: 'tts-1' } as AgentSettings;
  const wav = await generateVoicePreview({ DEFAULT_LLM_API_KEY: 'not-speech' } as Env, settings, new AbortController().signal);
  expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/audio/speech', expect.objectContaining({
    headers: { Authorization: 'Bearer speech-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', input: 'Guten Tag! So klingt meine Stimme. Wie kann ich Ihnen heute helfen?', voice: 'nova', response_format: 'pcm' }),
  }));
  expect(wav.byteLength).toBe(48);
});
it('Pipeline refuses oversized or empty provider audio rather than returning a misleading sample', async () => {
  const settings = { engine: 'pipeline', language: 'en', voice: 'nova', tts_provider: 'openai',
    tts_base_url: 'https://api.openai.com/v1', tts_api_key: 'speech-key', tts_model: 'tts-1' } as AgentSettings;
  for (const size of [0, PREVIEW_MAX_BYTES + 2]) {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array(size)));
    await expect(generateVoicePreview({} as Env, settings, new AbortController().signal)).rejects.toThrow();
  }
});
