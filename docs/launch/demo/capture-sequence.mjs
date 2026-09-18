// Local capture orchestration only. No account, network, provider or filesystem access.
// The observer must retain real input/response IDs; never infer them from a timer.
export class CaptureSequence {
  #turn;
  #responses = new Set();
  #chunks = new Set();
  #playback = new Map();

  beginTurn(turnId, acceptTranscript) {
    if (!turnId || typeof acceptTranscript !== 'function') throw new Error('Turn ID and transcript acceptance check required');
    this.cancel('Turn superseded by interruption');
    this.#turn = { turnId, acceptTranscript, response: null, inputItemId: null, waiters: [], settled: false };
  }

  // Acknowledge the provider input item corresponding to this scripted utterance.
  inputCommitted({ turnId, inputItemId }) {
    const turn = this.#turn;
    if (!turn || turn.turnId !== turnId || turn.settled) return;
    if (!inputItemId || (turn.inputItemId && turn.inputItemId !== inputItemId)) return this.#fail('Ambiguous caller input item');
    turn.inputItemId = inputItemId;
  }

  responseStarted({ inputItemId, responseId }) {
    const turn = this.#turn;
    if (!turn || turn.settled || !turn.inputItemId || inputItemId !== turn.inputItemId) return;
    if (!responseId || this.#responses.has(responseId) || turn.response) return this.#fail('Missing, reused or competing response ID');
    this.#responses.add(responseId);
    turn.response = { responseId, chunks: new Set(), played: new Set(), completion: null };
  }

  // Call before scheduling each decoded playback chunk. IDs must be unique per call.
  audioQueued({ responseId, chunkId }) {
    if (!responseId || !chunkId) return this.#fail('Uncorrelated audio cannot establish response completion');
    if (this.#chunks.has(chunkId)) return this.#fail('Duplicate playback chunk ID');
    this.#chunks.add(chunkId);
    this.#playback.set(chunkId, responseId);
    const response = this.#turn?.response;
    if (response?.responseId !== responseId || this.#turn.settled) return;
    if (response.chunks.has(chunkId)) return this.#fail('Reused playback chunk ID');
    response.chunks.add(chunkId);
    this.#check();
  }

  // Report actual AudioBufferSource completion; a stopped/flushed chunk was not played.
  playbackEnded({ chunkId, reason = 'played' }) {
    const responseId = this.#playback.get(chunkId);
    if (!responseId) return; // late/duplicate callbacks never increment progress
    this.#playback.delete(chunkId);
    const response = this.#turn?.response;
    if (response?.responseId === responseId && !this.#turn.settled) {
      if (reason !== 'played') return this.#fail('Expected response playback was interrupted');
      response.played.add(chunkId);
    }
    this.#check();
  }

  // Full generation completion, not transcript.done, an audio pause, or queue drain.
  // audioChunkCount includes every chunk of this response, including not-yet-scheduled
  // chunks, so async decoding cannot release the next prompt prematurely.
  responseCompleted({ responseId, status, transcript, audioChunkCount }) {
    const turn = this.#turn;
    const response = turn?.response;
    if (!turn || turn.settled || response?.responseId !== responseId) return;
    if (status !== 'completed') return this.#fail('Expected response did not complete successfully');
    if (!Number.isSafeInteger(audioChunkCount) || audioChunkCount < 1) return this.#fail('Completed response has no counted audio');
    if (response.completion) return this.#fail('Duplicate response completion');
    response.completion = { transcript, audioChunkCount };
    this.#check();
  }

  waitForResponse({ timeoutMs = 20_000, signal } = {}) {
    const turn = this.#turn;
    if (!turn) return Promise.reject(new Error('No active capture turn'));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('Positive timeout required'));
    if (signal?.aborted) { this.cancel('Capture aborted'); return Promise.reject(new Error('Capture aborted')); }
    if (turn.error) return Promise.reject(turn.error);
    if (turn.result) return Promise.resolve(turn.result);
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel('Capture aborted');
      const timer = setTimeout(() => this.#fail('Timed out waiting for correlated response and playback', turn), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      turn.waiters.push({ resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  cancel(message = 'Capture cancelled') { if (this.#turn && !this.#turn.settled) this.#fail(message); }

  #fail(message, turn = this.#turn) {
    if (!turn || turn.settled) return;
    turn.settled = true;
    turn.error = new Error(message);
    for (const waiter of turn.waiters.splice(0)) waiter.reject(turn.error);
  }

  #check() {
    const turn = this.#turn;
    const response = turn?.response;
    if (!turn || turn.settled || !response?.completion) return;
    const { transcript, audioChunkCount } = response.completion;
    if (response.chunks.size > audioChunkCount) return this.#fail('Response audio count mismatch');
    if (response.chunks.size !== audioChunkCount || response.played.size !== audioChunkCount || this.#playback.size) return;
    let accepted = false;
    try { accepted = typeof transcript === 'string' && turn.acceptTranscript(transcript) === true; }
    catch { return this.#fail('Transcript acceptance check failed'); }
    if (!accepted) return this.#fail('Completed response did not satisfy the scripted acceptance check');
    turn.settled = true;
    turn.result = { turnId: turn.turnId, responseId: response.responseId, transcript, audioChunkCount };
    for (const waiter of turn.waiters.splice(0)) waiter.resolve(turn.result);
  }
}

// Replacement for finished(cumulativeCount) followed by speak(nextPrompt).
// Register observer events before playCaller; an uncorrelated browser wire times out.
// This function never retries a prompt or starts a provider session.
export async function capturePrompt(sequence, { turnId, playCaller, acceptTranscript, timeoutMs, signal }) {
  if (signal?.aborted) throw new Error('Capture aborted before caller playback');
  sequence.beginTurn(turnId, acceptTranscript);
  const completion = sequence.waitForResponse({ timeoutMs, signal });
  // Attach the rejection handler before caller playback (which may take seconds).
  const observed = completion.then(value => ({ value }), error => ({ error }));
  try { await playCaller(turnId); }
  catch (error) { sequence.cancel('Caller playback failed'); await observed; throw error; }
  const result = await observed;
  if (result.error) throw result.error;
  return result.value;
}
