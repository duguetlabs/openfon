import { isFarewell } from './providers';
import { RealtimeInputError } from './realtime-input';

function responseKey(id: unknown): string {
  if (id === undefined) return '';
  if (typeof id !== 'string' || !id || id.length > 128) throw new RealtimeInputError();
  return id;
}

type Reply = { source: object; id: string; audio: boolean; farewell: boolean; text: boolean; done: boolean; ok: boolean; eligible: boolean };
export type ClosingAction = 'wait' | 'generate' | 'ready' | 'failed';

// Correlate a close request with its response, rather than an old greeting or
// whatever PCM happens to be queued. Legacy gateways without IDs are serial
// same-socket streams; they cannot provide identified-response evidence.
export class RealtimeClosingGuard {
  private replies = new WeakMap<object, Map<string, Reply>>();
  private current = new WeakMap<object, Reply>();
  private target: Reply | undefined;
  private source: object | undefined;
  private replacement = false;
  private waitingForReplacement = false;
  private terminal = false;
  requested = false;

  private reply(source: object, id: unknown, restart = false): Reply {
    const key = responseKey(id);
    let entries = this.replies.get(source);
    if (!entries) { entries = new Map(); this.replies.set(source, entries); }
    let reply = entries.get(key);
    if (!reply || (!key && restart && reply.done)) {
      reply = { source, id: key, audio: false, farewell: false, text: false, done: false, ok: true, eligible: true };
      entries.set(key, reply); this.current.set(source, reply);
      while (entries.size > 8) entries.delete(entries.keys().next().value!);
      if (this.waitingForReplacement && source === this.source && reply !== this.target) {
        this.target = reply; this.waitingForReplacement = false;
      }
    }
    return reply;
  }
  startTurn(source: object): void {
    if (this.requested) return;
    for (const reply of this.replies.get(source)?.values() ?? []) reply.eligible = false;
    this.replies.get(source)?.delete('');
    this.current.delete(source);
  }
  created(source: object, id: unknown): void { this.reply(source, id, true); }
  audio(source: object, id: unknown, bytes: number): void {
    if (bytes) this.reply(source, id, true).audio = true;
  }
  transcript(source: object, id: unknown, text: string): void {
    const reply = this.reply(source, id);
    reply.text = Boolean(text.trim()); reply.farewell = isFarewell(text);
  }
  done(source: object, id: unknown, status: unknown): void {
    const reply = this.reply(source, id);
    reply.done = true; reply.ok = status === undefined || status === 'completed';
  }
  request(source: object, id?: unknown): void {
    if (this.requested) return;
    responseKey(id);
    this.requested = true; this.source = source;
    this.target = id === undefined ? this.current.get(source) ?? this.reply(source, undefined) : this.reply(source, id);
  }
  accepts(source: object, id: unknown): boolean {
    const key = responseKey(id);
    if (!this.requested) return true;
    if (this.terminal || source !== this.source) return false;
    if (this.waitingForReplacement) return !this.replies.get(source)?.has(key) || (!key && this.target?.done === true);
    return this.target?.id === key;
  }
  advance(): ClosingAction {
    if (!this.requested || this.terminal || this.waitingForReplacement) return 'wait';
    if (this.target && !this.target.done) return 'wait';
    // Some providers put the tool in a separate response after speaking.
    // Only a successful farewell from this caller turn can satisfy that tool.
    if (!this.replacement && this.source) {
      const farewell = [...(this.replies.get(this.source)?.values() ?? [])].reverse().find(r =>
        r.eligible && r.done && r.ok && r.audio && r.text && r.farewell);
      if (farewell) this.target = farewell;
    }
    const usable = this.target?.ok && this.target.eligible && this.target.audio && this.target.text;
    if (usable && this.target?.farewell) {
      this.terminal = true; return 'ready';
    }
    if (this.replacement) { this.terminal = true; return 'failed'; }
    this.replacement = true; this.waitingForReplacement = true;
    return 'generate';
  }
}
