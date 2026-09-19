# Release checklist

This release is not approval to deploy production or claim live telephone readiness.

## Code release

- [ ] Pass required CI on the final commit.
- [ ] Resolve real review findings and obtain the required PR-Agent security and major-issue clearance before merging.

## External acceptance still required

- [ ] Rehearse a fresh installation and production-shaped migration/preservation/recovery using separate disposable resources. A D1 backup does not restore Durable Object state. See [migration compatibility](../migration-compatibility.md).
- [ ] Verify authenticated setup and an actual microphone conversation against an independently configured provider. Synthetic PCM and browser graph tests do not prove physical audio or provider behavior.
- [ ] Verify interruption follow-up in an audible real-provider call: old playback stops, the matching new answer completes, and only then does the next prompt begin. Strict provider-explicit natural-VAD causality is not established by the existing recordings.
- [ ] Complete a consented SIP/PSTN pilot with the chosen carrier, number and spending explicitly authorized. Telnyx setup still requires the authorized account login; the existing support appeal must not be duplicated. See [pilot evaluation](pilot-evaluation.md).
- [ ] Before a separately approved production deployment, confirm operator/hostname/provider configuration, take a fresh backup, verify rollback/recovery, and explicitly enable only accepted routes. See [production preflight](production-preflight.md).

## Existing evidence and limits

The [corrective staging recording](demo/corrected/README.md) demonstrates canonical opening hours, missing-phone handling and persisted messages with a disclosed synthetic caller. Its interruption follow-up is inconclusive. The [original recording](demo/audible/README.md) remains labeled with its failures.

Local tests cover provider configuration, stale knowledge writes, confirmed deletion, reservation cleanup, and realtime transport bounds. Past synthetic and silent-browser checks do not establish live-provider, microphone, physical audibility or PSTN acceptance. See [audio harness](demo/capture-harness.md) for reproducible local commands.

### Model-independent audio checks — 2026-09-18

Development tests reproduced rapid-output cutoffs and rejected transcription
prompts before correction. With bounded output pacing, local workerd calls using
real Kataleptic `gpt-realtime-2.1-mini` and `llama-3.3-70b` delivered all generated
PCM without output errors; the mini answer lasted 28.2 seconds. A separate actual
Chrome AudioContext test played 30 seconds of synthetic PCM and released all
buffers (peak queued playback about 1.25 seconds). Run it with
`node test/realtime-playout-smoke.mjs`; optionally set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a local Chrome executable.

The actual transcription helper passed German audio against
`whisper-large-v3-turbo`, `gpt-4o-transcribe`, `gpt-transcribe`, and
`gpt-4o-transcribe-diarize`. Diarization took approximately 7.3 seconds on this
single-speaker sample; this is not a speaker-separation test or latency guarantee.
The earlier streaming `/listen` probes returned upstream-unreachable errors;
those protocols remain outside the multipart transcription adapter. Physical
speaker/microphone interruption quality, independent-provider and PSTN acceptance
remain separate checks.

### Graceful closing checks — 2026-09-19

The [closing controller](../call-closing.md) passed 1,783 tests, both TypeScript
checks and the production build. Original regressions reproduced immediate
closure after a tool-only response and before late goodbye audio. Tests cover
one replacement farewell, cancellation, provider loss/rotation, timeouts,
playback IDs and browser speech errors. Actual Chrome played 30 seconds of
synthetic PCM: eight nodes remained at the ending marker, and acknowledgement
arrived only after they finished (672 ms later, zero remaining buffers).
Actual workerd Asterisk playback preserved mark/flow-control drainage and emitted
the matching completion acknowledgement; the PBX and audio were synthetic. Telnyx, Asterisk, direct OpenAI and gateway
workerd smoke checks also passed after their fixtures gained the missing
`response.done` event exposed by the first CI run.

Local workerd/D1 calls against real Kataleptic `gpt-realtime-2` and
`llama-3.3-70b` completed Spanish farewells. A separate realtime-v2 tool-only
response triggered exactly one generated farewell, saved it to the transcript,
and completed normally. The proxy had a missing-audio fault option armed but
suppressed zero events in that run. Inputs were synthetic text and playback was
a paced simulated consumer; these runs do not prove physical audibility or PSTN
acceptance. An earlier v2 run completed the protocol successfully but its final
transcript-export query failed on a fixture column name; that failure remains
separate from the subsequent successful calls.

Component BYOK adds migration 0022 and independent workspace speech settings.
Remote migration/deployment and live custom-provider speech acceptance remain
pending; see [configuration and rollout](component-byok.md).
