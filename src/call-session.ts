// CallSession Durable Object: one instance per live call.
// Owns the WebSocket to the caller's browser and runs the voice loop:
//   caller audio -> STT -> LLM -> TTS -> caller.
//
// Protocol (client <-> server over WebSocket):
//   client JSON  {type:"start"}                 begin call (DO already knows the call id)
//   client BINARY <audio blob>                  one complete caller utterance (webm/opus or mp4)
//   client JSON  {type:"text", text}            text fallback for callers without mic
//   client JSON  {type:"hangup"}                end call
//   server JSON  {type:"ready", ttsMode, greeting}
//   server JSON  {type:"transcript", text}      what the caller said
//   server JSON  {type:"agent_text", text}      agent reply text (always sent)
//   server BINARY <mp3>                         spoken version of the last agent_text (azure mode)
//   server JSON  {type:"thinking"} | {type:"error", message} | {type:"ended"}
import type { Env, Business, AgentSettings, ChatMessage } from './types';
import { buildSystemPrompt, defaultGreeting, sttVocab, SUMMARY_PROMPT } from './prompt';
import { chatComplete, detectLang, isFarewell, isVocabEcho, LlmConfigError, normalizeLang, piperVoiceFor, resolveLlm, synthesize, transcribe, voiceForReply, SUPPORTED_LANGUAGES } from './providers';

// WebSocket binary payloads vary by runtime: ArrayBuffer, ArrayBufferView, or Blob.
async function toArrayBuffer(data: unknown): Promise<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  if (data && typeof (data as Blob).arrayBuffer === 'function') return (data as Blob).arrayBuffer();
  throw new Error('unsupported binary frame type');
}

function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function b64decode(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

interface SummaryResult {
  summary?: string | null;
  intent?: string | null;
  caller_name?: string | null;
  caller_phone?: string | null;
  message?: string | null;
}

// LLMs without JSON mode sometimes emit slightly broken JSON; salvage what we can.
function parseSummary(raw: string): SummaryResult {
  const cleaned = raw.replace(/```(json)?/g, '').trim();
  const candidates = [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c) as SummaryResult;
    } catch {
      /* try next */
    }
  }
  const grab = (key: string): string | null => {
    const m = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
    return m ? m[1] : null;
  };
  const summary = grab('summary');
  if (summary) {
    return { summary, intent: grab('intent'), caller_name: grab('caller_name'), caller_phone: grab('caller_phone'), message: grab('message') };
  }
  return { summary: cleaned.slice(0, 200) || null };
}

interface CallRow {
  id: string;
  business_id: string;
  status: string;
  started_at: string;
}

export class CallSession implements DurableObject {
  private ws: WebSocket | null = null;
  private callId = '';
  private biz: Business | null = null;
  private settings: AgentSettings | null = null;
  private history: ChatMessage[] = [];
  private busy = false;
  private ended = false; // stop handling caller messages
  private finalized = false; // the call row has been written; gates retries
  private finalizing: Promise<void> | null = null;
  // Computed once and reused across finalize retries, so a failed row write
  // does not re-bill summarization.
  private summarized: { summary: string | null; intent: string | null; messageJson: string | null } | null = null;
  private starting: Promise<void> | null = null; // in-flight or completed start
  private announced = false; // `ready` sent: the session exists, retries are off
  private lang = 'en'; // follows the caller; starts as the business default
  private mode: 'pipeline' | 'realtime' = 'pipeline';
  private upstream: WebSocket | null = null; // realtime engine connection
  private failure: string | null = null; // owner-facing reason, stored as the call's summary

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const callId = url.searchParams.get('call') ?? '';
    if (request.headers.get('Upgrade') !== 'websocket' || !callId) {
      return new Response('expected websocket', { status: 426 });
    }
    // One socket per call, for its whole life. Replacing `this.ws` would send
    // every reply — transcripts, agent audio — to the newcomer while the real
    // caller sat in silence. Rejecting a socket that is merely CLOSING matters
    // just as much: `starting` is already resolved by then, so the replacement's
    // {type:"start"} would return without a `ready` and the client would never
    // begin capturing audio — connected, and useless.
    //
    // Reject rather than replay the handshake: the widget never reattaches
    // (web/src/voice.ts always POSTs /api/public/call/start for a fresh id), and
    // re-greeting mid-conversation would be wrong for any client that did.
    if (this.ws) {
      return new Response('call already connected', { status: 409 });
    }
    this.callId = callId;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.ws = server;
    await this.armStartDeadline();
    server.addEventListener('message', (ev) => {
      this.onMessage(ev).catch((err) => this.failInternally(err));
    });
    server.addEventListener('close', () => {
      // Scoped to the socket it belongs to. A socket closing after it has been
      // replaced — e.g. one that was still CLOSING when the next caller
      // attached — must not tear down the call that succeeded it.
      if (this.ws !== server) return;
      this.finalize().catch((err) => console.error('finalize failed', err));
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {
      /* socket gone */
    }
  }

  // Only for messages written to be read by a caller. Anything derived from a
  // thrown error goes through failInternally instead.
  private sendError(message: string): void {
    console.error('call error:', message);
    this.send({ type: 'error', message });
  }

  // The disclosure boundary for the public call socket. Thrown errors quote
  // whatever the failure carried — an upstream response body, a redirect
  // target, an endpoint hostname — and this widget is reachable by anyone with
  // the business's public link. So the detail is logged and kept for the
  // owner's call log, and the caller is told only that the call broke.
  private failInternally(err: unknown): void {
    const detail = `${err}`;
    console.error(`call ${this.callId}: ${detail}`);
    this.failure ??= `Call failed: ${detail}`;
    this.send({ type: 'error', message: 'Sorry — this call ran into a problem. Please try again.' });
  }

  private async loadCall(): Promise<void> {
    const call = await this.env.DB.prepare('SELECT id, business_id, status, started_at FROM calls WHERE id = ?')
      .bind(this.callId)
      .first<CallRow>();
    if (!call || call.status !== 'active') throw new Error('call not found or not active');
    this.biz = await this.env.DB.prepare('SELECT * FROM businesses WHERE id = ?')
      .bind(call.business_id)
      .first<Business>();
    this.settings = await this.env.DB.prepare('SELECT * FROM agent_settings WHERE business_id = ?')
      .bind(call.business_id)
      .first<AgentSettings>();
    if (!this.biz || !this.settings) throw new Error('business not configured');
  }

  private async onMessage(ev: MessageEvent): Promise<void> {
    if (this.ended) return;
    this.lastActivity = Date.now(); // feeds the idle watchdog
    if (typeof ev.data !== 'string') {
      const audio = await toArrayBuffer(ev.data);
      if (this.mode === 'realtime') {
        this.sendUpstream({ type: 'input_audio_buffer.append', audio: b64encode(audio) });
      } else {
        await this.handleUtterance(audio);
      }
      return;
    }
    const msg = JSON.parse(ev.data) as { type: string; text?: string; contentType?: string };
    switch (msg.type) {
      case 'start':
        await this.handleStart();
        break;
      case 'text':
        if (msg.text?.trim()) {
          if (this.mode === 'realtime') this.sendCallerText(msg.text.trim());
          else await this.respond(msg.text.trim());
        }
        break;
      case 'hangup':
        // finalize() owns the whole teardown: engine, client socket, DB row.
        await this.finalize();
        break;
      default:
        if (msg.contentType) this.pendingContentType = msg.contentType;
    }
  }

  private pendingContentType = 'audio/webm';

  // Answer the phone once. A repeated {type:"start"} would open a second engine
  // connection, greet again, and write another agent turn, so concurrent starts
  // join the attempt already in flight.
  //
  // Retryable only up to the point where we announce `ready`. Before then a
  // failure — a D1 blip in loadCall(), a storage write — cost the caller
  // nothing, and latching would strand them on a live socket that can never be
  // answered. After `ready` the session exists: an engine may be connected and
  // a greeting turn written, so re-running would duplicate exactly what this
  // guard is here to prevent. Those surface as an error instead.
  private handleStart(): Promise<void> {
    if (!this.starting) {
      this.starting = this.runStart().catch((err) => {
        if (!this.announced) this.starting = null;
        throw err;
      });
    }
    return this.starting;
  }

  // Announcing `ready` is the point of no return for retries, and the point at
  // which the call has made real progress — so the start deadline is retired
  // and the idle timer takes over from here.
  private async sendReady(payload: Record<string, unknown>): Promise<void> {
    this.announced = true;
    this.send({ type: 'ready', ...payload });
    await this.state.storage.delete('startDeadline');
  }

  private async runStart(): Promise<void> {
    await this.loadCall();
    if (this.ended) return; // hung up while we were loading
    // Resolve the LLM config before saying hello: a rejected AI-provider setup
    // must fail at pickup with a message the owner can act on, not stall the
    // caller mid-conversation (realtime calls would only notice at summary time).
    try {
      resolveLlm(this.env, this.settings);
    } catch (err) {
      if (!(err instanceof LlmConfigError)) throw err;
      // The diagnostic is for the owner, not the caller: it can name the
      // instance's allowed hosts, and anyone can dial the public widget. The
      // caller hears that the line is down; the reason is logged and lands on
      // the call row, which is where the person who can fix it looks.
      this.failure = `Agent misconfigured — ${err.message} Fix it in Settings → AI provider.`;
      console.error(`call ${this.callId}: ${this.failure}`);
      this.sendError('This agent is not available right now. Please try again later.');
      // finalize() owns the rest: it sends `ended`, closes the socket, and
      // writes the row. Doing any of that here would duplicate it. Returning
      // normally also leaves `starting` resolved, so a retry cannot restart a
      // call we have already given up on — a misconfigured agent stays
      // misconfigured until the owner changes something.
      await this.finalize();
      return;
    }
    // Armed only once the call is actually going ahead — nothing to watch over
    // a call that is being torn down at pickup.
    await this.armWatchdog();
    if (this.ended) return;
    this.lang = this.settings!.language in SUPPORTED_LANGUAGES ? this.settings!.language : 'en';
    const greeting = defaultGreeting(this.biz!, this.settings!);
    const systemPrompt = buildSystemPrompt(this.biz!, this.settings!, new Date());

    if (this.settings!.engine === 'realtime') {
      const ok = await this.startRealtime(systemPrompt, greeting).catch((err) => {
        console.error('realtime engine failed, falling back to pipeline:', err);
        return false;
      });
      if (this.ended) {
        this.closeUpstream(); // hung up while the engine was connecting
        return;
      }
      if (ok) {
        this.mode = 'realtime';
        const engineLabel = `realtime · ${this.realtimeModel}`;
        if (this.engineGreets()) {
          // Engine speaks the greeting in its own voice; the greeting text and
          // transcript turn arrive through the normal event stream.
          this.history = [{ role: 'system', content: systemPrompt }];
          const ttsMode = this.env.DEFAULT_TTS_PROVIDER === 'azure' && this.env.AZURE_SPEECH_KEY ? 'server' : 'browser';
          await this.sendReady({ mode: 'realtime', ttsMode, greeting: '', engine: engineLabel });
          return;
        }
        this.history = [
          { role: 'system', content: systemPrompt },
          { role: 'assistant', content: greeting },
        ];
        const ttsMode = this.env.DEFAULT_TTS_PROVIDER === 'azure' && this.env.AZURE_SPEECH_KEY ? 'server' : 'browser';
        await this.sendReady({ mode: 'realtime', ttsMode, greeting, engine: engineLabel });
        await this.saveTurn('agent', greeting);
        // The greeting is ours, not the model's: synthesize it deterministically
        // and stream it as PCM so it matches the realtime audio path.
        const voice = voiceForReply(this.env, this.lang, this.settings!.language, this.settings!.voice || '');
        const audio = await synthesize(this.env, greeting, voice, 'pcm24');
        if (audio && this.ws) {
          // PCM16 @ 24 kHz = 48000 bytes/s; shield the greeting from
          // noise-triggered barge-in flushes for its playback duration.
          this.greetingGuardUntil = Date.now() + (audio.byteLength / 48000) * 1000 + 500;
          try {
            this.ws.send(audio);
          } catch {
            /* caller gone */
          }
        }
        return;
      }
    }

    this.mode = 'pipeline';
    this.history = [
      {
        role: 'system',
        // Pipeline only: we strip the marker before TTS, so it is never spoken.
        content: `${systemPrompt}\n- When the conversation is finished and you have said your goodbye, append the marker <END_CALL> at the very end of your reply.`,
      },
      { role: 'assistant', content: greeting },
    ];
    const ttsMode = this.env.DEFAULT_TTS_PROVIDER === 'azure' && this.env.AZURE_SPEECH_KEY ? 'server' : 'browser';
    await this.sendReady({
      mode: 'pipeline',
      ttsMode,
      greeting,
      engine: `pipeline · ${resolveLlm(this.env, this.settings).model}`,
    });
    await this.saveTurn('agent', greeting);
    await this.speak(greeting);
  }

  // ---- realtime engine bridge (OpenAI Realtime wire protocol) ----

  // Two different questions, deliberately kept apart. `upstream` is the socket
  // we write to; `readableUpstreams` is every socket whose events we still
  // accept. They differ during a proactive rotation: the outgoing connection is
  // still mid-response and has to stay both readable and writable until its
  // replacement is actually open, or rotating — which exists so a call does not
  // drop mid-sentence — would itself swallow seconds of speech.
  private readableUpstreams = new Set<WebSocket>();

  private sendUpstream(obj: unknown, target: WebSocket | null = this.upstream): void {
    try {
      target?.send(JSON.stringify(obj));
    } catch {
      /* upstream gone */
    }
  }

  private closeUpstream(): void {
    for (const ws of this.readableUpstreams) {
      try {
        ws.close(1000, 'call ended');
      } catch {
        /* noop */
      }
    }
    this.readableUpstreams.clear();
    this.upstream = null;
  }

  private realtimeInstructions = '';
  private realtimeModel = '';
  private sessionVoice = ''; // voice sent upstream; '' = let the tier pick
  private voiceManaged = false; // true when we own language->voice switching (HD default)
  private reconnects = 0;
  private totalReconnects = 0; // whole-call ceiling; session.expiring resets only `reconnects`
  private recovering: Promise<void> | null = null;
  private static readonly MAX_TOTAL_RECONNECTS = 5;
  private greetingGuardUntil = 0; // ignore barge-in flushes while our greeting plays
  private endPending = false; // caller said farewell; hang up after the agent's sign-off

  // Full session payload, resent whenever the voice changes — partial updates
  // are not guaranteed to preserve transcription config.
  private realtimeSessionPayload(voice: string, instructions: string): unknown {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions,
        ...(this.toolsSupported()
          ? {
              tools: [
                {
                  type: 'function',
                  name: 'end_call',
                  description: 'Hang up the phone call. Call this right after saying goodbye, when the conversation is finished.',
                  parameters: { type: 'object', properties: {} },
                },
              ],
              tool_choice: 'auto',
            }
          : {}),
        audio: {
          input: {
            // 24 kHz: the lowest rate every tier accepts (native S2S models reject 16 kHz)
            format: { type: 'audio/pcm', rate: 24000 },
            // Higher threshold: ambient noise was triggering barge-ins that cut
            // off the greeting; prefix padding keeps word onsets unclipped.
            turn_detection: { type: 'server_vad', threshold: 0.7, prefix_padding_ms: 300, silence_duration_ms: 550 },
            transcription: {
              // Native S2S tiers only support their own transcription models;
              // forcing ours silently disables caller transcripts there.
              model: this.realtimeModel.startsWith('gpt-realtime') ? 'whisper-1' : this.env.DEFAULT_STT_MODEL,
              prompt: this.biz && this.settings ? sttVocab(this.biz, this.settings) : undefined,
              // On cascade tiers this is a greeting seed + STT accuracy hint,
              // not a pin: per-utterance detection overrides it once the caller
              // speaks (verified 2026-06-13 after Kataleptic's fix).
              ...(this.isCascade() && this.settings && this.settings.language in SUPPORTED_LANGUAGES
                ? { language: this.settings.language }
                : {}),
            },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            // Each tier has its own voice catalog — only pass a voice we have
            // reason to believe it understands ('' = tier default).
            ...(voice ? { voice } : {}),
          },
        },
      },
    };
  }

  // The engine is supposed to follow the caller's language with a matching
  // voice, but the HD tier keeps the initial voice — so we detect language
  // switches from transcripts and hot-swap the voice ourselves.
  private maybeSwitchVoice(callerText: string, langHint?: string | null): void {
    const detected = langHint ?? detectLang(callerText);
    if (!detected || detected === this.lang) return;
    const before = this.lang;
    this.lang = detected;
    if (!this.voiceManaged) return; // tier picks its own voices
    const prevVoice = voiceForReply(this.env, before, this.settings?.language ?? 'en', this.settings?.voice || '');
    const voice = voiceForReply(this.env, detected, this.settings?.language ?? 'en', this.settings?.voice || '');
    if (voice === prevVoice) return; // multilingual voices cover all languages — nothing to swap
    console.log(`call ${this.callId}: language switch -> ${detected}, voice -> ${voice}`);
    this.sessionVoice = voice;
    this.sendUpstream(this.realtimeSessionPayload(voice, this.realtimeInstructions));
  }

  // True when the engine should speak the greeting itself: its reply voice is
  // not an Azure voice (so our synthesized greeting would not match), and its
  // first-token latency is low enough for an instant pickup.
  private engineGreets(): boolean {
    return this.realtimeModel === 'kataleptic-realtime' || this.realtimeModel.startsWith('gpt-realtime');
  }

  private isCascade(): boolean {
    return this.realtimeModel !== 'kataleptic-realtime-hd' && !this.realtimeModel.startsWith('gpt-realtime');
  }

  // end_call function calling is verified on every tier (HD since its brain
  // moved to gpt-4.1-mini, 2026-06-13 — 2/2 clean structural invocations; the
  // upstream narration net converts any remaining prose-shaped calls). The
  // caller-farewell heuristic stays armed on non-native tiers as
  // belt-and-braces, since no cascaded LLM is 100% invocation-disciplined.
  private toolsSupported(): boolean {
    return true;
  }

  // Agent-initiated hangup: tell the client to end once playback drains, with
  // a server-side safety net if it never does.
  private endingSent = false;

  private beginHangup(): void {
    if (this.ended || this.endingSent) return;
    this.endingSent = true;
    console.log(`call ${this.callId}: agent ending the call`);
    this.send({ type: 'ending' });
    // Safety net: if the client never drains playback and hangs up itself.
    setTimeout(() => void this.finalize(), 15_000);
  }

  private async startRealtime(systemPrompt: string, greeting: string): Promise<boolean> {
    const key = this.env.REALTIME_API_KEY || this.env.DEFAULT_LLM_API_KEY || '';
    const model = this.settings?.realtime_model || this.env.REALTIME_MODEL;
    this.realtimeModel = model;
    console.log(`call ${this.callId}: realtime engine, model ${model}`);
    const isHd = model === 'kataleptic-realtime-hd';
    const isCascade = this.isCascade();
    // Explicit per-business realtime voice wins; on the Azure-backed HD tier we
    // manage the voice (matches the synthesized greeting); Piper cascades get a
    // default-language initial voice (they'd otherwise start English until the
    // caller's language is first detected); native S2S tiers pick their own.
    this.voiceManaged = isHd && !this.settings?.realtime_voice;
    this.sessionVoice =
      this.settings?.realtime_voice ||
      (isHd
        ? voiceForReply(this.env, this.lang, this.settings?.language ?? 'en', this.settings?.voice || '')
        : isCascade
          ? await piperVoiceFor(this.env, this.lang)
          : '');
    const toolNote = this.toolsSupported()
      ? '\n\nWhen the conversation is finished and you have said goodbye, call the end_call function.'
      : '';
    this.realtimeInstructions =
      (this.engineGreets()
        ? systemPrompt
        : `${systemPrompt}\n\nYou already opened the call by saying: "${greeting}". Continue the conversation from there.`) + toolNote;
    return this.openUpstream(this.realtimeInstructions, this.engineGreets() ? greeting : null);
  }

  // Discard a connection that never became usable. Without this it stays in
  // `this.upstream` and, if it opens after we already gave up, still sends
  // session.update and streams PCM at a client that has fallen back to
  // pipeline mode and will try to decode those frames as MP3.
  private abandonUpstream(ws: WebSocket): void {
    this.readableUpstreams.delete(ws);
    try {
      ws.close(1000, 'abandoned');
    } catch {
      /* never opened */
    }
    if (this.upstream === ws) this.upstream = null;
  }

  // Instructions may be a thunk so a rotation can snapshot the conversation at
  // handover rather than at dial time — see runRecovery.
  private openUpstream(instructions: string | (() => string), greetWith: string | null): Promise<boolean> {
    const key = this.env.REALTIME_API_KEY || this.env.DEFAULT_LLM_API_KEY || '';
    const url = `${this.env.REALTIME_BASE_URL}?model=${encodeURIComponent(this.realtimeModel)}&token=${encodeURIComponent(key)}`;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        settle(false);
        return;
      }
      // Readable from the moment it is dialed, but not the write target until
      // it opens — so a rotation keeps using the outgoing connection, in both
      // directions, right up to the handover.
      this.readableUpstreams.add(ws);
      let abandoned = false;
      let opened = false; // did this connection ever become usable?
      const timer = setTimeout(() => {
        abandoned = true;
        this.abandonUpstream(ws);
        settle(false);
      }, 5000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        if (abandoned) return; // we already gave up on this one and closed it
        opened = true;
        // Snapshot now, not at dial time. The outgoing connection stayed live
        // through the connect window, so `history` may have gained turns since
        // — and taking it before we route means the replacement is briefed on
        // everything that happened up to the moment it takes over.
        const briefing = typeof instructions === 'function' ? instructions() : instructions;
        this.upstream = ws; // handover: from here we write to the new socket
        this.sendUpstream(this.realtimeSessionPayload(this.sessionVoice, briefing), ws);
        if (greetWith) {
          this.sendUpstream(
            {
              type: 'response.create',
              response: { instructions: `Greet the caller by saying exactly this, then wait for them to speak: "${greetWith}"` },
            },
            ws
          );
        }
        settle(true);
      });
      ws.addEventListener('message', (ev) => {
        if (!this.readableUpstreams.has(ws)) return; // abandoned or rotated out
        this.onUpstreamMessage(ev).catch((err) => console.error('upstream handler error', err));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        // Only discard a connection that never became usable. WebSockets
        // routinely emit `error` immediately before `close`, and `close` is
        // what triggers recovery — dropping it here would make the close
        // listener's ownership guard false and silently kill the reconnect.
        if (!opened) this.abandonUpstream(ws);
        settle(false);
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        this.readableUpstreams.delete(ws);
        settle(false);
        if (this.mode === 'realtime' && !this.ended && this.upstream === ws) {
          this.upstream = null;
          void this.recoverUpstream();
        }
      });
    });
  }

  // The engine dropped the session mid-call: reconnect with the conversation so
  // far folded into the instructions, instead of hanging up.
  //
  // Single-flight: a failed connect notifies us twice — once by resolving false
  // and once through the socket's close listener. Letting both run would open
  // two replacements, and only the last would land in `this.upstream`, leaving
  // an orphan nobody closes.
  private recoverUpstream(): Promise<void> {
    if (!this.recovering) {
      this.recovering = this.runRecovery().finally(() => {
        this.recovering = null;
      });
    }
    return this.recovering;
  }

  private resumeInstructions(): string {
    const transcript = this.history
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role === 'user' ? 'Caller' : 'You'}: ${m.content}`)
      .join('\n');
    return `${this.realtimeInstructions}\n\nThe call audio was briefly interrupted; the caller is still on the line. Do NOT greet again. Conversation so far:\n${transcript}`;
  }

  private async runRecovery(): Promise<void> {
    while (!this.ended) {
      // `reconnects` is the per-rotation budget, which session.expiring resets;
      // `totalReconnects` bounds a flapping engine over the whole call.
      if (this.reconnects >= 1 || this.totalReconnects >= CallSession.MAX_TOTAL_RECONNECTS) {
        this.sendError('Voice engine connection lost');
        await this.finalize();
        return;
      }
      this.reconnects++;
      this.totalReconnects++;
      console.log(`call ${this.callId}: upstream dropped, reconnecting`);
      const old = this.upstream;
      // Deferred: on a proactive rotation the old connection keeps talking
      // while this one dials, so the briefing has to be built at handover.
      // Freezing it here would hand the replacement a transcript missing the
      // exchange that happened during the connect window, and the agent would
      // ask the caller to repeat something they had just said.
      const ok = await this.openUpstream(() => this.resumeInstructions(), null);
      if (ok) {
        if (old && old !== this.upstream) {
          try {
            old.close(1000, 'rotated');
          } catch {
            /* already closed */
          }
        }
        return;
      }
    }
  }

  private async onUpstreamMessage(ev: MessageEvent): Promise<void> {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data) as {
      type: string;
      delta?: string;
      transcript?: string;
      language?: string;
      item?: { type?: string; name?: string };
      name?: string;
      error?: { message?: string };
    };
    switch (msg.type) {
      case 'response.output_audio.delta':
        if (msg.delta && this.ws) {
          try {
            this.ws.send(b64decode(msg.delta));
          } catch {
            /* caller gone */
          }
        }
        break;
      case 'input_audio_buffer.speech_started':
        // Barge-in: the server cancels its in-flight response; we flush caller
        // playback — except while our own greeting is playing, where a noise
        // blip would cut off the agent's opening line for nothing.
        if (Date.now() < this.greetingGuardUntil) break;
        this.send({ type: 'flush' });
        this.send({ type: 'speaking', who: 'caller' });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript?.trim()) {
          const text = msg.transcript.trim();
          // STT echoes the vocabulary bias prompt back on silence-committed
          // turns; cancel the response it triggered and pretend it never happened.
          const vocab = this.biz && this.settings ? sttVocab(this.biz, this.settings) : '';
          if (vocab && isVocabEcho(text, vocab)) {
            console.log(`call ${this.callId}: dropped vocab-echo transcript: ${text.slice(0, 80)}`);
            this.sendUpstream({ type: 'response.cancel' });
            this.send({ type: 'flush' });
            break;
          }
          // Standard tier sends a detected language with each transcript;
          // prefer it over our own text-based heuristic.
          this.maybeSwitchVoice(text, normalizeLang(msg.language));
          this.send({ type: 'transcript', text });
          this.history.push({ role: 'user', content: text });
          // Caller-farewell backstop (primary mechanism on HD, belt-and-braces
          // on cascades whose models might not call the tool): armed after at
          // least one real exchange. beginHangup is idempotent, so this firing
          // alongside end_call is harmless.
          this.endPending = !this.realtimeModel.startsWith('gpt-realtime') && this.history.length > 3 && isFarewell(text);
          if (this.endPending) {
            // Event ordering isn't guaranteed: if the sign-off reply's
            // transcript never arrives (cancelled response, race), end anyway.
            setTimeout(() => {
              if (this.endPending && !this.ended) this.beginHangup();
            }, 8000);
          }
          await this.saveTurn('caller', text);
        }
        break;
      case 'response.output_audio_transcript.done':
        if (msg.transcript?.trim()) {
          const text = msg.transcript.trim();
          this.send({ type: 'agent_text', text });
          this.history.push({ role: 'assistant', content: text });
          await this.saveTurn('agent', text);
          if (this.endPending) this.beginHangup();
        }
        break;
      case 'response.output_item.done':
        if (msg.item?.type === 'function_call' && msg.item?.name === 'end_call') this.beginHangup();
        break;
      case 'response.function_call_arguments.done':
        // Some paths (e.g. narration-to-call conversion) synthesize only this
        // event without a function_call output item.
        if (msg.name === 'end_call') this.beginHangup();
        break;
      case 'session.expiring':
        // Vendor extension: the engine warns a minute before its hard session
        // cutoff — reconnect proactively instead of dropping mid-sentence.
        console.log(`call ${this.callId}: upstream session expiring, rotating connection`);
        this.reconnects = 0; // each warned rotation gets its own retry budget
        void this.recoverUpstream();
        break;
      case 'error':
        console.error('realtime engine error:', JSON.stringify(msg.error ?? msg).slice(0, 300));
        break;
    }
  }

  private sendCallerText(text: string): void {
    this.maybeSwitchVoice(text);
    this.sendUpstream({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.sendUpstream({ type: 'response.create' });
    this.send({ type: 'transcript', text });
    this.history.push({ role: 'user', content: text });
    void this.saveTurn('caller', text);
  }

  private async handleUtterance(audio: ArrayBuffer): Promise<void> {
    if (this.busy || !this.biz) return; // drop overlapping speech while we respond
    this.busy = true;
    try {
      this.send({ type: 'thinking' });
      const vocab = this.biz && this.settings ? sttVocab(this.biz, this.settings) : undefined;
      const { text, language } = await transcribe(this.env, audio, this.pendingContentType, vocab);
      if (!text) {
        this.busy = false;
        return;
      }
      if (language) this.lang = language; // follow the caller's language
      this.send({ type: 'transcript', text });
      await this.respondInner(text);
    } finally {
      this.busy = false;
    }
  }

  private async respond(text: string): Promise<void> {
    if (this.busy || !this.biz) return;
    this.busy = true;
    try {
      this.send({ type: 'transcript', text });
      await this.respondInner(text);
    } finally {
      this.busy = false;
    }
  }

  private async respondInner(callerText: string): Promise<void> {
    await this.saveTurn('caller', callerText);
    this.history.push({ role: 'user', content: callerText });
    const llm = resolveLlm(this.env, this.settings);
    const raw = (await chatComplete(llm, this.history, { maxTokens: 200, temperature: 0.6 })).trim();
    const wantsEnd = /<?END_CALL>?/i.test(raw);
    const reply = raw.replace(/\s*<?END_CALL>?\s*/gi, ' ').trim();
    this.history.push({ role: 'assistant', content: reply });
    this.send({ type: 'agent_text', text: reply });
    await this.saveTurn('agent', reply);
    await this.speak(reply);
    if (wantsEnd) this.beginHangup();
  }

  private async speak(text: string): Promise<void> {
    const voice = voiceForReply(this.env, this.lang, this.settings?.language ?? 'en', this.settings?.voice || '');
    const audio = await synthesize(this.env, text, voice);
    if (audio && this.ws) {
      try {
        this.ws.send(audio);
      } catch {
        /* socket gone */
      }
    }
  }

  private async saveTurn(role: 'caller' | 'agent', text: string): Promise<void> {
    await this.env.DB.prepare('INSERT INTO call_turns (call_id, role, text) VALUES (?, ?, ?)')
      .bind(this.callId, role, text)
      .run();
    // A model that loops — or an engine echoing itself — would otherwise run up
    // provider spend for as long as the socket stays open.
    if (++this.turns >= CallSession.MAX_TURNS) {
      console.log(`call ${this.callId}: turn cap reached, ending`);
      this.beginHangup();
    }
  }

  // ---- watchdog ----
  // All call state lives in memory, so a worker restart or a caller whose
  // network drops without a close frame leaves the row 'active' forever. A
  // periodic alarm force-finalizes those. `callId` is persisted because an
  // alarm can fire on a fresh instance that has lost every field.
  // (Rows whose socket never opened are not covered — no DO exists to run an
  // alarm for them; that needs a sweeper, handled separately.)
  private static readonly WATCHDOG_TICK_MS = 60_000;
  private static readonly IDLE_LIMIT_MS = 120_000; // clients ping every 20 s
  private static readonly MAX_CALL_MS = 30 * 60_000;
  private static readonly MAX_TURNS = 200;
  // A real widget sends {type:"start"} immediately; 30 s is generous.
  private static readonly START_DEADLINE_MS = 30_000;
  private static readonly MAX_RETRY_MS = 15 * 60_000; // backoff ceiling
  // 0 = this instance has seen no activity of its own. Not the same as "the
  // call was just active": an alarm can run on an object rebuilt after
  // eviction, where any Date.now() initializer would look like fresh activity
  // and keep the call alive forever — the very case the watchdog is for.
  private lastActivity = 0;
  private turns = 0;

  // A socket that upgrades but never sends {type:"start"} does no provider work
  // yet still occupies the call — and a concurrency slot, since the row stays
  // 'active'. The idle timer cannot see it: `ping` is inbound traffic, so a
  // squatter pinging every 20 s looks perfectly alive. Liveness and progress are
  // different properties, so this gets its own deadline, armed at upgrade and
  // retired by `ready`. Persisted rather than a timer, so it survives eviction.
  private async armStartDeadline(): Promise<void> {
    const deadline = Date.now() + CallSession.START_DEADLINE_MS;
    await this.state.storage.put({ callId: this.callId, startDeadline: deadline });
    await this.state.storage.setAlarm(deadline);
  }

  private async armWatchdog(): Promise<void> {
    const now = Date.now();
    this.lastActivity = now;
    await this.state.storage.put({
      callId: this.callId,
      hardDeadline: now + CallSession.MAX_CALL_MS,
      lastActivity: now,
    });
    await this.state.storage.setAlarm(now + CallSession.WATCHDOG_TICK_MS);
  }

  async alarm(): Promise<void> {
    const callId = this.callId || (await this.state.storage.get<string>('callId')) || '';
    if (!callId) return; // nothing to reconcile
    this.callId = callId;
    const now = Date.now();

    // Checked before the idle logic and never refreshed by inbound traffic:
    // pings keep an established call alive, but must not extend the grace
    // period for one that never began.
    const startDeadline = await this.state.storage.get<number>('startDeadline');
    if (startDeadline && now >= startDeadline) {
      console.log(`call ${this.callId}: no start within the deadline, releasing the call`);
      await this.finalize();
      return;
    }

    // Absent between the upgrade and a successful start. Treat that as "not
    // reached" — defaulting to `now` would read as already expired and end a
    // call that is still connecting. The idle check below is the backstop.
    const hardDeadline = (await this.state.storage.get<number>('hardDeadline')) ?? Number.POSITIVE_INFINITY;
    // Trust this instance's own observation, and only that. Falling back to the
    // persisted value when we have none is what lets an evicted-and-rebuilt
    // object see how stale the call really is.
    const stored = (await this.state.storage.get<number>('lastActivity')) ?? 0;
    const activity = this.lastActivity || stored;

    if (now >= hardDeadline || now - activity >= CallSession.IDLE_LIMIT_MS) {
      console.log(`call ${this.callId}: watchdog finalizing (idle ${Math.round((now - activity) / 1000)}s)`);
      try {
        await this.finalize();
      } catch (err) {
        // Own the retry rather than propagating. Cloudflare retries a throwing
        // alarm about six times and then stops, so a D1 outage lasting longer
        // than that would strand the row as 'active' forever — the exact state
        // this watchdog exists to prevent, reached through its own failure
        // path. Catching and rescheduling is the documented way to retry
        // indefinitely. Back off: an outage is when hammering helps least.
        const attempts = ((await this.state.storage.get<number>('finalizeAttempts')) ?? 0) + 1;
        const delay = Math.min(CallSession.MAX_RETRY_MS, CallSession.WATCHDOG_TICK_MS * 2 ** (attempts - 1));
        console.error(`call ${this.callId}: finalize failed (attempt ${attempts}), retrying in ${delay / 1000}s`, err);
        await this.state.storage.put('finalizeAttempts', attempts);
        await this.state.storage.setAlarm(now + delay);
      }
      return;
    }
    await this.state.storage.put('lastActivity', activity);
    await this.state.storage.setAlarm(now + CallSession.WATCHDOG_TICK_MS);
  }

  // Retryable: `finalized` flips only once the row is written, so a failed
  // attempt can be repeated by the watchdog. `ended` is a separate concern —
  // it stops the conversation immediately and must not gate the retry.
  private finalize(): Promise<void> {
    if (this.finalized || !this.callId) return Promise.resolve();
    this.ended = true; // stop handling caller messages from this instant
    if (!this.finalizing) {
      // Claim the slot before any of the work runs. runFinalize() closes the
      // client socket synchronously, and that close listener calls back into
      // finalize() — with the assignment happening after the call, the slot was
      // still empty at that moment and a second finalize started, writing the
      // call row and re-running summarization twice.
      this.finalizing = Promise.resolve()
        .then(() => this.runFinalize())
        .finally(() => {
          this.finalizing = null;
        });
    }
    return this.finalizing;
  }

  // An alarm can finalize a call on a Durable Object rebuilt after eviction,
  // which has lost `history` and `settings` while call_turns still holds the
  // whole conversation. Without this the watchdog would rescue the row and
  // write it `completed` with a null summary and null message_json — turning
  // "call stuck in progress" into "call completed, caller's message gone",
  // which looks fine on the dashboard and is therefore worse. Read the same
  // data back out of D1 and summarize normally.
  private async rehydrateHistory(businessId: string): Promise<void> {
    if (this.history.length > 0) return; // live session: memory is authoritative
    this.settings ??= await this.env.DB.prepare('SELECT * FROM agent_settings WHERE business_id = ?')
      .bind(businessId)
      .first<AgentSettings>();
    const { results } = await this.env.DB.prepare('SELECT role, text FROM call_turns WHERE call_id = ? ORDER BY id')
      .bind(this.callId)
      .all<{ role: string; text: string }>();
    if (!results.length) return;
    console.log(`call ${this.callId}: rehydrated ${results.length} turns for summarization`);
    // Index 0 stands in for the system prompt, which the summary path skips.
    this.history = [
      { role: 'system', content: '' },
      ...results.map((t) => ({
        role: t.role === 'caller' ? ('user' as const) : ('assistant' as const),
        content: t.text,
      })),
    ];
  }

  private async clearWatchdog(): Promise<void> {
    try {
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
    } catch (err) {
      console.error('watchdog cleanup failed', err);
    }
  }

  // The status is derived from the recorded failure, never passed in. It used
  // to be an argument, and then the two could disagree — a mid-call error wrote
  // "Call failed: …" into the summary of a row the dashboard counted as a
  // success, because the socket-close path finalizes without knowing anything
  // went wrong. A recorded failure *is* the call failing, so it decides both
  // fields and no caller can reintroduce the split. ('failed' is the schema's
  // own vocabulary, and the dashboard's stats read 'completed', so these drop
  // out of call counts and talk time.)
  private async runFinalize(): Promise<void> {
    this.ended = true;
    this.closeUpstream();
    // Anything still attached has to be told, and then actually closed. Leaving
    // it open means `ended` silently drops every later message and the caller
    // just hears the agent stop, with no error and no hangup.
    this.send({ type: 'ended' });
    try {
      this.ws?.close(1000, 'call ended');
    } catch {
      /* already gone */
    }
    const call = await this.env.DB.prepare('SELECT started_at, business_id FROM calls WHERE id = ? AND status = ?')
      .bind(this.callId, 'active')
      .first<{ started_at: string; business_id: string }>();
    if (!call) {
      // Already completed by someone else — nothing left to reconcile.
      this.finalized = true;
      await this.clearWatchdog();
      return;
    }
    const duration = Math.max(0, Math.round((Date.now() - new Date(call.started_at + 'Z').getTime()) / 1000));
    await this.rehydrateHistory(call.business_id);
    // A failure reason takes the summary slot: the call log renders it, so the
    // owner reads why the call died where they already look for what happened.
    let summary: string | null = this.failure;
    let intent: string | null = null;
    let messageJson: string | null = null;
    // Summarize only real conversations (greeting alone doesn't count), and
    // only once: this runs again on every finalize retry, and re-billing the
    // summarization for a call whose row simply failed to write is waste.
    if (this.summarized) {
      ({ summary, intent, messageJson } = this.summarized);
    } else if (this.history.length > 2) {
      try {
        const transcript = this.history
          .slice(1)
          .map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content}`)
          .join('\n');
        const llm = resolveLlm(this.env, this.settings);
        const raw = await chatComplete(
          llm,
          [
            {
              role: 'system',
              content: `${SUMMARY_PROMPT}\nWrite the "summary" and "message" values in ${SUPPORTED_LANGUAGES[this.settings?.language ?? 'en']?.name ?? 'English'}.`,
            },
            { role: 'user', content: transcript },
          ],
          { maxTokens: 300, temperature: 0 }
        );
        const parsed = parseSummary(raw);
        summary = parsed.summary ?? null;
        intent = parsed.intent ?? null;
        if (parsed.caller_name || parsed.caller_phone || parsed.message) {
          messageJson = JSON.stringify({
            caller_name: parsed.caller_name ?? null,
            caller_phone: parsed.caller_phone ?? null,
            message: parsed.message ?? null,
          });
        }
      } catch (err) {
        console.error('summary failed', err);
      }
    }
    if (!summary && this.history.length > 2) {
      // last-resort summary so the dashboard never shows an empty row
      const firstUser = this.history.find((m) => m.role === 'user');
      summary = firstUser ? `Caller: "${firstUser.content.slice(0, 120)}"` : null;
    }
    // Memoize the *unprefixed* summary: the failure prefix below is applied on
    // every attempt, so caching the combined string would stack it on a retry.
    this.summarized = { summary, intent, messageJson };
    // Two writers, one column, so the precedence is decided here rather than by
    // whoever assigns last: a call that broke leads with why. The log truncates
    // the row, and "it failed" is the fact the owner needs first; a summary, if
    // the exchange got far enough to produce one, follows it.
    if (this.failure && summary !== this.failure) {
      summary = summary ? `${this.failure} — ${summary}` : this.failure;
    }
    const status = this.failure ? 'failed' : 'completed';
    // If this throws, `finalized` stays false and the watchdog is still armed,
    // so the alarm retries. Clearing the watchdog first would strand the row
    // as 'active' with nothing left to ever reclaim it.
    await this.env.DB.prepare(
      `UPDATE calls SET status = ?, ended_at = datetime('now'), duration_s = ?, summary = ?, intent = ?, message_json = ? WHERE id = ?`
    )
      .bind(status, duration, summary, intent, messageJson, this.callId)
      .run();
    this.finalized = true;
    await this.clearWatchdog();
  }
}
