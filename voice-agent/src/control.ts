/** Operator-only callbacks. Keys and response bodies never appear in errors. */
export interface CallContext {
  callId: string; room: string; caller: string; callback: string;
  commands?:Array<{id:string;text:string}>;
  instructions: string; greeting: string; voice: string; language: string;
}
export class ControlClient {
  private base: string;
  constructor(base: string, private key: string, readonly callId: string, readonly room: string, readonly jobId: string) {
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid control address');
    this.base = url.href.replace(/\/$/, '');
    if (!key || !/^[a-zA-Z0-9_-]{1,100}$/.test(callId) || !jobId) throw new Error('Invalid admission');
  }
  async post(operation: 'context' | 'events', body: Record<string, unknown>): Promise<unknown> {
    // Same event/revision on retries: an ambiguous response cannot duplicate a turn.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${this.base}/api/internal/livekit/calls/${this.callId}/${operation}`, {
          method: 'POST', headers: {Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({...body, room: this.room, jobId: this.jobId}), redirect: 'error', signal: AbortSignal.timeout(2000),
        });
        if (response.ok) return await response.json();
        await response.body?.cancel();
        if (response.status < 500) throw new AdmissionError(response.status);
      } catch (error) { if (error instanceof AdmissionError) throw error; }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
    throw new Error('Call control unavailable');
  }
  async context(): Promise<CallContext> {
    const value = await this.post('context', {}) as CallContext;
    if (value.callId !== this.callId || value.room !== this.room || typeof value.caller !== 'string' || !value.caller ||
        typeof value.callback !== 'string' || !value.callback || typeof value.instructions !== 'string' ||
        typeof value.greeting !== 'string' || typeof value.voice !== 'string' || typeof value.language !== 'string') throw new AdmissionError();
    if(value.commands!==undefined&&(!Array.isArray(value.commands)||value.commands.length>16||value.commands.some(c=>!c||typeof c.id!=='string'||!/^typed_[a-zA-Z0-9-]{1,100}$/.test(c.id)||typeof c.text!=='string'||c.text.length>30000)))throw new AdmissionError();
    return value;
  }
}
export class AdmissionError extends Error { constructor(readonly status=403) { super('Call admission ended'); } }
