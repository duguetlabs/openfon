# Current task — OpenFon Calm Studio staged redesign

- **Status:** In progress
- **Owner / active agent:** Next OpenFon Calm Studio agent — takeover requested by Cristian
- **Branch:** `agent/calm-studio-foundation`
- **Base commit:** `eb13a19353a4fc9521711443fadada7ffc4588e4` (`origin/main`, verified 2026-09-06)
- **Last updated:** 2026-09-06T01:21:14+02:00
- **Applicable AGENTS.md:** `/Users/cristian/.codex/AGENTS.md`; `/Users/cristian/projects/fun/openfon/AGENTS.md`
- **Read first:** `.agent/handoffs/calm-studio-takeover.md`; `migrations/0008_calm_studio_foundation.sql`; `src/studio-api.ts`; `.agent/archive/current-task-2026-09-06.md` only if resuming the separate voice-engine workstream

## Objective

Deliver the OpenFon “Calm Studio” redesign through dependent staged PRs around the lifecycle:

**Discover → Create assistant → Test → Review → Improve → Publish**

Stage 1 establishes the domain and typed API foundation. Later stages add the public experience and Test Studio, the operating/learning loop, and Telnyx inbound plus individual outbound calling.

## Scope

- Finish and merge Stage 1 PR #13 safely.
- Start each later stage only from the previously merged stage.
- Preserve compatibility for the existing singular business/settings/call routes during the transition.
- Continue through Stage 2, Stage 3, and the high-priority Telnyx milestone after their dependencies merge.

## Out of scope

- Teams or multiple workspaces per account.
- Billing, campaigns, SMS, calendars, live transfer, website ingestion, and Telnyx number purchasing.
- Remote D1 migration or production deployment unless Cristian separately authorizes it.
- Changes to the separate voice-engine evaluation workstream archived at `.agent/archive/current-task-2026-09-06.md`.

## Confirmed facts

- The repository is `duguetlabs/openfon`; local and remote branch are `agent/calm-studio-foundation` at product commit `4f8ab243367674091bc3beddacdc56f7a82e6bb1`.
- After `git fetch origin --prune` on 2026-09-06, `origin/main` and the merge base are both `eb13a19353a4fc9521711443fadada7ffc4588e4`; the feature branch is 5 commits ahead and 0 behind.
- PR #13, <https://github.com/duguetlabs/openfon/pull/13>, is open, ready, mergeable, and `CLEAN` at `4f8ab24336`.
- The Stage 1 branch changes 34 files relative to `origin/main`: 6,779 insertions and 316 deletions.
- Stage 1 includes migration `0008`, multi-assistant ownership/lifecycle/public slugs, workspace provider settings, assistant-aware test/live calls, reusable knowledge collections/items, bootstrap/readiness, filtered cursor pagination, overview metrics, engine presets, provider checks, and legacy compatibility adapters.
- Existing public slugs, provider credentials, engine settings, connected-call/stale-call behavior, and legacy knowledge are preserved or reconciled by migrations and compatibility code.
- Review-driven hardening covers explicit API-key clearing, normalized RFC 3339 call filters, onboarding lifecycle gating, row-by-row recovery, call outcome correctness, mixed-version live-call attribution, session/logout races, abuse ceilings/refunds, watchdog failure metadata, and malformed legacy prompt data.
- GitHub CI for `4f8ab24336` ran on 2026-08-10: `check`, `bench-scoring`, and `bench-realtime` passed; `deploy` was skipped.
- Codex reviewed the exact product head twice. The latest 2026-08-26 comment says no major issues for `4f8ab24336`. A fresh GraphQL read on 2026-09-06 shows all 6 review threads resolved.
- There is no PR-Agent caller on either `origin/main` or the feature branch: `.github/workflows/` contains only `ci.yml`. `gh secret list` and `gh variable list` for this repository return no entries. `/review` and `/improve` comments produced no PR-Agent output.
- The current global AGENTS.md requires PR-Agent and Codex before merge, while the original Calm Studio task also independently imposed a PR-Agent gate. Cristian has not explicitly relaxed that task-specific gate or authorized merging #13 without PR-Agent.
- An earlier relay explicitly said not to add a cross-org caller for the private `qapture/.github` reusable workflow and not to merge on the relay alone.
- A separate untracked voice-engine `current-task.md` existed before this handoff. Its state at takeover time is preserved as `.agent/archive/current-task-2026-09-06.md`.

## Hypotheses

- The current test failure is a clock-source mismatch, not a Stage 1 behavior regression: Vitest freezes JavaScript at `2026-08-10`, while Node SQLite evaluates `datetime('now')` using the real `2026-09-06` clock. `rollingDayRetryAfter()` then compares timestamps from different dates and returns `2373611`. **Test:** trace the clock used by `testCallDayState`, the conditional test-call insert, and `rollingDayRetryAfter`; make one captured instant drive both SQL boundaries and retry calculation, then run the focused test under a date different from the fixture date.
- PR-Agent cannot satisfy the review gate until Duguet Labs has its own supported workflow/credentials or Cristian explicitly changes the gate. **Test:** inspect the repository workflow and Actions run after any owner-provided infrastructure change; do not infer installation from slash comments.

## Decisions

- Preserve the unrelated voice-engine resume document in `.agent/archive/` instead of overwriting or deleting it.
- Leave PR #13 open until the fresh test failure is resolved and the review-policy decision is explicit.
- Do not start Stage 2 before Stage 1 is merged; the requested PRs are dependency-ordered.
- Do not add the private cross-organization `qapture/.github` reusable workflow caller to this public Duguet Labs repository.
- Use `dsecret`, never `qsecret`, for any secrets needed under `~/projects/fun/`; do not print secret values.

## Work completed

- Reconciled the upstream baseline through `eb13a193` while preserving the existing local changes and ignored reference material.
- Implemented and pushed five Stage 1 commits:
  - `c36259d` — Add Calm Studio domain foundation
  - `978e81c` — Harden Calm Studio compatibility rollout
  - `068f463` — Address Stage 1 review findings
  - `9f3a4b5` — Preserve recovery data and call outcomes
  - `4f8ab24` — Harden Calm Studio recovery and abuse boundaries
- Opened and iteratively reviewed PR #13; answered and resolved every Codex thread.
- Updated the PR body with Stage 1 compatibility, security, and validation evidence.
- Re-verified repository, branch, PR, workflow, reviewer, and test state on 2026-09-06.
- Archived the separate voice-engine resume point and created this Calm Studio takeover state.

## Work remaining

1. Diagnose and fix the clock-dependent daily-limit regression exposed by running the suite on 2026-09-06.
2. Rerun `git diff --check`, typecheck, all tests, and build. Record the exact new totals.
3. Obtain Cristian's explicit decision on the unavailable PR-Agent gate or wait for valid Duguet Labs PR-Agent infrastructure. Do not attempt the blocked private cross-org caller.
4. If any code or documentation commit changes the PR head, get fresh CI and Codex review for that exact SHA and resolve every actionable thread.
5. Squash-merge PR #13 and delete the branch only when the applicable gate is satisfied.
6. Branch Stage 2 from updated `main`; implement the public landing page, Calm Studio shell/routes, resumable onboarding, and authenticated Test Studio with component/E2E/accessibility coverage and viewport captures.
7. Implement Stage 3 operating and learning loop in its dependent PR.
8. Implement Stage 4 Telnyx transport, webhooks, number assignment, inbound routing, outbound calls, and provider tests in its dependent PR.

## Files changed

- Stage 1 product branch: 34 files, led by `migrations/0008_calm_studio_foundation.sql`, `src/studio-api.ts`, `src/index.ts`, `src/call-session.ts`, `src/prompt.ts`, typed web API/session helpers, and worker/UI regression tests.
- Handoff-only working tree:
  - `.agent/current-task.md`
  - `.agent/handoffs/calm-studio-takeover.md`
  - `.agent/archive/current-task-2026-09-06.md`

## Validation

- `git fetch origin --prune` — succeeded; `origin/main` remains `eb13a193`.
- `git rev-list --left-right --count origin/main...HEAD` — `0 5`.
- `gh pr view 13 --repo duguetlabs/openfon ...` — PR open, ready, mergeable, `CLEAN`, head `4f8ab24336`.
- `gh pr checks 13 --repo duguetlabs/openfon` — `check`, `bench-scoring`, and `bench-realtime` pass; `deploy` skipped.
- GraphQL `reviewThreads(first:100)` on 2026-09-06 — 6/6 threads resolved.
- `git ls-tree -r --name-only origin/main .github/workflows` and the same query for `HEAD` — only `.github/workflows/ci.yml`.
- `gh secret list --repo duguetlabs/openfon` — no repository secrets returned.
- `gh variable list --repo duguetlabs/openfon` — no repository variables returned.
- `npm run typecheck` on 2026-09-06 — passed.
- `npm run build` on 2026-09-06 — passed; 44 modules transformed.
- `git diff --check` on 2026-09-06 — passed before handoff document edits.
- `npm test -- --reporter=dot` on 2026-09-06 — **failed: 229 passed, 1 failed across 12 files**. Failure: `test/studio-api.test.ts` daily-ceiling test expected `Retry-After <= 86400`, received `2373611`.
- Previous `npm test -- --reporter=dot` on 2026-08-10 at the same product head — 230/230 passed across 12 files; this is historical evidence, not a substitute for fixing the fresh failure.

## Blockers, risks and unresolved questions

- The full local suite is red because the rate-limit test/code path mixes Vitest's frozen JavaScript clock with SQLite's real clock. Do not merge based only on the older green CI run.
- PR-Agent is absent from this repository, but both current global instructions and the original task request it. Only Cristian can relax that requirement or authorize/provision a supported Duguet Labs setup.
- Adding or committing these handoff files changes working-tree/head state. Any pushed PR head needs a new same-SHA CI and Codex cycle.
- PR #13 is based on an August `main`. Re-fetch and check for upstream movement immediately before any merge or next-stage branch.
- Preserve user-owned ignored reference material and unrelated work. Never use destructive reset/checkout commands to clean the tree.

## Recommended next action

Run the read-only commands in `.agent/handoffs/calm-studio-takeover.md`, reproduce the focused daily-ceiling failure, and make the rolling-day query plus retry calculation use one explicit captured clock. Then rerun the full matrix before asking Cristian for the merge-gate decision.
