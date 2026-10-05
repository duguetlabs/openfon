import { AzureUsageCapture } from '../../src/usage.js';
import { UsageOutbox } from '../../src/usage-outbox.js';
import { within } from '../../src/deadline.js';
const directory = process.argv[2]!;
let entered!: () => void;
const sending = new Promise<void>((resolve) => {
  entered = resolve;
});
const box = new UsageOutbox(
  directory,
  'https://synthetic.invalid',
  'synthetic',
  async () => {
    entered();
    await new Promise(() => {});
  }
);
const capture = new AzureUsageCapture(
  'call_1',
  'job_1',
  (observation) =>
    box.send({
      callId: 'call_1',
      jobId: 'job_1',
      room: 'room_1',
      callback: 'synthetic',
      observation,
    }),
  () => {}
);
capture.observe({ type: 'session.started', session: { id: 'session_1' } });
capture.observe({ type: 'session.usage.updated', usage: { seconds: 1 } });
await sending;
capture.observe({ type: 'session.closed', usage: { seconds: 2.5 } });
await (box as any).flushPersistence?.();
let expired = false;
try {
  await within(capture.flush(), 100);
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'Call operation deadline')
    throw error;
  expired = true;
}
if (!expired) throw Error('remote unexpectedly settled');
process.send?.({ type: 'flush_expired' });
// Parent kills this actual process, then replays its durable records in a new owner.
setInterval(() => {}, 10000);
