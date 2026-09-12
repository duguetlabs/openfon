# Integration checkpoint

- Status: In progress
- Owner: openfon-integration
- Branch: codex/integrated-release
- Base commit: a9b33c5c46ccb441e4c07f50b81469354d3cf700
- Last updated: 2026-09-12

## Objective and ownership
Consolidate completed owner commits, finish existing launch PR findings, validate the release and enforce both required reviewers. Root shared documents are read-only. Ports: application 8814; inspector 9254. Migrations 0010 reserved for presets and 0011 for Asterisk pending collision inspection.

## Verified state
- Read root AGENTS.md, handoff, orchestration rules, current-task, manifest, strategy and release readiness.
- Integration checkout is codex/integrated-release at a9b33c5; only pre-existing untracked node_modules.
- /private/tmp/openfon-launch-review is codex/launch-review with only pre-existing untracked node_modules; authorized PR #14 fix workspace.
- Personal project uses dsecret. No provider credential or live call verified this session.

## Work completed
Initial independent state inspection and checkpoint.

## Work remaining
Refresh PR #10/#13/#14/#15 reviews and CI; repair confirmed launch findings in its existing worktree; coordinate finished commits; run applicable validation and migration rehearsal; update readiness with actual evidence.

## Files changed
.agent/workstreams/integration.md

## Validation
- git status --short --branch in both worktrees: expected branches; no tracked changes.
- git rev-parse HEAD: a9b33c5c46ccb441e4c07f50b81469354d3cf700.

## Blockers and next action
Historical PR-Agent unavailability and real-provider/carrier gates require fresh verification. Next: inspect PR state and launch code. No merge or deployment authorized past missing required gates.

## Implementation checkpoint (13:35 local)
- Refreshed PR stack unchanged: #13 d6ea5d2 -> main; #14 370be80 -> foundation; #15 d616fff -> launch; #10 10f1903 -> main.
- GitHub workflow inventory has CI only, no PR-Agent workflow. #14 has one failed browser check and confirmed review findings, plus boolean false creation issue.
- Existing migrations end at 0009; confirmed 0010 presets and 0011 Asterisk reservations without collision.
- Implemented draft navigation/replacement guards, connected-only headline total, boolean false creation preservation, per-attempt browser limiter headers, precise status locators and configurable test ports in authorized launch-review worktree.
- Targeted studio API: 49 passed. Typecheck caught narrow request-body typing for boolean false; correcting. Browser suite running on 8814/9254.
- No staging HTTPS origin/version validated. Telnyx must remain disabled; no webhook target supplied.
- PR #13 Codex no major issues confirmed at d6ea5d2, all applicable checks green; PR #15 old head has no security issues and green checks but its owner is updating the greeting fix. PR #10 findings are addressed in existing integrated commit 8666e7e; still open, not blindly merged.
- Launch branch final typecheck and all 285 unit/API tests pass. First browser run could not launch missing bundled Chromium; installed Chrome rerun passed 5/6, exposing test-only timeout when cancelling cross-document Back. Added bounded Back timeout; repeating suite twice also verifies more than five signup attempts can succeed without shared limiter exhaustion.

## Candidate a50bc84 / integrated 51bfe28
- Launch fixes committed a50bc84 in codex/launch-review, cherry-picked cleanly as 51bfe28 on codex/integrated-release.
- Validation: typecheck passed; 285 unit/API tests passed; Chrome/workerd browser suite repeated twice, 12/12 passed against one DB (ten signups; retry limiter isolation demonstrated). Ports 8814/9254. Synthetic provider only.
- Added reproducible scripts/migration-rehearsal.py in integration (not yet committed): explicit --through target, rejects gaps/duplicate migration numbers, 0006→0009 backup/SQL restore/rollback/re-upgrade passed.
- QA corroborated baseline Knowledge loss; candidate now tests cancellation of links, collection replacement, Add knowledge, Back and refresh without losing Q/A.
- QA notes test/sqlite-d1.ts hardcodes through 0009: presets/Asterisk need consistent helper extension when their migrations land.

## Consolidation and infrastructure checkpoint
- Telnyx owner commit 37b3575 cherry-picked cleanly as e974f08; greeting readiness unit and synthetic harness changes retained. Owner handles PR15 review loop.
- Integrated 51bfe28 typecheck and all 426 unit/API tests passed before the Telnyx addition.
- Read-only Cloudflare APIs verified existing scoped personal account, workers subdomain duguetlabs, only D1 database openfon, and unchanged deployed version 289e186d-34b2-46b4-8c34-d58e233b69b3 (100%, July 6). No staging database exists.
- wrangler d1 migrations list openfon --remote confirms 0007, 0008 and 0009 pending. No production migrations or deployment run.
- Authorized pre-release D1 export started into mode-700 /Users/cristian/.local/share/openfon/backups/2026-09-12-integration with umask 077; no database contents printed. Restore rehearsal pending completed export.

## Verified milestones (13:42 local)
- QA independently approved scoped candidate 51bfe287e912656337bae7d4073b3592026e5e14: no major issues/new security concerns; 426 integrated tests, typecheck, 6 workerd scenarios and extra real-API false-value/reservation/discard probes passed. Not a PR-Agent substitute.
- Launch kit 52b73ee consolidated cleanly as 3cd372a; provider truth table awaits new adapters.
- Production D1 backup saved mode 600 outside repo: /Users/cristian/.local/share/openfon/backups/2026-09-12-integration/pre-release.sql (189751 bytes; SHA256 prefix 79ab670c40518de3). Restored locally, applied 0007-0009, verified legacy data/completed history/public slugs and integrity/FKs, wrote restricted upgraded binary backup. No remote migrations/deployment. Cloud staging still not rehearsed.
- Operational issue: wrangler export unexpectedly printed a one-hour signed download URL in tool output. No URL copied to files/messages; future exports must capture stdout to restricted files rather than emit it. Its expiry is 2026-09-12T12:39:48Z. Treat the transcript as sensitive until expiry.
- PR14 a50bc84 CI application/browser/quality checks green; realtime benchmark and Codex review still running at last check; PR-Agent missing.

## Current changed files
Integration: .agent/workstreams/integration.md, docs/launch/readiness.md, scripts/migration-rehearsal.py. Cherry-picked owner files are preserved in commits 51bfe28, e974f08, 3cd372a.

## Deployment control
Found existing CI deploys automatically on every main push, which would couple any future merge to unaccepted production migrations. Integration changes CI to explicit workflow_dispatch on main with deploy_production=true (default false), preserving all prerequisite jobs. This makes merge and deployment separate concrete actions and implements the handoff's no-blind-deployment requirement. No dispatch executed.
