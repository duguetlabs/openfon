# OpenFon overnight launch preparation

- Status: In progress
- Owner/active agent: Codex /root (desktop task)
- Branch: original checkout codex/launch-studio; active review codex/launch-review at /tmp/openfon-launch-review; telephony codex/telnyx-inbound at /tmp/openfon-telephony
- Base commit: a38a20e1cd8b09c31eacf6a97ebc9ed63edb03f5 (PR #13)
- Last updated: 2026-09-11T22:35:02Z
- Applicable AGENTS.md: repository AGENTS.md and user-provided global instructions
- Read first: this file; docs/launch/readiness.md; docs/launch/telephony-plan.md

## Objective
Complete missing app flows, resolve technical bugs/open PRs, build an original dimensional website, and prepare launch marketing. User authorizes overnight work and parallel agents. Hourly heartbeat openfon-overnight-launch-preparation continues until 2026-09-12 08:00 Europe/Vienna, then should pause and report.

## Scope
Backend consolidation, issues #6/#12 and PRs #10/#13, authenticated app, website, marketing, release validation, then Telnyx integration. Current user request supersedes historical serial implementation plan; review gates remain required before merges.

## Out of scope
Unapproved paid campaigns and external marketing messages. Preserve user-owned untracked docs/research/sim-ai-voice-gateway-2026-09-08.md. No real carrier calls or number purchases without configured credentials/number and verified transport.

## Confirmed facts
- Foundation rate-limit clock fixed in 66943f1; migration validation fixed in a38a20e. PR #13 pushed/reopened and Codex re-requested after each fix.
- Latest #13 Codex migration finding was real and fixed. Its expired-fixture finding was false because test SQLite datetime(now) now uses JS frozen time; rebuttal posted with actual September12 test evidence.
- Mandatory PR-Agent is not installed. Old handoff forbids private cross-org qapture caller. User was asked asynchronously whether independent review + Codex + CI may substitute; NO answer yet. Do not merge without satisfying gate.
- Desktop process outside Herdr; its skill prohibits outside control. No Herdr agents dispatched.
- Domain/operator/support information was asked asynchronously; NO answer yet.
- Scoped vault provider preflight to configured Kataleptic models returned HTTP403. No real-provider call completed.
- Port8787 belongs to another project (whatsapp-mcp); never stop it. Preview used8788; E2E uses8790 and fresh temporary D1 state.

## Decisions
- Review branch now includes the launch code/assets, subsequent fixes, and prepared CI changes. The CLI OAuth token could not update workflows; the already-authorized GitHub connector successfully published the prepared workflow as fabdee7 without expanding account permissions. Browser CI and all-validation deployment gates are now included in PR #14; no OAuth scope action is needed.
- Original cream/cobalt/orange design with interactive CSS3D phone; no fake customers, guarantees or carrier claims.
- Draft-first onboarding; publishing explicit. Draft/paused complete assistants may enter studio; partial setup resumes onboarding.
- Account deletion refuses active calls and uses RETURNING id because real D1 metadata counts cascades. Export allowlists columns and bounds rows/serialized bytes under D1 limits.
- Dependabot-style upgrades removed all npm audit findings; Node minimum22.13, Vitest5, Workers types5, React Router7.
- Telephony helper work is kept separate from launch UI/runtime; no carrier endpoint exposed yet.

## Work completed
- App: overview, assistants/editor/lifecycle, private Test Studio, conversations/filtering/review, caller-question knowledge drafts, collection/item CRUD+approval+attachments, settings, account password/export/delete.
- Auth input/origin/session security, microphone/socket cleanup, unsaved editor protections, setup recovery.
- Website, social card/favicons/robots, configurable canonical+sitemap build metadata.
- Marketing strategy, announcement drafts, demonstration script, release gate and screenshots in docs/launch/.
- Issues #6/#12 benchmark hardening complete; PR #10 evidence overclaims consolidated in launch commits, not yet closed.
- PR #13 isolated fix worktree /tmp/openfon-foundation-review; branch agent/calm-studio-foundation, commit d6ea5d2 pushed, exact-head Codex/CI green. node_modules symlink there is untracked, not a secret.
- Independent local account review found export limits/D1 function limit issues; fixed and re-reviewed with no major issue.

## Active review and integration state
- PR #14 opened: https://github.com/duguetlabs/openfon/pull/14, branch codex/launch-review in /tmp/openfon-launch-review. Foundation fix d6ea5d2 propagated as adea131; PR #13 now exact-head Codex/CI green. PR #14 progressed through validation/input fixes and CI integration to db7e361, review retriggered after every change. Root added local-provider WebSocket E2E in923a1c1,5/5browser scenarios pass; foundation agent owns reviewer loop for #13/#14.
- Separate /tmp/openfon-telephony branch codex/telnyx-inbound based on cdc76ab. Root owns CallSession carrier capability guard, studio_app owns control/schema/admission/account carrier gate, benchmark_hardening owns media protocol/codec. Helpers committed to telephony branch c6048df; original duplicates removed, user research remains untouched.
- Telephony must later receive launch-review fixes after agent edits; root carrier guard3138370, helpers/media c6048df, rolling startup buffer2e60c3e committed. Control/admission unit tests and actual workerd synthetic harness under development; no real carrier test or credentials available.

## Work remaining
- Launch PR #14 pushed; obtain fresh GitHub Codex/security and mandatory reviewer gate, resolve every real finding and re-trigger after every fix.
- Continue #13 review until green; merge only if user resolves missing PR-Agent gate or valid infra exists. Launch PR then retarget main if appropriate.
- Independent review/polish ongoing codec/signature helpers; integrate carrier transport with number/config authorization, durable idempotency and media admission per plan.
- Production hostname/operator/legal disclosures, valid provider key, real-provider audio/text and deployed smoke checks. Read docs/launch/production-preflight.md for read-only Cloudflare observations (pending migrations0007/0008; existing Worker public probe403).
- No public launch, remote migration/deployment, campaign distribution or phone-number claim yet.

## Files changed / ownership
- root owns integration, launch docs/website, package/CI/E2E and current-task.
- foundation_fix: account/auth and #13 migration fixes complete, available for further backend work.
- benchmark_hardening: actual local workerd synthetic Telnyx harness. Codec/media helpers committed; combined23 tests pass.
- studio_app: control/schema/admission/routing/account carrier gate and unit tests in telephony worktree. Webhook helper committed,71 tests pass.
- Telephony stays on its dependent branch; do not mix partial integration into launch PR.

## Validation
- Tracked launch application tests:276/276 after malformed input fixes; subsequent public body bound tested separately, across15 files (git ls-files test files piped to Vitest), actual2026-09-12.
- Foundation isolated suite:233/233; migration regression fails old code then passes fix.
- Typecheck/build and Worker dry-run bundle pass.
- Browser actual local workerd:5/5 pass (includes typed call through local synthetic provider, transcript and summary persistence), desktop/mobile artifacts in docs/launch/previews.
- Quality Python:220 tests,1 existing skip. Realtime Python:206 tests; standalone report checker passed.
- npm audit:zero vulnerabilities after upgrades.
- Failed intermediate E2E runs revealed setup recovery and D1 cascade issues; also corrected test waits/selectors and fresh-per-run DB to respect real signup limits. Current5/5 green supersedes these runs.

## Blockers, risks and unresolved questions
- PR-Agent merge gate; final domain/operator identity; provider access403; unimplemented carrier transport.
- New codec/webhook helpers are offline-tested, not integrated or production ready.
- Password-reset email and verification unavailable; do not imply they exist.

## Recommended next action
Verify all three worktrees and agents; finish carrier control/runtime tests, merge latest launch-review fixes into telephony once overlapping edits are committed, and continue PR review loops. Never merge past missing review authorization.
