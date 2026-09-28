import { api } from './api';
import { VoiceCall, type VoiceEvent } from '../voice';

interface Transport {
  ended: boolean; readonly hasMic: boolean;
  on(listener: (event: VoiceEvent) => void): void;
  prepareAudio(): void; connect(id: string): Promise<void>; start(slug: string): Promise<void>;
  hangup(): void; sendText(text: string): void;
}
interface Dependencies {
  create: () => Transport;
  reserve: (assistantId: string) => Promise<{ callId: string }>;
  cancel: (callId: string) => Promise<unknown>;
}
const defaults: Dependencies = { create: () => new VoiceCall(), reserve: api.reserveTest, cancel: api.cancelTest };

/** Owns one browser session and its unused ticket, including permission/network races. */
export class RehearsalController {
  private voice: Transport | null = null;
  private ticket: string | null = null;
  private run = 0;
  private active = false;
  private disposed = false;
  constructor(private readonly emit: (event: VoiceEvent) => void, private readonly ended: () => void = () => {}, private readonly deps: Dependencies = defaults) {}
  get hasMic(): boolean { return this.voice?.hasMic ?? false; }
  prepareAudio(): void { this.voice?.prepareAudio(); }
  sendText(text: string): void { if (this.active) this.voice?.sendText(text); }
  private retireTicket(): void {
    const ticket = this.ticket;
    this.ticket = null;
    if (ticket) void this.deps.cancel(ticket).catch(() => {});
  }
  async start(assistantId: string, options: { dirty?: boolean; slug?: string } = {}): Promise<void> {
    if (options.dirty) throw new Error('Save your changes before testing the saved assistant.');
    if (this.disposed || this.active) return;
    const run = ++this.run;
    this.active = true;
    const voice = this.deps.create();
    this.voice = voice;
    let failed = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.active = false;
      this.retireTicket();
      this.ended();
    };
    voice.on(event => {
      if (this.disposed || run !== this.run) return;
      if (event.type === 'status') {
        if (event.status === 'error') failed = true;
        if (event.status === 'ended') {
          // VoiceCall emits ended after error to signal teardown. Keep the actionable error visible.
          finish();
          if (failed) return;
        }
      }
      this.emit(event);
    });
    this.emit({ type: 'status', status: 'connecting' });
    voice.prepareAudio(); // preserve user gesture before any network await
    try {
      if (options.slug) await voice.start(options.slug);
      else {
        const ticket = await this.deps.reserve(assistantId);
        if (this.disposed || run !== this.run) {
          void this.deps.cancel(ticket.callId).catch(() => {});
          return;
        }
        this.ticket = ticket.callId;
        await voice.connect(ticket.callId);
      }
    } catch (error) {
      if (this.disposed || run !== this.run) return;
      failed = true;
      voice.hangup();
      finish();
      this.emit({ type: 'status', status: 'error', detail: error instanceof Error ? error.message : 'Could not connect. Please try again.' });
    }
  }
  stop(): void {
    const wasActive = this.active;
    ++this.run;
    this.active = false;
    this.voice?.hangup();
    this.retireTicket();
    if (!this.disposed && wasActive) {
      this.emit({ type: 'status', status: 'ended' });
      this.ended();
    }
  }
  dispose(): void { this.disposed = true; this.stop(); }
}
