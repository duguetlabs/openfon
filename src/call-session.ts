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
import { chatComplete, detectLang, isVocabEcho, normalizeLang, resolveLlm, synthesize, transcribe, voiceForReply, SUPPORTED_LANGUAGES } from './providers';

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
  private ended = false;
  private lang = 'en'; // follows the caller; starts as the business default
  private mode: 'pipeline' | 'realtime' = 'pipeline';
  private upstream: WebSocket | null = null; // realtime engine connection

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.callId = url.searchParams.get('call') ?? '';
    if (request.headers.get('Upgrade') !== 'websocket' || !this.callId) {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.ws = server;
    server.addEventListener('message', (ev) => {
      this.onMessage(ev).catch((err) => this.sendError(`${err}`));
    });
    server.addEventListener('close', () => {
      this.closeUpstream();
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

  private sendError(message: string): void {
    console.error('call error:', message);
    this.send({ type: 'error', message });
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
        this.send({ type: 'ended' });
        this.closeUpstream();
        this.ws?.close(1000, 'hangup');
        await this.finalize();
        break;
      default:
        if (msg.contentType) this.pendingContentType = msg.contentType;
    }
  }

  private pendingContentType = 'audio/webm';

  private async handleStart(): Promise<void> {
    await this.loadCall();
    this.lang = this.settings!.language in SUPPORTED_LANGUAGES ? this.settings!.language : 'en';
    const greeting = defaultGreeting(this.biz!, this.settings!);
    const systemPrompt = buildSystemPrompt(this.biz!, this.settings!, new Date());

    if (this.settings!.engine === 'realtime') {
      const ok = await this.startRealtime(systemPrompt, greeting).catch((err) => {
        console.error('realtime engine failed, falling back to pipeline:', err);
        return false;
      });
      if (ok) {
        this.mode = 'realtime';
        if (this.engineGreets()) {
          // Engine speaks the greeting in its own voice; the greeting text and
          // transcript turn arrive through the normal event stream.
          this.history = [{ role: 'system', content: systemPrompt }];
          const ttsMode = this.env.DEFAULT_TTS_PROVIDER === 'azure' && this.env.AZURE_SPEECH_KEY ? 'server' : 'browser';
          this.send({ type: 'ready', mode: 'realtime', ttsMode, greeting: '' });
          return;
        }
        this.history = [
          { role: 'system', content: systemPrompt },
          { role: 'assistant', content: greeting },
        ];
        const ttsMode = this.env.DEFAULT_TTS_PROVIDER === 'azure' && this.env.AZURE_SPEECH_KEY ? 'server' : 'browser';
        this.send({ type: 'ready', mode: 'realtime', ttsMode, greeting });
        await this.saveTurn('agent', greeting);
        // The greeting is ours, not the model's: synthesize it deterministically
        // and stream it as PCM so it matches the realtime audio path.
        const voice = voiceForReply(this.env, this.lang, this.settings!.language, this.settings!.voice || '');
        const audio = await synthesize(this.env, greeting, voice, 'pcm24');
        if (audio && this.ws) {
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
      { role: 'system', content: systemPrompt },
      { role: 'assistant', content: greeting },
    ];
    const ttsMode = this.env.DEFAULT_TTS_PROVIDER === 'azure' && this.env.AZURE_SPEECH_KEY ? 'server' : 'browser';
    this.send({ type: 'ready', mode: 'pipeline', ttsMode, greeting });
    await this.saveTurn('agent', greeting);
    await this.speak(greeting);
  }

  // ---- realtime engine bridge (OpenAI Realtime wire protocol) ----

  private sendUpstream(obj: unknown): void {
    try {
      this.upstream?.send(JSON.stringify(obj));
    } catch {
      /* upstream gone */
    }
  }

  private closeUpstream(): void {
    try {
      this.upstream?.close(1000, 'call ended');
    } catch {
      /* noop */
    }
    this.upstream = null;
  }

  private realtimeInstructions = '';
  private realtimeModel = '';
  private sessionVoice = ''; // voice sent upstream; '' = let the tier pick
  private voiceManaged = false; // true when we own language->voice switching (HD default)
  private reconnects = 0;

  // Full session payload, resent whenever the voice changes — partial updates
  // are not guaranteed to preserve transcription config.
  private realtimeSessionPayload(voice: string, instructions: string): unknown {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions,
        audio: {
          input: {
            // 24 kHz: the lowest rate every tier accepts (native S2S models reject 16 kHz)
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: { type: 'server_vad', silence_duration_ms: 550 },
            transcription: {
              // Native S2S tiers only support their own transcription models;
              // forcing ours silently disables caller transcripts there.
              model: this.realtimeModel.startsWith('gpt-realtime') ? 'whisper-1' : this.env.DEFAULT_STT_MODEL,
              prompt: this.biz && this.settings ? sttVocab(this.biz, this.settings) : undefined,
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

  private startRealtime(systemPrompt: string, greeting: string): Promise<boolean> {
    const key = this.env.REALTIME_API_KEY || this.env.DEFAULT_LLM_API_KEY || '';
    const model = this.settings?.realtime_model || this.env.REALTIME_MODEL;
    this.realtimeModel = model;
    console.log(`call ${this.callId}: realtime engine, model ${model}`);
    const isHd = model === 'kataleptic-realtime-hd';
    // Explicit per-business realtime voice wins; on the Azure-backed HD tier we
    // manage the voice (matches the synthesized greeting); other tiers default.
    this.voiceManaged = isHd && !this.settings?.realtime_voice;
    this.sessionVoice =
      this.settings?.realtime_voice ||
      (isHd ? voiceForReply(this.env, this.lang, this.settings?.language ?? 'en', this.settings?.voice || '') : '');
    this.realtimeInstructions = this.engineGreets()
      ? systemPrompt
      : `${systemPrompt}\n\nYou already opened the call by saying: "${greeting}". Continue the conversation from there.`;
    return this.openUpstream(this.realtimeInstructions, this.engineGreets() ? greeting : null);
  }

  private openUpstream(instructions: string, greetWith: string | null): Promise<boolean> {
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
      const timer = setTimeout(() => settle(false), 5000);
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        clearTimeout(timer);
        settle(false);
        return;
      }
      this.upstream = ws;
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.sendUpstream(this.realtimeSessionPayload(this.sessionVoice, instructions));
        if (greetWith) {
          this.sendUpstream({
            type: 'response.create',
            response: { instructions: `Greet the caller by saying exactly this, then wait for them to speak: "${greetWith}"` },
          });
        }
        settle(true);
      });
      ws.addEventListener('message', (ev) => {
        this.onUpstreamMessage(ev).catch((err) => console.error('upstream handler error', err));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        settle(false);
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        settle(false);
        if (this.mode === 'realtime' && !this.ended && this.upstream === ws) {
          void this.recoverUpstream();
        }
      });
    });
  }

  // The engine dropped the session mid-call: reconnect once with the
  // conversation so far folded into the instructions, instead of hanging up.
  private async recoverUpstream(): Promise<void> {
    if (this.reconnects >= 1) {
      this.sendError('Voice engine connection lost');
      this.send({ type: 'ended' });
      this.ws?.close(1000, 'engine closed');
      await this.finalize();
      return;
    }
    this.reconnects++;
    console.log(`call ${this.callId}: upstream dropped, reconnecting`);
    const transcript = this.history
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role === 'user' ? 'Caller' : 'You'}: ${m.content}`)
      .join('\n');
    const resumed = `${this.realtimeInstructions}\n\nThe call audio was briefly interrupted; the caller is still on the line. Do NOT greet again. Conversation so far:\n${transcript}`;
    const ok = await this.openUpstream(resumed, null).catch(() => false);
    if (!ok) await this.recoverUpstream();
  }

  private async onUpstreamMessage(ev: MessageEvent): Promise<void> {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data) as { type: string; delta?: string; transcript?: string; language?: string; error?: { message?: string } };
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
        // Barge-in: the server cancels its in-flight response; we flush caller playback.
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
          await this.saveTurn('caller', text);
        }
        break;
      case 'response.output_audio_transcript.done':
        if (msg.transcript?.trim()) {
          const text = msg.transcript.trim();
          this.send({ type: 'agent_text', text });
          this.history.push({ role: 'assistant', content: text });
          await this.saveTurn('agent', text);
        }
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
    const reply = (await chatComplete(llm, this.history, { maxTokens: 200, temperature: 0.6 })).trim();
    this.history.push({ role: 'assistant', content: reply });
    this.send({ type: 'agent_text', text: reply });
    await this.saveTurn('agent', reply);
    await this.speak(reply);
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
  }

  private async finalize(): Promise<void> {
    if (this.ended || !this.callId) return;
    this.ended = true;
    const call = await this.env.DB.prepare('SELECT started_at FROM calls WHERE id = ? AND status = ?')
      .bind(this.callId, 'active')
      .first<{ started_at: string }>();
    if (!call) return;
    const duration = Math.max(0, Math.round((Date.now() - new Date(call.started_at + 'Z').getTime()) / 1000));
    let summary: string | null = null;
    let intent: string | null = null;
    let messageJson: string | null = null;
    // Summarize only real conversations (greeting alone doesn't count).
    if (this.history.length > 2) {
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
    await this.env.DB.prepare(
      `UPDATE calls SET status = 'completed', ended_at = datetime('now'), duration_s = ?, summary = ?, intent = ?, message_json = ? WHERE id = ?`
    )
      .bind(duration, summary, intent, messageJson, this.callId)
      .run();
  }
}
