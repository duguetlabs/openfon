import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeCaptureChild } from './capture-child.mjs';

// Read only the literal final cleanup body. Never import capture.mjs: doing so
// would start the browser/app/capture workflow. The override preserves exact
// original-source negatives while exercising the same test bodies.
const source = readFileSync(process.env.CAPTURE_CLEANUP_SOURCE || new URL('./capture.mjs', import.meta.url), 'utf8');
const marker = '\n} finally {';
assert.equal(source.split(marker).length, 2, 'one top-level cleanup block');
const body = source.slice(source.indexOf(marker) + marker.length).trim();
assert.ok(body.endsWith('}'));
const cleanup = new (Object.getPrototypeOf(async function () {}).constructor)(
  'browser', 'server', 'stopServer', 'rmSync', 'temporary', body.slice(0, -1),
);

// Test watchdog only; no timeout or escalation is added to the capture helper.
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('TEST_WATCHDOG: cleanup did not settle')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

function harness(child, browser) {
  const stop = observeCaptureChild(child);
  const temporary = mkdtempSync(join(tmpdir(), 'openfon-child-test-'));
  return {
    stop, temporary,
    run: () => bounded(cleanup(browser, child, stop, rmSync, temporary)),
    removed: () => !existsSync(temporary),
    dispose: () => rmSync(temporary, { recursive: true, force: true }),
  };
}

async function reap(child) {
  // Reap only the test's own child, including when a negative assertion fails.
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await bounded(exited);
  }
}

function realChild(code) {
  return spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}

for (const code of [0, 7]) {
  test(`already naturally exited child (${code}) is not signalled again`, async () => {
    const child = realChild(`process.exit(${code})`);
    const h = harness(child);
    try {
      await bounded(once(child, 'exit'));
      assert.equal(child.exitCode, code);
      child.kill = () => { throw new Error('must not signal terminal child'); };
      await h.run();
      assert.equal(h.removed(), true);
    } finally { h.dispose(); await reap(child); }
  });
}

test('already signalled child skips an exit event that has already fired', async () => {
  const child = realChild("process.send('ready'); setInterval(() => {}, 1000)");
  const h = harness(child);
  try {
    await bounded(once(child, 'message'));
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await bounded(exited);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, 'SIGTERM');
    // Exact old cleanup waits forever here. The watchdog bounds that negative.
    await h.run();
    assert.equal(h.removed(), true);
  } finally { h.dispose(); await reap(child); }
});

test('running child is signalled and cleanup waits for actual exit', async () => {
  const child = realChild("process.send('ready'); setInterval(() => {}, 1000)");
  const h = harness(child);
  let exitSeen = false;
  child.once('exit', () => { exitSeen = true; });
  try {
    await bounded(once(child, 'message'));
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    await h.run();
    assert.equal(exitSeen, true);
    assert.equal(child.signalCode, 'SIGTERM');
    assert.equal(h.removed(), true);
  } finally { h.dispose(); await reap(child); }
});

test('early real spawn error is stored without premature rejection and surfaces at cleanup', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'openfon-missing-child-')), 'not-an-executable');
  const child = spawn(missing, [], { stdio: 'ignore' });
  const h = harness(child);
  try {
    const [error] = await bounded(once(child, 'error'));
    assert.equal(error.code, 'ENOENT');
    // Let an unhandled rejection surface if the observer incorrectly rejected
    // before cleanup. node:test also reports unhandled async errors as failures.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(h.run(), actual => actual === error);
    assert.equal(h.removed(), true);
  } finally {
    h.dispose();
    rmSync(join(missing, '..'), { recursive: true, force: true });
    await reap(child);
  }
});

// Synthetic event controls cover conditions difficult to induce portably with
// real OS children; they are not represented as real kill failures or exits.
function controlledChild(kill) {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, killed: false, kill });
}

for (const mode of ['event', 'throw']) {
  test(`synthetic kill ${mode} error surfaces, removes temp, and is not exit proof`, async () => {
    const error = new Error(`synthetic kill ${mode} failure`);
    const child = controlledChild(function () {
      if (mode === 'throw') throw error;
      this.emit('error', error);
      return false;
    });
    const h = harness(child);
    let exitSeen = false;
    child.once('exit', () => { exitSeen = true; });
    try {
      await assert.rejects(h.run(), actual => actual === error);
      assert.equal(exitSeen, false);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.equal(h.removed(), true);
    } finally {
      h.dispose();
      // Dispose the synthetic observer only after asserting error is not exit.
      child.emit('exit', null, 'SIGTERM');
    }
  });
}

test('browser close failure does not bypass real child or temporary cleanup', async () => {
  const failure = new Error('synthetic browser close failure');
  const child = realChild("process.send('ready'); setInterval(() => {}, 1000)");
  const h = harness(child, { close: async () => { throw failure; } });
  try {
    await bounded(once(child, 'message'));
    await assert.rejects(h.run(), actual => actual === failure);
    assert.equal(child.signalCode, 'SIGTERM');
    assert.equal(h.removed(), true);
  } finally { h.dispose(); await reap(child); }
});

test('synthetic synchronous exit during kill sees preinstalled completion listener', async () => {
  const child = controlledChild(function (signal) {
    this.signalCode = signal;
    this.emit('exit', null, signal);
    return true;
  });
  const h = harness(child);
  try { await h.run(); assert.equal(h.removed(), true); }
  finally { h.dispose(); }
});

test('synthetic killed flag is not treated as confirmed exit', async () => {
  let killCalls = 0;
  let exitSeen = false;
  const child = controlledChild(function (signal) {
    killCalls++;
    setImmediate(() => {
      this.signalCode = signal;
      exitSeen = true;
      this.emit('exit', null, signal);
    });
    return true;
  });
  child.killed = true;
  const h = harness(child);
  try {
    await h.run();
    assert.equal(killCalls, 1);
    assert.equal(exitSeen, true);
    assert.equal(h.removed(), true);
  } finally { h.dispose(); }
});
