import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSequence, capturePrompt } from './capture-sequence.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const acceptsRefusal = text => /cannot guarantee.*staff confirmation/i.test(text);
const start = (s, turnId, responseId) => {
  s.inputCommitted({ turnId, inputItemId: `input-${turnId}` });
  s.responseStarted({ inputItemId: `input-${turnId}`, responseId });
};
const finish = (s, responseId, audioChunkCount = 1, transcript = 'I cannot guarantee a repair; staff confirmation is required.') =>
  s.responseCompleted({ responseId, status: 'completed', audioChunkCount, transcript });

test('stale service chunks and completion cannot advance the next caller prompt after interruption', async () => {
  const s = new CaptureSequence();
  s.beginTurn('services', () => true);
  start(s, 'services', 'old-response');
  s.audioQueued({ responseId: 'old-response', chunkId: 'old-queued' });
  const spoken = [];
  const run = capturePrompt(s, {
    turnId: 'repair-question', acceptTranscript: acceptsRefusal,
    playCaller: async turnId => { spoken.push(turnId); start(s, turnId, 'new-response'); },
  }).then(() => spoken.push('next-unknown-question'));
  // The original recorder would see totalPlayback > before, an empty queue and
  // a quiet interval here. All of these events belong to the interrupted response.
  s.audioQueued({ responseId: 'old-response', chunkId: 'late-old' });
  s.playbackEnded({ chunkId: 'old-queued', reason: 'stopped' });
  s.playbackEnded({ chunkId: 'late-old' });
  finish(s, 'old-response');
  const legacyWouldAdvance = 2 > 1 && 0 === 0 && 1000 > 900;
  assert.equal(legacyWouldAdvance, true, 'the old cumulative-count/quiet predicate accepts this stale trace');
  await tick();
  assert.deepEqual(spoken, ['repair-question']);

  s.audioQueued({ responseId: 'new-response', chunkId: 'new-a' });
  s.playbackEnded({ chunkId: 'new-a' });
  await tick();
  assert.deepEqual(spoken, ['repair-question'], 'quietness alone is not generation completion');
  finish(s, 'new-response', 2);
  await tick();
  assert.deepEqual(spoken, ['repair-question'], 'generation done cannot skip async final chunk');
  s.audioQueued({ responseId: 'new-response', chunkId: 'new-b' });
  await tick();
  assert.deepEqual(spoken, ['repair-question'], 'scheduled audio must actually finish');
  s.playbackEnded({ chunkId: 'new-b' });
  await run;
  assert.deepEqual(spoken, ['repair-question', 'next-unknown-question']);
});

test('a delayed response-start for the previous input cannot bind to the new turn', async () => {
  const s = new CaptureSequence();
  s.beginTurn('new', acceptsRefusal);
  s.inputCommitted({ turnId: 'new', inputItemId: 'input-new' });
  s.responseStarted({ inputItemId: 'input-old', responseId: 'old' });
  s.audioQueued({ responseId: 'old', chunkId: 'old' });
  s.playbackEnded({ chunkId: 'old' });
  finish(s, 'old');
  await assert.rejects(s.waitForResponse({ timeoutMs: 10 }), /Timed out/);
});

test('filler is not accepted as the substantive post-interruption answer', async () => {
  const s = new CaptureSequence(); let next = false;
  const run = capturePrompt(s, { turnId: 'new', acceptTranscript: acceptsRefusal, playCaller: async () => {
    start(s, 'new', 'new'); s.audioQueued({ responseId: 'new', chunkId: 'a' });
    finish(s, 'new', 1, 'Let me think'); s.playbackEnded({ chunkId: 'a' });
  } }).then(() => { next = true; });
  await assert.rejects(run, /acceptance check/); assert.equal(next, false);
});

for (const status of ['cancelled', 'failed', 'incomplete']) test(`${status} generation cannot advance`, async () => {
  const s = new CaptureSequence(); s.beginTurn('t', acceptsRefusal); start(s, 't', 'r');
  s.responseCompleted({ responseId: 'r', status, transcript: 'done', audioChunkCount: 1 });
  await assert.rejects(s.waitForResponse(), /did not complete successfully/);
});

test('flushing a new response is not successful playback', async () => {
  const s = new CaptureSequence(); s.beginTurn('t', acceptsRefusal); start(s, 't', 'r');
  s.audioQueued({ responseId: 'r', chunkId: 'a' }); finish(s, 'r');
  s.playbackEnded({ chunkId: 'a', reason: 'stopped' });
  await assert.rejects(s.waitForResponse(), /interrupted/);
});

test('anonymous browser PCM cannot be treated as the awaited response', async () => {
  const s = new CaptureSequence(); s.beginTurn('t', acceptsRefusal);
  s.audioQueued({ chunkId: 'unknown' });
  await assert.rejects(s.waitForResponse(), /Uncorrelated audio/);
});

test('old playback still on the speaker delays even a complete new response', async () => {
  const s = new CaptureSequence(); s.audioQueued({ responseId: 'old', chunkId: 'old' });
  s.beginTurn('t', acceptsRefusal); start(s, 't', 'r');
  let done = false; const wait = s.waitForResponse().then(() => { done = true; });
  s.audioQueued({ responseId: 'r', chunkId: 'new' }); finish(s, 'r'); s.playbackEnded({ chunkId: 'new' });
  await tick(); assert.equal(done, false);
  s.playbackEnded({ chunkId: 'old', reason: 'stopped' }); await wait; assert.equal(done, true);
});

test('timeout and abort never play another caller prompt', async () => {
  const s = new CaptureSequence(); let calls = 0;
  await assert.rejects(capturePrompt(s, { turnId: 't', playCaller: async () => { calls++; }, acceptTranscript: acceptsRefusal, timeoutMs: 10 }), /Timed out/);
  assert.equal(calls, 1);
  const abort = new AbortController();
  const pending = capturePrompt(s, { turnId: 'u', playCaller: async () => { calls++; }, acceptTranscript: acceptsRefusal, signal: abort.signal });
  abort.abort(); await assert.rejects(pending, /aborted/); assert.equal(calls, 2);
});

test('superseding a waiting turn rejects its continuation', async () => {
  const s = new CaptureSequence(); s.beginTurn('old', acceptsRefusal);
  const wait = assert.rejects(s.waitForResponse(), /superseded/);
  s.beginTurn('new', acceptsRefusal); await wait;
  start(s, 'new', 'new'); s.audioQueued({ responseId: 'new', chunkId: 'new' }); finish(s, 'new'); s.playbackEnded({ chunkId: 'new' });
  assert.equal((await s.waitForResponse()).responseId, 'new');
});


test('an already aborted capture never emits caller audio', async () => {
  const s = new CaptureSequence(); const controller = new AbortController(); controller.abort();
  let called = false;
  await assert.rejects(capturePrompt(s, { turnId: 't', playCaller: async () => { called = true; }, acceptTranscript: acceptsRefusal, signal: controller.signal }), /aborted/);
  assert.equal(called, false);
});

test('duplicate playback-ended callbacks cannot substitute for an unplayed chunk', async () => {
  const s = new CaptureSequence(); s.beginTurn('t', acceptsRefusal); start(s, 't', 'r');
  s.audioQueued({ responseId: 'r', chunkId: 'a' }); s.audioQueued({ responseId: 'r', chunkId: 'b' });
  finish(s, 'r', 2); s.playbackEnded({ chunkId: 'a' }); s.playbackEnded({ chunkId: 'a' });
  let next = false; const pending = s.waitForResponse().then(() => { next = true; });
  await tick(); assert.equal(next, false); s.playbackEnded({ chunkId: 'b' }); await pending;
});

test('caller playback failure rejects instead of scheduling a next prompt', async () => {
  const s = new CaptureSequence();
  await assert.rejects(capturePrompt(s, { turnId: 't', acceptTranscript: acceptsRefusal, playCaller: async () => { throw new Error('fixture decode failed'); } }), /fixture decode failed/);
});
