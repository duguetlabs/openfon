# Response-specific capture sequencing

Local-only follow-up to the inconclusive interruption segment in the [corrective recording](corrected/README.md). Neither recording, saved result nor qualified acceptance claim is changed. No provider request is made by this harness or its tests.

## Shared correction

[`capture-sequence.mjs`](capture-sequence.mjs) replaces the old `totalPlayback > before && queueEmpty && quiet` condition with a response-scoped barrier. `capturePrompt` plays exactly one caller prompt and resolves only after all of the following:

1. The observer binds the scripted turn to the provider’s committed input-item ID.
2. A new response explicitly refers to that input, with an unused response ID.
3. That response completes successfully and supplies its final transcript and total audio-chunk count.
4. Every counted chunk of that response actually finishes playback. Async decoding/queueing must finish too; a late last chunk cannot be skipped. Any remaining old playback must also stop.
5. The final transcript meets the caller’s explicit acceptance predicate. For the repair question, a filler such as “Let me think” is insufficient.

Old input/response events and playback-ended callbacks cannot provide progress for the new response. Cancellation, failed generation, current-response flush, missing correlation, timeout or rejected transcript stop the sequence instead of sending another caller prompt. `capturePrompt` contains no retry, account creation, session setup, credential loading or network connection.

## Observer contract — do not infer missing IDs

The observer feeds `inputCommitted`, `responseStarted`, `audioQueued`, `playbackEnded` and `responseCompleted`. IDs must be traced to the actual provider input/response and its corresponding browser playback. `audioChunkCount` must count the complete response even if some audio is still awaiting decode/scheduling. Send `playbackEnded(reason: 'stopped')` for cancelled sources, not `'played'`. Do not convert an audio pause or transcript completion into successful full generation completion.

**The currently deployed browser wire does not expose these correlations.** It forwards anonymous PCM plus `transcript`, `agent_text` and `flush`; guessing that everything after a flush belongs to the new response recreates the race. This module therefore is not represented as an already-wired live browser recorder. A response-aware observer/telemetry bridge must first retain the provider IDs and full completion status through the capture playback path. Missing correlation must time out or fail; there is intentionally no timing-based fallback. Product/transport changes are outside this local-only follow-up and remain integration-owned.

Once such an observer is connected, the caller sequence uses:

```js
await capturePrompt(sequence, {
  turnId: 'repair-after-interruption',
  playCaller: turnId => playPreparedMicClip(turnId),
  acceptTranscript: text => /cannot guarantee.*staff confirmation/i.test(text),
  timeoutMs: 20_000,
  signal: captureAbortSignal,
});
// Reached only after the matching response completes and its playback drains.
await playNextPreparedPrompt();
```

The regex is a deterministic fixture example, not a universal semantic evaluator. Configure acceptance to recognize the intended answer without demanding an exact wording. A future live recording still needs review of what was actually spoken.

## Offline regression evidence

Run with Node, without dependencies or network:

```sh
node --test docs/launch/demo/capture-sequence.test.mjs
```

The main regression runs the real `capturePrompt` continuation. It feeds queued/late chunks and completion from the interrupted services response, then proves the next caller prompt has **not** run. It also reconstructs why the former count/quiet predicate would pass that trace. Only successful completion of the matching new response plus its last actually-played chunk releases the next prompt.

Other cases cover a delayed old response-start, new audio arriving after generation completion, a quiet gap before generation completion, filler-only output, failed/cancelled/incomplete generation, stopped new audio, anonymous PCM, leftover old playback, duplicate playback-end callbacks, timeout, abort, caller-playback failure and superseded turns. These are synthetic event traces; they do not upgrade either recorded call’s evidence.

## Exact remaining live acceptance

After a reviewed response-aware observer is wired and locally verified, a coordinated bounded run still needs to interrupt actual audible services output, hear the old playback stop, wait for the **matching new response** to give a substantive repair-timing answer, hear it finish, and only then send the next caller question. Preserve provider/playback correlation evidence, audible output, transcript and persisted result. Confirm it does not promise an unconfirmed same-day repair. Report latency only if measured with an appropriate audio-timing method.

That live interruption-follow-up check is still unverified. The corrected Saturday-hours, missing-phone and message-persistence passes remain valid for their recorded scope. This follow-up made no live call, staging mutation or release-branch change. Integration chooses whether to include the isolated harness commit in its next reviewed candidate.
