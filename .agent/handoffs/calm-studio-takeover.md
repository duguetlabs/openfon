# Handoff — OpenFon Calm Studio Stage 1 and staged continuation

- **Sender:** Codex `/root`
- **Intended recipient:** Next OpenFon Calm Studio agent
- **Reason:** Cristian requested a durable takeover handoff
- **Repository path:** `/Users/cristian/projects/fun/openfon`
- **Branch:** `agent/calm-studio-foundation`
- **Base commit:** `eb13a19353a4fc9521711443fadada7ffc4588e4`
- **Current commit:** `4f8ab243367674091bc3beddacdc56f7a82e6bb1` (product head before handoff-document commit)
- **Working-tree status:** Product files match `origin/agent/calm-studio-foundation`; the local branch will be one documentation-only handoff commit ahead of the remote, with no product-code changes
- **Applicable AGENTS.md:** `/Users/cristian/.codex/AGENTS.md`; `/Users/cristian/projects/fun/openfon/AGENTS.md`
- **Read first:** `.agent/current-task.md`; `migrations/0008_calm_studio_foundation.sql`; `src/studio-api.ts`; PR #13

## Objective

Take ownership of the Calm Studio redesign, finish Stage 1's merge gate, then deliver the dependent public/Test Studio, operating/learning, and Telnyx stages without collapsing them into one PR.

## Scope and exclusions

- In scope: Stage 1 PR #13, its new deterministic test failure, reviewer/CI state, and the subsequent dependent stages described in `.agent/current-task.md`.
- Keep one business workspace per account and preserve legacy public URLs/contracts during the compatibility release.
- Excluded: teams, billing, campaigns, SMS, calendars, live transfer, website ingestion, Telnyx number purchasing, and remote production deployment without separate authorization.
- The voice-engine evaluation is a separate workstream preserved at `.agent/archive/current-task-2026-09-06.md`; do not merge it into this task by accident.

## Completed work

- Stage 1 domain/API foundation is implemented in five commits on `agent/calm-studio-foundation`.
- Migration `0008` upgrades populated databases from migrations `0001`–`0007` and seeds a canonical active assistant while retaining compatibility data.
- Typed assistant, calls, metrics, provider, preset, knowledge, bootstrap, lifecycle, and test-call APIs are implemented.
- Legacy UI/API/session paths are hardened for mixed-version rollout and recovery.
- Review feedback was verified, fixed where valid, answered, and resolved. Codex reports no major issues on `4f8ab24336`; all six threads are resolved.
- PR #13 is open and mergeable with its historical CI green at the product head.
- The previous repo-wide voice-engine current task was archived before this handoff.

## Incomplete work

- Fix the fresh failing daily-limit test/clock boundary and rerun the entire matrix.
- Resolve the PR-Agent policy/infrastructure contradiction with Cristian.
- Merge Stage 1 only after current validation and the applicable review gate are satisfied.
- Implement Stages 2–4 as dependent PRs after each predecessor merges.

## Files changed

- Product diff against `origin/main`: 34 files, 6,779 insertions, 316 deletions.
- Core foundation: `migrations/0008_calm_studio_foundation.sql`, `src/studio-api.ts`, `src/index.ts`, `src/types.ts`.
- Voice/call integration: `src/call-session.ts`, `src/prompt.ts`, `src/providers.ts`.
- Compatibility web work: `web/src/App.tsx`, `web/src/api.ts`, Auth/Onboarding/Settings/Call Detail/Dashboard pages, and row/session helpers.
- Tests: migration/API SQLite coverage, call filters/messages/outcomes, gating, session recovery, malformed rows, provider security, abuse limits, and call lifecycle.
- Handoff: `.agent/current-task.md`, `.agent/handoffs/calm-studio-takeover.md`, `.agent/archive/current-task-2026-09-06.md`.

## Confirmed findings

- Before the documentation-only handoff commit, local `HEAD`, the remote feature branch, and PR #13's product head were all `4f8ab243367674091bc3beddacdc56f7a82e6bb1` as verified on 2026-09-06.
- `origin/main` and the merge base are `eb13a19353a4fc9521711443fadada7ffc4588e4`; the branch is 5 ahead, 0 behind.
- PR #13 is open, ready, mergeable, and `CLEAN`.
- Current local typecheck/build pass, but the suite is 229/230 because the daily-limit Retry-After test receives `2373611` rather than at most `86400`.
- The failing route/test mixes a frozen JavaScript clock (`2026-08-10`) with real SQLite `datetime('now')` (`2026-09-06`). This diagnosis is strongly evidenced but must be verified in source before editing.
- GitHub has no unresolved review thread. Codex's latest exact-head review on 2026-08-26 reports no major issues.
- Neither base nor feature branch contains a PR-Agent workflow; repository secret and variable lists are empty; slash commands have no responder.

## Decisions and rationale

- Keep Stage 1 open: a fresh red test and unresolved merge-policy question make merging unsafe.
- Preserve the old current task in `.agent/archive/`: it is verified work from another stream, not disposable scratch text.
- Do not add a caller to the private cross-org `qapture/.github` reusable workflow: the earlier owner relay explicitly rejected that structurally invalid path.
- Do not begin Stage 2 on this branch: the product plan requires one dependent PR per stage.

## Validation performed

- `git fetch origin --prune` — success.
- `git status --short --branch` — product branch tracks its remote; only `.agent/` was untracked before writing this handoff.
- `git rev-list --left-right --count origin/main...HEAD` — `0 5`.
- `git diff --stat origin/main...HEAD` — 34 files, 6,779 insertions, 316 deletions.
- `gh pr view 13 --repo duguetlabs/openfon ...` — open, ready, mergeable, clean, exact product head.
- `gh pr checks 13 --repo duguetlabs/openfon` — three passes, deploy skipped.
- GitHub GraphQL review-thread query — all 6 threads resolved.
- `npm run typecheck` — pass on 2026-09-06.
- `npm run build` — pass on 2026-09-06.
- `git diff --check` — pass before handoff edits.
- `npm test -- --reporter=dot` — fail on 2026-09-06: 229 pass, 1 fail.

## Validation still required

- Reproduce with:
  - `npm test -- test/studio-api.test.ts --reporter=verbose -t "enforces independent daily ceilings"`
- After fixing the clock source:
  - `git diff --check`
  - `npm run typecheck`
  - `npm test -- --reporter=dot`
  - `npm run build`
- After any push: verify the exact PR head, all required CI checks, mergeability, Codex's same-head verdict, and thread state.
- If Cristian provisions a supported PR-Agent path, verify the required security and major-issue all-clear against the exact same SHA.

## Known failures, risks and unresolved questions

- The test suite is currently red. Historical green CI is dated 2026-08-10 and must not be treated as present-day validation.
- Clock coupling spans both SQL (`datetime('now')`) and JavaScript (`Date.now()`); patching only the assertion may hide a real boundary race. Prefer one captured, explicitly bound request instant and test across a different wall-clock date.
- The current AGENTS.md review loop says PR-Agent is required, but this repository lacks the caller and credentials described by that policy. Cristian must decide whether to relax the task gate or provide a supported Duguet Labs installation.
- Pushing the documentation-only handoff commit would change the PR SHA and make the previous CI/Codex verdict stale for merge purposes.
- The branch base is old; re-fetch before changing or merging it.

## Actions not to take

- Do not merge PR #13 while the full suite is red.
- Do not merge merely because the August CI and Codex results were green.
- Do not add `qapture/.github/.github/workflows/pr-agent.yml@v1` as a cross-organization caller.
- Do not keep posting inert `/review` or `/improve` comments without installed infrastructure.
- Do not start Stage 2 until Stage 1 is merged and `main` is refreshed.
- Do not run remote D1 migration/deploy commands without explicit authorization.
- Do not use `qsecret` in this Duguet Labs project; use `dsecret` and never print credentials.
- Do not discard `.agent/archive/current-task-2026-09-06.md`, ignored reference material, or unrelated user changes.
- Do not use destructive git cleanup commands.

## Recommended first command

```sh
git status --short --branch && git rev-parse HEAD && git rev-parse origin/main && git merge-base HEAD origin/main
```

Then read `.agent/current-task.md` and reproduce the focused failing test before modifying code.

## Recommended next action

Make the test-call rolling-day query, conditional insert, and Retry-After calculation share one captured timestamp; add a regression that remains correct when the host date differs from fixture dates; run the full matrix; then ask Cristian for the explicit PR-Agent gate decision.

The recipient must independently verify repository state, source files, GitHub state, and validation results before relying on this handoff.
