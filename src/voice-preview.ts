import type { AgentSettings, Env } from './types';
import { piperVoiceFor, speechConfig, speechVoice, synthesize, voiceForReply } from './providers';
import { realtimeCapabilities, realtimeConnection, resolveRealtime, type RealtimeConfig } from './realtime-providers';
import { decodeRealtimeAudio, parseRealtimeMessage } from './realtime-input';

import { PREVIEW_TEXT } from './voice-preview-text';
export { PREVIEW_TEXT } from './voice-preview-text';
export const PREVIEW_MAX_BYTES = 960_000; // 20 seconds, mono PCM16 at 24 kHz.
export const PREVIEW_DEADLINE_MS = 25_000;
const failed = () => new Error('Voice preview failed. Check the selected model, voice and saved provider settings, then try again.');

export function pcmWav(pcm: Uint8Array): ArrayBuffer {
  if (!pcm.length || pcm.length > PREVIEW_MAX_BYTES || pcm.length % 2) throw failed();
  const wav = new Uint8Array(44 + pcm.length); const view = new DataView(wav.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']] as const) {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  }
  view.setUint32(4, 36 + pcm.length, true); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  view.setUint32(40, pcm.length, true); wav.set(pcm, 44); return wav.buffer;
}

// Every preview has its own session: realtime providers lock the voice after
// first audio. No microphone, tools, business prompt, or call persistence.
export function realtimePreview(config: RealtimeConfig, voice: string, text: string, signal: AbortSignal): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined, settled = false, requested = false, responseId = '';
    let bytes = 0, events = 0, inputChars = 0; const chunks: Uint8Array[] = [];
    const controller = new AbortController();
    const instructions = `Read this sample exactly once, without any introduction or extra words: ${text}`;
    const close = (ws?: WebSocket) => { try { ws?.close(1000, 'Preview complete'); } catch { /* already closed */ } };
    const finish = (result?: ArrayBuffer) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      close(socket); controller.abort(); chunks.length = 0;
      if (result) resolve(result); else reject(failed());
    };
    const abort = () => finish();
    const timer = setTimeout(abort, PREVIEW_DEADLINE_MS);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    const connection = realtimeConnection(config);
    void fetch(connection.url, { headers: connection.headers, signal: controller.signal, redirect: 'manual' }).then(response => {
      const ws = response.webSocket;
      if (settled) { if (ws) { ws.accept(); close(ws); } else void response.body?.cancel().catch(() => {}); return; }
      if (!ws || response.status !== 101) { void response.body?.cancel().catch(() => {}); finish(); return; }
      socket = ws; ws.accept();
      ws.addEventListener('close', abort); ws.addEventListener('error', abort);
      ws.addEventListener('message', event => {
        if (settled) return;
        try {
          if (++events > 1500 || typeof event.data !== 'string' || (inputChars += event.data.length) > 4_000_000) throw failed();
          const msg = parseRealtimeMessage(event.data);
          if (msg.type === 'error') throw failed();
          if (msg.type === 'session.updated' && !requested) {
            // Ignore a provider's initial/default session acknowledgment.
            const session = msg.session as { instructions?: string } | undefined;
            if (session?.instructions !== instructions) return;
            requested = true;
            ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: instructions }] } }));
            ws.send(JSON.stringify({ type: 'response.create' }));
          } else if (msg.type === 'response.created' && requested) {
            const id = (msg.response as { id?: unknown } | undefined)?.id;
            if (responseId || typeof id !== 'string' || !id) throw failed();
            responseId = id;
          } else if (msg.type === 'response.output_audio.delta') {
            if (!responseId || msg.response_id !== responseId) throw failed();
            const chunk = new Uint8Array(decodeRealtimeAudio(msg.delta as string));
            if ((bytes += chunk.length) > PREVIEW_MAX_BYTES) throw failed();
            chunks.push(chunk);
          } else if (msg.type === 'response.done') {
            const result = msg.response as { id?: string; status?: string } | undefined;
            if (!responseId || result?.id !== responseId || result.status !== 'completed') throw failed();
            const pcm = new Uint8Array(bytes); let offset = 0;
            for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
            finish(pcmWav(pcm));
          }
        } catch { finish(); }
      });
      ws.send(JSON.stringify({ type: 'session.update', session: {
        type: 'realtime', instructions,
        ...(config.protocol === 'openai' ? { output_modalities: ['audio'] } : {}),
        audio: { input: { format: { type: 'audio/pcm', rate: 24000 } },
          output: { format: { type: 'audio/pcm', rate: 24000 }, ...(voice ? { voice } : {}) } },
      } }));
    }).catch(() => finish());
  });
}

export async function generateVoicePreview(env: Env, settings: AgentSettings, signal: AbortSignal): Promise<ArrayBuffer> {
  const text = PREVIEW_TEXT[settings.language];
  if (!text) throw failed();
  if (settings.engine === 'pipeline') {
    if (speechConfig(env, settings).provider === 'browser') throw failed();
    const bytes = await synthesize(env, text, speechVoice(env, settings.language, settings), 'pcm24', settings, signal);
    if (!bytes) throw failed();
    return pcmWav(new Uint8Array(bytes));
  }
  const config = resolveRealtime(env, settings); const capabilities = realtimeCapabilities(config);
  const voice = settings.realtime_voice || (capabilities.managedVoice
    ? voiceForReply(env, settings.language, settings.language, settings.voice)
    : capabilities.cascade ? await piperVoiceFor({ ...env, REALTIME_BASE_URL: config.baseUrl }, settings.language) : '');
  return realtimePreview(config, voice, text, signal);
}
