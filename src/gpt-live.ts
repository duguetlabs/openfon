// GPT-Live (gpt-live-1): Azure/OpenAI's full-duplex voice model, reached through
// the Kataleptic gateway at `/v1/live/sessions`. It is NOT the Realtime API:
//
//   client  session.start {model, instructions, audio, delegation}  -> session.started
//   client  session.input_audio.append {audio}            (never acknowledged)
//   server  session.output_audio.delta {delta}            100 ms chunks, continuous,
//                                                         silence included, no done event
//   server  session.input_transcript.delta / session.output_transcript.delta
//                                                         {delta,start_ms,end_ms}, interleaved,
//                                                         with no turn events
//   client  session.{instructions,thinking,commentary}.append {content, delegation_id}
//   server  session.delegation.created, then response.event {delegation_id, event}
//           envelopes carrying ordinary Responses streaming events
//   client  response.item.create {function_call_output} + response.create
//   client  session.close  -> server session.closed {usage}
//
// Verified against the live service on 2026-09-24. Where it disagrees with
// Microsoft's documentation (output `delta`, continuous silence), the service
// won. Anything this file does not rely on is deliberately not modelled.
//
// There are no turns, no response ids and no barge-in events, so the pieces of
// CallSession built on those (closing guard, VAD table, session echo re-sends,
// response.cancel/truncate) do not apply. This engine derives what CallSession
// needs from the stream instead: audible segments from the audio itself, turns
// from transcript timing, and the end of a farewell from the silence after it.
import type { CallDebug } from './call-debug';
import { isFarewell } from './providers';
import { GPT_LIVE_MODEL, gptLiveConnection, type RealtimeConfig } from './realtime-providers';
import { parseRealtimeMessage, transcriptBytes, MAX_TRANSCRIPT_FIELD_BYTES } from './realtime-input';

/** The ten voices session.start accepts. marin is the service default. */
export const GPT_LIVE_VOICES = ['marin', 'cedar', 'alloy', 'coral', 'shimmer', 'verse', 'ash', 'sage', 'ballad', 'echo'];
/** Backend model the live model delegates tool work to: a Kataleptic chat id. */
export const DEFAULT_GPT_LIVE_DELEGATION_MODEL = 'gpt-5.4-mini';
export const GPT_LIVE_AUDIO_FORMAT = { type: 'audio/pcm', rate: 24000 } as const;

// The service streams digital near-silence between utterances: measured peaks
// of 0-35 over whole 100 ms chunks, against 5000-16000 for speech and 50-650
// for the fade at a word's end. Anything at or under this is not speech.
const SILENT_PEAK = 128;
// A pause this long stays in the audio as a natural gap. Beyond it silence is
// dropped: forwarding a continuous stream would never let a carrier's playback
// queue drain, and timer drift on its 20 ms tick grows that queue without bound.
const PAUSE_CHUNKS = 3;
// Silence after a farewell before the call may hang up (chunks of 100 ms).
const FAREWELL_TAIL_CHUNKS = 6;
// A transcript turn ends after this much quiet from that speaker. Deltas arrive
// in 200 ms buckets and were at most ~450 ms apart within one utterance.
const TURN_GAP_MS = 1200;
// A closing request with no spoken goodbye still hangs up, once the agent is quiet.
const FAREWELL_GRACE_MS = 8000;
// The caller said goodbye: how long to wait for the agent's sign-off.
const CALLER_FAREWELL_WAIT_MS = 8000;
const HANDSHAKE_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 2000;
// session.instructions.append is limited to 500 tokens; a typed message is
// cut well inside that.
const MAX_TYPED_TEXT_CHARS = 1200;

export interface GptLiveSessionOptions {
  instructions: string;
  voice: string; // '' = service default
  delegationModel: string;
  delegationInstructions: string;
  greeting: string | null;
}

/** What CallSession provides. Every method is synchronous and must not throw. */
export interface GptLiveHost {
  readonly debug: CallDebug | null;
  /** Rate/size admission and decode for one output chunk; null if the call is failing. */
  admitAudio(encoded: string, source: object): ArrayBuffer | null;
  /** The agent went quiet: output admission may start a new bounded segment. */
  audioPaused(source: object): void;
  playAudio(pcm: ArrayBuffer): void;
  turn(role: 'caller' | 'agent', text: string): void;
  closeRequested(trigger: 'model_tool' | 'caller_farewell'): void;
  /** The farewell (or a bounded wait for one) has been spoken and followed by silence. */
  readyToHangUp(): void;
  /** Provider error or invalid provider message on an established session. */
  failed(error: Error): void;
  /** An established session closed without our asking. */
  disconnected(): void;
}

export class GptLiveProtocolError extends Error {
  constructor(what: string) { super(`GPT-Live ${what}; provider response redacted`); }
}

export function gptLiveVoice(voice: string): string {
  return GPT_LIVE_VOICES.includes(voice) ? voice : '';
}

export function gptLiveSessionStart(options: GptLiveSessionOptions): { type: 'session.start'; session: Record<string, unknown> } {
  return { type: 'session.start', session: {
    model: GPT_LIVE_MODEL,
    instructions: options.instructions,
    audio: { format: { ...GPT_LIVE_AUDIO_FORMAT }, ...(options.voice ? { output: { voice: options.voice } } : {}) },
    // The gateway refuses anything but function tools here.
    delegation: { type: 'responses', responses: {
      model: options.delegationModel,
      instructions: options.delegationInstructions,
      tools: [{
        type: 'function', name: 'end_call',
        description: 'End the phone call. Use it once the caller has said goodbye or the conversation is finished.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      }],
      tool_choice: 'auto',
    } },
  } };
}

/** Whole-chunk peak test on PCM16LE. */
export function silentPcm(pcm: ArrayBuffer): boolean {
  const samples = new Int16Array(pcm, 0, pcm.byteLength >> 1);
  for (let i = 0; i < samples.length; i++) if (samples[i] > SILENT_PEAK || samples[i] < -SILENT_PEAK) return false;
  return true;
}

function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const ms = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : -1;

type Role = 'caller' | 'agent';
interface Turn { text: string; bytes: number; startMs: number; endMs: number; timer?: ReturnType<typeof setTimeout> }

export class GptLiveEngine {
  private ws: WebSocket | null = null;
  private started = false;
  private closing = false; // we asked for the end of this socket
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private open: Record<Role, Turn | null> = { caller: null, agent: null };
  private lastTurn: Record<Role, { text: string; startMs: number; endMs: number } | null> = { caller: null, agent: null };
  private turns = 0;
  private silentRun = PAUSE_CHUNKS + 1; // leading silence is dropped
  // Silent chunks since the agent last made a sound or a transcript word. A
  // word's transcript can arrive just before its audio, so silence that
  // predates it is not the silence after it.
  private quietAfterAgent = 0;
  private muted = false;
  private answeredCalls = new Set<string>();
  private closeState: { trigger: 'model_tool' | 'caller_farewell'; at: number; ready: boolean } | null = null;
  private callerFarewell: ReturnType<typeof setTimeout> | undefined;
  private callerFarewellAt = -1;

  constructor(private readonly config: RealtimeConfig, private readonly host: GptLiveHost) {}

  get socket(): WebSocket | null { return this.ws; }
  get closeRequested(): boolean { return this.closeState !== null; }

  /** Connect and start a session. Resolves once `session.started` confirms the
   * format and voice, or false on any failure (the socket is then discarded). */
  async start(options: GptLiveSessionOptions): Promise<boolean> {
    this.discard();
    const connection = gptLiveConnection(this.config);
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    let ws: WebSocket;
    try {
      this.host.debug?.event('connect_attempt', { engine: 'gpt-live' });
      const response = await fetch(connection.url, { headers: connection.headers, redirect: 'manual', signal: controller.signal });
      if (response.status !== 101 || !response.webSocket) {
        this.host.debug?.event('connect_rejected', { status: response.status });
        return false;
      }
      ws = response.webSocket;
    } catch { this.host.debug?.event('connect_failed'); return false; }
    finally { clearTimeout(connectTimer); } // bounds setup, not the call
    ws.accept();
    this.ws = ws; this.started = false; this.closing = false;
    this.silentRun = this.quietAfterAgent = PAUSE_CHUNKS + 1;
    const start = gptLiveSessionStart(options);
    return new Promise<boolean>(resolve => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (!ok) this.discard();
        resolve(ok);
      };
      const timer = setTimeout(() => { this.host.debug?.event('handshake_timeout'); settle(false); }, HANDSHAKE_TIMEOUT_MS);
      ws.addEventListener('message', event => {
        if (this.ws !== ws) return;
        let msg: Record<string, unknown>;
        try { msg = parseRealtimeMessage(event.data); } catch { return settled ? this.host.failed(new GptLiveProtocolError('sent an invalid message')) : settle(false); }
        if (typeof msg.type !== 'string') return settled ? this.host.failed(new GptLiveProtocolError('sent an invalid message')) : settle(false);
        if (!this.started) {
          if (msg.type === 'session.started') {
            if (!this.confirmed(msg.session, start.session)) { this.host.debug?.event('session_rejected'); settle(false); return; }
            this.started = true;
            this.host.debug?.event('provider', { type: msg.type });
            if (options.greeting) this.send({ type: 'session.commentary.append', delegation_id: null, content: `Greet the caller: '${options.greeting}'` });
            settle(true);
          } else if (msg.type === 'error') {
            this.host.debug?.event('provider', { type: msg.type, errorCode: code((msg.error as { code?: unknown } | undefined)?.code) });
            settle(false);
          }
          return;
        }
        try { this.onMessage(msg, ws); }
        catch (error) { this.host.failed(error instanceof Error ? error : new GptLiveProtocolError('sent an invalid message')); }
      });
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        const established = this.started && !this.closing;
        this.detach();
        if (!settled) settle(false);
        else if (established) this.host.disconnected();
      });
      ws.addEventListener('error', () => { if (this.ws === ws && !settled) settle(false); });
      this.send(start);
    });
  }

  // Azure closes a session with the wrong model with no error at all, and the
  // audio format decides how every byte in both directions is read. Confirm
  // both before a caller is told the line is ready.
  private confirmed(echo: unknown, sent: Record<string, unknown>): boolean {
    if (!echo || typeof echo !== 'object') return false;
    const session = echo as { model?: unknown; audio?: { format?: { type?: unknown; rate?: unknown }; output?: { voice?: unknown } } };
    const voice = (sent.audio as { output?: { voice?: string } }).output?.voice;
    return session.model === GPT_LIVE_MODEL &&
      session.audio?.format?.type === GPT_LIVE_AUDIO_FORMAT.type && session.audio.format.rate === GPT_LIVE_AUDIO_FORMAT.rate &&
      (voice === undefined || session.audio.output?.voice === voice);
  }

  appendAudio(pcm: ArrayBuffer): boolean {
    if (!this.started || this.closing || !pcm.byteLength) return false;
    return this.send({ type: 'session.input_audio.append', audio: b64encode(pcm) });
  }

  /** A caller typing instead of speaking. There is no user-message item in this
   * protocol; an instruction addendum was verified to be answered aloud. */
  sendText(text: string): boolean {
    if (!this.started || this.closing) return false;
    const typed = text.length > MAX_TYPED_TEXT_CHARS ? text.slice(0, MAX_TYPED_TEXT_CHARS) : text;
    return this.send({ type: 'session.instructions.append', delegation_id: null,
      content: `The caller typed this message instead of speaking: "${typed}" Answer it aloud.` });
  }

  /** Graceful end: session.close, then a bounded wait for session.closed. Open
   * transcript turns are handed over first so the summary sees them. */
  close(): void {
    this.flushTurns();
    this.clearTimers();
    const ws = this.ws;
    if (!ws || this.closing) return;
    this.closing = true;
    if (!this.started || !this.send({ type: 'session.close' })) { this.discard(); return; }
    // A session with an unanswered delegation was seen never to send
    // session.closed. The gateway bills from wall time in that case; we only
    // need the socket gone.
    this.closeTimer = setTimeout(() => this.discard(), CLOSE_TIMEOUT_MS);
  }

  private send(value: unknown): boolean {
    const ws = this.ws;
    if (!ws) return false;
    try {
      ws.send(JSON.stringify(value));
      const type = (value as { type: string }).type;
      if (type !== 'session.input_audio.append') this.host.debug?.event('upstream_send', { type, socket: this.host.debug.socket(ws) });
      return true;
    } catch { return false; }
  }

  private detach(): void {
    this.flushTurns();
    if (this.closeTimer !== undefined) clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    this.ws = null; this.started = false;
  }

  private discard(): void {
    const ws = this.ws;
    this.detach();
    try { ws?.close(1000, 'call ended'); } catch { /* already closed */ }
  }

  private clearTimers(): void {
    if (this.callerFarewell !== undefined) clearTimeout(this.callerFarewell);
    this.callerFarewell = undefined;
  }

  private onMessage(msg: Record<string, unknown>, ws: WebSocket): void {
    const type = msg.type as string;
    if (!type.endsWith('.delta')) this.host.debug?.event('provider', { type: code(type), socket: this.host.debug.socket(ws) });
    switch (type) {
      case 'session.output_audio.delta':
        this.onAudio(msg.delta, ws);
        break;
      case 'session.input_transcript.delta':
        this.onTranscript('caller', msg);
        break;
      case 'session.output_transcript.delta':
        this.onTranscript('agent', msg);
        break;
      case 'response.event':
        this.onDelegationEvent(msg.event);
        break;
      case 'session.closed':
        if (this.closing) this.discard();
        break;
      case 'error':
        // Unknown/auth/quota/input failures cannot leave a silent call alive.
        // Fixed wording only: provider fields never reach the call record.
        throw new GptLiveProtocolError('rejected a request');
      // session.delegation.created, *.appended and anything newer: nothing to do.
    }
  }

  private onAudio(delta: unknown, ws: WebSocket): void {
    if (typeof delta !== 'string') throw new GptLiveProtocolError('sent invalid audio');
    const pcm = this.host.admitAudio(delta, ws);
    if (!pcm?.byteLength) return; // an empty delta is neither speech nor silence
    if (pcm.byteLength % 2) throw new GptLiveProtocolError('sent invalid audio');
    if (silentPcm(pcm)) { this.silentRun++; this.quietAfterAgent++; }
    else this.silentRun = this.quietAfterAgent = 0;
    if (this.silentRun > PAUSE_CHUNKS) this.host.audioPaused(ws);
    else if (!this.muted) this.host.playAudio(pcm);
    this.advanceClose();
  }

  private onTranscript(role: Role, msg: Record<string, unknown>): void {
    const text = msg.delta;
    const bytes = transcriptBytes(text); // bounded before it is kept
    const startMs = ms(msg.start_ms), endMs = ms(msg.end_ms);
    let turn = this.open[role];
    // One stored field is capped; a monologue that long is split, not dropped.
    if (turn && turn.bytes + bytes > MAX_TRANSCRIPT_FIELD_BYTES) { this.flushTurn(role); turn = null; }
    if (!turn) turn = this.open[role] = { text: '', bytes: 0, startMs, endMs };
    turn.text += text as string; turn.bytes += bytes;
    if (endMs >= 0) turn.endMs = Math.max(turn.endMs, endMs);
    if (turn.timer !== undefined) clearTimeout(turn.timer);
    turn.timer = setTimeout(() => this.flushTurn(role), TURN_GAP_MS);
    if (role === 'agent') { this.quietAfterAgent = 0; this.advanceClose(); }
  }

  private flushTurns(): void {
    this.flushTurn('caller');
    this.flushTurn('agent');
  }

  private flushTurn(role: Role): void {
    const turn = this.open[role];
    if (!turn) return;
    this.open[role] = null;
    if (turn.timer !== undefined) clearTimeout(turn.timer);
    const text = turn.text.trim();
    if (!text) return;
    this.lastTurn[role] = { text, startMs: turn.startMs, endMs: turn.endMs };
    this.turns++;
    this.host.turn(role, text);
    if (role === 'caller') this.onCallerTurn(text, turn.startMs);
    else if (this.callerFarewell !== undefined) {
      // The agent answered a caller's goodbye. A sign-off ends the call; any
      // other reply (for instance "anything else?") means it is not over.
      this.clearTimers();
      if (isFarewell(text)) this.requestClose('caller_farewell');
    }
  }

  // Caller-farewell backstop. Not a fallback: the live model delegates
  // non-deterministically (one of two identical goodbye probes never did),
  // so on some calls this is what ends them. Armed only after a real exchange.
  private onCallerTurn(text: string, startMs: number): void {
    if (this.closeState || this.turns < 3 || !isFarewell(text)) return;
    this.callerFarewellAt = startMs;
    if (this.agentFarewell()) { this.requestClose('caller_farewell'); return; }
    this.clearTimers();
    this.callerFarewell = setTimeout(() => {
      this.callerFarewell = undefined;
      this.requestClose('caller_farewell');
    }, CALLER_FAREWELL_WAIT_MS);
  }

  // The agent's latest words include a goodbye, spoken no earlier than the
  // caller's last turn began: an old "bye" the caller has since talked over
  // does not count.
  private agentFarewell(): boolean {
    const agent = this.open.agent ?? this.lastTurn.agent;
    if (!agent || !isFarewell(agent.text)) return false;
    const callerStart = Math.max(this.open.caller?.startMs ?? -1, this.lastTurn.caller?.startMs ?? -1, this.callerFarewellAt);
    return agent.endMs < 0 || agent.endMs >= callerStart;
  }

  private onDelegationEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const e = event as { type?: unknown; item?: { type?: unknown; call_id?: unknown; name?: unknown } };
    if (e.type !== 'response.output_item.done' || e.item?.type !== 'function_call') return;
    const callId = e.item.call_id;
    if (typeof callId !== 'string' || !callId || callId.length > 128 || this.answeredCalls.has(callId)) return;
    if (this.answeredCalls.size >= 64) throw new GptLiveProtocolError('requested too many tool calls');
    this.answeredCalls.add(callId);
    const endCall = e.item.name === 'end_call';
    // Answer every call, known or not: an unanswered delegation was seen to
    // keep session.closed from ever arriving.
    this.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: callId,
      output: endCall ? 'The call is ending now. If you have not said goodbye yet, say one short goodbye. Do not say anything else.'
        : JSON.stringify({ error: 'Unknown tool.' }) } });
    this.send({ type: 'response.create' });
    if (endCall) this.requestClose('model_tool');
  }

  private requestClose(trigger: 'model_tool' | 'caller_farewell'): void {
    if (this.closeState) return;
    this.clearTimers();
    this.closeState = { trigger, at: Date.now(), ready: false };
    this.host.closeRequested(trigger);
    this.advanceClose();
  }

  // Hang up once the goodbye has been said and the agent has gone quiet. The
  // audio stream is the clock: it runs continuously, so silence is observable.
  private advanceClose(): void {
    const close = this.closeState;
    if (!close || close.ready) return;
    // A caller's goodbye already waited for the agent's reply before getting here.
    if (!this.agentFarewell() && close.trigger === 'model_tool' && Date.now() - close.at < FAREWELL_GRACE_MS) return;
    if (this.quietAfterAgent < FAREWELL_TAIL_CHUNKS) return;
    close.ready = true;
    // Nothing after the goodbye reaches the caller: a carrier drains its
    // playback only once audio stops arriving.
    this.muted = true;
    this.host.readyToHangUp();
  }
}

function code(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(value) ? value : undefined;
}
