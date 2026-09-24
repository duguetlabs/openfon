import { loadSummaryLlm } from './summary-settings';
import { RealtimeClosingGuard } from './call-closing';
import { normalizeCallerPhone } from './contact';
import { RealtimeOutputBudget, RealtimeAudioQueue, RealtimeOutputError, RealtimeAudioReceipts, MAX_UNRECEIVED_AUDIO_BYTES } from './realtime-output';
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
import type { Env, Business, AgentSettings, ChatMessage, ProviderSettings } from './types';
import { isGptLiveModel, liveRealtimeVoice, resolveRealtime, realtimeConnection, realtimeCapabilities, type RealtimeConfig } from './realtime-providers';
import { DEFAULT_GPT_LIVE_DELEGATION_MODEL, GptLiveEngine, gptLiveVoice, type GptLiveHost, type GptLiveSessionOptions } from './gpt-live';
import { CallDebug, debugMeta, debugResponse, purgeDebug, debugClientEvent, debugProviderEvent } from './call-debug';
import { buildSystemPrompt, defaultGreeting, sttVocab, SUMMARY_PROMPT } from './prompt';
import type { PromptKnowledgeItem } from './prompt';
import { loadCallKnowledge } from './call-knowledge';
import { parseRealtimeMessage, decodeRealtimeAudio, RealtimeInputError, transcriptBytes, MAX_TRANSCRIPT_FIELD_BYTES, MAX_CALL_TRANSCRIPT_BYTES, MAX_REALTIME_AUDIO_BYTES } from './realtime-input';
import { chatComplete, detectLang, isFarewell, isVocabEcho, LlmConfigError, normalizeLang, resolveLlm, speechConfig, speechVoice, synthesize, transcribe, voiceForReply, SUPPORTED_LANGUAGES } from './providers';

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

interface UpstreamMessage {
  type: string;
  delta?: string;
  response_id?: unknown;
  response?: { id?: unknown; status?: unknown };
  item_id?: string;
  content_index?: number;
  transcript?: string;
  language?: string;
  item?: { type?: string; name?: string; call_id?: unknown };
  call_id?: unknown;
  name?: string;
  session?: SessionConfig;
  error?: { type?: unknown; code?: unknown; event_id?: unknown; message?: unknown };
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

function messageJsonHasRealMessage(messageJson: string | null): boolean {
  if (!messageJson) return false;
  try {
    const parsed = JSON.parse(messageJson) as { message?: unknown };
    return typeof parsed.message === 'string' && Boolean(parsed.message.trim());
  } catch {
    return false;
  }
}

interface CallRow {
  id: string;
  business_id: string;
  assistant_id: string | null;
  channel: string;
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

// Evidence: docs/research/realtime-latency-2026-08.md and
// docs/research/realtime-21-2026-08.md. Evaluate observed tail latency as well
// as medians before changing a detector; a null median does not establish
// equivalent latency distributions.
//
// In the 72-turn split experiment, gpt-realtime-2, 2.1, and 2.1-mini each split
// 12/12 clause-pause utterances under server VAD, versus HD's 0/12. Cancelled
// fragment responses consume provider work even when callers hear no audio.
// OpenAI semantic VAD eliminated observed splits on 2 and 2.1, but only reduced
// mini to 4/12. It is a mitigation on mini, not a demonstrated fix.
//
// OpenAI semantic VAD also produced multi-second observed end-of-turn tails:
// speech_stopped_ms p90 was 4512 ms on 2 and 4442 ms on 2.1. Both measured tails
// are undesirable for this application. These unmatched samples (n=10 and 20)
// do not establish equivalence or independence from the underlying model.
//
// Azure semantic VAD is a separate detector. The later Voice Live arms showed
// narrow observed distributions (end-of-turn p50 731-732 ms, p90 738-785 ms)
// and 0/12 observed splits with gpt-realtime. These small samples do not rule
// out rare tails. At the time of those measurements, the gateway offered no
// Voice Live tier pairing this detector with a gpt-realtime brain. Recheck
// availability and measure tail latency before adopting that configuration.
//
// Keep the tuned server detector: its observed splitting is currently preferred
// to OpenAI semantic VAD's measured latency cost. The session echo verification
// below is required to confirm that the provider actually applied the choice.
const TURN_DETECTION_BY_TIER: Record<string, TurnDetection> = {
  // Splits 12/12 under server_vad. Left on it anyway — see the trade above.
  'gpt-realtime-2': SERVER_VAD,
  // Semantic VAD eliminated observed splits (12/12 -> 0/12), but the paired
  // TTFA median +106 ms hid a p90 +3490 ms (n=20). End-of-turn p90 was 4442 ms
  // versus server VAD's 805 ms. Retain server VAD based on that observed tail;
  // the null median alone is not evidence that semantic VAD is cheap.
  'gpt-realtime-2.1': SERVER_VAD,
  // Semantic VAD left 4/12 splits and measured TTFA p90 5123 ms. It did not
  // eliminate splitting in this sample, and it added an undesirable tail.
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
  // gpt-live-1 has no entry: it is full duplex and takes no turn-detection
  // settings at all (src/gpt-live.ts).
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
  private debug: CallDebug | null = null;
  private ws: WebSocket | null = null;
  private callId = '';
  private biz: Business | null = null;
  private settings: AgentSettings | null = null;
  // Undefined is deliberate: a mixed-version call row with no assistant_id
  // must keep using the legacy services/FAQs stored on the business. An
  // assistant with zero active attached items sets this to [], which is a real
  // and authoritative empty knowledge set.
  private knowledge: PromptKnowledgeItem[] | undefined;
  private history: ChatMessage[] = [];
  private persistedTranscriptBytes = 0;
  private busy = false;
  private ended = false; // stop handling caller messages
  private finalized = false; // the call row has been written; gates retries
  private finalizing: Promise<void> | null = null;
  // Computed once and reused across finalize retries, so a failed row write
  // does not re-bill summarization.
  private summarized: { summary: string | null; intent: string | null; messageJson: string | null } | null = null;
  private nativeGreeting: { ready: Promise<boolean>; resolve: (ok: boolean) => void; frames: ArrayBuffer[]; bytes: number; failed: boolean } | null = null;
  private starting: Promise<void> | null = null; // in-flight or completed start
  private announced = false; // `ready` sent: the session exists, retries are off
  private lang = 'en'; // follows the caller; starts as the business default
  private mode: 'pipeline' | 'realtime' = 'pipeline';
  private requiresCarrierAudio = false;
  private upstream: WebSocket | null = null; // realtime engine connection
  private failure: string | null = null; // owner-facing reason, stored as the call's summary

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/debug')) return debugResponse(this.state, request, this.debug);
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
        `UPDATE calls SET status = 'failed', ended_at = ?, summary = ?, outcome = 'failed',
          failure_code = 'watchdog_unavailable', failure_message = ?
         WHERE id = ? AND status = 'active'`
      )
        .bind(
          CallSession.sqlTime(Date.now()),
          'Call failed: the call could not be started.',
          'The call watchdog could not be started.',
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
      if (this.debug) {
        const v = obj as { type?: string; text?: string; message?: string };
        if (v.type) this.debug.event('caller_event', { type: v.type, text: v.text, message: v.message });
      }
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

  private async loadSettings(businessId: string, assistantId: string | null): Promise<void> {
    if (assistantId) {
      this.settings = await this.env.DB.prepare(
        `SELECT
          assistants.business_id,
          assistants.name AS agent_name,
          assistants.greeting,
          assistants.persona,
          assistants.language,
          assistants.voice,
          assistants.take_messages,
          assistants.custom_instructions,
          COALESCE(provider_settings.llm_base_url, '') AS llm_base_url,
          COALESCE(provider_settings.llm_api_key, '') AS llm_api_key,
          COALESCE(NULLIF(assistants.llm_model, ''), provider_settings.llm_model, '') AS llm_model,
          provider_settings.realtime_provider,
          provider_settings.realtime_base_url,
          provider_settings.realtime_api_key,
          provider_settings.stt_provider,
          provider_settings.stt_base_url,
          provider_settings.stt_api_key,
          provider_settings.stt_model,
          provider_settings.tts_provider, provider_settings.tts_base_url, provider_settings.tts_api_key, provider_settings.tts_model,
          assistants.engine,
          assistants.realtime_model,
          assistants.realtime_voice
         FROM assistants
         LEFT JOIN provider_settings ON provider_settings.business_id = assistants.business_id
         WHERE assistants.id = ? AND assistants.business_id = ?`
      )
        .bind(assistantId, businessId)
        .first<AgentSettings>();
      this.knowledge = await loadCallKnowledge(this.env.DB, assistantId, businessId);
    }
    // Compatibility for a call row created before 0008 or during a mixed-version
    // rollout. Migration 0008 backfills assistant_id, but an old worker can
    // still insert a NULL until the new worker takes traffic.
    if (!this.settings) {
      this.settings = await this.env.DB.prepare('SELECT * FROM agent_settings WHERE business_id = ?')
        .bind(businessId)
        .first<AgentSettings>();
      const workspace = await this.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?')
        .bind(businessId).first<ProviderSettings>();
      if (this.settings && workspace) {
        this.settings = { ...this.settings,
          llm_base_url: workspace.llm_base_url,
          llm_api_key: workspace.llm_api_key,
          llm_model: this.settings.llm_model || workspace.llm_model || '',
          realtime_provider: workspace.realtime_provider,
          realtime_base_url: workspace.realtime_base_url,
          realtime_api_key: workspace.realtime_api_key,
          stt_provider: workspace.stt_provider, stt_base_url: workspace.stt_base_url,
          stt_api_key: workspace.stt_api_key, stt_model: workspace.stt_model,
          tts_provider: workspace.tts_provider, tts_base_url: workspace.tts_base_url, tts_api_key: workspace.tts_api_key, tts_model: workspace.tts_model,
        };
      }
      this.knowledge = undefined;
    }
  }

  private async loadCall(): Promise<void> {
    const call = await this.env.DB.prepare('SELECT id, business_id, assistant_id, status, started_at, channel, environment FROM calls WHERE id = ?')
      .bind(this.callId)
      .first<CallRow>();
    if (!call || call.status !== 'active') throw new Error('call not found or not active');
    const budget = await this.env.DB.prepare('SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS bytes FROM call_turns WHERE call_id = ?')
      .bind(this.callId).first<{ bytes: number }>();
    this.persistedTranscriptBytes = budget?.bytes ?? 0;
    if (!this.debug && this.env.TEST_CALL_DEBUG === 'true' && (call as CallRow & { environment?: string }).environment === 'test' && call.channel === 'web') {
      this.debug = await CallDebug.start(this.state, this.callId);
      this.debug?.event('start', { release: this.env.OPENFON_RELEASE_SHA || 'development' });
    }
    // Persisted admission decides capabilities; a client cannot opt into another
    // channel using a query parameter or WebSocket message.
    this.requiresCarrierAudio = call.channel === 'telnyx' || call.channel === 'asterisk';
    this.biz = await this.env.DB.prepare('SELECT * FROM businesses WHERE id = ?')
      .bind(call.business_id)
      .first<Business>();
    await this.loadSettings(call.business_id, call.assistant_id);
    if (!this.biz || !this.settings) throw new Error('business not configured');
  }

  private async onMessage(ev: MessageEvent): Promise<void> {
    if (this.ended) return;
    this.lastActivity = Date.now(); // feeds the idle watchdog
    if (typeof ev.data !== 'string') {
      const audio = await toArrayBuffer(ev.data);
      if (this.closingTimeline || this.nativeGreeting) {
        this.debug?.audio('caller', audio, this.mode === 'realtime' ? 'pcm_s16le_24000' : this.pendingContentType, { forwarded: false });
        return;
      }
      if (this.mode === 'realtime') {
        // While typed text is being spoken into the session it is the caller's
        // audio; one input stream cannot carry both.
        const forwarded = this.gptLive ? !this.typedAudio.length && this.gptLive.appendAudio(audio)
          : this.sendUpstream({ type: 'input_audio_buffer.append', audio: b64encode(audio) });
        this.debug?.audio('caller', audio, 'pcm_s16le_24000', { forwarded });
      } else {
        this.debug?.audio('caller_utterance', audio, this.pendingContentType, { admitted: !this.busy });
        await this.handleUtterance(audio);
      }
      return;
    }
    const msg = JSON.parse(ev.data) as { event?: unknown; audio?: string; type: string; text?: string; contentType?: string; id?: unknown };
    if (this.debug && !['audio_received', 'debug', 'debug_audio'].includes(msg.type)) this.debug.event('caller_control', { type: msg.type });
    switch (msg.type) {
      case 'debug': {
        const event = debugClientEvent(msg.event);
        if (this.debug && event) {
          if (event.name === 'capture_gap') this.debug.meta.partial = true;
          this.debug.event('browser', event);
        }
        break;
      }
      case 'debug_audio':
        if (this.debug && this.mode === 'pipeline' && typeof msg.audio === 'string' && msg.audio.length <= 16_384) {
          try { this.debug.audio('microphone', decodeRealtimeAudio(msg.audio), 'pcm_s16le_24000'); } catch { /* invalid diagnostics do not fail calls */ }
        }
        break;
      case 'playback_complete':
      case 'playback_failed':
        if (!this.endingSent || !this.playbackId || msg.id !== this.playbackId) break;
        if (Date.now() >= this.closingTimeline!.serverDrainedAt! + 25_000 || Date.now() >= this.closingTimeline!.requestedAt + 90_000) {
          this.closingTimeline!.result = 'playback_timeout'; await this.finalize(); break;
        }
        this.closingTimeline!.result = msg.type === 'playback_complete' ? 'playback_complete' : 'playback_failed';
        if (msg.type === 'playback_complete') this.closingTimeline!.playbackCompletedAt = Date.now();
        await this.finalize();
        break;
      case 'audio_received':
        try {
          this.audioReceipts.acknowledge(msg.id, Date.now());
          this.armAudioReceiptDeadline();
        } catch (error) { this.failRealtimeOutput(error); }
        break;
      case 'start':
        await this.handleStart();
        break;
      case 'text':
        if (this.closingTimeline) break;
        if (msg.text?.trim()) {
          if (this.mode === 'realtime') this.sendCallerText(msg.text.trim());
          else await this.respond(msg.text.trim());
        }
        break;
      case 'hangup':
        if (this.closingTimeline) this.closingTimeline.result ??= 'caller_or_legacy_hangup';
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
    this.send({ type: 'ready', language: this.lang, debugRecording: Boolean(this.debug), ...payload, ...(payload.mode === 'realtime' ? { audioReceipts: true } : {}) });
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
      if (this.settings?.engine === 'realtime') this.resolveRealtimeConfig();
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
    if (this.requiresCarrierAudio && this.settings!.engine !== 'realtime') {
      await this.failCarrierAudio('Telephone calls require a realtime assistant.');
      return;
    }
    // Armed only once the call is actually going ahead — nothing to watch over
    // a call that is being torn down at pickup.
    await this.armWatchdog();
    if (this.ended) return;
    this.lang = this.settings!.language in SUPPORTED_LANGUAGES ? this.settings!.language : 'en';
    const greeting = defaultGreeting(this.biz!, this.settings!);
    const systemPrompt = buildSystemPrompt(this.biz!, this.settings!, new Date(), this.knowledge);
    this.debug?.event('configuration', { engine: this.settings!.engine, language: this.lang, prompt: systemPrompt,
      llmModel: this.settings!.llm_model || this.env.DEFAULT_LLM_MODEL, sttModel: this.settings!.stt_model || this.env.DEFAULT_STT_MODEL,
      ttsProvider: this.settings!.tts_provider || this.env.DEFAULT_TTS_PROVIDER, voice: this.settings!.voice,
      realtimeModel: this.settings!.realtime_model || this.env.REALTIME_MODEL, realtimeVoice: this.settings!.realtime_voice });

    if (this.settings!.engine === 'realtime') {
      this.history = [{ role: 'system', content: systemPrompt }];
      if (this.requiresCarrierAudio && this.engineGreets()) {
        let resolve!: (ok: boolean) => void;
        const ready = new Promise<boolean>(done => { resolve = done; });
        this.nativeGreeting = { ready, resolve, frames: [], bytes: 0, failed: false };
      }
      const ok = await this.startRealtime(systemPrompt, greeting).catch((err) => {
        console.error('realtime engine startup failed: provider details redacted');
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
          const ttsMode = this.env.DEFAULT_TTS_PROVIDER === 'azure' && this.env.AZURE_SPEECH_KEY ? 'server' : 'browser';
          const pending = this.nativeGreeting;
          if (pending) {
            // Config acknowledgement is not evidence of generated greeting
            // audio. Bound the wait; hangup also wakes it through closeUpstream.
            const timer = setTimeout(() => pending.resolve(false), 5000);
            const hasAudio = await pending.ready;
            clearTimeout(timer);
            this.nativeGreeting = null;
            if (this.ended) return;
            if (!hasAudio || pending.failed) {
              await this.failCarrierAudio('The realtime provider did not produce usable greeting audio.');
              return;
            }
            // The carrier releases buffered input on ready. Queue the first
            // PCM immediately afterward, with no await or event-loop gap.
            this.sendReady({ mode: 'realtime', ttsMode, greeting: '', engine: engineLabel });
            try { for (const audio of pending.frames) this.sendRealtimeAudio(audio); }
            catch (error) { this.failRealtimeOutput(error); }
          } else {
            this.sendReady({ mode: 'realtime', ttsMode, greeting: '', engine: engineLabel });
          }
          return;
        }
        if (this.requiresCarrierAudio && !(this.env.DEFAULT_TTS_PROVIDER === 'azure' && this.env.AZURE_SPEECH_KEY)) {
          await this.failCarrierAudio('This realtime tier requires server speech synthesis for telephone greetings.');
          return;
        }
        this.reserveTranscript(greeting);
        this.history = [
          { role: 'system', content: systemPrompt },
          { role: 'assistant', content: greeting },
        ];
        const ttsMode = this.env.DEFAULT_TTS_PROVIDER === 'azure' && this.env.AZURE_SPEECH_KEY ? 'server' : 'browser';
        if (!this.requiresCarrierAudio) this.sendReady({ mode: 'realtime', ttsMode, greeting, engine: engineLabel });
        await this.saveTurn('agent', greeting);
        // The greeting is ours, not the model's: synthesize it deterministically
        // and stream it as PCM so it matches the realtime audio path.
        const voice = voiceForReply(this.env, this.lang, this.settings!.language, this.settings!.voice || '');
        const audio = await synthesize(this.env, greeting, voice, 'pcm24');
        if (this.ended) return; // caller hung up while synthesis was pending
        // Carrier adapters admit one PCM24 frame of at most ten seconds.
        // Reject before ready instead of releasing input or bursting split
        // frames into their bounded playback queues. Browser audio is unchanged.
        if (this.requiresCarrierAudio && audio &&
          (audio.byteLength > MAX_REALTIME_AUDIO_BYTES || audio.byteLength % 2 !== 0)) {
          await this.failCarrierAudio('Telephone greeting audio must be valid PCM and no longer than 10 seconds. Shorten the greeting and retry.');
          return;
        }
        if (this.requiresCarrierAudio && !audio?.byteLength) {
          await this.failCarrierAudio('Telephone greeting audio could not be generated.');
          return;
        }
        // The carrier bridge releases buffered input on ready. Queue ready and
        // greeting PCM in the same turn, only after synthesis succeeds, so no
        // caller response can overtake the greeting during the awaited work.
        if (this.requiresCarrierAudio) this.sendReady({ mode: 'realtime', ttsMode, greeting, engine: engineLabel });
        if (audio && this.ws) {
          // PCM16 @ 24 kHz = 48000 bytes/s; shield the greeting from
          // noise-triggered barge-in flushes for its playback duration.
          this.greetingGuardUntil = Date.now() + (audio.byteLength / 48000) * 1000 + 500;
          try {
            this.sendRealtimeAudio(audio);
          } catch (error) {
            this.failRealtimeOutput(error);
          }
        }
        return;
      }
    }

    if (this.settings?.engine === 'realtime' || this.requiresCarrierAudio || this.realtimeConfig?.protocol === 'openai') {
      await this.failCarrierAudio('The realtime provider could not start this call.');
      return;
    }
    this.mode = 'pipeline';
    this.reserveTranscript(greeting);
    this.history = [
      {
        role: 'system',
        // Pipeline only: we strip the marker before TTS, so it is never spoken.
        content: `${systemPrompt}\n- When the conversation is finished and you have said your goodbye, append the marker <END_CALL> at the very end of your reply.`,
      },
      { role: 'assistant', content: greeting },
    ];
    const ttsMode = speechConfig(this.env, this.settings).provider !== 'browser' ? 'server' : 'browser';
    this.sendReady({
      mode: 'pipeline',
      ttsMode,
      greeting,
      engine: `pipeline · ${resolveLlm(this.env, this.settings).model}`,
    });
    await this.saveTurn('agent', greeting);
    await this.speak(greeting);
  }

  private async failCarrierAudio(reason: string): Promise<void> {
    this.failure = reason;
    this.sendError(this.requiresCarrierAudio ? 'Telephone audio is unavailable.' : 'Realtime audio is unavailable.');
    await this.finalize();
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

  private sendUpstream(obj: unknown, target: WebSocket | null = this.upstream): boolean {
    try {
      if (!target) return false;
      target.send(JSON.stringify(obj));
      if (this.debug) {
        const v = obj as { type: string; session?: { instructions?: string; audio?: unknown } };
        if (v.type === 'session.update') this.debug.event('session', { socket: this.debug.socket(target), session: v.session });
        else if (v.type !== 'input_audio_buffer.append') this.debug.event('upstream_send', { type: v.type, socket: this.debug.socket(target) });
      }
      return true;
    } catch { return false; }
  }

  private cancelResponse(from: WebSocket): void {
    if (from.readyState !== WS_OPEN) return;
    const pending = this.cancelRequests.get(from) ?? new Map<string, number>();
    for (const [id, until] of pending) if (until <= Date.now()) pending.delete(id);
    while (pending.size >= 4) pending.delete(pending.keys().next().value!);
    const eventId = crypto.randomUUID();
    pending.set(eventId, Date.now() + 10_000);
    this.cancelRequests.set(from, pending);
    this.sendUpstream({ type: 'response.cancel', event_id: eventId }, from);
  }

  private consumeCancelRace(error: UpstreamMessage['error'], from: WebSocket): boolean {
    if (error?.type !== 'invalid_request_error' || error.code !== 'response_cancel_not_active' ||
      typeof error.event_id !== 'string' || error.event_id.length > 128) return false;
    const pending = this.cancelRequests.get(from);
    const until = pending?.get(error.event_id);
    pending?.delete(error.event_id); // one acknowledgement, never a reusable exemption
    return until !== undefined && until > Date.now();
  }

  private closeUpstream(): void {
    this.typedAudio = [];
    if (this.typedTimer !== undefined) clearTimeout(this.typedTimer);
    this.typedTimer = undefined;
    this.gptLive?.close();
    this.clearRealtimeQueue();
    for (const timer of [this.closingTimer, this.generationTimer, this.playbackTimer]) if (timer !== undefined) clearTimeout(timer);
    this.closingTimer = this.generationTimer = this.playbackTimer = undefined;
    if (this.audioReceiptTimer !== undefined) clearTimeout(this.audioReceiptTimer);
    this.audioReceiptTimer = undefined;
    this.audioReceipts.clear();
    this.nativeGreeting?.resolve(false);
    this.nativeGreeting = null;
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
  private realtimeOutputBudget = new RealtimeOutputBudget(Date.now());
  private audioQueue = new RealtimeAudioQueue(Date.now());
  private audioQueueTimer: ReturnType<typeof setTimeout> | undefined;
  private hangupAfterQueue = false;
  private closingGuard = new RealtimeClosingGuard();
  private closingSource: WebSocket | undefined;
  private closingToolCall: string | undefined;
  private closingTimer: ReturnType<typeof setTimeout> | undefined;
  private generationTimer: ReturnType<typeof setTimeout> | undefined;
  private playbackTimer: ReturnType<typeof setTimeout> | undefined;
  private playbackId: string | undefined;
  private closingLogged = false;
  private closingTimeline: { trigger: string; requestedAt: number; generationRequestedAt?: number;
    generationCompletedAt?: number; serverDrainedAt?: number; playbackCompletedAt?: number;
    endedAt?: number; result?: string } | undefined;
  private speechAbort = new AbortController();
  private transcriptionAbort: AbortController | undefined;
  private audioReceipts = new RealtimeAudioReceipts();
  private audioReceiptTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelRequests = new WeakMap<WebSocket, Map<string, number>>();
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
  private static readonly ENFORCED_SESSION_PATHS = ['audio.input.turn_detection', 'audio.input.format', 'audio.output.format', 'audio.output.voice'];

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
  private static at(obj: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
  }

  // A copy of the payload with these subtrees removed, so "everything else" is
  // a diff over a smaller object rather than a filter over rendered text.
  private static without(obj: SessionConfig, paths: string[]): unknown {
    const copy = structuredClone(obj) as Record<string, unknown>;
    for (const path of paths) {
      const keys = path.split('.');
      const leaf = keys.pop() as string;
      const parent = keys.length ? CallSession.at(copy, keys.join('.')) : copy;
      if (parent && typeof parent === 'object') delete (parent as Record<string, unknown>)[leaf];
    }
    return copy;
  }

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

    // Everything we asked for is compared. The enforced subtrees are the ones
    // worth re-sending for; the rest is reported so a silent substitution is at
    // least a visible one. **Both sets are computed structurally, by diffing
    // subtrees — never by reading the wording of a divergence back out.**
    //
    // The first version classified by string-matching `diffSession`'s
    // human-readable output against each enforced path, which put a safety
    // decision at the mercy of a display format: change the delimiter after
    // the path and an enforced divergence quietly becomes advisory, skipping
    // the re-send, with a clean log. That is this line's own bug reproduced in
    // a new medium, and the tell was that the matcher needed a clause for
    // `path absent — unverifiable` — it was already leaning on prose.
    //
    // Diffing at each enforced path also keeps the dropped-ancestor case right
    // by construction instead of by special case: if the echo has no `audio`,
    // `at(echoed, 'audio.input.turn_detection')` is undefined, `diffSession`
    // reports it absent, and it lands in the enforced set.
    const enforcedPaths = this.enforcedSessionPaths();
    const enforced = enforcedPaths.flatMap((p) =>
      CallSession.diffSession(CallSession.at(sent, p), CallSession.at(echoed, p), `session.${p}`)
    );
    const advisory = CallSession.diffSession(CallSession.without(sent, enforcedPaths), echoed, 'session');
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
        ...(this.realtimeConfig?.protocol === 'openai' ? { output_modalities: ['audio'] } : {}),
        instructions,
        ...(this.toolsSupported()
          ? {
              tools: [
                {
                  type: 'function',
                  name: 'end_call',
                  description: 'Request call closure after a brief spoken goodbye. OpenFon waits for the response and playback to finish before hanging up.',
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
            turn_detection: this.realtimeConfig?.protocol === 'openai' ? SERVER_VAD : turnDetectionFor(this.realtimeModel),
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
              model: (this.realtimeConfig && realtimeCapabilities(this.realtimeConfig).transcriptionModel) || (this.realtimeModel.startsWith('gpt-realtime') ? 'whisper-1' : this.env.DEFAULT_STT_MODEL),
              // Not sent on HD, where it cannot take effect: Azure Voice Live
              // answers `prompt is not yet supported for azure-speech`, and its
              // transcription config is latched by the first `session.update`
              // of the session, which the gateway spends on its own default.
              // Sending it anyway would only produce an advisory line on every
              // HD call about a field nobody can apply. If Kataleptic stops
              // spending that first update, this can go back to unconditional —
              // and `phrase_list` becomes the supported spelling of it there.
              ...(this.realtimeConfig?.protocol !== 'openai' && this.realtimeModel === 'kataleptic-realtime-hd' ? {} : { prompt: this.biz && this.settings ? sttVocab(this.biz, this.settings, this.knowledge) : undefined }),
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
  private realtimeConfig: RealtimeConfig | null = null;
  private outputAudio: { socket: WebSocket; itemId: string; contentIndex: number; startedAt: number; bytes: number } | null = null;

  private resolveRealtimeConfig(): RealtimeConfig {
    const config = this.realtimeConfig = resolveRealtime(this.env, this.settings);
    if (config.retiredModel) console.log(`call ${this.callId}: retired realtime model ${config.retiredModel} served on ${config.model}`);
    if (this.settings?.realtime_voice && !liveRealtimeVoice(config, this.settings.realtime_voice)) {
      // A voice chosen for the retired cascade means nothing now: let the tier manage it.
      this.settings = { ...this.settings, realtime_voice: '' };
    }
    return config;
  }

  private engineGreets(): boolean {
    // An explicitly selected realtime voice must also speak the greeting.
    // Instance Azure/browser synthesis could otherwise substitute another voice.
    if (this.settings?.realtime_voice) return true;
    if (this.realtimeConfig) return realtimeCapabilities(this.realtimeConfig).engineGreeting;
    return this.realtimeModel.startsWith('gpt-realtime');
  }

  // Every tier accepts the tool. None of them reliably calls it: measured over
  // 33 goodbye turns per engine, the agent invoked `end_call` on 23-25 of them,
  // with no meaningful spread between engines — and on one scenario it fired
  // 1 time in 15 after capturing every detail correctly
  // (docs/research/voice-engine-quality-2026-08.md, scoring-defects section).
  // Track B counts only the 9 scored scenarios (17-19/27); the 23-25/33
  // figure includes every goodbye turn. These are different denominators.
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

  private startClosing(trigger: string): void {
    if (this.closingTimeline) return;
    this.closingTimeline = { trigger, requestedAt: Date.now() };
    console.info(JSON.stringify({ event: 'call_closing_requested', callId: this.callId, trigger, at: Date.now() }));
    this.closingTimer = setTimeout(() => {
      if (this.closingTimeline) this.closingTimeline.result = 'closing_timeout';
      void this.finalize();
    }, 90_000);
  }

  private generationDeadline(): void {
    if (this.generationTimer !== undefined) clearTimeout(this.generationTimer);
    this.generationTimer = setTimeout(() => {
      if (this.closingTimeline) this.closingTimeline.result = 'generation_timeout';
      void this.finalize();
    }, 30_000);
  }

  private requestRealtimeHangup(msg: UpstreamMessage, source: WebSocket): void {
    if (this.ended || this.endingSent) return;
    const callId = msg.call_id ?? msg.item?.call_id;
    if (!this.closingToolCall && typeof callId === 'string' && callId.length <= 128) this.closingToolCall = callId;
    if (!this.closingGuard.requested) {
      this.startClosing(msg.name === 'end_call' || msg.item?.name === 'end_call' ? 'model_tool' : 'caller_farewell');
      this.closingSource = source;
      this.closingGuard.request(source, msg.response_id);
      this.generationDeadline();
    }
    this.advanceClosing();
  }

  private advanceClosing(): void {
    if (this.ended) return;
    const action = this.closingGuard.advance();
    if (action === 'generate') {
      this.closingTimeline!.generationRequestedAt = Date.now();
      this.generationDeadline();
      if (this.closingToolCall) this.sendUpstream({ type: 'conversation.item.create', item: {
        type: 'function_call_output', call_id: this.closingToolCall,
        output: 'Closing requested. Say a brief polite goodbye before disconnecting.',
      } }, this.closingSource ?? this.upstream);
      this.sendUpstream({ type: 'response.create', response: {
        instructions: 'The conversation is finished. Say one short, polite goodbye in the language of the most recent caller message. Do not ask questions, add business facts, or call any tools.',
        tool_choice: 'none',
      } }, this.closingSource ?? this.upstream);
    } else if (action === 'ready') {
      if (this.generationTimer !== undefined) clearTimeout(this.generationTimer);
      this.generationTimer = undefined;
      this.closingTimeline!.generationCompletedAt = Date.now();
      this.beginHangup();
    } else if (action === 'failed') {
      this.closingTimeline!.result = 'farewell_unavailable';
      void this.finalize();
    }
  }

  private beginHangup(): void {
    if (this.ended || this.endingSent) return;
    this.startClosing(this.mode === 'pipeline' ? 'pipeline' : 'turn_limit');
    if (this.audioQueue.pending) { this.hangupAfterQueue = true; return; }
    this.hangupAfterQueue = false;
    this.endingSent = true;
    this.closingTimeline!.serverDrainedAt = Date.now();
    this.playbackId = crypto.randomUUID();
    this.send({ type: 'ending', id: this.playbackId });
    // An acknowledgement is browser completion or carrier mark drainage, never
    // a claim that a human heard the audio. Legacy clients may still hang up.
    this.playbackTimer = setTimeout(() => {
      this.closingTimeline!.result = 'playback_timeout';
      void this.finalize();
    }, 25_000);
  }

  private async startRealtime(systemPrompt: string, greeting: string): Promise<boolean> {
    this.realtimeConfig ??= this.resolveRealtimeConfig();
    if (isGptLiveModel(this.realtimeConfig.model)) return this.startGptLive(systemPrompt, greeting);
    const model = this.realtimeConfig.model;
    this.realtimeModel = model;
    console.log(`call ${this.callId}: realtime engine, model ${model}`);
    const isHd = realtimeCapabilities(this.realtimeConfig).managedVoice;
    // Explicit per-business realtime voice wins; on the Azure-backed HD tier we
    // manage the voice (matches the synthesized greeting); native S2S tiers
    // pick their own.
    this.voiceManaged = isHd && !this.settings?.realtime_voice;
    this.sessionVoice =
      this.settings?.realtime_voice ||
      (isHd
        ? voiceForReply(this.env, this.lang, this.settings?.language ?? 'en', this.settings?.voice || '')
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
  private async openUpstream(instructions: string | (() => string), greetWith: string | null): Promise<boolean> {
    const config = this.realtimeConfig ?? resolveRealtime(this.env, this.settings);
    const connection = realtimeConnection({ ...config, model: this.realtimeModel });
    let upgraded: WebSocket | null = null;
    if (connection.headers) {
      this.debug?.event('connect_attempt');
      const controller = new AbortController();
      const connectTimer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(connection.url, {
          headers: connection.headers, redirect: 'manual', signal: controller.signal,
        });
        if (response.status !== 101 || !response.webSocket) { this.debug?.event('connect_rejected', { status: response.status }); return false; }
        upgraded = response.webSocket;
      } catch { this.debug?.event('connect_failed'); return false; }
      finally {
        // workerd keeps the request signal attached to the upgraded socket.
        // The deadline bounds connection setup, not the lifetime of the call.
        clearTimeout(connectTimer);
      }
    }
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
        ws = upgraded ?? new WebSocket(connection.url);
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
        this.debug?.event('handshake_timeout', { socket: this.debug.socket(ws) });
        abandoned = true;
        this.abandonUpstream(ws);
        settle(false);
      }, 5000);
      const ready = () => {
        if (abandoned || opened) return;
        if (this.closingTimeline) { abandoned = true; clearTimeout(timer); this.abandonUpstream(ws); settle(false); return; }
        clearTimeout(timer);
        opened = true;
        this.debug?.event('upstream_ready', { socket: this.debug.socket(ws) });
        this.upstream = ws;
        if (greetWith) this.sendUpstream({
          type: 'response.create',
          response: { instructions: `Greet the caller by saying exactly this, then wait for them to speak: "${greetWith}"` },
        }, ws);
        settle(true);
      };
      // A native voice can become immutable after its first audio. Confirm an
      // explicit selection before generation or handover to a rotated socket.
      const confirmVoice = config.protocol === 'gateway' && Boolean(this.settings?.realtime_voice);
      let configured = false;
      const onOpen = () => {
        if (abandoned || configured) return;
        if (this.closingTimeline) { abandoned = true; clearTimeout(timer); this.abandonUpstream(ws); settle(false); return; }
        configured = true;
        // Snapshot now, not at dial time. The outgoing connection stayed live
        // through the connect window, so `history` may have gained turns since
        // — and taking it before we route means the replacement is briefed on
        // everything that happened up to the moment it takes over.
        const briefing = typeof instructions === 'function' ? instructions() : instructions;
        if (config.protocol === 'gateway' && !confirmVoice) this.upstream = ws;
        this.sendSessionUpdate(this.sessionVoice, briefing, ws);
        if (config.protocol === 'gateway' && !confirmVoice) ready();
      };
      ws.addEventListener('open', onOpen);
      const rejectMessage = () => {
        abandoned = true; clearTimeout(timer);
        if (opened) {
          this.readableUpstreams.delete(ws);
          this.failInternally(new RealtimeInputError());
          this.abandonUpstream(ws);
        }
        else this.abandonUpstream(ws);
        settle(false);
      };
      ws.addEventListener('message', (ev) => {
        if (!this.readableUpstreams.has(ws)) return; // abandoned or rotated out
        let event: UpstreamMessage;
        try { event = parseRealtimeMessage(ev.data) as unknown as UpstreamMessage; }
        catch { this.debug?.event('provider_parse_error'); rejectMessage(); return; }
        if (!event.type.endsWith('.delta')) this.debug?.event('provider', { ...debugProviderEvent(event), socket: this.debug.socket(ws) });
        if (config.protocol === 'openai' && !opened) {
          try {
            if (event.type === 'error') {
              abandoned = true; clearTimeout(timer); this.abandonUpstream(ws); settle(false); return;
            }
            if (event.type === 'session.updated' && event.session?.instructions === this.sessionState.get(ws)?.sent.instructions) {
              const differences = CallSession.diffSession(this.sessionState.get(ws)?.sent, event.session, 'session');
              if (differences.length) {
                // A direct provider must confirm the actual requested format,
                // transcription and tools before we tell a telephone caller ready.
                abandoned = true; clearTimeout(timer); this.abandonUpstream(ws); settle(false); return;
              }
              ready();
            }
          } catch { /* malformed events are handled below without logging their payload */ }
        }
        if (confirmVoice && !opened) {
          if (event.type === 'error') { abandoned = true; clearTimeout(timer); this.abandonUpstream(ws); settle(false); return; }
          const sent = this.sessionState.get(ws)?.sent;
          if (event.type === 'session.updated' && sent && event.session?.instructions === sent.instructions) {
            if (CallSession.at(event.session, 'audio.output.voice') === CallSession.at(sent, 'audio.output.voice')) ready();
            else this.checkSessionEcho(event.session, ws);
          }
        }
        // This socket is readable for handshake events while pending, but
        // application output must remain inert until its own configuration is
        // confirmed. The acknowledged old socket remains live during rotation.
        if ((config.protocol === 'openai' || confirmVoice) && !opened) return;
        this.onUpstreamMessage(event, ws).catch(error => {
          if (error instanceof RealtimeInputError) rejectMessage();
          else console.error('upstream handler error: provider response redacted');
        });
      });
      ws.addEventListener('error', () => {
        this.debug?.event('upstream_error', { socket: this.debug.socket(ws) });
        clearTimeout(timer);
        // Only discard a connection that never became usable. WebSockets
        // routinely emit `error` immediately before `close`, and `close` is
        // what triggers recovery — dropping it here would make the close
        // listener's ownership guard false and silently kill the reconnect.
        if (!opened) this.abandonUpstream(ws);
        settle(false);
      });
      ws.addEventListener('close', (event) => {
        this.debug?.event('upstream_close', { socket: this.debug.socket(ws), code: event.code, clean: event.wasClean });
        clearTimeout(timer);
        this.readableUpstreams.delete(ws);
        settle(false);
        if (this.nativeGreeting) { this.nativeGreeting.failed = true; this.nativeGreeting.resolve(false); return; }
        if (this.mode === 'realtime' && !this.ended && this.upstream === ws) {
          this.upstream = null;
          if (this.closingTimeline) {
            if (!this.closingTimeline.generationCompletedAt) {
              this.closingTimeline.result = 'provider_disconnect';
              void this.finalize();
            }
          } else void this.recoverUpstream();
        }
      });
      if (upgraded) { ws.accept(); onOpen(); }
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
    while (!this.ended && !this.closingTimeline) {
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
      this.debug?.event('recovery_attempt', { total: this.totalReconnects });
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

  private failRealtimeOutput(error?: unknown): void {
    // finalize() gates the call immediately but defers its body to claim its
    // single-flight slot. Stop provider ingress now, before another queued
    // event can even parse, while preserving that finalizer's D1 ordering.
    this.failInternally(error instanceof RealtimeOutputError ? error
      : new RealtimeOutputError(error instanceof RealtimeInputError ? 'invalid_audio' : 'transport'));
    this.closeUpstream();
  }

  private armAudioReceiptDeadline(): void {
    if (this.audioReceiptTimer !== undefined) clearTimeout(this.audioReceiptTimer);
    this.audioReceiptTimer = undefined;
    const deadline = this.audioReceipts.deadline;
    if (deadline === undefined || this.ended) return;
    this.audioReceiptTimer = setTimeout(() => {
      this.audioReceiptTimer = undefined;
      if (!this.ended) this.failRealtimeOutput(new RealtimeOutputError('receipt_timeout'));
    }, Math.max(0, deadline - Date.now()));
  }

  private checkAudioReceiver(bytes: number, additionalFrames = 0): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) throw new RealtimeOutputError('receiver_closed');
    // Useful on runtimes exposing it, but never our Workers safety boundary:
    // the unacknowledged byte/frame window is enforced even when absent.
    const buffered = (this.ws as WebSocket & { bufferedAmount?: number }).bufferedAmount;
    if (buffered !== undefined && (!Number.isFinite(buffered) || buffered < 0 ||
        buffered + bytes > MAX_UNRECEIVED_AUDIO_BYTES)) throw new RealtimeOutputError('receiver_buffer');
    this.audioReceipts.check(bytes, additionalFrames);
  }

  private clearRealtimeQueue(): void {
    if (this.audioQueueTimer !== undefined) clearTimeout(this.audioQueueTimer);
    this.audioQueueTimer = undefined;
    this.audioQueue.clear();
  }

  private sendRealtimeAudio(audio: ArrayBuffer): void {
    this.audioQueue.push(audio);
    this.drainRealtimeQueue();
  }

  private drainRealtimeQueue(): void {
    if (this.ended) return;
    if (this.audioQueueTimer !== undefined) clearTimeout(this.audioQueueTimer);
    this.audioQueueTimer = undefined;
    try {
      let audio: ArrayBuffer | undefined;
      while ((audio = this.audioQueue.take(Date.now())) !== undefined) this.deliverRealtimeAudio(audio);
      if (this.audioQueue.pending) {
        this.audioQueueTimer = setTimeout(() => this.drainRealtimeQueue(), 100);
      } else if (this.hangupAfterQueue) this.beginHangup();
    } catch (error) { this.failRealtimeOutput(error); }
  }

  private deliverRealtimeAudio(audio: ArrayBuffer): void {
    if (!audio.byteLength) return;
    this.checkAudioReceiver(audio.byteLength);
    const id = this.audioReceipts.sent(audio.byteLength, Date.now());
    // Ordered marker follows exactly one admitted binary frame. A recipient
    // cannot know this unpredictable ID until it consumes the preceding bytes.
    this.ws!.send(audio);
    this.debug?.audio('agent', audio, 'pcm_s16le_24000');
    this.ws!.send(JSON.stringify({ type: 'audio_receipt', id, bytes: audio.byteLength }));
    this.armAudioReceiptDeadline();
  }

  private sendRealtimeControl(value: { type: string; who?: string }): boolean {
    if (this.ended) return false;
    try {
      this.realtimeOutputBudget.control(Date.now());
      if (value.type === 'flush') {
        this.clearRealtimeQueue();
        this.hangupAfterQueue = false;
      }
      const wire = JSON.stringify(value);
      const bytes = new TextEncoder().encode(wire).byteLength;
      this.checkAudioReceiver(bytes);
      const id = this.audioReceipts.sent(bytes, Date.now());
      this.ws!.send(wire);
      this.debug?.event('caller_control_sent', { type: value.type, who: value.who });
      this.ws!.send(JSON.stringify({ type: 'control_receipt', id }));
      this.armAudioReceiptDeadline();
      return true;
    } catch (error) {
      this.failRealtimeOutput(error);
      return false;
    }
  }

  private receiveRealtimeAudio(msg: UpstreamMessage, from: WebSocket): void {
    if (this.ended || !this.ws) return;
    try {
      // Admission is synchronous and precedes atob/PCM allocation. Do not let
      // an async rejection microtask leave the rest of a same-turn burst live.
      const bytes = this.realtimeOutputBudget.reserve(msg.delta ?? '', Date.now(), from, msg.response_id);
      this.audioQueue.check(bytes);
      this.checkAudioReceiver(Math.min(bytes, 24000) + (this.nativeGreeting?.bytes ?? 0), this.nativeGreeting?.frames.length ?? 0);
      if (!msg.delta) return;
      const audio = decodeRealtimeAudio(msg.delta);
      this.closingGuard.audio(from, msg.response_id, audio.byteLength);
      if (this.realtimeConfig?.protocol === 'openai' && msg.item_id) {
        if (this.outputAudio?.itemId !== msg.item_id || this.outputAudio.socket !== from) {
          this.outputAudio = { socket: from, itemId: msg.item_id, contentIndex: msg.content_index ?? 0, startedAt: Date.now(), bytes: 0 };
        }
        this.outputAudio.bytes += audio.byteLength;
      }
      const pending = this.nativeGreeting;
      if (pending) {
        if (!audio.byteLength || audio.byteLength % 2) return;
        if (pending.bytes + audio.byteLength > MAX_REALTIME_AUDIO_BYTES) {
          pending.failed = true; pending.resolve(false); return;
        }
        pending.frames.push(audio); pending.bytes += audio.byteLength;
        pending.resolve(true);
      } else this.sendRealtimeAudio(audio);
    } catch (error) {
      // Never reflect socket/provider exception text. This closes every readable
      // upstream and the caller synchronously through the existing finalizer.
      this.failRealtimeOutput(error);
    }
  }

  private async onUpstreamMessage(msg: UpstreamMessage, from: WebSocket): Promise<void> {
    if (this.ended) return;
    const responseId = msg.response_id ?? msg.response?.id;
    if (msg.type.startsWith('response.') && !this.closingGuard.accepts(from, responseId)) return;
    switch (msg.type) {
      case 'response.created':
        this.closingGuard.created(from, responseId);
        break;
      case 'response.output_audio.delta':
        this.receiveRealtimeAudio(msg, from);
        break;
      case 'response.done':
        this.realtimeOutputBudget.responseDone(from, msg.response?.id);
        this.closingGuard.done(from, msg.response?.id, msg.response?.status);
        this.advanceClosing();
        break;
      case 'input_audio_buffer.speech_started':
        if (this.closingGuard.requested) break;
        this.closingGuard.startTurn(from);
        // Barge-in: the server cancels its in-flight response; we flush caller
        // playback — except while our own greeting is playing, where a noise
        // blip would cut off the agent's opening line for nothing.
        if (this.nativeGreeting || Date.now() < this.greetingGuardUntil) break;
        if (!this.sendRealtimeControl({ type: 'flush' })) break;
        if (this.realtimeConfig?.protocol === 'openai' && this.outputAudio?.socket === from) {
          const output = this.outputAudio;
          // The media contract has no per-item playback acknowledgements. Use
          // elapsed delivery time capped at emitted PCM duration; this is an
          // estimate, not a claim of exact handset/browser playback position.
          const audioEndMs = Math.max(0, Math.floor(Math.min(Date.now() - output.startedAt, output.bytes / 48)));
          this.sendUpstream({ type: 'conversation.item.truncate', item_id: output.itemId,
            content_index: output.contentIndex, audio_end_ms: audioEndMs }, from);
          this.outputAudio = null;
        }
        this.sendRealtimeControl({ type: 'speaking', who: 'caller' });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript?.trim()) {
          const text = msg.transcript.trim();
          // STT echoes the vocabulary bias prompt back on silence-committed
          // turns; cancel the response it triggered and pretend it never happened.
          const vocab = this.biz && this.settings ? sttVocab(this.biz, this.settings, this.knowledge) : '';
          if (vocab && isVocabEcho(text, vocab)) {
            console.log(`call ${this.callId}: dropped vocab-echo transcript: ${text.slice(0, 80)}`);
            this.cancelResponse(from);
            if (!this.sendRealtimeControl({ type: 'flush' })) break;
            break;
          }
          this.reserveTranscript(text);
          this.history.push({ role: 'user', content: text });
          // Standard tier sends a detected language with each transcript;
          // prefer it over our own text-based heuristic.
          this.maybeSwitchVoice(text, normalizeLang(msg.language));
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
              if (this.endPending && !this.ended) this.requestRealtimeHangup({ type: 'caller_farewell' }, from);
            }, 8000);
          }
          await this.saveTurn('caller', text);
          if (this.ended) return;
          this.send({ type: 'transcript', text });
        }
        break;
      case 'response.output_audio_transcript.done':
        if (msg.transcript?.trim()) {
          this.closingGuard.transcript(from, msg.response_id, msg.transcript);
          const text = msg.transcript.trim();
          this.reserveTranscript(text);
          this.history.push({ role: 'assistant', content: text });
          await this.saveTurn('agent', text);
          if (this.ended) return;
          this.send({ type: 'agent_text', text });
          if (this.endPending) this.requestRealtimeHangup(msg, from);
        }
        break;
      case 'response.output_item.done':
        if (msg.item?.type === 'function_call' && msg.item?.name === 'end_call') this.requestRealtimeHangup(msg, from);
        break;
      case 'response.function_call_arguments.done':
        // Some paths (e.g. narration-to-call conversion) synthesize only this
        // event without a function_call output item.
        if (msg.name === 'end_call') this.requestRealtimeHangup(msg, from);
        break;
      case 'session.updated':
        // Read back what the service actually applied. Nothing else in the
        // call ever notices a substitution.
        this.checkSessionEcho(msg.session, from);
        break;
      case 'session.expiring':
        if (this.closingTimeline) break;
        // Vendor extension: the engine warns a minute before its hard session
        // cutoff — reconnect proactively instead of dropping mid-sentence.
        console.log(`call ${this.callId}: upstream session expiring, rotating connection`);
        this.reconnects = 0; // each warned rotation gets its own retry budget
        void this.recoverUpstream();
        break;
      case 'error':
        // A cancel can race a response that already ended. Only a recent
        // locally issued cancel on this exact socket can exempt that one code.
        if (this.consumeCancelRace(msg.error, from)) break;
        // Unknown/input/auth/quota/server failures cannot leave a silent call
        // alive. Store only a fixed local reason, never provider fields/URLs.
        this.failInternally(new Error('Realtime provider rejected a request; provider response redacted'));
        this.closeUpstream();
        break;
    }
  }

  // ---- GPT-Live bridge (src/gpt-live.ts) ----
  // A second engine on the same call plumbing: output admission, pacing and
  // receipts, the carrier greeting gate, transcript persistence, the closing
  // timeline and hangup are CallSession's, unchanged. What differs is the wire
  // protocol and that there are no responses, turns or barge-in events to key
  // anything on; the engine derives those from the stream.
  private gptLive: GptLiveEngine | null = null;
  private gptLiveDelegation = '';

  private async startGptLive(systemPrompt: string, greeting: string): Promise<boolean> {
    const config = this.realtimeConfig!;
    this.realtimeModel = config.model;
    console.log(`call ${this.callId}: realtime engine, model ${config.model}`);
    this.voiceManaged = false; // one voice per session; the model follows the caller's language itself
    this.sessionVoice = gptLiveVoice(this.settings?.realtime_voice || '');
    this.realtimeInstructions = `${systemPrompt}\n\nWhen the conversation is finished and you have said goodbye, delegate so the call can be ended.`;
    // The backend answers delegated work. It needs the business facts too, or
    // whatever it hands back for the live model to say is invented.
    this.gptLiveDelegation = 'You handle delegated tasks for a live phone agent. Call end_call once the caller has said goodbye or the conversation is finished. ' +
      `Otherwise answer briefly, using only the business instructions and facts below, and say so when they do not cover the question.\n\n${systemPrompt}`;
    this.gptLive = new GptLiveEngine(config, this.gptLiveHost());
    return this.gptLive.start(this.gptLiveOptions(this.realtimeInstructions, greeting));
  }

  private gptLiveOptions(instructions: string, greeting: string | null): GptLiveSessionOptions {
    return { instructions, greeting, voice: this.sessionVoice,
      delegationModel: this.env.GPT_LIVE_DELEGATION_MODEL || DEFAULT_GPT_LIVE_DELEGATION_MODEL,
      delegationInstructions: this.gptLiveDelegation };
  }

  private gptLiveHost(): GptLiveHost {
    const session = this;
    return {
      get debug() { return session.debug; },
      admitAudio: (encoded, source) => {
        if (this.ended || !this.ws) return null;
        try {
          // Same admission as realtime deltas, charged before decoding.
          const bytes = this.realtimeOutputBudget.reserve(encoded, Date.now(), source);
          this.audioQueue.check(bytes);
          this.checkAudioReceiver(Math.min(bytes, 24000) + (this.nativeGreeting?.bytes ?? 0), this.nativeGreeting?.frames.length ?? 0);
          return decodeRealtimeAudio(encoded);
        } catch (error) { this.failRealtimeOutput(error); return null; }
      },
      // The stream has no response ids. A pause closes the unlabelled segment,
      // so the per-response size cap bounds one stretch of speech, not the call.
      audioPaused: source => this.realtimeOutputBudget.responseDone(source),
      playAudio: audio => {
        // After `ending` the carrier drains only once audio stops arriving.
        if (this.ended || this.endingSent) return;
        const pending = this.nativeGreeting;
        try {
          if (!pending) { this.sendRealtimeAudio(audio); return; }
          if (pending.bytes + audio.byteLength > MAX_REALTIME_AUDIO_BYTES) { pending.failed = true; pending.resolve(false); return; }
          pending.frames.push(audio); pending.bytes += audio.byteLength;
          pending.resolve(true);
        } catch (error) { this.failRealtimeOutput(error); }
      },
      turn: (role, text) => {
        try { this.reserveTranscript(text); }
        catch (error) { if (!this.ended) { this.failInternally(error); this.closeUpstream(); } return; }
        this.history.push({ role: role === 'caller' ? 'user' : 'assistant', content: text });
        if (role === 'caller') this.maybeSwitchVoice(text);
        if (!this.ended) this.send({ type: role === 'caller' ? 'transcript' : 'agent_text', text });
        void this.saveTurn(role, text).catch(error => {
          if (error instanceof RealtimeInputError && !this.ended) { this.failInternally(error); this.closeUpstream(); }
          else console.error(`call ${this.callId}: transcript turn write failed`);
        });
      },
      closeRequested: trigger => {
        if (this.ended || this.endingSent || this.closingTimeline) return;
        this.startClosing(trigger);
        this.generationDeadline();
      },
      readyToHangUp: () => {
        if (this.ended) return;
        if (this.generationTimer !== undefined) clearTimeout(this.generationTimer);
        this.generationTimer = undefined;
        if (this.closingTimeline) this.closingTimeline.generationCompletedAt ??= Date.now();
        this.beginHangup();
      },
      failed: error => {
        if (this.ended) return;
        this.failInternally(error);
        this.closeUpstream();
      },
      disconnected: () => {
        if (this.nativeGreeting) { this.nativeGreeting.failed = true; this.nativeGreeting.resolve(false); return; }
        if (this.ended || this.mode !== 'realtime') return;
        if (this.closingTimeline) {
          if (!this.closingTimeline.generationCompletedAt) {
            this.closingTimeline.result = 'provider_disconnect';
            void this.finalize();
          }
          return;
        }
        void this.recoverGptLive();
      },
    };
  }

  // One replacement session per drop, briefed with the conversation so far,
  // within the same whole-call ceiling as realtime rotations. A session lasts
  // an hour and a call at most thirty minutes, so there is no expiry rotation.
  private recoverGptLive(): Promise<void> {
    this.recovering ??= (async () => {
      if (this.totalReconnects < CallSession.MAX_TOTAL_RECONNECTS) {
        this.totalReconnects++;
        this.debug?.event('recovery_attempt', { total: this.totalReconnects });
        console.log(`call ${this.callId}: GPT-Live session dropped, reconnecting`);
        if (await this.gptLive!.start(this.gptLiveOptions(this.resumeInstructions(), null))) return;
      }
      if (this.ended || this.closingTimeline) return;
      this.failure ??= 'Call failed: the voice engine connection was lost and could not be restored.';
      this.sendError('Voice engine connection lost');
      await this.finalize();
    })().finally(() => { this.recovering = null; });
    return this.recovering;
  }

  // GPT-Live has no user-message item, and appending typed text to its
  // instructions would give whatever a caller types instruction-level
  // authority. It is spoken into the caller's side instead, so it reaches the
  // model with exactly the standing of speech, and its transcript comes back
  // like any other caller turn. That needs server speech synthesis.
  private static readonly MAX_TYPED_CHARS = 500;
  private typedAudio: ArrayBuffer[] = [];
  private typedTimer: ReturnType<typeof setTimeout> | undefined;
  // Synthesis times vary; messages are queued in the order they were typed.
  private typedChain: Promise<void> = Promise.resolve();

  private speakTypedText(text: string): void {
    this.typedChain = this.typedChain.then(() => this.synthesizeTypedText(text));
  }

  private async synthesizeTypedText(text: string): Promise<void> {
    const typed = text.slice(0, CallSession.MAX_TYPED_CHARS);
    let audio: ArrayBuffer | null = null;
    try { audio = await synthesize(this.env, typed, speechVoice(this.env, this.lang, this.settings), 'pcm24', this.settings, this.speechAbort.signal); }
    catch { /* reported below, like no synthesis at all */ }
    if (this.ended || !this.gptLive) return;
    if (!audio?.byteLength || audio.byteLength % 2) {
      console.log(`call ${this.callId}: typed text on GPT-Live needs server speech synthesis; not delivered`);
      return;
    }
    // Real-time pace, 100 ms at a time, then a short silence to end the utterance.
    for (let offset = 0; offset < audio.byteLength; offset += 4800) this.typedAudio.push(audio.slice(offset, offset + 4800));
    for (let i = 0; i < 5; i++) this.typedAudio.push(new ArrayBuffer(4800));
    const tick = () => {
      this.typedTimer = undefined;
      const chunk = this.typedAudio.shift();
      if (!chunk || this.ended) return;
      this.gptLive?.appendAudio(chunk);
      this.typedTimer = setTimeout(tick, 100);
    };
    if (this.typedTimer === undefined) tick();
  }

  private sendCallerText(text: string): void {
    if (this.gptLive) {
      if (!this.closingTimeline) this.speakTypedText(text);
      return;
    }
    if (this.upstream) this.closingGuard.startTurn(this.upstream);
    this.reserveTranscript(text);
    this.maybeSwitchVoice(text);
    this.sendUpstream({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.sendUpstream({ type: 'response.create' });
    this.send({ type: 'transcript', text });
    this.history.push({ role: 'user', content: text });
    void this.saveTurn('caller', text).catch(error => this.failInternally(error));
  }

  private async handleUtterance(audio: ArrayBuffer): Promise<void> {
    if (this.ended || this.busy || !this.biz) return; // drop overlapping speech while we respond
    this.busy = true;
    try {
      this.send({ type: 'thinking' });
      const vocab = this.biz && this.settings ? sttVocab(this.biz, this.settings, this.knowledge) : undefined;
      const abort = new AbortController();
      this.transcriptionAbort = abort;
      const { text, language } = await transcribe(this.env, audio, this.pendingContentType, vocab, this.settings, abort.signal);
      if (this.ended) return;
      if (!text) {
        this.busy = false;
        return;
      }
      this.reserveTranscript(text);
      if (language) this.lang = language; // follow the caller's language
      this.send({ type: 'transcript', text });
      await this.respondInner(text);
    } catch (error) {
      // Hanging up cancels STT; its rejection must not relabel a normal call as failed.
      if (!this.ended) throw error;
    } finally {
      this.transcriptionAbort = undefined;
      this.busy = false;
    }
  }

  private async respond(text: string): Promise<void> {
    if (this.busy || !this.biz) return;
    this.busy = true;
    try {
      this.reserveTranscript(text);
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
    if (this.ended) return;
    const wantsEnd = /<?END_CALL>?/i.test(raw);
    let reply = raw.replace(/\s*<?END_CALL>?\s*/gi, ' ').trim();
    if (wantsEnd) {
      this.startClosing('pipeline');
      this.generationDeadline();
      if (!isFarewell(reply)) {
        this.closingTimeline!.generationRequestedAt = Date.now();
        const farewell = (await chatComplete(llm, [...this.history, { role: 'system', content:
          'The conversation is finished. Say only one short, polite goodbye in the language of the most recent caller message. Do not add facts, ask questions or output END_CALL.' }], { maxTokens: 80 })).replace(/\s*<?END_CALL>?\s*/gi, ' ').trim();
        if (this.ended) return;
        if (!isFarewell(farewell)) { this.closingTimeline!.result = 'farewell_unavailable'; await this.finalize(); return; }
        reply = [reply, farewell].filter(Boolean).join(' ');
      }
      if (this.ended) return;
      if (!reply) { this.closingTimeline!.result = 'farewell_unavailable'; await this.finalize(); return; }
      this.closingTimeline!.generationCompletedAt = Date.now();
    }
    this.reserveTranscript(reply);
    this.history.push({ role: 'assistant', content: reply });
    this.send({ type: 'agent_text', text: reply, language: this.lang });
    await this.saveTurn('agent', reply);
    const speechAvailable = await this.speak(reply);
    if (this.ended) return;
    if (wantsEnd) {
      if (this.generationTimer !== undefined) clearTimeout(this.generationTimer);
      this.generationTimer = undefined;
      if (!speechAvailable) { this.closingTimeline!.result = 'farewell_unavailable'; await this.finalize(); }
      else this.beginHangup();
    }
  }

  private async speak(text: string): Promise<boolean> {
    const voice = speechVoice(this.env, this.lang, this.settings);
    const audio = await synthesize(this.env, text, voice, 'mp3', this.settings, this.speechAbort.signal);
    if (this.ended) return false;
    if (audio && this.ws) {
      try {
        this.ws.send(audio);
        this.debug?.audio('agent', audio, 'audio/mpeg');
      } catch {
        /* socket gone */
      }
    }
    return Boolean(audio?.byteLength) || speechConfig(this.env, this.settings).provider === 'browser';
  }

  private reserveTranscript(text: string): void {
    const bytes = transcriptBytes(text);
    if (this.persistedTranscriptBytes + bytes > MAX_CALL_TRANSCRIPT_BYTES) throw new RealtimeInputError();
    // Synchronous reservation: overlapping provider events cannot each observe
    // the same remaining budget while their D1 writes are pending. Keep failed
    // write reservations spent rather than reopening capacity after an error.
    this.persistedTranscriptBytes += bytes;
  }

  private async saveTurn(role: 'caller' | 'agent', text: string): Promise<void> {
    const bytes = transcriptBytes(text);
    const result = await this.env.DB.prepare(`INSERT INTO call_turns (call_id, role, text)
      SELECT ?, ?, ? WHERE
      (SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) FROM call_turns WHERE call_id = ?) + ? <= ${MAX_CALL_TRANSCRIPT_BYTES}`)
      .bind(this.callId, role, text, this.callId, bytes)
      .run();
    if (result.meta?.changes === 0) throw new RealtimeInputError();
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
    const recording = await debugMeta(this.state.storage);
    if (recording?.watchdogCleared) {
      if (recording.expiresAt <= Date.now()) await purgeDebug(this.state.storage);
      else await this.state.storage.setAlarm(recording.expiresAt);
      return;
    }
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
        if (await debugMeta(this.state.storage)) await this.clearWatchdog();
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
  private async rehydrateHistory(businessId: string, assistantId: string | null): Promise<void> {
    if (this.history.length > 0) return; // live session: memory is authoritative
    if (!this.settings) await this.loadSettings(businessId, assistantId);
    const { results } = await this.env.DB.prepare(`SELECT role, text FROM (
      SELECT id, role, text, length(CAST(text AS BLOB)) AS bytes,
        SUM(length(CAST(text AS BLOB))) OVER (ORDER BY id) AS total_bytes
      FROM call_turns WHERE call_id = ?
      ORDER BY id LIMIT ${CallSession.MAX_TURNS}
    ) WHERE bytes <= ${MAX_TRANSCRIPT_FIELD_BYTES} AND total_bytes <= ${MAX_CALL_TRANSCRIPT_BYTES} ORDER BY id`)
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
      const recording = await debugMeta(this.state.storage);
      if (recording) {
        if (this.debug) {
          await this.debug.finish();
          this.debug.meta.watchdogCleared = true;
          await this.state.storage.put('debug:meta', this.debug.meta);
        } else await this.state.storage.put('debug:meta', { ...recording, finishedAt: Date.now(), interrupted: true, partial: true, watchdogCleared: true });
        await this.state.storage.delete(['callId', 'startDeadline', 'startedAt', 'hardDeadline', 'lastActivity', 'ending', 'summarized']);
        await this.state.storage.setAlarm(recording.expiresAt);
      } else await this.commit(this.state.storage.deleteAlarm(), this.state.storage.deleteAll());
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

  // A connected carrier may project failure before session finalization. That
  // verdict is terminal, but the conversation still needs its content projection.
  private static readonly failedAsterisk = `channel = 'asterisk' AND status = 'failed'
    AND connected_at IS NOT NULL AND carrier_released_at IS NOT NULL
    AND ended_at IS NOT NULL AND failure_code GLOB 'asterisk_*'`;

  private async salvageAsteriskConversation(summary: string | null, intent: string | null, messageJson: string | null): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `UPDATE calls SET duration_s = COALESCE(duration_s, MAX(0, unixepoch(ended_at) - unixepoch(connected_at))),
        summary = COALESCE(summary, ?), intent = COALESCE(intent, ?), message_json = COALESCE(message_json, ?)
        WHERE id = ? AND ${CallSession.failedAsterisk}`
    ).bind(summary, intent, messageJson, this.callId).run();
    return (result?.meta?.changes ?? 0) > 0;
  }

  private async runFinalize(): Promise<void> {
    this.ended = true;
    if (this.closingTimeline && !this.closingLogged) {
      this.closingLogged = true;
      this.closingTimeline.endedAt = Date.now();
      this.closingTimeline.result ??= this.failure ? 'call_error' : 'caller_or_transport_disconnect';
      console.info(JSON.stringify({ event: 'call_closing', callId: this.callId, ...this.closingTimeline }));
    }
    this.transcriptionAbort?.abort();
    this.speechAbort.abort();
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
    let call = await this.env.DB.prepare('SELECT started_at, connected_at, business_id, assistant_id FROM calls WHERE id = ? AND status = ?')
      .bind(this.callId, 'active')
      .first<{ started_at: string; connected_at: string | null; business_id: string; assistant_id: string | null }>();
    call ??= await this.env.DB.prepare(
      `SELECT started_at, connected_at, business_id, assistant_id FROM calls WHERE id = ? AND ${CallSession.failedAsterisk}`
    ).bind(this.callId).first<typeof call>();
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
    // Carrier reservation/answer/setup precedes media readiness. Count talk
    // time from connection, preserving the legacy unconnected-row fallback.
    const durationOrigin = call.connected_at ?? call.started_at;
    const duration = Math.max(0, Math.round((endedAt - new Date(durationOrigin + 'Z').getTime()) / 1000));
    await this.rehydrateHistory(call.business_id, call.assistant_id);
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
        const llm = await loadSummaryLlm(this.env, call.business_id, this.settings);
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
        const callerPhone = normalizeCallerPhone(parsed.caller_phone);
        if (parsed.caller_name || callerPhone || parsed.message) {
          messageJson = JSON.stringify({
            caller_name: parsed.caller_name ?? null,
            caller_phone: callerPhone,
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
    // message_json also carries caller contact details. Its mere presence does
    // not mean a callback message was taken: booking flows commonly collect a
    // name and phone number without a separate message. Inspect the parsed
    // message itself before giving it precedence over booking intent.
    const outcome = this.failure
      ? 'failed'
      : messageJsonHasRealMessage(messageJson)
        ? 'message_taken'
        : intent === 'booking'
          ? 'booking_requested'
          : 'answered';
    // If this throws, `finalized` stays false and the watchdog is still armed,
    // so the alarm retries. Clearing the watchdog first would strand the row
    // as 'active' with nothing left to ever reclaim it.
    //
    // Still predicated on 'active': the sweep can retire the row between the
    // select above and here, and summarization is long enough to make that a
    // real window. Without the predicate this would overwrite the sweep's
    // status and duration — the salvage path exists to cooperate with the
    // sweep, and unconditionally overriding it is the opposite.
    // The Telnyx owner can project a carrier failure while this connected row
    // is still active, including during summarization. Preserve that classification
    // in this atomic write: terminal owners sleep until cleanup, so correctness
    // must not depend on a later poll restoring fields overwritten here.
    const carrierFailure = "channel = 'telnyx' AND failure_code IS NOT NULL AND outcome = 'failed'";
    const res = await this.env.DB.prepare(
      `UPDATE calls SET status = CASE WHEN ${carrierFailure} THEN 'failed' ELSE ? END,
        ended_at = ?, duration_s = ?, summary = ?, intent = ?, message_json = ?,
        outcome = CASE WHEN ${carrierFailure} THEN outcome ELSE ? END,
        failure_code = CASE WHEN ${carrierFailure} THEN failure_code ELSE ? END,
        failure_message = CASE WHEN ${carrierFailure} THEN failure_message ELSE ? END
        WHERE id = ? AND status = 'active'`
    )
      .bind(
        status,
        CallSession.sqlTime(endedAt),
        duration,
        summary,
        intent,
        messageJson,
        outcome,
        this.failure ? 'session_error' : null,
        this.failure,
        this.callId
      )
      .run();
    // `changes` missing means the driver did not report one, not that nothing
    // matched — only an explicit zero means the sweep got there first.
    if ((res?.meta?.changes ?? 1) === 0) {
      // This also covers carrier failure while the summary request was in flight.
      // Read terminal timing in the UPDATE itself; retries must not add talk time.
      if (!await this.salvageAsteriskConversation(summary, intent, messageJson)) await this.salvageSummary();
    }
    this.finalized = true;
    await this.clearWatchdog();
  }
}
