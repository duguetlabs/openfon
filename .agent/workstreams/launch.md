# Launch workstream

- Status: Complete — launch assets and original/corrective audible captures delivered; hours/contact corrective checks pass, interruption follow-up inconclusive
- Owner: openfon-launch
- Branch: codex/launch-kit
- Starting commit: a9b33c5c46ccb441e4c07f50b81469354d3cf700
- Updated: 2026-09-12
- Rules: root AGENTS.md, orchestration-rules.md, launch handoff; shared root docs read-only
- Read first: docs/launch/demo/audible/README.md; integration checkpoint; docs/providers.md on integrated release

## Delivered
README/landing identity and provider disclosure; quickstart; capability/telephone compatibility; CONTRIBUTING; pilot and support scope; evaluation and measured-cost templates; announcement drafts; approved audible script and actual recording. Existing website architecture and silent synthetic walkthrough preserved. No marketing distributed, invented identity/testimonial/bill, provider default replacement or production deployment.

Launch commits:52b73ee,45fb33a,24d8321,7f9c30c,7267d13 plus current audible artifact commit. Integration received all prior commits. Owner alone changes runtime/schema/shared release branches.

## Original audible evidence — preserved
Root approved existing fictional Northwheel scenario, with no additional scenario approval required. Realtime preflight consumed one conversation and handed exclusive ownership of the final one to launch; integration verified working staging configuration. Launch made exactly one call, no retry. **Remaining conversation allowance: ZERO.**

- Origin:https://openfon-staging.duguetlabs.workers.dev
- Source:718d233e3754e53b800a397b1e600ffea492bb79
- Worker version:76a515eb-877e-48ef-bdcd-1ab8ea7095ef
- Private draft assistant:realtime/gpt-realtime-2/blank voice; summary llama-3.3-70b; real Kataleptic gateway. Provider default resolved voice ID not recorded.
- Session:5e890b0d-1c0e-4e34-88d0-92b9c16d0443;2026-09-12T12:11–12:12Z;58s;completed;10 turns;summary;message_taken.
- Local synthetic Samantha caller audio flowed through browser mic/capture/WebSocket. Provider replies captured as actually played. No physical mic, handset, direct OpenAI or SIP/PSTN claim. Staging carriers/routes stayed disabled.
- Artifacts:docs/launch/demo/audible/ contains68.24s H.264/AAC video,58.197s lossless original FLAC, sanitized persisted result, capture metadata, poster and detailed README.
- Original replies/pauses retained, no alternate take or overdub. Permanent fictional/synthetic-caller/real-Kataleptic affiliation disclosure. Screen/audio alignment approximate, not latency evidence.

## Observed failures and disposition
1. Intended Saturday09–14 answer failed: launch setup left canonical business hours at onboarding default Saturday closed, conflicting with description/custom instructions. Read-only post-call snapshot verified the conflict. This is a fixture setup defect, not proven hallucination; original answer retained. Correct canonical hours before any newly authorized acceptance run.
2. Provider extraction stored caller_phone literal string "null", visibly rendered despite caller declining number. Original row/artifact retained. Integration corrected shared persistence and historical UI normalization in696a34a; owner reports typecheck/build/22 summary-contact tests pass, preserving real numbers and surname Null. No live retest.
3. Interruption attempted; audio contains interrupted replies. Manual hangup may truncate the final spoken reply. Persisted transcript text does not prove every word was heard. No human listening/voice-quality verdict or exact latency claim.

## Validation
- Original launch code: npm run typecheck and npm run build passed. Public hostname unset locally; canonical/sitemap omitted as designed.
- Static signed-out UI: desktop1440×1000/mobile390×844 Chromium149 passed rendering, disclosure expansion, overflow checks; screenshots inspected. Initial bundled Chromium missing; initial exact-summary locator included plus icon and timed out; corrected locator passed. Mock signed-out API, not voice evidence.
- Integrated wording/link audit at9efef65:45 local paths/anchors across13 documents passed. Later dbb01e7 audit confirmed real Asterisk22.11.0+mockAI vs synthetic direct-provider tests vs pending SIP/PSTN. Corrected stale README staging claim in7267d13.
- Capture locally self-tested without provider requests. Initial Opus capture self-test exposed decode errors; replaced with PCM WAV before the single live call. Final audio/video decode passed.
- Audio:48kHz mono;58.197s;peak−0.9dBFS/mean−19.9dBFS; provider-only speech intervals about−25dBFS. Local faster-whisper base.en independently recovered both voices from recording; no paid/cloud ASR request. ASR timestamps/errors are not ground truth.
- Video:H.2641280×1060/AAC48kHz mono/68.24s; poster and saved result visually inspected. Full ffmpeg decode and artifact link/whitespace checks passed.

## Files / private state
Launch-owned README.md,CONTRIBUTING.md,web/src/pages/Landing.tsx,docs/quickstart.md,docs/providers.md,docs/launch/copy.md,pilot.md,pilot-evaluation.md,costs.md,demo/README.md,demo/audible-script.md,demo/audible/* and this checkpoint. Existing node_modules symlink not committed. Restricted temporary setup/session/raw capture under `private-evidence-826c4a6e3b1f9e4aed94f805fcaef454`; no cookie/key/password exported to repository. No vault credential fetched by launch; staging secret injection stayed integration-owned.

## Remaining / next action
Integration consumes the distinct corrective artifact and updates consolidated evidence. Canonical-hours and contact-normalization corrective checks now pass on526be52/a1bc90ea. Capture sequencing leaves interruption follow-up inconclusive; no general voice-quality or clean whole-release verdict. Original failed artifacts remain unchanged. Hosted operator/support/legal/domain inputs stay factual release decisions. No uncontrolled retries, external distribution, physical-mic/directOpenAI/PSTN claims or production routing.

## Root-authorized corrective run — preparation
Root clarified previous two-call ceiling was an operational batch bound and explicitly authorized ONE further short corrective Northwheel staging acceptance/capture. No additional user permission needed. Original e42531a artifacts remain unchanged. Launch prepares canonical hours/facts/timezone verification and distinct corrected capture outputs; integration subsequently supplied exclusive ownership/version confirmation with696a34a deployed; corrective run completed as recorded below. No new account/provider purchase or uncontrolled retries.

Corrective preflight passed: persisted Saturday09:00–14:00/closedfalse, Europe/Vienna, no closures; description, instructions, active default knowledge and expected answers consistent. Readback at14:24+ local Saturday after closing distinguishes regular Saturday hours from closed now. Private draft realtime/gpt-realtime-2/blank voice. Integration exclusive freeze source526be52ab15785dfa4ec0c7c87a958295a5ce4b6/versiona1bc90ea-dad0-4677-abc0-e8e34cdc9c51 includes696a34a. Local caller+output mixing/playback-drain selftest passed without provider call. Initiating ONE root-authorized corrective call now; no automatic retry. Distinct raw path `private-evidence-33c1f08c5202f3af8b85b38e03811dfc`; original committed artifacts untouched.

Corrective result: session722e6aff-a154-4d86-ad80-a80e83cf7dec completed68s/12turns at frozen526be52/a1bc90ea, correct spoken Saturday09–14 and after-closing context, actual caller_phone JSONnull with clean UI, unknown-service no-information reply, Alex Example message/summary persistence. Original artifacts untouched. New79.2s video/67.499s lossless audio under docs/launch/demo/corrected/. Local ASR recovers full final message; playback drained before hangup.

Remaining capture limitation: interruption follow-up is inconclusive. Capture script's completion predicate compares cumulative playback source count and quietness; old service-response chunks can satisfy it after interruption. It advanced to the next prompt at+32.151s; saved filler “Let me think” appears12:26:37, after that next prompt began. Thus it did not establish completion of a substantive same-day-repair follow-up. Local source inspection found no hardcoded filler; do not infer a provider/app defect or clean barge-in acceptance. Diagnose sequencing locally; no live retry. The two corrective targets (canonical hours and phone normalization) passed.


Corrective delivery validation: new79.2s H.264/AAC video and67.499s lossless FLAC; FLAC-decoded samples SHA-match captured WAV exactly, full MP4 decode passes. Offline base.en ASR recovers correct hours/context, unknown response and complete final message. Persisted-result assertions pass completed/message_taken, correct hours, actual JSONnull phone, Alex Example and no failure. Corrected poster/result visually inspected. Original docs/launch/demo/audible files unchanged frome42531a. Updated demo index/script/pilot/announcement drafts to point to corrected scope and retain interruption qualification. Local links and git diff --check pass. No application code changed or further live calls made.

## Local-only capture sequencing follow-up
Root authorizes a bounded harness/test correction only; no live call, staging or release branch changes. Existing private capture used cumulative playback count, allowing stale service-response chunks to advance the next prompt. Public browser protocol currently forwards anonymous PCM and agent_text/flush without response IDs/completion correlation. Shareable replacement must use explicit response-scoped events and fail closed when correlation is unavailable; never relabel late anonymous PCM as the new response. Original/corrected artifacts and qualified claims remain unchanged. Integration owns inclusion with its six-finding candidate.

Local harness follow-up delivered: docs/launch/demo/capture-sequence.mjs exposes response-scoped CaptureSequence/capturePrompt, explicit committed input/response IDs, successful generation completion, expected total chunks, actual played callbacks and substantive-transcript acceptance. Old response/input/chunk events cannot count as the new response. Failures/timeout/abort do not advance or retry. No anonymous-PCM timing fallback. Public wire still needs a correlated observer/telemetry bridge before live usage; this local module is not falsely represented as already wired to staging.

Validation: node --test docs/launch/demo/capture-sequence.test.mjs —14/14 passed, including actual next-prompt callback held through stale chunks/completion, delayed final chunk, quiet gaps, filler, cancellation, old playback, duplicate callbacks and abort. git diff --check passed; both original/corrected artifact directories unchanged againstc654788. Sharing only module, offline tests, capture-harness.md evidence/remaining-acceptance contract and this checkpoint. No private temporary setup/session files, provider calls, staging mutations or release branch changes.

Exact remaining acceptance: first wire/review a response-aware capture observer retaining real input/response IDs and completion through playback; then coordinated bounded live barge-in must stop old audio, receive and fully play a substantive matching repair-timing response before the next prompt, and preserve correlated/audio/transcript/persisted evidence. Existing hours/contact/message passes stand; interruption follow-up remains unverified. Integration alone chooses inclusion with its six-finding remediation candidate.


## README evidence wording correction — 2026-09-13
Integration50fdf0bb7677625bee59efbaa5b4d391ffbb3928 still described all real-provider voice acceptance as pending. Narrow README correction links the existing corrective capture: live Kataleptic replies with synthetic caller passed canonical-hours and missing-phone checks on recorded526be52/a1bc90ea. Interruption remains inconclusive, physical-microphone and SIP/PSTN acceptance unverified; this is not full acceptance of the current candidate, and HTTP probes alone do not establish audible success. Original/corrective artifacts unchanged. Source-only validation: replacement matches integration baseline exactly; linked report exists and supports each scoped claim; git diff --check passed. No application runner, live call, staging change or artifact edit. Integration owns cherry-pick/publication with its next remediation candidate.
