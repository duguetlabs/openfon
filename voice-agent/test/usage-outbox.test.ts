import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readdir,
  readFile,
  stat,
  rm,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageOutbox, type PendingUsage } from '../src/usage-outbox.js';
import { AdmissionError } from '../src/control.js';
const value: PendingUsage = {
  callId: 'call_1',
  room: 'room_1',
  jobId: 'job_1',
  callback: 'synthetic-capability',
  observation: {
    eventId: 'event_1',
    callId: 'call_1',
    jobId: 'job_1',
    source: 'azure_voice',
    providerSessionId: 'session_1',
    observedAt: '2026-10-05T00:00:00.000Z',
    final: true,
    metrics: { voiceSessionSeconds: '2.5' },
  },
};
test('usage persists before failed callback; a restarted process replays identical observation and removes only ACKed data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openfon-usage-test-'));
  try {
    const original = new UsageOutbox(
      dir,
      'https://fixed.example',
      'synthetic-key',
      async () => {
        throw Error('offline');
      }
    );
    await original.assertAvailable();
    await assert.rejects(() => original.send(value));
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    assert.equal(names.length, 1);
    assert.equal((await stat(join(dir, names[0]!))).mode & 0o777, 0o600);
    const raw = await readFile(join(dir, names[0]!), 'utf8');
    assert.ok(!raw.includes('synthetic-key'));
    assert.ok(!raw.includes('https://fixed.example'));
    assert.deepEqual(JSON.parse(raw).value, value);
    const delivered: PendingUsage[] = [];
    const restarted = new UsageOutbox(
      dir,
      'https://fixed.example',
      'synthetic-key',
      async (v) => {
        delivered.push(v);
      }
    );
    assert.deepEqual(await restarted.replay(), {
      sent: 1,
      pending: 0,
      dead: 0,
      expired: 0,
    });
    assert.deepEqual(delivered, [value]);
    assert.deepEqual(await readdir(dir), ['.replay-cursor']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('revoked/deleted calls quarantine instead of retrying forever or changing account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openfon-usage-test-'));
  try {
    const box = new UsageOutbox(
      dir,
      'https://fixed.example',
      'key',
      async () => {
        throw new AdmissionError(410);
      }
    );
    await assert.rejects(() => box.send(value));
    assert.equal((await box.replay()).dead, 1);
    assert.ok((await readdir(dir)).some((n) => n.endsWith('.dead')));
    assert.equal((await box.replay()).dead, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('full durable queue rejects new paid admission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openfon-usage-test-'));
  try {
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        writeFile(join(dir, i.toString(16).padStart(64, '0') + '.json'), '{}')
      )
    );
    await assert.rejects(
      () =>
        new UsageOutbox(dir, 'https://fixed.example', 'key').assertAvailable(),
      /full/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('malformed and oversized journals quarantine, expire, and never reach the callback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openfon-usage-test-'));
  try {
    const { utimes } = await import('node:fs/promises');
    const names = ['a'.repeat(64), 'b'.repeat(64)];
    await writeFile(join(dir, names[0] + '.json'), '{bad');
    await writeFile(join(dir, names[1] + '.json'), 'x'.repeat(17000));
    const box = new UsageOutbox(dir, 'https://fixed.example', 'key', async () =>
      assert.fail('malformed delivery')
    );
    assert.deepEqual(await box.replay(), {
      sent: 0,
      pending: 0,
      dead: 2,
      expired: 0,
    });
    for (const name of names)
      await utimes(join(dir, name + '.dead'), new Date(0), new Date(0));
    assert.deepEqual(await box.replay(), {
      sent: 0,
      pending: 0,
      dead: 0,
      expired: 2,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('crash leftovers are removed under the writer lock before admitting new work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openfon-usage-test-'));
  try {
    await writeFile(
      join(
        dir,
        'a'.repeat(64) + '.json.11111111-1111-1111-1111-111111111111.tmp'
      ),
      'unused'
    );
    await writeFile(
      join(dir, '11111111-1111-1111-1111-111111111111.probe'),
      'unused'
    );
    await new UsageOutbox(
      dir,
      'https://fixed.example',
      'key'
    ).assertAvailable();
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
