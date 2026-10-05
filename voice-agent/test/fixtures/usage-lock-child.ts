import { existsSync } from 'node:fs';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageOutbox } from '../../src/usage-outbox.js';
const [directory, mode, releasePath] = process.argv.slice(2) as [
  string,
  string,
  string,
];
const box = new UsageOutbox(
  directory,
  'https://synthetic.invalid',
  'synthetic'
);
const temporary = join(
  directory,
  'a'.repeat(64) + '.json.11111111-1111-1111-1111-111111111111.tmp'
);
const tell = (type: string) => process.send?.({ type, pid: process.pid });
if (mode === 'contender') {
  const kill = process.kill;
  let paused = false;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    try {
      const result = kill(pid, signal);
      if (paused) tell('live_owner');
      return result;
    } catch (error) {
      if (!paused && (error as NodeJS.ErrnoException).code === 'ESRCH') {
        paused = true;
        tell('stale_observed');
        // Hold the real stale liveness decision while another process replaces the lock.
        while (!existsSync(releasePath))
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      throw error;
    }
  }) as typeof process.kill;
}
try {
  if (mode === 'holder') {
    await (box as any).withLock(async () => {
      await writeFile(temporary, 'pending usage canary');
      const release = new Promise<void>((resolve) =>
        process.once('message', () => resolve())
      );
      tell('holding');
      await release;
      await access(temporary);
      tell('preserved');
    });
  } else await box.assertAvailable();
  tell('done');
} catch {
  tell('failed');
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}
