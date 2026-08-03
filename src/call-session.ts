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

// WebSocket.OPEN. Fixed by the spec, and not exposed on the Workers instance
// type — needed to tell "this connection still works" from "it is gone".
const WS_OPEN = 1;

// ---- turn detection ----
// Which detector a realtime tier gets is a measured property of that tier, not
// a house style, so it lives in a table rather than inline in the payload
// builder. Every tier resolves to server VAD today; the table exists so that
// stays a decision on the record rather than a default nobody revisited.
//
// Higher threshold: ambient noise was triggering barge-ins that cut off the
// greeting; prefix padding keeps word onsets unclipped.
type TurnDetection = Record<string, string | number>;
const SERVER_VAD: TurnDetection = { type: 'server_vad', threshold: 0.7, prefix_padding_ms: 300, silence_duration_ms: 550 };

// What we send in `session.update`, and therefore what the echo is checked
// against. Loose on purpose: the fields differ by tier and the comparison walks
// whatever we actually sent rather than a list someone has to remember to
// update.
type SessionConfig = Record<string, unknown>;

// The trade, so it does not get re-litigated from half the evidence — all of it
// in docs/research/realtime-latency-2026-08.md § "Follow-up: is the splitting
// the brain or the turn detector?":
//
//   * `server_vad` splits a caller's utterance at a clause pause on
//     gpt-realtime tiers — 10 of 10 turns, against 0 of 10 for the same brain
//     and serving stack on a semantic detector (exact McNemar p = 0.00195).
//     Inaudibly: the fragment's response is cancelled before any audio goes
//     out, so the caller hears nothing and the model answers a sentence
//     fragment as a complete turn, billing a discarded response each time.
//   * OpenAI's `semantic_vad` fixes that and costs too much for a phone call:
//     end-of-turn p50 1189 ms against server VAD's 736, and a **p90 of
//     4512 ms**. The engine-only delta is −87 ms and null, so the whole penalty
//     is the detector deciding, not the model thinking.
//   * Azure's semantic detector is genuinely free — 707 ms p50, the tightest
//     spread of any arm measured, 0/10 splits. It is only reachable through
//     Voice Live, and Kataleptic exposes no tier that pairs Voice Live with a
//     gpt-realtime brain. That combination is the actual fix and it is not
//     currently purchasable.
//
// So: the splitting is real and stays, because every available remedy is worse
// than the defect. Revisit when a Voice Live + gpt-realtime tier exists.
// Two detectors with opposite latency profiles both get called "semantic VAD";
// collapsing them is how this nearly shipped the 4.5 s tail.
//
// The whole gpt-realtime family behaves the same way, so none of this is
// specific to one model id (72-turn run, all controls verified): 2, 2.1 and
// 2.1-mini all split **12/12** under `server_vad`, against HD's 0/12. Semantic
// VAD takes 2.1 to 0/12 (Holm p = 0.00293) but only takes **2.1-mini to 4/12**
// (Holm p = 0.02344) — still one turn in three, with the detector confirmed
// echoed back on all 12. On mini the semantic detector is a mitigation, not a
// fix, which counts against that tier as a default on its own, before latency
// is even considered.
const TURN_DETECTION_BY_TIER: Record<string, TurnDetection> = {
  // Splits 12/12 under server_vad. Left on it anyway — see the trade above.
  'gpt-realtime-2': SERVER_VAD,
  // 12/12 too, and semantic VAD would take it to 0/12 — the one tier where the
  // detector is a clean fix. Still server VAD pending the latency block: if 2.1
  // carries gpt-realtime-2's 4512 ms p90 end-of-turn tail, fixing the splitting
  // does not pay for it. One line to flip when those numbers land.
  'gpt-realtime-2.1': SERVER_VAD,
  // 12/12, and semantic VAD only gets it to 4/12. Nothing available fixes this
  // tier, so the detector choice is not what decides it.
  'gpt-realtime-2.1-mini': SERVER_VAD,
  // Does not split (0/10), and semantic VAD measured *worse* on this brain
  // (strict success 0.333 -> 0.259, pass^3 0.222 -> 0.111, TTFA p95 +133 ms;
  // docs/research/voice-engine-quality-2026-08.md).
  //
  // It is also not a free experiment. Probed live 2026-08-03, `semantic_vad`
  // on this tier is **rejected outright**: the gateway translates it to Voice
  // Live's `azure_semantic_vad_multilingual`, and Voice Live refuses to change
  // the detector type once a session has one — which the gateway's own injected
  // session.update has already set. "Cannot change turn detection type during
  // session (from server_vad to azure_semantic_vad_multilingual)", an error at
  // session start, on every HD call. A rule keyed on the model *name* rather
  // than on the tier would have shipped exactly that.
  'kataleptic-realtime-hd': SERVER_VAD,
  // Cascade: no evidence it splits, and it will not honour a semantic detector
  // anyway. Worse than rejecting it — probed live 2026-08-03, it *accepts*
  // `semantic_vad` and then quietly serves `server_vad` back at Azure's
  // defaults (0.5 / 500), discarding the tuning above. Nothing fails; the call
  // just runs on settings nobody chose. Only reading the `session.updated` echo
  // shows it, which is the lesson both benchmarks kept re-learning: a config we
  // cannot confirm is not a config.
  'kataleptic-realtime': SERVER_VAD,
};

// Exact tier ids, with server VAD as the fallback for anything unlisted —
// deliberately not a rule keyed on the model name, because the two live
// substitutions above are both cases where a name-shaped rule would have been
// applied to a tier that cannot honour it.
//
// This is the seam for the decision: changing one tier's detector is one line
// in the table. An unlisted tier takes the fallback, which is deliberately the
// tuned server VAD rather than an untuned one — a tier nobody has measured
// should still get the settings that were tuned against real ambient noise.
//
// If a semantic entry is ever added here, note that OpenAI's detector takes
// only `{type: 'semantic_vad', eagerness: 'auto'}` — verified against these
// endpoints by bench/realtime/arms.py and echoed back unchanged by every
// gpt-realtime tier when probed live. The 0.7 threshold and 300 ms prefix
// padding have no successor there: that detector has no energy gate, no prefix
// padding and no fixed silence hangover, so the tuning is dropped rather than
// ported.
function turnDetectionFor(model: string): TurnDetection {
  return TURN_DETECTION_BY_TIER[model] ?? SERVER_VAD;
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
    // Armed before the socket is accepted, so a storage failure here leaves no
    // trace. Assigning `this.ws` first meant a failed arm returned an error
    // with a socket in place but no listeners and no watchdog: every later
    // attach got the 409 above, and nothing existed to finalize the row — an
    // active call that could neither be recovered nor replaced, which is the
    // exact state this class exists to prevent, reached through the guard that
    // prevents it. Ordering it this way rather than unwinding in a catch: the
    // undo path would be one more thing to get right.
    try {
      await this.armStartDeadline();
    } catch (err) {
      // The row outlives a failed arm: /api/public/call/start inserted it
      // before this upgrade, and with no alarm armed nothing in here will ever
      // finalize it. The widget does not retry a call id either — it asks for a
      // fresh one — so retire the row on the way out rather than leave it
      // 'active' with no owner. Same ordering fix as arming before accepting,
      // one layer out: no socket was the first half, no orphaned row is this.
      console.error(`call ${this.callId}: could not arm the watchdog; retiring the row`, err);
      await this.env.DB.prepare(
        `UPDATE calls SET status = 'failed', ended_at = ?, summary = ? WHERE id = ? AND status = 'active'`
      )
        .bind(
          CallSession.sqlTime(Date.now()),
          'Call failed: the call could not be started.',
          this.callId
        )
        .run()
        .catch((dbErr) => console.error(`call ${this.callId}: could not retire the row either`, dbErr));
      throw err;
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.ws = server;
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
    // The call is already over for the caller: the widget turns any error frame
    // into its terminal state, and a later `ended` deliberately does not
    // override that phase. So the session has to agree. Leaving it open kept
    // the row 'active' with connected_at set — what the concurrency cap counts
    // as a live call — with nothing to release it until the sweep an hour
    // later, so a handful of failures could answer "all lines are busy" long
    // after the provider recovered. finalize() derives 'failed' from the
    // failure just recorded, so the row keeps its summary too, which the sweep
    // cannot write.
    void this.finalize().catch((e) => console.error('finalize after failure failed', e));
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
        // Its errors are caught here rather than reaching failInternally: a row
        // that fails to write is retried by the watchdog and is not the call
        // failing. Letting it through recorded a transient D1 blip as the
        // caller's outcome, so a perfectly normal conversation that wrote on
        // the second attempt was reported to the owner as a failed call.
        await this.finalize().catch((err) => console.error('finalize failed', err));
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

  // Announcing `ready` is the point of no return for retries. (The start
  // deadline is retired in armWatchdog, not here — see there.)
  private sendReady(payload: Record<string, unknown>): void {
    this.announced = true;
    // An earlier attempt may have recorded a failure that this one has just
    // disproved. The marker decides the row's status, so carrying it forward
    // would file a call that ran perfectly well as failed — and a working call
    // disappearing from the owner's counts gives them nothing to notice.
    this.failure = null;
    this.send({ type: 'ready', ...payload });
  }

  private async runStart(): Promise<void> {
    // Recorded before anything that can block. The start deadline is for a
    // socket that never sends a start, not for a start that is slow — and
    // "startup has not finished" cannot tell those apart, so a legitimate
    // caller whose loadCall or engine handshake ran long was hung up on
    // mid-connect and told they had never started the call.
    await this.state.storage.put('startedAt', Date.now());
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
          this.sendReady({ mode: 'realtime', ttsMode, greeting: '', engine: engineLabel });
          return;
        }
        this.history = [
          { role: 'system', content: systemPrompt },
          { role: 'assistant', content: greeting },
        ];
        const ttsMode = this.env.DEFAULT_TTS_PROVIDER === 'azure' && this.env.AZURE_SPEECH_KEY ? 'server' : 'browser';
        this.sendReady({ mode: 'realtime', ttsMode, greeting, engine: engineLabel });
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
    this.sendReady({
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
  //
  // **Ask of anything new that touches upstream state: what does this do while
  // two sockets are alive?** That window has now produced the same bug three
  // times — the receive guard keyed on "is this the write target" (dropping the
  // working connection's audio), the reconnect counter shared across an episode
  // (hanging up on the second drop), and the session read-back holding one
  // `sent`/`resends` pair per call (a superseded socket's echo spending the
  // replacement's budget). Every one was a per-connection fact stored per call.
  // State that belongs to a connection is keyed by the connection.
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

  // ---- session echo read-back ----
  // The gateway dials its upstream lazily and injects a `session.update` of its
  // own, which races with ours. When it wins, the call runs on settings nobody
  // chose and nothing anywhere says so. Measured over 8 sessions per tier, our
  // turn detector came back as sent on 7 and was replaced on 1 — the same race
  // that substituted the STT model on 22 of 25 turns in the latency benchmark.
  // At ~1 in 8 this is not an edge case; it is a routine, silent config loss.
  //
  // The benchmark harness rejects those sessions. Production cannot reject
  // anything, so it re-asserts instead: compare the echo against what we sent
  // and, if something that matters differs, send the whole payload again.
  //
  // Keyed by socket, because `session.updated` arrives per connection and during
  // a rotation two connections are alive at once (see `readableUpstreams`). Held
  // as one field per call, the outgoing socket's echo would have been compared
  // against the replacement's config, spent the replacement's retry budget, and
  // re-sent to a socket that is about to close. A WeakMap rather than bookkeeping
  // we have to remember to clean up: a socket nobody references is a session
  // nobody can echo.
  private sessionState = new WeakMap<WebSocket, { sent: SessionConfig; resends: number }>();
  private static readonly MAX_SESSION_RESENDS = 2;

  // Subtrees whose silent substitution changes what the caller experiences, so
  // they are worth re-sending for. Everything *else* we send is compared too
  // and logged — there is no second list of paths to keep in step with the
  // payload, because a hand-maintained list is a list of the substitutions
  // somebody thought of. The rule is the one `diffSession` already applies:
  // report wherever we expressed an intent.
  //
  // Measured before widening it, because the read-back is only as useful as it
  // is quiet — a line on every call gets filtered within a day and takes the
  // real substitutions with it. Two sessions per tier on all five tiers, whole
  // payload including tools: **nothing outside `transcription` diverges
  // anywhere.** Formats, turn detection, tools, tool_choice and voice come back
  // verbatim, so the wider net costs no noise.
  private static readonly ENFORCED_SESSION_PATHS = ['audio.input.turn_detection', 'audio.input.format', 'audio.output.format'];

  // Transcription is enforced everywhere it *can* be, which is everywhere but
  // the HD tier.
  //
  // It used to be advisory on the grounds that the gateway's substitution is
  // persistent and re-sending would lose. That was wrong, and the way it was
  // wrong is worth keeping: the gateway injects its own transcription default
  // asynchronously, so this is a *race*, not an override. Whichever
  // `session.update` lands last wins, and a re-send lands last by construction.
  // Measured on the three native tiers, six sessions each: an update sent after
  // the injected one keeps our model and vocabulary prompt **18/18**. The loss
  // is intermittent — one sitting lost it 4/4, another kept it 18/18 untouched —
  // which is exactly why re-asserting beats reasoning about the odds.
  //
  // HD is the exception and cannot be fixed from this side: Azure Voice Live
  // latches `input_audio_transcription` on the *first* `session.update` of a
  // session and ignores it in every later one (reproduced against Azure
  // directly, with no gateway in the path), and the gateway spends that one
  // update on its own voice default. 0/18 there, under three different
  // strategies. Enforcing it would burn both re-sends on every HD call and
  // report a failure nobody can act on.
  private enforcedSessionPaths(): string[] {
    return this.realtimeModel === 'kataleptic-realtime-hd'
      ? CallSession.ENFORCED_SESSION_PATHS
      : [...CallSession.ENFORCED_SESSION_PATHS, 'audio.input.transcription'];
  }

  // Every field we sent, compared against the echo — derived from the request
  // rather than from a hardcoded list, so a field added to the payload is
  // checked without anyone remembering to add it here. Absent counts as a
  // mismatch: a control we cannot confirm is not a control, which is the rule
  // both benchmarks arrived at after silent substitutions went unnoticed for a
  // whole run.
  private static diffSession(sent: unknown, echoed: unknown, path: string): string[] {
    // Nothing was asked for here, so there is nothing to verify. This looks
    // like the opposite of the rule above and is the same one: what matters is
    // whether we expressed an intent. An echo that *drops* a field we set is a
    // substitution; an echo that *fills in* a field we deliberately left unset
    // is the tier answering a question we asked it to answer. `voice` is the
    // live case — gpt-realtime tiers are sent no voice ('' = tier default) and
    // echo back the one they chose, which is intended behaviour and not news.
    if (sent === undefined) return [];
    if (sent === null || typeof sent !== 'object') {
      if (sent === echoed) return [];
      return [`${path}=${JSON.stringify(echoed)} (asked ${JSON.stringify(sent)})`];
    }
    if (echoed === null || typeof echoed !== 'object') return [`${path} absent — unverifiable`];
    return Object.entries(sent as Record<string, unknown>).flatMap(([k, v]) =>
      CallSession.diffSession(v, (echoed as Record<string, unknown>)[k], `${path}.${k}`)
    );
  }

  private checkSessionEcho(echoed: unknown, from: WebSocket): void {
    // This connection's own configuration and its own budget. A late echo from
    // a socket being rotated out is therefore checked against what *that* socket
    // was told, and can neither spend the live connection's retries nor push a
    // re-send at it.
    const state = this.sessionState.get(from);
    if (!state || !echoed || typeof echoed !== 'object') return;
    const sent = state.sent;
    // The gateway's own injected update produces an echo too, and it arrives
    // first. Only the echo carrying our instructions is a report on what we
    // asked for — and it is still the right discriminator when the race is
    // lost, because a losing session comes back as ours by instructions and
    // theirs by detector. That asymmetry is exactly how the benchmark found it.
    if ((echoed as SessionConfig).instructions !== sent.instructions) return;

    // The whole payload, not a list of subtrees somebody remembered to add.
    // Everything we asked for is compared; the enforced subtrees are the ones
    // worth re-sending for, and the rest is reported so a silent substitution
    // is at least a visible one.
    const divergences = CallSession.diffSession(sent, echoed, 'session');
    if (!divergences.length) return;
    const enforcedPaths = this.enforcedSessionPaths().map((p) => `session.${p}`);
    // A divergence counts as enforced when it is at, below, **or above** an
    // enforced path. The ancestor direction is the one the widened comparison
    // lost: an echo that drops `audio.input` wholesale reports a single
    // `session.audio.input absent — unverifiable`, which is at or below
    // nothing, so it read as advisory and no re-send went out — while the
    // detector, the formats and the transcription were all unverifiable at
    // once. The per-path version enforced that case by construction, because
    // it looked up each enforced path and found the parent missing.
    const isEnforced = (d: string): boolean => {
      const path = d.split(/[ =]/)[0];
      return enforcedPaths.some((p) => path === p || path.startsWith(`${p}.`) || p.startsWith(`${path}.`));
    };
    const enforced = divergences.filter(isEnforced);
    const advisory = divergences.filter((d) => !isEnforced(d));
    if (advisory.length) console.log(`call ${this.callId}: session echo differs (advisory): ${advisory.join('; ')}`);
    if (!enforced.length) return;

    if (state.resends >= CallSession.MAX_SESSION_RESENDS) {
      // Out of attempts. Say so loudly rather than silently: the call carries
      // on, and the owner's log is the only place this can surface.
      console.error(`call ${this.callId}: session config not applied after ${state.resends} re-sends: ${enforced.join('; ')}`);
      return;
    }
    state.resends++;
    console.warn(`call ${this.callId}: session config was substituted, re-sending (${state.resends}): ${enforced.join('; ')}`);
    // Byte-identical to what we sent, and aimed at the socket that answered —
    // during a rotation that is not necessarily the current write target.
    this.sendUpstream({ type: 'session.update', session: sent }, from);
  }

  // Every session.update goes through here so what we recorded cannot drift from
  // what actually went on the wire, and so a fresh configuration gets a fresh
  // re-send budget — on the connection it was sent to, and only that one. The
  // re-send path deliberately does not come back through this method: resetting
  // the budget from inside a retry is how a retry becomes a loop.
  private sendSessionUpdate(voice: string, instructions: string, target: WebSocket | null = this.upstream): void {
    if (!target) return;
    const payload = this.realtimeSessionPayload(voice, instructions);
    this.sessionState.set(target, { sent: payload.session, resends: 0 });
    this.sendUpstream(payload, target);
  }

  // Full session payload, resent whenever the voice changes — partial updates
  // are not guaranteed to preserve transcription config.
  private realtimeSessionPayload(voice: string, instructions: string): { type: string; session: SessionConfig } {
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
            // There is deliberately no noise-reduction field in here, and a
            // test pins its absence. Azure's `azure_deep_noise_suppression`
            // returns an empty transcript for ~32% of English utterances and
            // takes clean-audio WER from 4.8% to 47.8%; on German it drops
            // nothing and is merely harmful (40.4% against 20.5% at 0 dB cafe
            // noise). It improves robustness nowhere — including under the
            // noise it exists to remove — and `near_field` / `far_field`
            // measured as exact no-ops. See
            // docs/research/voice-engine-quality-2026-08.md § "Noise
            // suppression". Sending nothing is already the right answer; the
            // note and the test exist so it does not get "improved" later.
            //
            // 24 kHz: the lowest rate every tier accepts (native S2S models reject 16 kHz)
            format: { type: 'audio/pcm', rate: 24000 },
            // Per-tier, from the measurements — see TURN_DETECTION_BY_TIER.
            turn_detection: turnDetectionFor(this.realtimeModel),
            transcription: {
              // Native S2S tiers only support their own transcription models;
              // forcing ours silently disables caller transcripts there.
              //
              // Do NOT "fix" the HD tier by asking for `azure-speech` here, even
              // though that is what it always ends up using. The gateway strips
              // an unsupported `prompt` only when it is the one choosing
              // azure-speech; name it ourselves and the prompt goes upstream
              // intact, where Azure rejects the **entire** session.update —
              // instructions, voice and tools with it.
              model: this.realtimeModel.startsWith('gpt-realtime') ? 'whisper-1' : this.env.DEFAULT_STT_MODEL,
              // Not sent on HD, where it cannot take effect: Azure Voice Live
              // answers `prompt is not yet supported for azure-speech`, and its
              // transcription config is latched by the first `session.update`
              // of the session, which the gateway spends on its own default.
              // Sending it anyway would only produce an advisory line on every
              // HD call about a field nobody can apply. If Kataleptic stops
              // spending that first update, this can go back to unconditional —
              // and `phrase_list` becomes the supported spelling of it there.
              ...(this.realtimeModel === 'kataleptic-realtime-hd' ? {} : { prompt: this.biz && this.settings ? sttVocab(this.biz, this.settings) : undefined }),
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
    this.sendSessionUpdate(voice, this.realtimeInstructions);
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

  // Every tier accepts the tool. None of them reliably calls it: measured over
  // 33 goodbye turns per engine, the agent invoked `end_call` on 23-25 of them,
  // with no meaningful spread between engines — and on one scenario it fired
  // 1 time in 15 after capturing every detail correctly
  // (docs/research/voice-engine-quality-2026-08.md, Track B).
  //
  // So the caller-farewell heuristic and the hangup safety net below are not
  // belt-and-braces. They are the primary mechanism on roughly a quarter of
  // calls, and removing either one would leave those calls running until a
  // watchdog picks them up. Do not remove them.
  private toolsSupported(): boolean {
    return true;
  }

  // Agent-initiated hangup: tell the client to end once playback drains, with
  // a server-side safety net if it never does.
  //
  // Reached three ways, and the ranking is not what it looks like: `end_call`
  // is the intended path but only fires on 23-25 of 33 goodbye turns on every
  // tier measured (see toolsSupported), so the caller-farewell backstop and
  // this timer carry the rest. Idempotent by design, because more than one of
  // them firing on the same call is the normal case rather than the odd one.
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
        this.sendSessionUpdate(this.sessionVoice, briefing, ws);
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
        this.onUpstreamMessage(ev, ws).catch((err) => console.error('upstream handler error', err));
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
        // Failing to open a replacement is not the same as the call being over.
        // A proactive rotation keeps the outgoing connection live while the new
        // one dials, so when that connection is still open the right move is to
        // keep using it: session.expiring warns about a minute ahead, and
        // riding the engine we have until it actually closes beats hanging up
        // on a caller whose engine still works. A close-driven recovery is the
        // other case — the listener nulls `upstream` before calling here, so
        // there is genuinely nothing left and finalizing is correct.
        if (this.upstream && this.upstream.readyState === WS_OPEN) {
          console.log(`call ${this.callId}: rotation failed; staying on the connection we still have`);
          // The rotation episode is over. A later drop is a new event and gets
          // its own attempt; `totalReconnects` still bounds the whole call.
          this.reconnects = 0;
          return;
        }
        // The caller was cut off mid-conversation and we could not get the
        // engine back. That is a failed call, not a completed one, and the
        // owner's log should say so — otherwise it reads as a normal call that
        // merely ends abruptly. The summary the exchange produced still follows
        // the reason, so nothing the caller said is lost.
        this.failure ??= 'Call failed: the voice engine connection was lost and could not be restored.';
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
        // The episode succeeded, so its budget goes back. `reconnects` bounds
        // attempts within one recovery; leaving it spent turned it into a
        // second, stricter whole-call cap, and the next drop finalized without
        // trying at all — a call that survived one engine drop was hung up on
        // by the second, with MAX_TOTAL_RECONNECTS still permitting several.
        // `totalReconnects` is what bounds the call.
        this.reconnects = 0;
        return;
      }
    }
  }

  private async onUpstreamMessage(ev: MessageEvent, from: WebSocket): Promise<void> {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data) as {
      type: string;
      delta?: string;
      transcript?: string;
      language?: string;
      item?: { type?: string; name?: string };
      name?: string;
      session?: SessionConfig;
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
          // Caller-farewell backstop, armed after at least one real exchange.
          // Not a fallback: `end_call` fires on 23-25 of 33 goodbye turns on
          // every tier measured (see toolsSupported), so on roughly a quarter
          // of calls this is what ends them. beginHangup is idempotent, so
          // this firing alongside end_call is harmless.
          //
          // Still skipped on gpt-realtime tiers, where it has never been
          // armed — those calls rely on end_call alone and are exposed to the
          // same ~25% miss rate. Arming it there is a behaviour change, not a
          // comment fix, so it is proposed in the PR rather than done here.
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
      case 'session.updated':
        // Read back what the service actually applied. Nothing else in the
        // call ever notices a substitution.
        this.checkSessionEcho(msg.session, from);
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
  // Deliberately a separate, larger budget: this one covers a start that has
  // arrived and is still working, which normally takes under ten seconds but
  // has D1, an engine handshake and TTS behind it.
  private static readonly START_CEILING_MS = 90_000;
  // How long finalize keeps retrying before leaving the row to a sweep.
  private static readonly MAX_FINALIZE_RETRY_MS = 30 * 60_000;
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
  // Durable Object writes issued without an await between them are coalesced
  // into one transaction, so they land together or not at all. Every place this
  // class persists state and schedules the alarm that acts on it needs that:
  // a put that commits while its setAlarm fails leaves a row with nothing left
  // to finalize it, which is the stranding this whole class exists to prevent.
  // Callers must pass the started promises, never await one first.
  private async commit(...writes: Promise<unknown>[]): Promise<void> {
    await Promise.all(writes);
  }

  private async armStartDeadline(): Promise<void> {
    const deadline = Date.now() + CallSession.START_DEADLINE_MS;
    await this.commit(
      this.state.storage.put({ callId: this.callId, startDeadline: deadline }),
      this.state.storage.setAlarm(deadline)
    );
  }

  private async armWatchdog(): Promise<void> {
    const now = Date.now();
    this.lastActivity = now;
    // Retiring the start deadline is part of this same write rather than a
    // separate delete once `ready` goes out. A standalone delete can fail on
    // its own, and then the call is live with a stale deadline that the
    // watchdog will honour — it would hang up on a caller mid-conversation.
    // Folded in here it either lands with the rest of the watchdog state or
    // not at all, and by this point the call is going ahead.
    await this.commit(
      this.state.storage.put({
        callId: this.callId,
        startDeadline: 0,
        hardDeadline: now + CallSession.MAX_CALL_MS,
        lastActivity: now,
      }),
      this.state.storage.setAlarm(now + CallSession.WATCHDOG_TICK_MS)
    );
  }

  async alarm(): Promise<void> {
    const callId = this.callId || (await this.state.storage.get<string>('callId')) || '';
    if (!callId) return; // nothing to reconcile
    this.callId = callId;
    const now = Date.now();

    // Checked before the idle logic and never refreshed by inbound traffic:
    // pings keep an established call alive, but must not extend the grace
    // period for one that never began.
    // Both of these are skipped once armWatchdog zeroes the deadline, so
    // neither can touch a call that is under way.
    const startDeadline = await this.state.storage.get<number>('startDeadline');
    if (startDeadline) {
      const startedAt = await this.state.storage.get<number>('startedAt');
      if (!startedAt && now >= startDeadline) {
        console.log(`call ${this.callId}: no start within the deadline, releasing the call`);
        // Never became a call: no start, no turns, no conversation. 'failed' is
        // what keeps it out of the owner's call count and talk time, which is
        // where a connection that produced nothing belongs — and the recorded
        // reason means the row explains itself instead of sitting there blank.
        this.failure ??= 'Call failed: the caller connected but never started the call.';
        return this.finalizeFromAlarm(now);
      }
      // A start that arrived but never finished gets its own, longer budget:
      // it has real work behind it — D1 reads, an engine handshake, the
      // greeting — and deserves a different verdict from a caller who never
      // said anything. Without it a client that keeps pinging could hold a
      // half-started call open forever, since nothing else bounds this window.
      if (startedAt && now - startedAt >= CallSession.START_CEILING_MS) {
        console.log(`call ${this.callId}: start never completed, releasing the call`);
        this.failure ??= 'Call failed: the call did not finish starting.';
        return this.finalizeFromAlarm(now);
      }
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
      // Deliberately records no failure, so these land as 'completed'. The
      // conversation happened and the agent did its job; the line went quiet on
      // the caller's side, which is nothing the owner can act on. Marking them
      // failed would drop real calls — and any message left in them — out of the
      // dashboard's counts and talk time, which is the opposite of what someone
      // reading their call log needs. Only a call that never began (the start
      // deadline above) or one we cut off ourselves records a failure.
      return this.finalizeFromAlarm(now);
    }
    await this.commit(
      this.state.storage.put('lastActivity', activity),
      this.state.storage.setAlarm(now + CallSession.WATCHDOG_TICK_MS)
    );
  }

  // The single exit for every watchdog-initiated finalize, so no branch can
  // reach one without the retry handling — an earlier version had two, and the
  // one that skipped it recreated the stranding this watchdog exists to stop.
  //
  // Retry at the ordinary tick rather than propagating: a throwing alarm gets
  // roughly six platform retries and then nothing, leaving the row 'active'.
  // No backoff ladder. One Durable Object retrying one row by primary key once
  // a minute is not a herd worth protecting D1 from, and spacing the attempts
  // out only delays recovering the caller's summary — which is the entire
  // reason to retry rather than let the sweep take it. The sweep is also the
  // termination condition: once it retires the row, the next attempt finds no
  // active call, marks itself finalized and clears the watchdog, so this needs
  // no attempt counter or ceiling of its own.
  private async finalizeFromAlarm(now: number): Promise<void> {
    try {
      await this.finalize();
    } catch (err) {
      // Its own ceiling, not one borrowed from the sweep. This has to be
      // correct standing alone: on main there is no scheduled handler and no
      // cron, so an unbounded loop here would keep a Durable Object alive and
      // hit D1 once a minute forever. Measured from the frozen end of the call,
      // which is already persisted for the retry, so it costs no extra state
      // and survives eviction.
      // Bounded by a durable clock or not run at all. `ending` is written
      // before the first fallible statement in runFinalize, so if it is
      // missing or unreadable there is no record of when the failures began.
      // An in-memory fallback looks like the answer and is not: it resets on
      // every eviction, so each rebuilt instance measures zero elapsed and
      // reschedules, turning this ceiling into the unbounded loop it exists to
      // prevent. Defer those to the platform's alarm retries instead — finite
      // by construction, and the behaviour that predates any of this.
      //
      // Narrow in practice: setAlarm is part of the same Storage API and, per
      // Cloudflare's docs, "alarm operations follow the same rules as other
      // storage operations" — so storage being wholly unavailable stops the
      // reschedule too. This covers the partial case where writes fail and
      // scheduling still works.
      let startedTrying: number | undefined;
      try {
        startedTrying = (await this.state.storage.get<{ endedAt: number }>('ending'))?.endedAt;
      } catch {
        /* unreadable is the same as absent: no clock either way */
      }
      if (startedTrying === undefined) {
        console.error(`call ${this.callId}: finalize failed with no durable retry clock; deferring to platform retries`, err);
        throw err;
      }
      const trying = now - startedTrying;
      if (trying >= CallSession.MAX_FINALIZE_RETRY_MS) {
        console.error(
          `call ${this.callId}: giving up on finalize after ${Math.round(trying / 60_000)}m — leaving the row to be swept`,
          err
        );
        return; // stop rescheduling; the row stays 'active' for a later sweep
      }
      console.error(`call ${this.callId}: finalize failed, retrying at the next tick`, err);
      await this.state.storage.setAlarm(now + CallSession.WATCHDOG_TICK_MS);
    }
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
      await this.commit(this.state.storage.deleteAlarm(), this.state.storage.deleteAll());
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
  // When the call actually ended, decided once and persisted. Every retry
  // recomputed Date.now(), so an outage plus the wait before the next attempt
  // was reported as call duration — a 40 second call retried ten minutes later
  // became an eleven minute call in the owner's talk-time total, with nothing
  // to indicate anything had gone wrong. Persisted because an eviction between
  // attempts is expected: by then every socket is closed.
  // Everything a retry must not recompute, decided once and kept together.
  // `endedAt` because recomputing it billed the outage to the owner's talk
  // time; `failure` because losing it across an eviction flipped a failed call
  // to 'completed' on the retry that finally landed. Frozen before the first
  // fallible statement, so an attempt that dies on the SELECT leaves the same
  // record behind as one that dies on the UPDATE.
  private async rememberEnding(): Promise<number> {
    const stored = await this.state.storage.get<{ endedAt: number; failure: string | null }>('ending');
    if (stored) {
      this.failure ??= stored.failure;
      return stored.endedAt;
    }
    const ending = { endedAt: Date.now(), failure: this.failure };
    await this.state.storage.put('ending', ending);
    return ending.endedAt;
  }

  // SQLite's datetime('now') format, in UTC, so a frozen timestamp is stored
  // exactly as the column's other writers would have written it.
  private static sqlTime(ms: number): string {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  }

  // A summary this session already paid for, written to a row that something
  // else has since retired. For a small business the structured callback
  // message is the most valuable thing a call produces, and the sweep writes
  // none of the content fields — so losing it because our write lost a race is
  // worth one more statement to avoid.
  //
  // COALESCE so we only fill blanks, never overwrite another writer. Status and
  // duration are left exactly as they were found: this recovers what the caller
  // said, it does not reopen the call. Nothing is generated here, so a call
  // that never reached summarization costs nothing but a log line.
  private async salvageSummary(): Promise<void> {
    this.summarized ??= (await this.state.storage.get<typeof this.summarized>('summarized')) ?? null;
    const { summary = null, intent = null, messageJson = null } = this.summarized ?? {};
    if (!summary && !messageJson) {
      console.warn(`call ${this.callId}: row already retired, and nothing summarized to salvage`);
      return;
    }
    console.warn(`call ${this.callId}: row retired before finalize could write — salvaging its summary`);
    await this.env.DB.prepare(
      `UPDATE calls SET summary = COALESCE(summary, ?), intent = COALESCE(intent, ?), message_json = COALESCE(message_json, ?) WHERE id = ?`
    )
      .bind(summary, intent, messageJson, this.callId)
      .run();
  }

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
    const endedAt = await this.rememberEnding();
    const call = await this.env.DB.prepare('SELECT started_at, business_id FROM calls WHERE id = ? AND status = ?')
      .bind(this.callId, 'active')
      .first<{ started_at: string; business_id: string }>();
    if (!call) {
      // The row is no longer active: either something else completed it, or the
      // sweep retired it as 'abandoned' before we got here. The sweep is
      // terminal — this select is what forecloses recovery — so if a previous
      // attempt already produced a summary, write its content now instead of
      // letting the caller's callback request die with the row.
      await this.salvageSummary();
      this.finalized = true;
      await this.clearWatchdog();
      return;
    }
    const duration = Math.max(0, Math.round((endedAt - new Date(call.started_at + 'Z').getTime()) / 1000));
    await this.rehydrateHistory(call.business_id);
    // Survives eviction between attempts, so a retry never pays the
    // summarization model a second time for the same conversation.
    this.summarized ??= (await this.state.storage.get<typeof this.summarized>('summarized')) ?? null;
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
    await this.state.storage.put('summarized', this.summarized);
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
    //
    // Still predicated on 'active': the sweep can retire the row between the
    // select above and here, and summarization is long enough to make that a
    // real window. Without the predicate this would overwrite the sweep's
    // status and duration — the salvage path exists to cooperate with the
    // sweep, and unconditionally overriding it is the opposite.
    const res = await this.env.DB.prepare(
      `UPDATE calls SET status = ?, ended_at = ?, duration_s = ?, summary = ?, intent = ?, message_json = ?
        WHERE id = ? AND status = 'active'`
    )
      .bind(status, CallSession.sqlTime(endedAt), duration, summary, intent, messageJson, this.callId)
      .run();
    // `changes` missing means the driver did not report one, not that nothing
    // matched — only an explicit zero means the sweep got there first.
    if ((res?.meta?.changes ?? 1) === 0) await this.salvageSummary();
    this.finalized = true;
    await this.clearWatchdog();
  }
}
