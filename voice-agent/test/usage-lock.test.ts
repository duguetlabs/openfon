import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, access, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function start(directory: string, mode: string, release: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./fixtures/usage-lock-child.ts', import.meta.url)),
      directory,
      mode,
      release,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  const messages: string[] = [];
  let waiter: ((value: string) => void) | undefined;
  child.on('message', (message: any) => {
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(message.type);
    } else messages.push(message.type);
  });
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve())
  );
  return {
    child,
    exited,
    next: () =>
      messages.length
        ? Promise.resolve(messages.shift()!)
        : new Promise<string>((resolve) => {
            waiter = resolve;
          }),
  };
}
test(
  'competing processes cannot reap a replacement owner or prune its live journal',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openfon-journal-race-'));
    const release = join(directory, 'release-stale');
    const children: Array<ReturnType<typeof start>> = [];
    const spawnChild = (mode: string) => {
      const child = start(directory, mode, release);
      children.push(child);
      return child;
    };
    try {
      const crashed = spawnChild('holder');
      assert.equal(await crashed.next(), 'holding');
      crashed.child.kill('SIGKILL');
      await crashed.exited;
      const stale = spawnChild('contender');
      assert.equal(await stale.next(), 'stale_observed');
      const current = spawnChild('holder');
      assert.equal(await current.next(), 'holding');
      await writeFile(release, 'release');
      const observed = await stale.next();
      const preserved = await access(
        join(
          directory,
          'a'.repeat(64) + '.json.11111111-1111-1111-1111-111111111111.tmp'
        )
      ).then(
        () => true,
        () => false
      );
      console.info(
        JSON.stringify({
          event: 'competing_process_evidence',
          observed,
          liveTemporaryPreserved: preserved,
        })
      );
      assert.equal(
        observed,
        'live_owner',
        'stale decision must respect replacement owner before entering pruneTemporary'
      );
      assert.equal(preserved, true, 'live journal survives stale contender');
      current.child.send('release');
      assert.equal(await current.next(), 'preserved');
      assert.equal(await current.next(), 'done');
      await current.exited;
      let next = await stale.next();
      while (next === 'live_owner') next = await stale.next();
      assert.equal(next, 'done');
      await stale.exited;
      assert.equal(current.child.exitCode, 0);
      assert.equal(stale.child.exitCode, 0);
    assert.deepEqual(await readdir(directory), ['release-stale']);
    } finally {
      for (const { child } of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      await Promise.all(children.map((c) => c.exited));
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test('legacy or unknown lock ownership fails closed without deleting operator state', async () => {
  const { mkdir, readdir, readFile, utimes } = await import('node:fs/promises');
  const { UsageOutbox } = await import('../src/usage-outbox.js');
  const directory = await mkdtemp(join(tmpdir(), 'openfon-journal-legacy-'));
  try {
    const lock = join(directory, 'writer.lock');
    await mkdir(lock);
    await writeFile(join(lock, 'pid'), '2147483647');
    await utimes(lock, new Date(0), new Date(0));
    await assert.rejects(
      new UsageOutbox(
        directory,
        'https://synthetic.invalid',
        'synthetic'
      ).assertAvailable(),
      /Usage journal unavailable/
    );
    assert.equal(await readFile(join(lock, 'pid'), 'utf8'), '2147483647');
    assert.deepEqual(
      await readdir(directory),
      ['writer.lock'],
      'failed acquisition cleans its own candidate only'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
