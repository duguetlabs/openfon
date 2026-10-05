import { createHash } from 'node:crypto';
export interface UsageObservation {
  eventId: string;
  callId: string;
  jobId: string;
  source: 'azure_voice' | 'azure_reasoning';
  providerSessionId: string;
  providerResponseId?: string;
  observedAt: string;
  final: boolean;
  metrics: {
    voiceSessionSeconds?: string;
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
  model?: string;
}
const record = (x: unknown): Record<string, unknown> | undefined =>
  x !== null && typeof x === 'object' && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : undefined;
const id = (x: unknown): string | undefined =>
  typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(x) ? x : undefined;
function seconds(value: unknown): string | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 86400
  )
    return;
  const fixed = value.toFixed(9);
  if (Number(fixed) !== value) return;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}
/** Preserve provider units and identities; the server ledger owns pricing and cumulative reconciliation. */
export class AzureUsageCapture {
  private sessionId?: string;
  private terminal = false;
  private pending = Promise.resolve();
  private failure: unknown;
  private queued = 0;
  private seen = new Set<string>();
  constructor(
    private callId: string,
    private jobId: string,
    private send: (o: UsageObservation) => Promise<unknown>,
    private fail: () => void
  ) {}
  observe(value: unknown): void {
    const event = record(value);
    if (!event) return;
    if (event.type === 'session.started') {
      if (this.sessionId && !this.terminal)
        this.observe({ type: 'openfon.usage.unreported' });
      this.sessionId = id(record(event.session)?.id);
      this.terminal = false;
      return;
    }
    if (!this.sessionId) return;
    let source: UsageObservation['source'],
      metrics: UsageObservation['metrics'] = {},
      final = false,
      responseId: string | undefined,
      model: string | undefined;
    if (
      event.type === 'session.usage.updated' ||
      event.type === 'session.closed' ||
      event.type === 'openfon.usage.unreported'
    ) {
      source = 'azure_voice';
      final = event.type === 'session.closed';
      if (final) this.terminal = true;
      model = 'gpt-live-1';
      const decimal = seconds(record(event.usage)?.seconds);
      if (decimal !== undefined) metrics.voiceSessionSeconds = decimal;
      else if (!final && event.type !== 'openfon.usage.unreported') return; // Missing terminal usage is explicitly retained as unknown, never zero.
    } else if (event.type === 'response.event') {
      const nested = record(event.event);
      if (
        !nested ||
        ![
          'response.completed',
          'response.failed',
          'response.incomplete',
        ].includes(String(nested.type))
      )
        return;
      const response = record(nested.response);
      responseId = id(response?.id);
      if (!responseId) return;
      source = 'azure_reasoning';
      final = true;
      model = id(response?.model);
      const usage = record(response?.usage),
        input = record(usage?.input_tokens_details),
        output = record(usage?.output_tokens_details);
      for (const [name, value] of Object.entries({
        inputTokens: usage?.input_tokens,
        cachedInputTokens: input?.cached_tokens,
        cacheWriteInputTokens: input?.cache_write_tokens,
        outputTokens: usage?.output_tokens,
        reasoningTokens: output?.reasoning_tokens,
        totalTokens: usage?.total_tokens,
      })) {
        if (
          typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value >= 0
        )
          (metrics as Record<string, number | string>)[name] = value;
      }
    } else return;
    const canonical = JSON.stringify({
      source,
      session: this.sessionId,
      responseId,
      final,
      metrics,
    });
    const observation: UsageObservation = {
      eventId: 'azure_' + createHash('sha256').update(canonical).digest('hex'),
      callId: this.callId,
      jobId: this.jobId,
      source,
      providerSessionId: this.sessionId,
      ...(responseId ? { providerResponseId: responseId } : {}),
      observedAt: new Date().toISOString(),
      final,
      metrics,
      ...(model ? { model } : {}),
    };
    if (this.seen.has(observation.eventId)) return;
    if (this.seen.size >= 10000) {
      this.failure = Error('Usage identity capacity exceeded');
      this.fail();
      return;
    }
    this.seen.add(observation.eventId);
    if (++this.queued > 1000) {
      this.failure = Error('Usage capture capacity exceeded');
      this.fail();
      return;
    }
    // Start local journal admission now; a prior remote callback must not keep
    // a terminal observation only in memory. The outbox serializes disk and
    // network work independently while this aggregate still tracks delivery.
    const delivery = (async () => {
      try {
        await this.send(observation);
      } catch (error) {
        this.failure = error;
        this.fail();
      } finally {
        this.queued--;
      }
    })();
    this.pending = Promise.all([this.pending, delivery]).then(() => {});
  }
  finish(): void {
    if (this.sessionId && !this.terminal)
      this.observe({ type: 'openfon.usage.unreported' });
  }
  async flush(): Promise<void> {
    await this.pending;
    if (this.failure) throw Error('Usage delivery unconfirmed');
  }
}
