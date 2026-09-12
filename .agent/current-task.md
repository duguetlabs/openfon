# OpenFon launch preparation

- Status: In progress
- Owner/active agent: Codex /root; subagents finished; overnight automation paused
- Branch: codex/launch-studio at /Users/cristian/projects/fun/openfon; verified carrier review branch codex/telnyx-inbound at /tmp/openfon-telephony
- Base commit: cd3acc9 (consolidated checkout before this documentation update)
- Last updated: 2026-09-12T08:13:05.257242+00:00
- Applicable AGENTS.md: repository AGENTS.md and user-provided project instructions
- Read first: this file, docs/launch/readiness.md, docs/telephony.md, docs/launch/production-preflight.md

## Objective
Finish launch app/technical work, original website and marketing assets; user authorizes overnight parallel agents. Overnight window ended; heartbeat openfon-overnight-launch-preparation was paused at 2026-09-12 08:11 UTC when the queued wakeups were handled. No claim of continuous work during the intervening queued period.

## Scope
App completion, bugs/issues #6/#12, PRs #10/#13, website/marketing, disabled inbound Telnyx implementation and release verification.

## Out of scope
Unapproved spending, external marketing distribution, real carrier calls without configured authorized number/provider. Preserve original user research file docs/research/sim-ai-voice-gateway-2026-09-08.md. No outbound dialing, number purchasing/porting, calendar booking or email recovery implemented.

## Confirmed facts
- PR #13 branch agent/calm-studio-foundation at d6ea5d2: exact-head Codex no-major finding and CI green. Separate worktree /tmp/openfon-foundation-review.
- PR #14 head 370be80: assistant unsaved-edit guard integrated into root and carrier. Local tests pass; latest CI has one browser failure (ambiguous status locator, then signup retry quota exhaustion). Exact-head Codex has three remaining P2 findings; see Work remaining.
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
- PR #14 at 370be80: protect unsaved knowledge drafts (3994129324), exclude unconnected reservations from headline live-call total (3994129328), isolate browser retries from shared signup quota (3994129334). All verified and acknowledged on PR; none fixed yet. Also fix status locator ambiguity found in CI run 34656631441 before rerunning.
- PR #15 at d616fff: gate carrier input until Azure greeting audio is synthesized/queued (3994125261). Verified sendReady precedes synthesize and adapter flushes input on ready. Needs delayed-synthesis regression. All CI jobs passed; exact-head security review found no security issues, but code finding remains open.
- Earlier Telnyx connected-frame finding was false; official-contract rebuttal accepted with no-major review on a59f1ff. Latest d616fff has the separate greeting-order finding above.
- Every finding has a PR reply; fix, validate, push, close/reopen and re-request Codex after each fix. Propagate final branch changes into the original checkout. Never merge past unresolved findings or the unavailable mandatory PR-Agent gate.
- Final hostname/operator/support/privacy choices, valid provider access, production D1 backup and staging migration/restore, real-provider and consented carrier pilot remain required.
- Marketing strategy/copy/assets are prepared but distribution unsent. No public launch or production changes.

## Files changed
- This branch contains src/telnyx-*, src/telephony-audio.ts, migration0009, CallSession carrier guards, shared admission/account guards, tests, synthetic harness and docs.
- All worktrees share dependency symlink; node_modules is untracked in /tmp worktrees and must not be committed.

## Validation
- Final consolidated npm test: 424/424 across 20 files at cd3acc9; /tmp/openfon-launch-qa/final-integrated-unit.log.
- Local synthetic legacy migration/backup rehearsal passed: 0006 → 0009, preserved slugs/history/settings, binary and SQL restore, rollback/re-upgrade, integrity/foreign-key checks. Script: /tmp/openfon-launch-qa/migration-rehearsal.py; invocation python3 SCRIPT /Users/cristian/projects/fun/openfon. Migration 0008 regression group: 10 passed. Production D1 rehearsal remains required.
- npm run typecheck:passed.
- npm run test:telnyx:passed against actual local workerd, signed ingress, duplicate admission, valid-shaped forged token rejected, bidirectional non-silent PCM, interruption/marks/hangup and D1release. All outbound services mocked.
- Final consolidated browser suite: 6/6 passed at cd3acc9, including unsaved assistant guard; build included. /tmp/openfon-launch-qa/final-integrated-browser.log. This local pass does not override the later-inspected CI failure.
- Latest CI: PR #15 d616fff all required jobs green; PR #14 370be80 has one failing browser run, other jobs green. Python suites220(one existing skip)/206; npm audit zero after upgrades.
- Initial runtime failures above fixed; current passing harness supersedes them.

## Blockers, risks and unresolved questions
Four confirmed review fixes and browser CI failure, missing mandatory reviewer, final operator/domain/privacy details, unverified real-provider access (local credential preflight 403), absent real carrier configuration/pilot. Tombstones retain provider correlation for replay suppression; no live-carrier readiness claimed.

## Recommended next action
Resume by verifying git and remote reviews, then fix PR #14 browser isolation/locator and remaining product findings, followed by PR #15 greeting ordering. Automation is paused; no main merge or production launch until all gates pass.
