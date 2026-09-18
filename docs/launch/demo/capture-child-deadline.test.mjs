import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const helperUrl = process.env.CAPTURE_CHILD_HELPER
  ? pathToFileURL(process.env.CAPTURE_CHILD_HELPER) : new URL('./capture-child.mjs', import.meta.url);
const { observeCaptureChild } = await import(helperUrl.href);
const helperSource = readFileSync(helperUrl, 'utf8');
// Extract only the final cleanup block; never import/run capture or e2e-server.
const captureSource = readFileSync(new URL('./capture.mjs', import.meta.url), 'utf8');
const marker = '\n} finally {';
assert.equal(captureSource.split(marker).length, 2);
const cleanupBody = captureSource.slice(captureSource.indexOf(marker) + marker.length).trim();
assert.ok(cleanupBody.endsWith('}'));
const cleanup = new (Object.getPrototypeOf(async function () {}).constructor)(
  'browser', 'stopServer', 'rmSync', 'temporary', cleanupBody.slice(0, -1),
);

const outcome = promise => promise.then(() => ({ type: 'resolved' }), error => ({ type: 'rejected', error }));
async function watchdog(promise, ms = 7500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => {
      timer = setTimeout(() => resolve({ type: 'TEST_WATCHDOG' }), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function ready(child, text) {
  // Removing a data listener preserves the pipe; exiting a stream async
  // iterator would destroy it and could give the fixture an artificial EPIPE.
  return new Promise((resolve, reject) => {
    let output = '';
    const dispose = () => {
      child.stdout.removeListener('data', data);
      child.removeListener('exit', exited);
      child.removeListener('error', failed);
    };
    const data = chunk => {
      output += chunk;
      if (output.includes(text)) { dispose(); resolve(); }
    };
    const exited = () => { dispose(); reject(new Error(`Owned child exited before ${text}`)); };
    const failed = error => { dispose(); reject(error); };
    child.stdout.on('data', data);
    child.once('exit', exited);
    child.once('error', failed);
  });
}
async function reap(child) {
  // Test-only escalation of this fixture's owned child, after diagnostics.
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    assert.notEqual((await watchdog(exit))?.type, 'TEST_WATCHDOG', 'owned child reaped');
  }
}
function timeoutError(error, pid) {
  assert.equal(error?.code, 'CAPTURE_CHILD_STOP_TIMEOUT');
  assert.equal(error.pid, pid);
  assert.equal(error.timeoutMs, 5000);
  assert.match(error.message, /exit is unconfirmed/);
}

test('real owned child accepts SIGTERM but stays alive: deadline rejects and existing cleanup removes wrapper directory', async t => {
  // Actual OS delivery/receipt with capture-like stdio; a deliberate fixture
  // handler is not evidence that real npx/workerd shutdown has stalled.
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM', () => process.stdout.write('received\\n')); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = observeCaptureChild(child);
  const temporary = mkdtempSync(join(tmpdir(), 'openfon-deadline-test-'));
  const calls = [];
  const kill = child.kill.bind(child);
  child.kill = signal => { const sent = kill(signal); calls.push({ signal, sent }); return sent; };
  let stdout = '', exits = 0, errors = 0, browserClosed = false, settled = false;
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.on('exit', () => exits++);
  child.on('error', () => errors++);
  let result;
  try {
    if (!stdout.includes('ready')) assert.notEqual((await watchdog(ready(child, 'ready')))?.type, 'TEST_WATCHDOG');
    const started = Date.now();
    const run = outcome(cleanup({ close: async () => { browserClosed = true; } }, stop, rmSync, temporary));
    run.then(() => { settled = true; });
    result = await watchdog(run);
    t.diagnostic(JSON.stringify({ scope: 'real owned child, deliberate SIGTERM handler', pid: child.pid,
      result: result.type, code: result.error?.code, elapsedMs: Date.now() - started,
      calls, stdout, exits, errors, exitCode: child.exitCode, signalCode: child.signalCode,
      browserClosed, temporaryExists: existsSync(temporary), settled }));
    // Preserve the original pending/watchdog diagnosis before first assertion.
    assert.equal(result.type, 'rejected');
    timeoutError(result.error, child.pid);
    assert.ok(Date.now() - started >= 5000);
    assert.deepEqual(calls, [{ signal: 'SIGTERM', sent: true }]);
    assert.match(stdout, /received/);
    assert.equal(exits, 0); assert.equal(errors, 0);
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    assert.equal(browserClosed, true); assert.equal(existsSync(temporary), false);
    const again = stop();
    assert.equal(stop(), again);
    assert.equal((await outcome(again)).error, result.error);
    assert.equal(calls.length, 1);
  } finally {
    await reap(child);
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('real owned child exits gracefully after SIGTERM before the deadline', async t => {
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 30)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = observeCaptureChild(child);
  let calls = 0;
  const kill = child.kill.bind(child);
  child.kill = signal => { calls++; return kill(signal); };
  try {
    assert.notEqual((await watchdog(ready(child, 'ready')))?.type, 'TEST_WATCHDOG');
    const first = stop();
    assert.equal(stop(), first);
    const result = await watchdog(outcome(first));
    t.diagnostic(JSON.stringify({ scope: 'real owned graceful child', pid: child.pid, calls,
      result: result.type, exitCode: child.exitCode, signalCode: child.signalCode }));
    assert.equal(result.type, 'resolved');
    assert.equal(child.exitCode, 0); assert.equal(calls, 1);
  } finally { await reap(child); }
});

function synthetic(kill = () => true, overrides = {}) {
  // Exact helper body with lexical timer injection, not rewritten timing or
  // global clock mutation. These are synthetic event/scheduling controls only.
  assert.equal(helperSource.split('export function observeCaptureChild').length, 2);
  const timers = [];
  const factory = new Function('setTimeout', 'clearTimeout',
    helperSource.replace('export function observeCaptureChild', 'function observeCaptureChild') + '\nreturn observeCaptureChild;');
  const observe = factory((callback, ms) => {
    const timer = { callback, ms, cleared: false }; timers.push(timer); return timer;
  }, timer => { if (timer) timer.cleared = true; });
  let calls = 0;
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null,
    kill(signal) { calls++; return kill.call(this, signal); } }, overrides);
  const stop = observe(child);
  const exit = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); };
  return { child, stop, timers, exit, calls: () => calls };
}
function deadline(h) {
  assert.equal(h.timers.length, 1, 'live stop installs one deadline');
  assert.equal(h.timers[0].ms, 5000);
  return h.timers[0];
}

test('synthetic prior error plus deadline preserves both errors and safely observes late error/exit', async () => {
  const h = synthetic();
  const prior = new Error('injected prior error');
  h.child.emit('error', prior);
  try {
    const first = h.stop(), observed = outcome(first);
    assert.equal(h.stop(), first);
    const timer = deadline(h); timer.callback();
    const result = await observed;
    assert.ok(result.error instanceof AggregateError);
    assert.equal(result.error.errors[0], prior);
    timeoutError(result.error.errors[1], h.child.pid);
    assert.equal(timer.cleared, true);
    h.child.emit('error', new Error('injected late error; not exit'));
    assert.equal(h.child.signalCode, null);
    h.exit();
    assert.equal((await outcome(h.stop())).error, result.error);
    assert.equal(h.calls(), 1);
    assert.equal(h.child.listenerCount('error'), 0);
  } finally { h.exit(); }
});

test('synthetic synchronous exit wins over a stale deadline callback and clears timer', async () => {
  const h = synthetic(function () { this.signalCode = 'SIGTERM'; this.emit('exit', null, 'SIGTERM'); return true; });
  const first = h.stop();
  const timer = deadline(h);
  assert.equal(timer.cleared, true);
  // Deliberately invoke a canceled callback: settlement must remain exit.
  timer.callback();
  assert.equal((await outcome(first)).type, 'resolved');
  assert.equal(h.stop(), first); assert.equal(h.calls(), 1);
});

test('synthetic deadline wins over same-turn late exit and remains one rejected attempt', async () => {
  const h = synthetic();
  try {
    const first = h.stop(), observed = outcome(first);
    const timer = deadline(h); timer.callback(); h.exit();
    const result = await observed;
    timeoutError(result.error, h.child.pid);
    assert.equal(timer.cleared, true);
    timer.callback();
    assert.equal((await outcome(h.stop())).error, result.error);
    assert.equal(h.calls(), 1);
  } finally { h.exit(); }
});

test('synthetic new stop error wins before deadline and retains prior error identity', async () => {
  const h = synthetic(), prior = new Error('prior'), failure = new Error('stop failure');
  h.child.emit('error', prior);
  try {
    const observed = outcome(h.stop());
    const timer = deadline(h);
    h.child.emit('error', failure); timer.callback();
    const result = await observed;
    assert.deepEqual(result.error.errors, [prior, failure]);
    assert.equal(timer.cleared, true);
    assert.equal(h.child.signalCode, null);
  } finally { h.exit(); }
});

for (const mode of ['false', 'throw']) {
  test(`synthetic failed signal ${mode} clears deadline without confirming exit`, async () => {
    const failure = new Error('synthetic kill failure');
    const h = synthetic(() => { if (mode === 'throw') throw failure; return false; });
    try {
      const observed = outcome(h.stop());
      const timer = deadline(h);
      assert.equal(timer.cleared, true); timer.callback();
      const result = await observed;
      if (mode === 'throw') assert.equal(result.error, failure);
      else assert.match(result.error.message, /SIGTERM was not sent; exit is unconfirmed/);
      assert.equal(h.child.signalCode, null); assert.equal(h.calls(), 1);
    } finally { h.exit(); }
  });
}

for (const state of ['terminal', 'no-pid']) {
  test(`synthetic ${state} prior error does not create a deadline or signal`, async () => {
    const h = synthetic(() => { throw new Error('unexpected signal'); },
      state === 'terminal' ? { exitCode: 0 } : { pid: undefined });
    const prior = new Error('injected early failure');
    h.child.emit('error', prior);
    try {
      assert.equal((await outcome(h.stop())).error, prior);
      assert.equal(h.timers.length, 0); assert.equal(h.calls(), 0);
    } finally { h.exit(); }
  });
}
