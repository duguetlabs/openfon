import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { UsageOutbox, type PendingUsage } from '../src/usage-outbox.js';
const entry = (i: number): PendingUsage => ({
  callId: 'call_' + i,
  room: 'room_' + i,
  jobId: 'job_' + i,
  callback: 'synthetic',
  observation: {
    callId: 'call_' + i,
    jobId: 'job_' + i,
    eventId: 'event_' + i,
    source: 'azure_voice',
    providerSessionId: 'session_' + i,
    observedAt: '2026-10-05T00:00:00Z',
    final: true,
    metrics: { voiceSessionSeconds: '2.5' },
  },
});
const journals = async (directory: string) =>
  Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map(async (name) => ({
        name,
        raw: await readFile(join(directory, name), 'utf8'),
      }))
  );
test(
  'terminal usage persists during a stalled callback and survives actual producer exit',
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'openfon-usage-durability-')
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(
          new URL('./fixtures/usage-durability-child.ts', import.meta.url)
        ),
        directory,
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
    );
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve())
    );
    try {
      const message: any = await new Promise((resolve) => {
        child.once('message', resolve);
        child.once('exit', () => resolve({ type: 'producer_exited' }));
      });
      assert.equal(message.type, 'flush_expired');
      const stored = await journals(directory);
      console.info(
        JSON.stringify({
          event: 'durability_evidence',
          recordCount: stored.length,
          remote: 'held',
          flush: 'synthetic100ms_expired',
        })
      );
      assert.equal(
        stored.length,
        2,
        'terminal snapshot must be durable before earlier callback resolves'
      );
      child.kill('SIGKILL');
      await exited;
      const delivered: PendingUsage[] = [];
      const restarted = new UsageOutbox(
        directory,
        'https://synthetic.invalid',
        'synthetic',
        async (v) => {
          delivered.push(v);
        }
      );
      assert.equal((await restarted.replay()).sent, 2);
      assert.deepEqual(
        delivered.sort((a, b) =>
          a.observation.eventId.localeCompare(b.observation.eventId)
        ),
        stored
          .map((x) => JSON.parse(x.raw).value)
          .sort((a, b) =>
            a.observation.eventId.localeCompare(b.observation.eventId)
          )
      );
      assert.equal(
        delivered.filter(
          (v) =>
            v.observation.final &&
            v.observation.metrics.voiceSessionSeconds === '2.5'
        ).length,
        1
      );
      assert.equal((await journals(directory)).length, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  }
);
test('bounded replay advances past persistent failures across supervisor restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openfon-usage-fairness-'));
  try {
    const box = new UsageOutbox(
      directory,
      'https://synthetic.invalid',
      'synthetic',
      async () => {
        throw Error('offline');
      }
    );
    for (let i = 0; i < 21; i++) await assert.rejects(box.send(entry(i)));
    const before = await journals(directory);
    const blocked = new Set(
      before.slice(0, 20).map((x) => JSON.parse(x.raw).value.callId)
    );
    const delivered: PendingUsage[] = [];
    let attempts = 0;
    const deliver = async (v: PendingUsage) => {
      attempts++;
      if (blocked.has(v.callId)) throw Error('retry later');
      delivered.push(v);
    };
    const first = new UsageOutbox(
      directory,
      'https://synthetic.invalid',
      'synthetic',
      deliver
    );
    const round1 = await first.replay(20);
    assert.equal(round1.sent, 0);
    assert.equal(attempts, 20);
    attempts = 0;
    const restarted = new UsageOutbox(
      directory,
      'https://synthetic.invalid',
      'synthetic',
      deliver
    );
    const round2 = await restarted.replay(20);
    assert.equal(
      round2.sent,
      1,
      'later deliverable call cannot starve behind first twenty failures'
    );
    assert.ok(attempts <= 20);
    assert.equal(delivered.length, 1);
    assert.deepEqual(
      await journals(directory),
      before.slice(0, 20),
      'unconfirmed records retain exact payload, creation time and identity'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('capacity failure is visible before a prior callback settles and is never reported durable', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { AzureUsageCapture } = await import('../src/usage.js');
  const directory = await mkdtemp(join(tmpdir(), 'openfon-usage-capacity-'));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let failures = 0;
  const box = new UsageOutbox(
    directory,
    'https://synthetic.invalid',
    'synthetic',
    async () => {
      entered();
      await gate;
    }
  );
  const capture = new AzureUsageCapture(
    'call_1',
    'job_1',
    (observation) => box.send({ ...entry(1), observation }),
    () => {
      failures++;
    }
  );
  try {
    capture.observe({ type: 'session.started', session: { id: 'session_1' } });
    capture.observe({ type: 'session.usage.updated', usage: { seconds: 1 } });
    await started;
    for (let i = 0; i < 999; i++)
      await writeFile(join(directory, 'capacity_' + i + '.json'), '{}');
    capture.observe({ type: 'session.closed', usage: { seconds: 2.5 } });
    await assert.rejects(box.flushPersistence(), /persistence unconfirmed/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      failures,
      1,
      'disk admission failure is observed while first callback stays held'
    );
    const stored = (await journals(directory)).filter(
      (x) => !x.name.startsWith('capacity_')
    );
    assert.equal(stored.length, 1);
    assert.equal(JSON.parse(stored[0]!.raw).value.observation.final, false);
  } finally {
    release();
    await capture.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
test('concurrent supervisors reserve different bounded batches without mutating unacknowledged journals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openfon-usage-batches-'));
  try {
    const failed = async () => {
      throw Error('offline');
    };
    const box = new UsageOutbox(
      directory,
      'https://synthetic.invalid',
      'synthetic',
      failed
    );
    for (let i = 0; i < 4; i++) await assert.rejects(box.send(entry(i)));
    const before = await journals(directory),
      attempts: string[] = [];
    const deliver = async (value: PendingUsage) => {
      attempts.push(value.callId);
      throw Error('later');
    };
    await Promise.all([
      new UsageOutbox(
        directory,
        'https://synthetic.invalid',
        'synthetic',
        deliver
      ).replay(2),
      new UsageOutbox(
        directory,
        'https://synthetic.invalid',
        'synthetic',
        deliver
      ).replay(2),
    ]);
    assert.equal(attempts.length, 4);
    assert.equal(new Set(attempts).size, 4);
    assert.deepEqual(await journals(directory), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('late local persistence rejection after a flush deadline remains observed and unconfirmed', async () => {
  const { AzureUsageCapture } = await import('../src/usage.js');
  const { within } = await import('../src/deadline.js');
  const directory = await mkdtemp(join(tmpdir(), 'openfon-usage-late-disk-'));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let failures = 0,
    delivered = 0;
  const box = new UsageOutbox(
    directory,
    'https://synthetic.invalid',
    'synthetic',
    async () => {
      delivered++;
    }
  );
  // Controlled local I/O failure after the caller's deadline; real queue/error plumbing.
  (box as any).persist = async () => {
    entered();
    await gate;
    throw Error('synthetic disk unavailable');
  };
  const capture = new AzureUsageCapture(
    'call_1',
    'job_1',
    (observation) => box.send({ ...entry(1), observation }),
    () => {
      failures++;
    }
  );
  try {
    capture.observe({ type: 'session.started', session: { id: 'session_1' } });
    capture.observe({ type: 'session.closed', usage: { seconds: 2.5 } });
    await started;
    await assert.rejects(within(box.flushPersistence(), 10), /deadline/);
    assert.equal(failures, 0);
    release();
    await assert.rejects(capture.flush(), /unconfirmed/);
    await assert.rejects(box.flushPersistence(), /persistence unconfirmed/);
    assert.equal(failures, 1);
    assert.equal(delivered, 0);
    assert.equal((await journals(directory)).length, 0);
  } finally {
    release();
    await capture.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
