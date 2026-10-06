// Test-call diagnostics only. Audio writes must never hold the call's output gate.
function b64encode(buffer: ArrayBuffer): string {
  let text = ''; for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte); return btoa(text);
}

export const DEBUG_RETENTION_MS = 7 * 86400_000;
const PREFIX = 'debug:';
const META = PREFIX + 'meta';
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_PENDING = 2 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const encoder = new TextEncoder();
export interface DebugMeta {
  version: 1; callId: string; startedAt: number; expiresAt: number;
  chunks: number; records: number; bytes: number; partial: boolean;
  finishedAt?: number; deleted?: boolean; interrupted?: boolean; watchdogCleared?: boolean;
}
export interface DebugRecord { seq: number; ms: number; kind: string; [key: string]: unknown }
const chunkKey = (n: number) => PREFIX + 'chunk:' + String(n).padStart(6, '0');

export class CallDebug {
  private batch: DebugRecord[] = [];
  private batchBytes = 0;
  private pendingBytes = 0;
  private chain = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private seq = 0;
  private socketIds = new WeakMap<object, number>();
  private sockets = 0;
  private uploadSequence = 0;
  private uploadDigest = '';
  private writeFailures = 0;
  private producerComplete = false;
  private producerPartial = false;
  markPartial(): void { this.meta.partial = true; this.producerPartial = true; }
  get accepting(): boolean { return !this.stopped && !this.meta.deleted && !this.meta.finishedAt && this.meta.expiresAt > Date.now(); }
  async upload(body: Record<string, unknown>): Promise<number> {
    if (!this.accepting) return 410;
    const records = parseDebugUpload(body);
    if (!records) return 400;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(body))))).map(n=>n.toString(16).padStart(2,'0')).join('');
    if (body.sequence === this.uploadSequence - 1) return digest === this.uploadDigest ? 200 : 409;
    if (this.producerComplete) return 410;
    if (body.sequence !== this.uploadSequence) return 409;
    const failures = this.writeFailures;
    // Keep default-partial durable until a producer explicitly seals all batches.
    this.meta.partial = true;
    for (const record of records) {
      if (record.kind === 'audio') this.event('audio', {...record, frame: this.seq, offset: 0, total: (record.data as string).length / 4 * 3 - ((record.data as string).endsWith('==') ? 2 : (record.data as string).endsWith('=') ? 1 : 0)});
      else this.event('capture', record);
    }
    this.producerPartial ||= body.partial === true;
    this.flush(); await this.chain;
    if (this.writeFailures !== failures) { this.producerPartial = this.meta.partial = true; this.stopped = true; return 503; }
    this.producerPartial ||= this.writeFailures > 0;
    if (body.complete === true) { this.producerComplete = true; this.meta.partial = this.producerPartial; }
    try { await this.state.storage.put(META, this.meta); await this.state.storage.sync(); }
    catch { this.producerPartial = this.meta.partial = true; this.producerComplete = false; this.stopped = true; return 503; }
    this.uploadSequence++; this.uploadDigest = digest;
    return 200;
  }
  private constructor(private state: DurableObjectState, public meta: DebugMeta, readonly serviceCapture = false) {}

  static async start(state: DurableObjectState, callId: string, producer = false): Promise<CallDebug | null> {
    try {
      // Never overwrite evidence after a restart or an owner's deletion.
      if (await state.storage.get(META)) return null;
      const now = Date.now();
      const meta: DebugMeta = { version: 1, callId, startedAt: now, expiresAt: now + DEBUG_RETENTION_MS,
        chunks: 0, records: 0, bytes: 0, partial: producer };
      await state.storage.put(META, meta, { allowUnconfirmed: true });
      return new CallDebug(state, meta, producer);
    } catch { return null; }
  }
  socket(value: object): number {
    let id = this.socketIds.get(value);
    if (!id) { id = ++this.sockets; this.socketIds.set(value, id); }
    return id;
  }
  event(kind: string, fields: Record<string, unknown> = {}): void {
    if (this.stopped) return;
    try {
    const record: DebugRecord = { ...fields, seq: this.seq++, ms: Date.now() - this.meta.startedAt, kind };
    const bytes = encoder.encode(JSON.stringify(record)).length;
    if (bytes > 96_000 || this.meta.records >= MAX_RECORDS || this.meta.bytes + bytes > MAX_BYTES ||
        this.pendingBytes + this.batchBytes + bytes > MAX_PENDING) {
      this.markPartial();
      return;
    }
    if (this.batchBytes + bytes > 48_000) this.flush();
    this.batch.push(record); this.batchBytes += bytes;
    this.meta.records++; this.meta.bytes += bytes;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 1000);
    } catch { this.markPartial(); }
  }
  audio(track: string, buffer: ArrayBuffer, format: string, fields: Record<string, unknown> = {}): void {
    if (this.stopped || !buffer.byteLength) return;
    const frame = this.seq;
    // Preserve packet boundaries for utterance replay; large packets use parts.
    for (let offset = 0; offset < buffer.byteLength; offset += 24_000) {
      if (this.meta.records >= MAX_RECORDS || this.meta.bytes >= MAX_BYTES - 33_000 || this.pendingBytes + this.batchBytes >= MAX_PENDING - 33_000) { this.markPartial(); break; }
      this.event('audio', { ...fields, track, format, frame, offset, total: buffer.byteLength,
        data: b64encode(buffer.slice(offset, offset + 24_000)) });
    }
  }
  private flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined;
    if (!this.batch.length) return;
    const batch = this.batch; const bytes = this.batchBytes;
    this.batch = []; this.batchBytes = 0; this.pendingBytes += bytes;
    const key = chunkKey(this.meta.chunks++);
    const snapshot = { ...this.meta };
    this.chain = this.chain.then(async () => {
      try {
        await this.state.storage.put({ [key]: batch, [META]: snapshot }, { allowUnconfirmed: true });
      } catch { this.markPartial(); this.writeFailures++; }
      finally { this.pendingBytes -= bytes; }
    });
    this.state.waitUntil(this.chain);
  }
  async finish(): Promise<void> {
    if (!this.stopped) { this.event('recording_finished'); this.stopped = true; this.flush(); }
    await this.chain;
    this.meta.finishedAt ??= Date.now();
    await this.state.storage.put(META, this.meta, { allowUnconfirmed: true });
  }
  async remove(): Promise<void> {
    this.stopped = true; if (this.timer !== undefined) clearTimeout(this.timer); this.batch = []; this.batchBytes = 0;
    await this.chain;
    await purgeDebug(this.state.storage);
    this.meta.deleted = true;
    this.meta.chunks = this.meta.records = this.meta.bytes = 0;
    await this.state.storage.put(META, this.meta);
  }
}

export async function debugMeta(storage: DurableObjectStorage): Promise<DebugMeta | undefined> {
  const meta = await storage.get<DebugMeta>(META);
  return meta?.version === 1 ? meta : undefined;
}
export async function purgeDebug(storage: DurableObjectStorage): Promise<void> {
  for (;;) {
    const page = await storage.list({ prefix: PREFIX, limit: 128 });
    if (!page.size) return;
    await storage.delete([...page.keys()]);
  }
}

// Called only by authenticated, owner-scoped Worker routes through a DO stub.
export async function debugResponse(state: DurableObjectState, request: Request, recorder: CallDebug | null): Promise<Response> {
  const meta = await debugMeta(state.storage);
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!meta || meta.expiresAt <= Date.now()) {
    if (meta) await purgeDebug(state.storage);
    return Response.json({ available: false }, { headers });
  }
  if (request.method === 'DELETE') {
    if (recorder) await recorder.remove();
    else { await purgeDebug(state.storage); await state.storage.put(META, { ...meta, deleted: true, chunks: 0, records: 0, bytes: 0 }); }
    return Response.json({ available: false }, { headers });
  }
  if (meta.deleted) return Response.json({ available: false }, { headers });
  if (!new URL(request.url).pathname.endsWith('/download')) return Response.json({ available: true, ...meta }, { headers });
  if (!meta.finishedAt) return Response.json({ error: 'Recording is still being saved. Retry shortly.' }, { status: 409, headers });
  let index = -1;
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
    try {
      if (index === -1) { controller.enqueue(encoder.encode(JSON.stringify({ kind: 'manifest', ...meta }) + '\n')); index++; return; }
      if (index >= meta.chunks) { controller.enqueue(encoder.encode(JSON.stringify({ kind: 'end', chunks: meta.chunks }) + '\n')); controller.close(); return; }
      const records = await state.storage.get<DebugRecord[]>(chunkKey(index++));
      if (!records) { controller.error(new Error('Recording chunk missing or deleted')); return; }
      controller.enqueue(encoder.encode(records.map(r => JSON.stringify(r)).join('\n') + '\n'));
    } catch (error) { controller.error(error); }
  } });
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'application/x-ndjson',
    'Content-Disposition': `attachment; filename="call-${meta.callId}.debug.ndjson"` } });
}

const code = (value: unknown) => typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value) ? value : undefined;
// Never persist arbitrary provider errors, URLs, headers or credentials.
export function debugProviderEvent(event: Record<string, any>): Record<string, unknown> {
  return { type: code(event.type), responseId: code(event.response_id ?? event.response?.id),
    itemId: code(event.item_id), status: code(event.response?.status),
    reason: code(event.response?.status_details?.reason), errorType: code(event.error?.type), errorCode: code(event.error?.code),
    audioStartMs: typeof event.audio_start_ms === 'number' ? event.audio_start_ms : undefined,
    audioEndMs: typeof event.audio_end_ms === 'number' ? event.audio_end_ms : undefined };
}
export function debugClientEvent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || !['audio_state', 'flush', 'playback_start', 'playback_end', 'speech_start', 'speech_end',
    'speech_error', 'capture_gap', 'vad_start', 'vad_end', 'socket_error', 'socket_close', 'teardown', 'capture'].includes(v.name)) return null;
  return { name: v.name, clientMs: typeof v.ms === 'number' && Number.isFinite(v.ms) ? v.ms : undefined,
    value: typeof v.value === 'string' ? code(v.value) : typeof v.value === 'number' && Number.isFinite(v.value) ? v.value : undefined };
}

// An allowlist at the trusted service boundary still excludes raw provider payloads.
export function parseDebugUpload(body: Record<string, unknown>): Record<string, unknown>[] | null {
  if (!Number.isSafeInteger(body.sequence) || (body.sequence as number)<0 || typeof body.partial!=='boolean' || typeof body.complete!=='boolean' || !Array.isArray(body.records) || body.records.length>32 || encoder.encode(JSON.stringify(body)).length>48_000) return null;
  const result:Record<string,unknown>[]=[];
  for (const value of body.records) {
    if (!value || typeof value!=='object' || Array.isArray(value)) return null;
    const r=value as Record<string,unknown>;
    if(typeof r.sourceMs!=='number'||!Number.isFinite(r.sourceMs)||r.sourceMs<0||r.sourceMs>3_600_000)return null;
    if(r.kind==='audio') {
      if(!['caller','agent'].includes(String(r.track))||!['pcm_s16le_16000','pcm_s16le_24000','pcm_s16le_48000'].includes(String(r.format))||typeof r.data!=='string'||!r.data.length||r.data.length>16_000||r.data.length%4!==0||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.data))return null;
      const bytes=atob(r.data).length;if(bytes%2)return null;
      result.push({kind:'audio',track:r.track,format:r.format,data:r.data,sourceMs:r.sourceMs});
    } else if(r.kind==='capture'&&['speech_start','speech_end','interrupted','cancel','truncate','playback_start','playback_end','error','stopped','gap'].includes(String(r.name))) result.push({kind:'capture',name:r.name,sourceMs:r.sourceMs});
    else return null;
  }
  return result;
}
