# Launch workstream

- Status: Complete — launch assets and actual audible capture delivered; clean voice/release acceptance remains gated
- Owner: openfon-launch
- Branch: codex/launch-kit
- Starting commit: a9b33c5c46ccb441e4c07f50b81469354d3cf700
- Updated: 2026-09-12
- Rules: root AGENTS.md, orchestration-rules.md, launch handoff; shared root docs read-only
- Read first: docs/launch/demo/audible/README.md; integration checkpoint; docs/providers.md on integrated release

## Delivered
README/landing identity and provider disclosure; quickstart; capability/telephone compatibility; CONTRIBUTING; pilot and support scope; evaluation and measured-cost templates; announcement drafts; approved audible script and actual recording. Existing website architecture and silent synthetic walkthrough preserved. No marketing distributed, invented identity/testimonial/bill, provider default replacement or production deployment.

Launch commits:52b73ee,45fb33a,24d8321,7f9c30c,7267d13 plus current audible artifact commit. Integration received all prior commits. Owner alone changes runtime/schema/shared release branches.

## Actual audible evidence
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
Launch-owned README.md,CONTRIBUTING.md,web/src/pages/Landing.tsx,docs/quickstart.md,docs/providers.md,docs/launch/copy.md,pilot.md,pilot-evaluation.md,costs.md,demo/README.md,demo/audible-script.md,demo/audible/* and this checkpoint. Existing node_modules symlink not committed. Restricted temporary setup/session/raw capture under /tmp/openfon-audible-prep; no cookie/key/password exported to repository. No vault credential fetched by launch; staging secret injection stayed integration-owned.

## Remaining / next action
Integration consumes artifact commit, updates consolidated live-provider evidence with these specific limitations and drives release review. Clean acceptance needs consistent canonical fixture and fixed contact handling plus newly authorized voice test; no retry authorized now. Hosted operator/support/legal/domain inputs remain factual release decisions, never invented. Publish nothing under this implementation task. Actual Asterisk local PBX used mocked AI; direct OpenAI remains synthetic-tested; SIP/PSTN remains pending. These recordings do not change those evidence levels.
