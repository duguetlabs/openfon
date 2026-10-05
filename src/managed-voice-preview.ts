import type { Env } from './types';
import { azureConfig, managedVoice } from './managed-azure';
import { PREVIEW_TEXT } from './voice-preview-text';
import { decodeRealtimeAudio, parseRealtimeMessage } from './realtime-input';
import { GPT_LIVE_SILENCE, silentPcm } from './gpt-live';
import { pcmWav } from './voice-preview';
import { azureSeconds } from './azure-usage';
export interface PreviewUsage {
  sessionId: string;
  seconds?: number;
  final: boolean;
}
/** Actual selected conversation voice, with no caller audio or delegated tools. */
export async function azureVoicePreview(
  env: Env,
  selection: { voice: string; language: string },
  signal: AbortSignal,
  onUsage: (value: PreviewUsage) => Promise<void> = async () => {}
): Promise<ArrayBuffer> {
  const cfg = azureConfig(env),
    voice = managedVoice(selection.voice),
    text = PREVIEW_TEXT[selection.language];
  if (!text) throw Error('Choose an available language.');
  let usage: PreviewUsage | undefined;
  try {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      let ws: WebSocket | undefined,
        settled = false,
        draining = false,
        started = false,
        sessionId = '',
        input: ReturnType<typeof setInterval> | undefined,
        drain: ReturnType<typeof setTimeout> | undefined;
      let total = 0,
        kept = 0,
        silent = 0,
        events = 0,
        chars = 0;
      const chunks: Uint8Array[] = [];
      let result: ArrayBuffer | undefined;
      const controller = new AbortController();
      const complete = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (drain !== undefined) clearTimeout(drain);
        if (input !== undefined) clearInterval(input);
        signal.removeEventListener('abort', abort);
        controller.abort();
        try {
          ws?.close(1000, 'Preview ended');
        } catch {}
        result
          ? resolve(result)
          : reject(
              Error('The voice sample could not be played. Please try again.')
            );
      };
      const finish = (audio?: ArrayBuffer) => {
        if (settled || draining) return;
        draining = true;
        result = audio;
        if (input !== undefined) clearInterval(input);
        if (started) {
          try {
            ws?.send(JSON.stringify({ type: 'session.close' }));
            drain = setTimeout(complete, 3000);
            return;
          } catch {}
        }
        complete();
      };
      const abort = () => finish();
      const deadline = setTimeout(abort, 30000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      void fetch(cfg.baseURL + '/live/sessions', {
        headers: { Upgrade: 'websocket', 'api-key': cfg.apiKey },
        signal: controller.signal,
        redirect: 'manual',
      })
        .then((response) => {
          const socket = response.webSocket;
          if (settled) {
            if (socket) {
              socket.accept();
              socket.close();
            } else void response.body?.cancel();
            return;
          }
          if (response.status !== 101 || !socket) {
            void response.body?.cancel();
            complete();
            return;
          }
          ws = socket;
          ws.accept();
          ws.addEventListener('close', complete);
          ws.addEventListener('error', complete);
          ws.addEventListener('message', (event) => {
            if (settled) return;
            try {
              if (
                ++events > 1600 ||
                typeof event.data !== 'string' ||
                (chars += event.data.length) > 4000000
              )
                throw Error();
              const msg = parseRealtimeMessage(event.data);
              if (
                sessionId &&
                ((msg.session_id !== undefined &&
                  msg.session_id !== sessionId) ||
                  (msg.type === 'session.started' &&
                    (msg.session as { id?: unknown } | undefined)?.id !==
                      sessionId))
              ) {
                // One preview owns one session. Refuse replacement identity even
                // during close drain, before its usage can contaminate this record.
                result = undefined;
                complete();
                return;
              }
              if (
                msg.type === 'session.usage.updated' ||
                msg.type === 'session.closed'
              ) {
                const seconds = (msg.usage as { seconds?: unknown } | undefined)
                  ?.seconds;
                if (sessionId) {
                  const valid =
                    typeof seconds === 'number' &&
                    azureSeconds(seconds) !== undefined
                      ? seconds
                      : undefined;
                  const previous =
                    usage?.sessionId === sessionId ? usage.seconds : undefined;
                  const maximum =
                    valid === undefined
                      ? previous
                      : previous === undefined
                        ? valid
                        : Math.max(previous, valid);
                  usage = {
                    sessionId,
                    ...(maximum === undefined ? {} : { seconds: maximum }),
                    // Counters are cumulative, not additive. A missing/regressing
                    // terminal amount cannot certify an earlier measured quantity.
                    final:
                      msg.type === 'session.closed' &&
                      (maximum === undefined ||
                        (valid !== undefined && valid >= maximum)),
                  };
                }
                if (msg.type === 'session.closed') {
                  complete();
                  return;
                }
              }
              if (draining) return;
              if (msg.type === 'error') throw Error();
              if (msg.type === 'session.started' && !started) {
                const s = msg.session as
                  | {
                      id?: unknown;
                      model?: unknown;
                      audio?: {
                        format?: { type?: unknown; rate?: unknown };
                        output?: { voice?: unknown };
                      };
                    }
                  | undefined;
                if (
                  typeof s?.id === 'string' &&
                  /^[A-Za-z0-9_.:-]{1,200}$/.test(s.id)
                ) {
                  sessionId = s.id;
                  usage = { sessionId, final: false };
                }
                if (
                  s?.model !== cfg.liveModel ||
                  s.audio?.format?.type !== 'audio/pcm' ||
                  s.audio.format.rate !== 24000 ||
                  s.audio.output?.voice !== voice ||
                  typeof s.id !== 'string' ||
                  !/^[A-Za-z0-9_.:-]{1,200}$/.test(s.id)
                )
                  throw Error();
                started = true;
                sessionId = s.id;
                usage = { sessionId, final: false };
                const packet = JSON.stringify({
                  type: 'session.input_audio.append',
                  audio: btoa(
                    String.fromCharCode(...new Uint8Array(GPT_LIVE_SILENCE))
                  ),
                });
                const send = () => {
                  try {
                    ws!.send(packet);
                  } catch {
                    finish();
                  }
                };
                send();
                input = setInterval(send, 100);
                ws!.send(
                  JSON.stringify({
                    type: 'session.commentary.append',
                    delegation_id: null,
                    content: `Say exactly: '${text}'`,
                  })
                );
              } else if (msg.type === 'session.output_audio.delta') {
                if (!started) throw Error();
                const chunk = new Uint8Array(
                  decodeRealtimeAudio(msg.delta as string)
                );
                if (!chunk.length) return;
                if (chunk.length % 2) throw Error();
                if (!silentPcm(chunk.buffer as ArrayBuffer)) silent = 0;
                else if (!chunks.length) return;
                else if ((silent += chunk.length) >= 38400) {
                  const audio = new Uint8Array(kept);
                  let offset = 0;
                  for (const part of chunks) {
                    if (offset >= kept) break;
                    audio.set(part.subarray(0, kept - offset), offset);
                    offset += part.length;
                  }
                  finish(pcmWav(audio));
                  return;
                }
                if ((total += chunk.length) > 960000) throw Error();
                chunks.push(chunk);
                if (silent <= 9600) kept = total;
              }
            } catch {
              finish();
            }
          });
          ws.send(
            JSON.stringify({
              type: 'session.start',
              session: {
                model: cfg.liveModel,
                instructions:
                  'Say the requested sample once, with no introduction or extra words.',
                audio: {
                  format: { type: 'audio/pcm', rate: 24000 },
                  output: { voice },
                },
              },
            })
          );
        })
        .catch(complete);
    });
  } finally {
    if (usage) await onUsage(usage);
  }
}
