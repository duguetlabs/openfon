# Release checklist

This release is not approval to deploy production or claim live telephone readiness.

## Code release

- [ ] Pass required CI on the final commit.
- [ ] Resolve real review findings and obtain the required PR-Agent security and major-issue clearance before merging.

## External acceptance still required

- [ ] Rehearse a fresh installation and production-shaped migration/preservation/recovery using separate disposable resources. A D1 backup does not restore Durable Object state. See [migration compatibility](../migration-compatibility.md).
- [ ] Verify authenticated setup and an actual microphone conversation against an independently configured provider. Synthetic PCM and browser graph tests do not prove physical audio or provider behavior.
- [ ] Resolve reported restaurant-background false interruptions and failed endings on the smart-glasses microphone. Generic historical output errors do not identify the failed guard; new call records distinguish receipt, queue, rate and response failures.
- [ ] Verify interruption follow-up in an audible real-provider call: old playback stops, the matching new answer completes, and only then does the next prompt begin. Strict provider-explicit natural-VAD causality is not established by the existing recordings.
- [ ] Kataleptic model retirement: after migration 0024 and the new defaults (`kataleptic-realtime-hd`, `gpt-transcribe`) are live, run `scripts/retire-kataleptic-instance-defaults.sql` against production D1 (separately authorized, after a backup), place at least one English and one German call through the shipped realtime path and one pipeline call, and confirm production D1 holds no `kataleptic-realtime`, chat-model realtime, Piper-voice, `whisper-large-v3-turbo` or retired open-chat-model selection. Only then tell Kataleptic its cutover may proceed.
- [ ] GPT-Live (`gpt-live-1`): gateway and optional OpenFon consumer deployed on 2026-09-26. Local full-application tests through real Kataleptic passed greeting, answers, caller-farewell closure, saved turns and summary; a separate forced delegation probe passed `end_call`. Complete actual browser/microphone and interruption acceptance, then a separately authorized telephone call covering the same behavior. Synthetic caller/playback with local storage does not establish those gates; see [realtime providers](../realtime-providers.md#gpt-live-gpt-live-1).
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

Component BYOK and migration 0022 are deployed to staging at application release
`079f3ee` (2026-09-19). A fresh staging backup restored successfully; rehearsal
preserved existing rows, and remote integrity, deployment bindings, health and
built assets passed verification. Production is unchanged. Live custom-provider
speech acceptance remains pending; see [configuration and rollout](component-byok.md).

### Independent summary configuration

Migration 0023 and independent Call summaries settings are deployed to staging
at application release `d0ddf750bedadb015c9f88bbfe565ba8cf692ac7`
(2026-09-19), version `37311060-a7bc-4356-9e00-c5da504995e0`, at 100%.
This supersedes the component-BYOK staging release recorded above. The fresh
backup restored successfully; rehearsal preserved all existing rows and columns.
Remote integrity/FK checks, deployment bindings, health, exact built HTML/JS/CSS,
and unauthenticated summary-route rejection passed. No summary settings were
created: existing calls retain compatibility behavior until the owner chooses
independent summaries. Production is unchanged.

Before production rollout, verify a completed call with the selected summary
provider and confirm its saved summary; deployment verification and synthetic
routing tests do not establish live-provider acceptance.

### Voice selection and repeated browser playback

Selected realtime voices are acknowledged before generation, and the same
engine speaks the greeting. Local workerd/D1 with real Kataleptic confirmed
selected Alloy and HD Seraphina and received PCM. Chrome checks cover six
successive calls, resource closure and recovery from deliberate AudioContext
suspension, plus saved selection, reservation cancellation and cached previews.
The user's historical silence was not reproduced; these checks do not establish
physical audibility on the affected device. Confirm repeated calls there before
closing that acceptance item. Unreliable automated voice-presentation estimates
remain unclassified pending a reviewed listening assessment.

### Background noise and hands-free interruptions

The shared prompt now gives concise unclear-speech guidance and permits a
cautious noise explanation when appropriate. Hands-free Realtime interruption,
VAD thresholds, silence windows and browser microphone processing are unchanged.
This instruction change is not a provider noise-cancellation fix.

A controlled German test used actual local workerd/D1 and real Kataleptic,
with a paced PCM receiver. The inputs were three overlapping synthetic preview
voices plus white noise, a question at nominal +10 dB foreground/background RMS,
an intentional interruption during queued playback, and a clean recovery
question after the noise stopped. The background includes intelligible greeting
fragments; these tests cannot prove the model can distinguish nearby people from
the caller. The final prompt was exercised separately on all six realtime configurations.
Each run returned new audio after the interruption and
after the recovery question, with no reported output error. Calls were manually
ended by the harness; this does not test natural goodbye or physical audibility.

| Realtime mode | Noisy question and interruption follow-up | Clean recovery | Remaining observation |
| --- | --- | --- | --- |
| Standard | Relevant German answer, then answered the interruption | German answer and new audio | Tool-format marker in the background-response transcript |
| HD | Relevant answer, then answered the interruption | German answer and new audio | Responded to background-only speech |
| Native 2 | Relevant answer, then answered the interruption | German answer and new audio | Attempted clarification of background-only speech |
| Native 2.1 | Relevant answer, then answered the interruption | German answer and new audio | Responded to background-only speech |
| Native 2.1 Mini | Relevant answer, then answered the interruption | German answer and new audio | Responded to background-only speech |
| Standard with `llama-3.3-70b` | Relevant answer, then answered the interruption | German answer and new audio | Background speech and formatting remain acceptance risks |

Playback flush followed the synthetic intentional interruption in 112–327 ms
across these runs. This is a single observed sample per mode, not a latency
promise. No repeated-apology loop occurred, but background-only speech elicited
a response in every mode. Keep restaurant/smart-glasses acceptance open;
model instructions alone do not provide speaker separation or prevent VAD
cancellation. Standard language consistency and custom-model spoken formatting
also need acceptance before recommending those configurations for rollout. An
old-prompt Standard comparison also produced English replies to German questions
and a tool-format marker; these are not established regressions from this change.
The initial custom-model greeting transcript contained formatting text as well.

Actual Chrome tests used a synthetic Web Audio microphone stream, the real
browser recording/playback code, local workerd/D1 and real Kataleptic services.
Native 2 interrupted active PCM playback and spoke the follow-up and recovery
answers; the audio context stayed running. Pipeline used Whisper transcription,
Llama chat and installed browser speech. With initial guidance it prematurely
requested closure after background speech. After explicitly instructing it to
wait for the caller to finish the conversation, it stayed live through the noisy
question and clean recovery, with all four browser utterances reaching their end
events. Speech overlapping its answer was ignored, preserving half-duplex behavior.
These are observed model outcomes, not deterministic prompt guarantees. The first
final Pipeline run did not wait long enough to observe asynchronous D1 finalization;
its active-row readback is not classified as a completed-call check. A second
final Pipeline run repeated the noise sequence, recognized an intentional German
goodbye, finished browser speech before closing, and persisted a completed call
without a failure code. No physical
microphone, acoustic echo cancellation, arbitrary BYOK provider or PSTN acceptance
is implied.

### Debug recording acceptance

Test Studio supports opt-in deployment-wide recording for owner test calls; see
[debug recordings](../call-debug-recordings.md) for access, retention and replay.
Local real Worker storage checks cover byte preservation, owner isolation,
restart and expiry; Chrome checks cover Pipeline diagnostic microphone capture,
recording disclosure and deletion. These use synthetic input. Recordings cannot
recover historical audio, prove physical speaker playback, or reproduce a model
response deterministically. Browser-generated speech has text/events only.
Quiet and restaurant-noise tests with the actual smart-glasses microphone remain
physical acceptance items; hands-free interruption settings are unchanged.
