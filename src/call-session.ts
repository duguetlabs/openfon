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
import { buildSystemPrompt, defaultGreeting, SUMMARY_PROMPT } from './prompt';
import { chatComplete, resolveLlm, synthesize, transcribe, voiceForReply, SUPPORTED_LANGUAGES } from './providers';

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
      await this.handleUtterance(ev.data as ArrayBuffer);
      return;
    }
    const msg = JSON.parse(ev.data) as { type: string; text?: string; contentType?: string };
    switch (msg.type) {
      case 'start':
        await this.handleStart();
        break;
      case 'text':
        if (msg.text?.trim()) await this.respond(msg.text.trim());
        break;
      case 'hangup':
        this.send({ type: 'ended' });
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
    this.history = [
      { role: 'system', content: buildSystemPrompt(this.biz!, this.settings!, new Date()) },
      { role: 'assistant', content: greeting },
    ];
    const ttsMode = this.env.DEFAULT_TTS_PROVIDER === 'azure' && this.env.AZURE_SPEECH_KEY ? 'server' : 'browser';
    this.send({ type: 'ready', ttsMode, greeting });
    await this.saveTurn('agent', greeting);
    await this.speak(greeting);
  }

  private async handleUtterance(audio: ArrayBuffer): Promise<void> {
    if (this.busy || !this.biz) return; // drop overlapping speech while we respond
    this.busy = true;
    try {
      this.send({ type: 'thinking' });
      const { text, language } = await transcribe(this.env, audio, this.pendingContentType);
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
