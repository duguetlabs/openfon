# OpenFon launch preparation

- Status: In progress
- Owner/active agent: Codex /root; foundation_fix review monitoring, benchmark_hardening local migration rehearsal
- Branch: codex/launch-studio at /Users/cristian/projects/fun/openfon; verified carrier review branch codex/telnyx-inbound at /tmp/openfon-telephony
- Base commit: 3cad16bcd699b14979c5178bc2b587bbae30cef9 (PR #14; merged into this branch)
- Last updated: 2026-09-11T22:58:50.154256+00:00
- Applicable AGENTS.md: repository AGENTS.md and user-provided project instructions
- Read first: this file, docs/launch/readiness.md, docs/telephony.md, docs/launch/production-preflight.md

## Objective
Finish launch app/technical work, original website and marketing assets; user authorizes overnight parallel agents. Hourly heartbeat openfon-overnight-launch-preparation continues until2026-09-12 08:00 Europe/Vienna, then pauses and reports.

## Scope
App completion, bugs/issues #6/#12, PRs #10/#13, website/marketing, disabled inbound Telnyx implementation and release verification.

## Out of scope
Unapproved spending, external marketing distribution, real carrier calls without configured authorized number/provider. Preserve original user research file docs/research/sim-ai-voice-gateway-2026-09-08.md. No outbound dialing, number purchasing/porting, calendar booking or email recovery implemented.

## Confirmed facts
- PR #13 branch agent/calm-studio-foundation at d6ea5d2: exact-head Codex no-major finding and CI green. Separate worktree /tmp/openfon-foundation-review.
- PR #14 codex/launch-review at3cad16b: latest review findings fixed (one-snapshot export, production-origin wiring, cancelled reservation cleanup). Local 283 unit / 6 browser tests pass; all four CI jobs green at 3cad16b; latest Codex review pending. Separate worktree /tmp/openfon-launch-review. It includes app, website, account controls, benchmark fixes and CI.
- Mandatory PR-Agent is unavailable; personal reusable infrastructure probes returned404 and historical instructions forbid private cross-org qapture caller. User's async substitute-review question remains unanswered. Never merge around this gate.
- Workflow OAuth scope is NO LONGER blocked: existing authorized GitHub connector published prepared CI as fabdee7 without expanding account access. Canceled old gh auth refresh; no scope grant needed.
- Read-only Cloudflare preflight: Worker openfon exists, migrations0007/0008 pending; browser-user-agent workers.dev probes returned root 200 and signed-out /api/me 401; Python-user-agent probes returned 403. Secret names inspected only, values not read. See production-preflight.md. No deployment/migration/secret update occurred.
- Local scoped Kataleptic credential returned403; no real-provider call completed. Final hostname/operator/support/privacy details still await user input.
- Desktop process outside Herdr; no Herdr control dispatched. Codex agents used. Port8787 belongs to whatsapp-mcp; never stop it.

## Decisions
- Public marketing remains browser-first until real carrier pilot; no fake results/testimonials.
- Telnyx rollout defaults false; explicit operator-owned number routes, signed inbox, shared admission, durable retries and release confirmation. Carrier control IDs remain in separate private storage.
- Realtime-only audible carrier sessions; no browser-TTS/pipeline fallback. MediaPCM converted with bounded buffers, rolling pre-ready second,20ms pacing and generation-aware playback marks.
- Existing GitHub app tools may publish workflow edits with their already-granted permissions; no account permission expansion.

## Work completed
- Silent UI walkthrough verified and committed in docs/launch/demo/ (31.7 seconds, no audio, fictional data caption). Marketing distribution remains unsent.
- Studio overview, assistant lifecycle/editor/private testing, calls/review, knowledge approval/attachments, settings, password/export/delete; auth/input/teardown/race fixes.
- Original cream/cobalt/orange dimensional website, social/search assets, marketing strategy/copy and inspected screenshots.
- Benchmark fixes #6/#12 and qualified #10 claims integrated into #14; do not close #10 before replacement is reviewed/merged.
- Telnyx control4b0bd46, capability guard3138370, codec/signature/media c6048df, startupbuffer2e60c3e, actualworkerd harness a029e6f, ingressabusefix6f09669.
- Runtime harness found and fixed workerd unsupported redirect:error and defaultBlob WebSocket input. No external providers contacted.
- Independent review found/fixed unowned outgoing leg commands, expired-alarm hot loop, shutdown callback handling, exact number authorization, account deletion race, persistent failure reporting and arbitrary DO instantiation.

## Work remaining
- PR #15 open (codex/telnyx-inbound → codex/launch-review), all four CI jobs green at a59f1ff; latest code and security reviews pending. Actual carrier runtime harness included in CI. Obtain exact-head reviews and resolve real findings.
- Continue PR #14 review; satisfy mandatory PR-Agent gate before merging any PR.
- Confirm production identity/access/provider; backup/staging migration/rollback drill then actual provider/carrier pilot before launch. No production ready claim.
- Verified carrier and launch branches consolidated into this original checkout; user research remains untracked and untouched.

## Files changed
- This branch contains src/telnyx-*, src/telephony-audio.ts, migration0009, CallSession carrier guards, shared admission/account guards, tests, synthetic harness and docs.
- All worktrees share dependency symlink; node_modules is untracked in /tmp worktrees and must not be committed.

## Validation
- npm test:424/424 across20 files after merge and ingressfix.
- npm run typecheck:passed.
- npm run test:telnyx:passed against actual local workerd, signed ingress, duplicate admission, valid-shaped forged token rejected, bidirectional non-silent PCM, interruption/marks/hangup and D1release. All outbound services mocked.
- Browser test:e2e:6/6 passed on consolidated carrier branch; build included.
- Launch and carrier CI: app, browser, scoring and realtime green at PR #14 3cad16b and PR #15 a59f1ff. Python suites220(one existing skip)/206; npm audit zero after upgrades.
- Initial runtime failures above fixed; current passing harness supersedes them.

## Blockers, risks and unresolved questions
Missing mandatory reviewer, final operator/domain/privacy details, unverified real-provider access (local credential preflight 403), absent real carrier configuration/pilot. Tombstones retain provider correlation for replay suppression; no live-carrier readiness claimed.

## Recommended next action
Verify worktree/agent/remote PR state, collect latest-head reviews on PRs #14/#15, address confirmed findings, and finish the local migration rehearsal. No merge or production launch until gates pass.
