import {
  mkdir,
  open,
  rename,
  readdir,
  readFile,
  unlink,
  stat,
  rmdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ControlClient, AdmissionError } from './control.js';
import type { UsageObservation } from './usage.js';
export interface PendingUsage {
  callId: string;
  room: string;
  jobId: string;
  callback: string;
  observation: UsageObservation;
}
interface Stored {
  createdAt: number;
  value: PendingUsage;
}
const LIMIT = 1000,
  MAX_BYTES = 16384,
  RETENTION_MS = 7 * 86400000;
/** Restricted persistent volume. No transcript, destination URL or provider/service key is stored. */
export class UsageOutbox {
  private writing: Promise<void> = Promise.resolve();
  private delivering: Promise<void> = Promise.resolve();
  private persistenceFailure: unknown;
  constructor(
    private directory: string,
    private base: string,
    private serviceKey: string,
    private deliverOverride?: (value: PendingUsage) => Promise<void>
  ) {
    if (!directory.startsWith('/') || directory.includes('\0'))
      throw Error('Usage outbox requires an absolute path');
  }
  private file(value: PendingUsage) {
    return join(
      this.directory,
      createHash('sha256')
        .update(value.callId + '\0' + value.observation.eventId)
        .digest('hex') + '.json'
    );
  }
  private async pruneTemporary(): Promise<void> {
    for (const name of await readdir(this.directory))
      if (
        /^(?:[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp|[a-f0-9-]{36}\.probe|\.replay-cursor\.[a-f0-9-]{36}\.tmp)$/.test(
          name
        )
      )
        await this.remove(join(this.directory, name));
  }
  private async syncDirectory() {
    const directory = await open(this.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, 'writer.lock');
    const identity = randomUUID();
    const ownerName = `pid-${process.pid}-${identity}`;
    const candidate = join(this.directory, `.writer-${identity}`);
    let acquired = false;
    await mkdir(candidate, { mode: 0o700 });
    try {
      // Publish an initialized, nonempty directory atomically. Contenders can never
      // mistake a slow writer's not-yet-created owner file for an abandoned lock.
      const owner = await open(join(candidate, ownerName), 'wx', 0o600);
      await owner.close();
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(candidate, lock);
          acquired = true;
          break;
        } catch (error) {
          if (
            !['EEXIST', 'ENOTEMPTY'].includes(
              (error as NodeJS.ErrnoException).code || ''
            ) ||
            attempt >= 50
          )
            throw Error('Usage journal unavailable');
          try {
            const names = await readdir(lock);
            const match =
              names.length === 1 &&
              /^pid-([1-9][0-9]*)-([a-f0-9-]{36})$/.exec(names[0]!);
            if (match && Number.isSafeInteger(Number(match[1]))) {
              try {
                process.kill(Number(match[1]), 0);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                  // Remove only the observed acquisition identity. A replacement
                  // owns a different filename, even when it reuses the same PID.
                  await unlink(join(lock, names[0]!));
                  // A concurrent initialized replacement makes this fail nonempty.
                  await rmdir(lock);
                }
              }
            }
            // Legacy fixed-name pid locks and unknown contents fail closed. Never
            // steal by age, or erase a directory after an unverified PID read.
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      return await fn();
    } finally {
      const ownedDirectory = acquired ? lock : candidate;
      await unlink(join(ownedDirectory, ownerName)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await rmdir(ownedDirectory).catch((error) => {
        // Once our unique owner is removed, another initialized lock may already
        // occupy writer.lock. Never remove that replacement's contents.
        if (
          !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
            (error as NodeJS.ErrnoException).code || ''
          )
        )
          throw error;
      });
    }
  }
  /** Before opening paid inference, fail closed if storage is unavailable or the bounded queue is full. */
  async assertAvailable(): Promise<void> {
    await this.withLock(async () => {
      await this.pruneTemporary();
      const names = await readdir(this.directory);
      if (names.filter((n) => /\.(json|dead)$/.test(n)).length >= LIMIT)
        throw Error('Usage journal full');
      const probe = join(this.directory, randomUUID() + '.probe');
      const file = await open(probe, 'wx', 0o600);
      try {
        await file.sync();
      } finally {
        await file.close();
        await unlink(probe);
      }
      await this.syncDirectory();
    });
  }
  async send(value: PendingUsage): Promise<void> {
    this.valid(value);
    // Queue disk work independently: later observations become durable even
    // when an earlier remote delivery is slow. Preserve callback order.
    const stored = this.writing.then(() => this.persist(value));
    this.writing = stored.then(
      () => {},
      (error) => {
        this.persistenceFailure = error;
      }
    );
    const delivery = this.delivering.then(async () => {
      const record = await stored;
      await this.deliver(record.value);
      await this.remove(this.file(record.value));
    });
    this.delivering = delivery.catch(() => {});
    // Surface disk failure immediately, even behind a stalled remote request.
    await Promise.all([stored, delivery]);
  }
  async flushPersistence(): Promise<void> {
    await this.writing;
    if (this.persistenceFailure)
      throw Error('Usage journal persistence unconfirmed');
  }
  private async persist(value: PendingUsage): Promise<Stored> {
    const target = this.file(value);
    return this.withLock(async () => {
      try {
        return JSON.parse(await readFile(target, 'utf8')) as Stored;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await this.pruneTemporary();
      const names = await readdir(this.directory);
      if (names.filter((n) => /\.(json|dead)$/.test(n)).length >= LIMIT)
        throw Error('Usage journal full');
      const stored: Stored = { createdAt: Date.now(), value },
        serialized = JSON.stringify(stored);
      if (Buffer.byteLength(serialized) > MAX_BYTES)
        throw Error('Usage record exceeds bound');
      const tmp = target + '.' + randomUUID() + '.tmp',
        file = await open(tmp, 'wx', 0o600);
      try {
        await file.writeFile(serialized);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, target);
      await this.syncDirectory();
      return stored;
    });
  }
  private async remove(file: string) {
    await unlink(file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await this.syncDirectory();
  }
  private valid(value: PendingUsage): void {
    if (
      !value ||
      !['callId', 'room', 'jobId', 'callback'].every(
        (key) =>
          typeof value[key as keyof PendingUsage] === 'string' &&
          (value[key as keyof PendingUsage] as string).length > 0 &&
          (value[key as keyof PendingUsage] as string).length <= 200
      ) ||
      !value.observation ||
      typeof value.observation.eventId !== 'string' ||
      value.observation.eventId.length > 200 ||
      value.observation.callId !== value.callId ||
      value.observation.jobId !== value.jobId
    )
      throw new AdmissionError(400);
  }
  private async deliver(value: PendingUsage) {
    this.valid(value);
    if (this.deliverOverride) return this.deliverOverride(value);
    const control = new ControlClient(
      this.base,
      this.serviceKey,
      value.callId,
      value.room,
      value.jobId
    );
    await control.post('events', {
      callback: value.callback,
      type: 'usage',
      observation: value.observation,
    });
  }
  async replay(
    limit = 20
  ): Promise<{ sent: number; pending: number; dead: number; expired: number }> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > LIMIT)
      throw Error('Invalid usage replay limit');
    const { names, selected } = await this.withLock(async () => {
      await this.pruneTemporary();
      const sorted = (await readdir(this.directory))
        .filter((name) => /^[a-f0-9]{64}\.(json|dead)$/.test(name))
        .sort();
      const cursorFile = join(this.directory, '.replay-cursor');
      let cursor = '';
      try {
        if ((await stat(cursorFile)).size > 80)
          throw Error('Invalid usage replay cursor');
        cursor = await readFile(cursorFile, 'utf8');
        if (!/^[a-f0-9]{64}\.json$/.test(cursor))
          throw Error('Invalid usage replay cursor');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const after = sorted.findIndex((name) => name > cursor);
      const start = after < 0 ? 0 : after;
      const names = [...sorted.slice(start), ...sorted.slice(0, start)];
      const selected = names
        .filter((name) => name.endsWith('.json'))
        .slice(0, limit);
      if (selected.length) {
        // Reserve the next bounded batch before callbacks. A restart or a
        // failed prefix must not repeatedly prevent later calls from delivery.
        const temporary = cursorFile + '.' + randomUUID() + '.tmp';
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(selected[selected.length - 1]!);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, cursorFile);
        await this.syncDirectory();
      }
      return { names, selected: new Set(selected) };
    });
    let sent = 0,
      dead = 0,
      expired = 0,
      pending = 0;
    for (const name of names) {
      const file = join(this.directory, name);
      try {
        const info = await stat(file);
        // Invalid records have no trustworthy createdAt; filesystem age bounds their quarantine.
        if (Date.now() - info.mtimeMs > RETENTION_MS) {
          await this.remove(file);
          expired++;
          continue;
        }
        if (name.endsWith('.dead')) {
          dead++;
          continue;
        }
        if (info.size > MAX_BYTES) throw new AdmissionError(400);
        let stored: Stored;
        try {
          stored = JSON.parse(await readFile(file, 'utf8')) as Stored;
        } catch {
          throw new AdmissionError(400);
        }
        if (
          !stored ||
          !Number.isFinite(stored.createdAt) ||
          stored.createdAt > Date.now() + 60000 ||
          !stored.value
        )
          throw new AdmissionError(400);
        this.valid(stored.value);
        if (Date.now() - stored.createdAt > RETENTION_MS) {
          await this.remove(file);
          expired++;
          continue;
        }
        if (this.file(stored.value) !== file) throw new AdmissionError(400);
        if (!selected.has(name)) {
          pending++;
          continue;
        }
        await this.deliver(stored.value);
        await this.remove(file);
        sent++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if (
          error instanceof AdmissionError &&
          [400, 403, 404, 409, 410].includes(error.status)
        ) {
          try {
            await rename(file, file.replace(/\.json$/, '.dead'));
            await this.syncDirectory();
            dead++;
          } catch {
            pending++;
          }
        } else pending++;
        // Transient failures remain queued; revoked/deleted/malformed records never change account.
      }
    }
    return { sent, pending, dead, expired };
  }
}
