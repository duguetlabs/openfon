import type { Env } from "./types";
import { azureConfig, managedVoice } from "./managed-azure";
import { PREVIEW_TEXT } from "./voice-preview-text";
import { decodeRealtimeAudio, parseRealtimeMessage } from "./realtime-input";
import { pcmWav } from "./voice-preview";
import type { PreviewUsage } from "./managed-voice-preview";
import { realtimeTokenMetrics } from "./azure-usage";
/** One bounded GA response, no microphone, tools, business data or inference fallback. */
export async function miniVoicePreview(
  env: Env,
  selection: { voice: string; language: string },
  signal: AbortSignal,
  onUsage: (usage: PreviewUsage) => Promise<void>,
): Promise<ArrayBuffer> {
  const cfg = azureConfig(env),
    voice = managedVoice(selection.voice, env),
    text = PREVIEW_TEXT[selection.language];
  if (!text) throw Error("Choose an available language.");
  let usage: PreviewUsage | undefined;
  try {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      let socket: WebSocket | undefined,
        done = false,
        sessionId = "",
        responseId = "",
        events = 0,
        bytes = 0,
        chars = 0,
        requested = false;
      const chunks: Uint8Array[] = [];
      const fetchController = new AbortController();
      const finish = (result?: ArrayBuffer) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        fetchController.abort();
        try {
          socket?.close(1000, "Preview ended");
        } catch {}
        result
          ? resolve(result)
          : reject(
              Error("The voice sample could not be played. Please try again."),
            );
      };
      const abort = () => finish();
      const timer = setTimeout(abort, 25000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      void fetch(
        cfg.baseURL + "/realtime?model=" + encodeURIComponent(cfg.liveModel),
        {
          headers: { Upgrade: "websocket", "api-key": cfg.apiKey },
          redirect: "manual",
          signal: fetchController.signal,
        },
      )
        .then((response) => {
          const ws = response.webSocket;
          if (done) {
            if (ws) {
              ws.accept();
              ws.close();
            } else void response.body?.cancel();
            return;
          }
          if (response.status !== 101 || !ws) {
            void response.body?.cancel();
            finish();
            return;
          }
          socket = ws;
          ws.accept();
          ws.addEventListener("close", () => finish());
          ws.addEventListener("error", () => finish());
          ws.addEventListener("message", (event) => {
            if (done) return;
            try {
              if (
                ++events > 1600 ||
                typeof event.data !== "string" ||
                (chars += event.data.length) > 4000000
              )
                throw Error();
              const msg = parseRealtimeMessage(event.data) as any;
              if (msg.type === "error") throw Error();
              if (msg.type === "session.updated") {
                const s = msg.session;
                if (
                  typeof s?.id !== "string" ||
                  !/^[A-Za-z0-9_.:-]{1,200}$/.test(s.id) ||
                  s.model !== cfg.liveModel ||
                  s.audio?.output?.voice !== voice ||
                  s.audio?.output?.format?.type !== "audio/pcm" ||
                  s.audio.output.format.rate !== 24000 ||
                  (sessionId && sessionId !== s.id)
                )
                  throw Error();
                sessionId = s.id;
                usage = { sessionId, final: false, realtime: true };
                if (!requested) {
                  requested = true;
                  ws.send(
                    JSON.stringify({
                      type: "response.create",
                      response: {
                        instructions:
                          "Read exactly this sample once, without extra words: " +
                          text,
                      },
                    }),
                  );
                }
                return;
              }
              if (!requested) return;
              if (msg.type === "response.created") {
                if (responseId || typeof msg.response?.id !== "string")
                  throw Error();
                responseId = msg.response.id;
                return;
              }
              if (msg.response_id && msg.response_id !== responseId)
                throw Error();
              if (
                msg.type === "response.output_audio.delta" ||
                msg.type === "response.audio.delta"
              ) {
                const pcm = new Uint8Array(decodeRealtimeAudio(msg.delta));
                if (pcm.length % 2 || (bytes += pcm.length) > 960000)
                  throw Error();
                chunks.push(pcm);
              }
              if (msg.type === "response.done") {
                if (!responseId || msg.response?.id !== responseId)
                  throw Error();
                usage = {
                  sessionId,
                  responseId,
                  metrics: realtimeTokenMetrics(msg.response.usage),
                  final: true,
                  realtime: true,
                };
                if (msg.response.status !== "completed" || !bytes)
                  throw Error();
                const pcm = new Uint8Array(bytes);
                let offset = 0;
                for (const part of chunks) {
                  pcm.set(part, offset);
                  offset += part.length;
                }
                if (!pcm.some((x) => x !== 0)) throw Error();
                finish(pcmWav(pcm));
              }
            } catch {
              finish();
            }
          });
          ws.send(
            JSON.stringify({
              type: "session.update",
              session: {
                type: "realtime",
                model: cfg.liveModel,
                output_modalities: ["audio"],
                instructions: "Read the requested sample once.",
                tools: [],
                tool_choice: "none",
                audio: {
                  input: {
                    format: { type: "audio/pcm", rate: 24000 },
                    turn_detection: null,
                  },
                  output: { format: { type: "audio/pcm", rate: 24000 }, voice },
                },
              },
            }),
          );
        })
        .catch(() => finish());
    });
  } finally {
    if (usage) await onUsage(usage);
  }
}
