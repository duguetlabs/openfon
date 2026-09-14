import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({
  mode: 'normal', commands: [] as string[][],
  containers: new Map<string, { name: string; label?: string }>(),
  ownId: 'a'.repeat(64), foreignId: 'b'.repeat(64), name: '',
  logged: [] as string[], removed: [] as string[], executed: [] as string[],
  proxyClosed: false, websocketsClosed: false,
  handler: (_args: string[]): string => { throw Error('fake Docker not initialized'); },
}));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => { throw Error('unexpected callback form'); }, {
    [Symbol.for('nodejs.util.promisify.custom')]: async (_file: string, args: string[]) =>
      ({ stdout: fixture.handler(args), stderr: '' }),
  }),
}));
vi.mock('node:http', () => ({
  createServer: () => {
    let onError: (error: Error) => void;
    const proxy = {
      on: () => proxy,
      once: (_event: string, callback: (error: Error) => void) => { onError = callback; return proxy; },
      listen: (_port: number, _host: string, callback: () => void) => {
        if (fixture.mode === 'pre-run') onError(Error('proxy bind failed')); else callback();
      },
      close: (callback: (error?: Error) => void) => { fixture.proxyClosed = true; callback(); },
    };
    return proxy;
  },
}));
vi.mock('ws', () => ({
  WebSocket: class {},
  WebSocketServer: class { close() { fixture.websocketsClosed = true; } },
}));
// Import the actual original/fixed runtime, not a recreated lifecycle. The new
// helper is intentionally not imported, so original controls reach its old path.
import { runAsteriskRuntime } from '../scripts/asterisk-runtime.mjs';

let temp: string;
const primary = Error('fixture stops after container startup');
const failure = (message: string, stderr = message, code = 1) => Object.assign(Error(message), { code, stderr });
function find(reference: string) {
  const row = [...fixture.containers].find(([id, value]) => id === reference || value.name === reference);
  if (!row) throw failure('missing', `Error: No such container: ${reference}`);
  return row;
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'openfon-owned-runtime-test-'));
  fixture.mode = 'normal'; fixture.name = ''; fixture.commands = [];
  fixture.containers.clear(); fixture.logged = []; fixture.removed = []; fixture.executed = [];
  fixture.proxyClosed = false; fixture.websocketsClosed = false;
  vi.stubEnv('DOCKER_CONTEXT', 'fixture-local'); vi.stubEnv('DOCKER_HOST', 'ssh://ignored');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fixture.handler = full => {
    fixture.commands.push([...full]);
    if (full[0] === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///fixture.sock' } } }]);
    expect(full.slice(0, 2)).toEqual(['--host', 'unix:///fixture.sock']);
    const args = full.slice(2);
    if (args[0] === 'info') return args[2].includes('OperatingSystem') ? '"Docker Desktop"' : '[]';
    if (args[0] === 'image') return '[]';
    if (args[0] === 'run') {
      fixture.name = args[args.indexOf('--name') + 1];
      const labelAt = args.indexOf('--label');
      const label = labelAt < 0 ? undefined : args[labelAt + 1].split('=').slice(1).join('=');
      if (fixture.mode === 'collision') {
        fixture.containers.set(fixture.foreignId, { name: fixture.name, label: 'different-invocation' });
        throw failure('run name collision');
      }
      if (fixture.mode === 'before-create') throw failure('run failed before creation');
      fixture.containers.set(fixture.ownId, { name: fixture.name, label });
      if (fixture.mode === 'partial-create') throw failure('CLI failed after creation');
      if (fixture.mode === 'wrong-returned-id') {
        fixture.containers.set(fixture.foreignId, { name: 'foreign-container', label: 'different-invocation' });
        return fixture.foreignId;
      }
      if (fixture.mode === 'malformed-return') return 'not-a-full-container-id';
      return fixture.ownId;
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const reference = args.at(-1)!;
      if (fixture.mode === 'inspect-unavailable') throw failure('inspection denied', 'permission denied');
      if (fixture.mode === 'invalid-inspect') return 'invalid-inspect-private-sentinel';
      const [id, value] = find(reference);
      return JSON.stringify([id, value.label]);
    }
    if (args[0] === 'exec') {
      const [id] = find(args[1]); fixture.executed.push(args[1]);
      expect(id).toBe(fixture.ownId); return 'Asterisk fixture';
    }
    if (args[0] === 'logs') {
      const [id] = find(args.at(-1)!); fixture.logged.push(id);
      return id === fixture.ownId ? 'owned fixture log' : 'foreign private log';
    }
    if (args[0] === 'rm') {
      const [id] = find(args.at(-1)!); fixture.removed.push(args.at(-1)!);
      if (fixture.mode === 'remove-fails') throw failure('remove failed', 'daemon unavailable');
      fixture.containers.delete(id); return id;
    }
    throw Error('Unexpected fake Docker command: ' + args[0]);
  };
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(temp, { recursive: true, force: true }); });
async function run() {
  try {
    await runAsteriskRuntime({ temp, db: {}, telemetry: [], password: 'synthetic-only', wait: async (predicate: () => Promise<boolean>) => {
      await predicate();
      if (fixture.mode === 'name-replaced' || fixture.mode === 'auto-removed') {
        fixture.containers.delete(fixture.ownId);
        if (fixture.mode === 'name-replaced') fixture.containers.set(fixture.foreignId, { name: fixture.name, label: 'replacement' });
      }
      throw primary;
    } });
  } catch (error) { return error as Error & { errors?: Error[] }; }
  throw Error('Fixture should stop or fail before audio');
}
function closed() { expect(fixture.proxyClosed).toBe(true); expect(fixture.websocketsClosed).toBe(true); }
function effectArgs() { return fixture.commands.map(args => args.slice(2)).filter(args => ['exec', 'logs', 'rm'].includes(args[0])); }

it('pre-run proxy failure performs no container lookup, logs or removal', async () => {
  fixture.mode = 'pre-run';
  fixture.containers.set(fixture.foreignId, { name: `openfon-asterisk-${process.pid}`, label: 'preexisting' });
  const error = await run(); expect(error.message).toBe('proxy bind failed');
  expect(fixture.commands.some(args => args[2] === 'run' || args[2] === 'container')).toBe(false);
  expect(effectArgs()).toEqual([]); expect(fixture.containers.has(fixture.foreignId)).toBe(true); closed();
});
it('a colliding unowned name never authorizes logs or removal', async () => {
  fixture.mode = 'collision';const error = await run();
  expect(effectArgs()).toEqual([]);expect(fixture.containers.has(fixture.foreignId)).toBe(true);
  expect(error.message).toContain('failed');closed();
});
it('a failed run without a container is distinguished from failed inspection', async () => {
  fixture.mode = 'before-create';const error = await run();
  expect(error.message).toBe('run failed before creation');expect(error.errors).toBeUndefined();
  expect(effectArgs()).toEqual([]);closed();
});
it('ambiguous creation recovers only the matching invocation and acts by full CID', async () => {
  fixture.mode = 'partial-create';const error = await run();
  expect(error.message).toBe('CLI failed after creation');
  expect(fixture.logged).toEqual([fixture.ownId]);expect(fixture.removed).toEqual([fixture.ownId]);
  expect(fixture.containers.size).toBe(0);closed();
});
it('verifies returned ID ownership and cannot diagnose or delete its foreign container', async () => {
  fixture.mode = 'wrong-returned-id';const error = await run();
  expect(error.message).toContain('ownership');
  expect(fixture.executed).toEqual([]);expect(fixture.logged).toEqual([fixture.ownId]);
  expect(fixture.removed).toEqual([fixture.ownId]);expect(fixture.containers.has(fixture.foreignId)).toBe(true);closed();
});
it('malformed CLI output cannot prove ownership but matching-label recovery can clean its partial creation', async () => {
  fixture.mode = 'malformed-return';const error = await run();
  expect(error.message).toContain('full Asterisk container ID');expect(fixture.executed).toEqual([]);
  expect(fixture.removed).toEqual([fixture.ownId]);closed();
});
it('exec and failure diagnostics/removal use verified CID, not the name', async () => {
  const error = await run();expect(error).toBe(primary);
  expect(fixture.name).toMatch(/^openfon-asterisk-\d+-[a-f0-9-]{36}$/);
  expect(fixture.executed).toEqual([fixture.ownId]);expect(fixture.logged).toEqual([fixture.ownId]);
  expect(fixture.removed).toEqual([fixture.ownId]);expect(effectArgs().every(args => args.at(-1) === fixture.ownId || args[1] === fixture.ownId)).toBe(true);closed();
});
it('a replacement using the old name is untouched after the owned CID disappears', async () => {
  fixture.mode = 'name-replaced';const error = await run();expect(error).toBe(primary);
  expect(fixture.logged).toEqual([]);expect(fixture.removed).toEqual([]);
  expect(fixture.containers.has(fixture.foreignId)).toBe(true);closed();
});
it('automatic removal is safe absence rather than cleanup uncertainty', async () => {
  fixture.mode = 'auto-removed';const error = await run();expect(error).toBe(primary);
  expect(fixture.logged).toEqual([]);expect(fixture.removed).toEqual([]);closed();
});
it.each(['inspect-unavailable', 'invalid-inspect'])('unknown ownership (%s) fails closed with local disposal', async mode => {
  fixture.mode = mode;const error = await run();expect(error).toBeInstanceOf(AggregateError);
  expect(effectArgs()).toEqual([]);expect(fixture.containers.has(fixture.ownId)).toBe(true);
  expect(error.errors?.[0].message).toContain('ownership');
  expect(error.errors?.every(item => !item.message.includes('private-sentinel'))).toBe(true);closed();
});
it('failed owned removal preserves primary error and reports uncertainty without retaining local resources', async () => {
  fixture.mode = 'remove-fails';const error = await run();expect(error).toBeInstanceOf(AggregateError);
  expect(error.cause).toBe(primary);expect(error.errors?.[0]).toBe(primary);
  expect(error.errors?.some(item => item.message.includes('could not be removed'))).toBe(true);
  expect(fixture.removed).toEqual([fixture.ownId]);expect(fixture.containers.has(fixture.ownId)).toBe(true);closed();
});
