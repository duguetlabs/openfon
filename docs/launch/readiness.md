# Release checklist

## Current managed release — 2026-10-05

The managed Web restructure and direct Azure implementation are merged through `24ab5b7` and deployed to staging. Production remains on its prior release. Customer routing controls are hidden and server-rejected; booking requests remain requests, and voice choices do not change post-call processing. Existing data, public links, credentials and historical routing columns are preserved.

Latest reviewed application evidence: 2,316 Worker tests/101 files, 60 Node tests, both typechecks/builds and migration/restore checks passed. PR-Agent security/major clearance, local Codex clearance, and all five current PR/merged-main CI jobs passed. The exact staging Worker/Node/configuration identities and data-preservation readbacks are recorded in [production preflight](production-preflight.md#current-deployment--2026-10-05).

Native in-app browser checks passed for the deployed navigation, stored inbox/history, business/assistant/privacy sections, compatible voice labels, and the specified monthly/annual prices. These were read-only; no voice sample, conversation, save, payment or carrier operation was invoked. A separate disposable-account HTTP smoke was blocked before account creation by Cloudflare 403/error 1010; staged account-create/save/delete API acceptance is therefore still unverified. No test account remains to clean up. Two remote query-path migration failures were retained; the separately rehearsed supported file-import path succeeded with full old-data preservation and only the two intended ledger additions.

Production direct-Azure routing is held until separately authorized actual authentication/transport/audio acceptance demonstrates nonzero audible output, selected voice, persisted transcript, summary/actions and clean closure. Health 200, zero rooms and synthetic audio fixtures do not establish these properties. Physical microphone/restaurant-noise and carrier acceptance remain separate.

Commercial sandbox evidence is tracked in [billing and costs](../commercial/billing-and-costs.md). Billing verification/new checkout remain off until actual usage aggregation, invoices and lifecycle acceptance pass. Phone provisioning remains gated pending authorized geography/budget and actual carrier validation. The latest two read-only sandbox usage-history checks remained empty; that does not prove zero usage or a failed charge. No new metering or invoice claim is made.

The remainder records historical evidence. Older Kataleptic and voice defaults describe those dated releases, not the current managed staging release's routing.


The browser application is launched at https://openfon.ai. Production deployment
was explicitly authorized; this is not live telephone/carrier acceptance.

Current production/staging versions, migrations and configuration differences are
recorded in [production preflight](production-preflight.md).

## Code release

- [x] Pass required CI on the final commit (`ab0dcd5`, run `37111794546`).
- [x] Resolve real review findings and obtain required PR-Agent security/major-issue and local Codex clearance before merging PR #42.

## External acceptance still required

- [ ] Rehearse a fresh installation and production-shaped migration/preservation/recovery using separate disposable resources. A D1 backup does not restore Durable Object state. See [migration compatibility](../migration-compatibility.md).
- [ ] Verify authenticated setup and an actual microphone conversation against an independently configured provider. Synthetic PCM and browser graph tests do not prove physical audio or provider behavior.
- [ ] Resolve reported restaurant-background false interruptions and failed endings on the smart-glasses microphone. Generic historical output errors do not identify the failed guard; new call records distinguish receipt, queue, rate and response failures.
- [ ] Verify interruption follow-up in an audible real-provider call: old playback stops, the matching new answer completes, and only then does the next prompt begin. Strict provider-explicit natural-VAD causality is not established by the existing recordings.
- [ ] Kataleptic model retirement: migration 0024 and the new defaults are deployed. The September 23 rollout recorded the instance-default cleanup and zero retired selections; do not blindly repeat that data rewrite. Complete the remaining production English/German demo-call acceptance and recheck provider selections before the October 23 cutover. Local provider tests do not establish that production-call acceptance.
- [ ] GPT-Live (`gpt-live-1`): gateway and optional OpenFon consumer deployed on 2026-09-26. Local full-application tests through real Kataleptic passed greeting, answers, caller-farewell closure, saved turns and summary; a separate forced delegation probe passed `end_call`. Complete actual browser/microphone and interruption acceptance, then a separately authorized telephone call covering the same behavior. Synthetic caller/playback with local storage does not establish those gates; see [realtime providers](../realtime-providers.md#gpt-live-gpt-live-1).
- [ ] Complete a consented SIP/PSTN pilot with the chosen carrier, number and spending explicitly authorized. Telnyx setup still requires the authorized account login; the existing support appeal must not be duplicated. See [pilot evaluation](pilot-evaluation.md).
- [x] For the explicitly authorized 2026-09-30 rollout, confirm hostname/provider configuration, take fresh backups, verify local restore integrity, record Worker rollback targets, and preserve disabled carrier routes. Repeat these controls before future production rollouts. See [production preflight](production-preflight.md).

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

Component BYOK and migration 0022 first reached staging at application release
`079f3ee` (2026-09-19). A fresh staging backup restored successfully; rehearsal
preserved existing rows, and remote integrity, deployment bindings, health and
built assets passed verification. Both code and migration are now in production
(2026-09-26 readback); the original staging rollout did not change production. Live custom-provider
speech acceptance remains pending; see [configuration and rollout](component-byok.md).

### Independent summary configuration

Migration 0023 and independent Call summaries settings first reached staging
at application release `d0ddf750bedadb015c9f88bbfe565ba8cf692ac7`
(2026-09-19), version `37311060-a7bc-4356-9e00-c5da504995e0`, at 100%.
This supersedes the component-BYOK staging release recorded above. The fresh
backup restored successfully; rehearsal preserved all existing rows and columns.
Remote integrity/FK checks, deployment bindings, health, exact built HTML/JS/CSS,
and unauthenticated summary-route rejection passed. No summary settings were
created: existing calls retain compatibility behavior until the owner chooses
independent summaries. That staging rollout did not change production; both the
summary feature and migration are now deployed to production (2026-09-26 readback).

Before enabling a newly selected summary provider for callers, verify a completed
call and its saved summary. The September 26 full-application GPT-Live probe used
real Kataleptic summaries with local storage; it does not establish acceptance
of arbitrary custom summary providers or production workspace configuration.

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

### Brand Identity rollout — 2026-09-28

Both environments now serve the reviewed Brand Identity release from PR #39. Fresh backups, source/version and exact asset checks are recorded in
[production preflight](production-preflight.md). Provider defaults, separate
staging storage, debug flags, disabled carriers and schedules are preserved.
No remote migration or paid inference/carrier call was performed. Staging's
retired saved cascade preset remains stored and now requires an explicit
supported replacement before it can be applied; active configurations passed
the compatibility preflight. Physical audio and provider/call acceptance items
above remain open.

### Baseline audio acceptance — 2026-09-30

The baseline checks below used reviewed application source `d6f3d3f`.
They exposed the Pipeline closing defect described below; they are not a claim
that every tested call behaved correctly.

- All 30 Native model/voice combinations (three models, ten voices), 19 GPT-Live
  voices and ten language-specific HD voices returned nonempty audio after the
  requested voice was acknowledged. The first matrix had two GPT-Live preview
  timeouts; each passed its single unchanged-source follow-up. Those failures
  remain evidence of intermittent preview availability, not a proven root cause
  or an automatic retry policy.
- Independent transcription checked the generated samples in their requested
  languages. A first Sol sample's transcript omitted “Guten”; a second sample
  included it. Rate-limit and timeout failures from the transcription service
  were retained separately from successful paced/alternate-model follow-ups.
  These checks establish speech content and language, not perceived gender,
  accent quality or equivalence to voices in the ChatGPT application.
- Local full-application workerd/D1 calls through real Kataleptic completed in
  English and German for HD, Native 2, Native 2.1, Mini and GPT-Live, with audio,
  spoken farewells, saved turns and summaries. Independent transcription of
  delivered audio also contained the farewells. The first Native 2 harness
  omitted control receipts; its failures were retained and the corrected harness
  matches the browser client. Initial fixtures had empty canonical hours that
  conflicted with instructions; those runs establish audio/closure only. Later
  Native 2 and deployed checks use explicit matching business hours.
- Fresh local validation passed 2,013 tests in 83 files and both TypeScript
  projects. Eight actual Chrome/workerd checks cover guided provider settings,
  saved voice selection, previews, debug controls, six consecutive calls and
  recovery from a deliberately suspended AudioContext.
- Fresh staging checks on version `e5d61eba-3c57-4092-8992-6f751844a0ca`
  passed HD and GPT-Live in both languages, and English Pipeline, including
  canonical hours, farewell delivery and completed records. German Pipeline
  prematurely closed after asking whether more help was needed. The initial
  harness counted record completion as a pass; transcript review disproved
  that conversational acceptance on both staging and production. Staging Pipeline uses
  browser speech: the API probe validates transcription/text/closure, not browser
  synthesis. One English Pipeline final-record fetch hit a connection timeout;
  its isolated follow-up passed. Synthetic accounts were deleted normally.

All caller inputs and playback acknowledgements in the provider probes were
synthetic. Private audio and original failures are retained outside Git.
Restaurant conversations on the smart glasses, acoustic echo cancellation,
physical audibility, arbitrary BYOK services and SIP/PSTN remain separate
acceptance items. Hands-free interruption policy is unchanged.

### Pipeline closing correction

A German Pipeline response answered a business-hours question, asked whether
more help was needed, and appended `END_CALL`. The call closed before the caller
could reply. The server now ignores that marker when the response contains a
question mark, keeping the line open for another caller turn. This applies to
all Pipeline text models and leaves realtime interruption behavior unchanged.
It is deliberately conservative for quoted/rhetorical questions; see
[closing policy](../call-closing.md). It is not general semantic verification of
when a conversation should end.

Three original regressions failed; the corrected call-session/closing suite
passed all 223 tests, including subsequent normal goodbye and playback
acknowledgement. PR #40's genuine PR-Agent security/major-issue and local Codex
reviews passed. The remote harness now explicitly rejects an ending after the
initial question and requires both caller turns to be saved.

The exact merged correction `debd746` passed final German and English Pipeline
calls on staging version `20bdd7b2-6fd8-4981-aedb-b69ec1ac81c8`, then reached
production version `4788a875-29ee-4bc4-8e92-43948c3b4543`. All four merged-source
CI jobs passed. Final calls through `openfon.ai` passed HD, GPT-Live and Azure
Pipeline in both languages, with the call remaining open after the question,
the caller's later goodbye, audio and saved completed records. Pipeline MP3
output was decoded to pace the simulated playback acknowledgement.

An earlier fixed-candidate English staging attempt failed after transcription
and before a reply; its original events remain retained and one isolated
follow-up passed. The underlying provider/network cause is unproven. The
final merged-source pair and all six domain calls passed without retries.
This does not promise zero provider failures or replace physical-device tests.
The initial hotspot DNS cache and precise launch checks are recorded in
[production preflight](production-preflight.md).

## LiveKit production release (2026-10-03)

PR #42 is merged and deployed to staging and production. It preserves the released layout, brand assets, authentication and business interfaces. Cloudflare retains application/state authority; separate Azure LiveKit and Node services carry browser audio to Kataleptic. See [current versions and rollback](production-preflight.md#current-livekit-deployment--2026-10-03), [worker setup](../../voice-agent/README.md) and [Azure operations](../../voice-agent/deploy/README.md).

### Verified evidence

- Reviewed `ccf62ba` and merged `ab0dcd5` have identical trees. Genuine PR-Agent security/major-issue clearance, independent local Codex review, exact PR CI and merged CI passed. Final local validation: 2,061 root tests/86 files, both root TypeScript projects/build and 34 Node tests/build. Earlier review rounds exposed real defects in startup timing/readiness, typed input ownership, goodbye completion and cleanup; those rounds are historical, not final clearance.
- The final staged typed-only call passed through actual Kataleptic and Azure on reviewed runtime source: 44 seconds, one unchanged caller row, three assistant rows, 36 partial updates/four finals, 981,600 output samples with peak 13,743, persisted summary/callback details and spoken goodbye followed by automatic closure. Readiness waited for actual nonzero speech and took 25.2 seconds. The disposable account was deleted and both environments returned to zero rooms/jobs.
- Earlier staged English/marin and German/cedar calls and previews produced actual provider audio and saved summaries/callback details. These were on earlier candidates; the earlier typed-call assertion missed duplicate rows later exposed by stronger checks. Preserve that attribution rather than treating every original exit-zero result as final typed acceptance.
- The first production typed-only smoke on `ab0dcd5` **failed** its expected-row assertion. It completed in 25 seconds with one primary caller row unchanged, two assistant rows, correct callback extraction, 537,120 output samples (peak 16,652), 45 partial updates/three finals, spoken goodbye and clean closure. All final events match saved rows. The harness attempted an extra timed follow-up but did not record its admission; it therefore cannot prove a lost admitted message. Original failure manifest SHA256: `2990a9c3bb2fbe0234ba3a7bad69280dda536555bf2b86992b8a69d474a4e07c`. Production transport diagnostics recorded first speech at 2.14 seconds and normal flush/finish. The account was deleted; both Azure environments had zero rooms/jobs, health 200 and no restarts.
- Native direct RTC and forced TURN/TLS443 returned nonzero audio. The native in-app browser selected a TLS relay using server-advertised ICE and received 41,827 audio bytes/176 packets with staging TURN UDP temporarily disabled, then restored. These transport checks made no inference calls. The final official ZeroSSL chain passed native and browser TLS verification; certificate verification was never disabled.
- Fresh database backups restored with integrity `ok` and zero foreign-key violations. Additive 0025 is applied to both environments and preserves old columns/configurations. Staging's historical data-only 0024 remains deliberately unapplied. Production is through 0025. See preflight for the preserved initial Wrangler failure and independently verified API application.
- Public production root, sign-in and health return 200; signed-out account access returns 401. Source/version, binding, flag and built-index readback passed; native in-app landing/sign-in inspection passed.

- Corrected production typed-only smoke on the same deployed `ab0dcd5` passed: one initial request, no fallback, 25-second completed call, one unchanged caller row/three assistant rows, 43 partial updates/four finals, 528,720 output samples (peak 14,748), saved summary/callback details, goodbye and automatic closure. Client readiness took 4.47 seconds. The corrected harness waits up to 45 seconds and retains strict exact-once/content validation; it does not change deployed code. The disposable account was deleted. This new result does not relabel the original failure.

### Remaining acceptance and limitations

- Variable startup latency remains unresolved: staged readiness observations range from 2.7 to 25.2 seconds. [Issue #43](https://github.com/duguetlabs/openfon/issues/43) tracks the accepted-session/provider greeting delay. A successful call does not establish consistent responsiveness.
- Physical microphone/playback, actual permission denial, repeated device calls, reconnect and restaurant-background interruption quality remain unverified on this release. Native software-received PCM is actual provider output, but does not prove physical audibility or subjective voice identity.
- iOS main `c5519d6` is merged with 31 tests, simulator build, exact CI and reviews passed. Signed archive, upload, TestFlight processing/install and device audio remain blocked on Apple authentication while the Mac is locked.
- Carrier acceptance remains separate; Telnyx and Asterisk ingress stay disabled. Anonymous public-link calling and arbitrary custom providers are not covered by the owner test-call probes.

Debug audio recording is not implemented for the new LiveKit transport; transcript persistence remains. The historical composed local 91-partial/seven-final call used a different credential source from the personal product credential used for these Azure tests. Earlier greeting-silence and farewell failures remain retained with their original outcomes. No synthetic check establishes all-model, all-voice, physical microphone or PSTN acceptance.
