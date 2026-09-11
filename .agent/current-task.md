# OpenFon overnight launch preparation

- Status: In progress
- Owner/active agent: Codex /root (desktop task)
- Branch: codex/launch-studio, based on agent/calm-studio-foundation
- Base commit: a38a20e1cd8b09c31eacf6a97ebc9ed63edb03f5 (PR #13)
- Last updated: 2026-09-12T00:11:00+02:00
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
- PR #13 isolated fix worktree /tmp/openfon-foundation-review; branch agent/calm-studio-foundation, commit a38a20e pushed. node_modules symlink there is untracked, not a secret.
- Independent local account review found export limits/D1 function limit issues; fixed and re-reviewed with no major issue.

## Work remaining
- Commit/push launch PR based on #13, obtain fresh GitHub Codex/security and mandatory reviewer gate, resolve every real finding and re-trigger after every fix.
- Continue #13 review until green; merge only if user resolves missing PR-Agent gate or valid infra exists. Launch PR then retarget main if appropriate.
- Independent review/polish ongoing codec/signature helpers; integrate carrier transport with number/config authorization, durable idempotency and media admission per plan.
- Production hostname/operator/legal disclosures, valid provider key, real-provider audio/text and deployed smoke checks.
- No public launch, remote migration/deployment, campaign distribution or phone-number claim yet.

## Files changed / ownership
- root owns integration, launch docs/website, package/CI/E2E and current-task.
- foundation_fix: account/auth and #13 migration fixes complete, available for further backend work.
- benchmark_hardening: src/telephony-audio.ts + test/telephony-audio.test.ts (untracked building block); codecs9 tests pass.
- studio_app: src/telnyx-webhook.ts + test/telnyx-webhook.test.ts (untracked building block); signature/parser71 tests pass.
- Do not accidentally include these untracked telephony modules in launch PR until planned separately.

## Validation
- Tracked launch application tests: 272/272 across15 files (git ls-files test files piped to Vitest), actual2026-09-12.
- Foundation isolated suite:233/233; migration regression fails old code then passes fix.
- Typecheck/build and Worker dry-run bundle pass.
- Browser actual local workerd:4/4 pass, desktop/mobile artifacts in docs/launch/previews.
- Quality Python:220 tests,1 existing skip. Realtime Python:206 tests; standalone report checker passed.
- npm audit:zero vulnerabilities after upgrades.
- Failed intermediate E2E runs revealed setup recovery and D1 cascade issues; also corrected test waits/selectors and fresh-per-run DB to respect real signup limits. Current4/4 green supersedes these runs.

## Blockers, risks and unresolved questions
- PR-Agent merge gate; final domain/operator identity; provider access403; unimplemented carrier transport.
- New codec/webhook helpers are offline-tested, not integrated or production ready.
- Password-reset email and verification unavailable; do not imply they exist.

## Recommended next action
Verify git and agents, push reviewable launch PR excluding telephony helper files, then continue carrier work in an isolated dependent worktree while GitHub reviews run. Never merge past missing review authorization.
