# Release integration and existing fixes handoff

- Sender: root orchestration task 01a09543-75cb-7c52-8c7f-4b5a24ed5c75
- Intended recipient: openfon-integration, Codex CLI gpt-6-astra / medium
- Reason: explicit user delegation, 2026-09-12
- Repository path: /Users/cristian/projects/fun/openfon-worktrees/integration
- Branch: codex/integrated-release
- Base commit: b730480685b56de0e785a400621459e3896a7fb1 (Telnyx existing branch starts at d616fff)
- Current commit: verify independently on arrival
- Working-tree status: new isolated worktree, or existing Telnyx worktree with untracked dependency symlink
- Applicable AGENTS.md: root AGENTS.md plus root .agent/orchestration-rules.md containing user-provided rules
- Read first: root .agent/current-task.md, .agent/orchestration-rules.md, this handoff, docs/launch/readiness.md

## Objective
You are the sole integration and release-branch owner. First independently refresh existing PR #13/#14/#15 and #10, review requirements and CI status. Finish the known PR #14 knowledge-draft navigation guard, connected-call totals, retry quota isolation and browser status locator issue in its existing worktree /private/tmp/openfon-launch-review (verify it is otherwise clean except dependency symlink). Preserve and review the stacked PR base relationships. Coordinate Telnyx owner for #15. Reserve schema migrations for new agents and agree shared interfaces. Integrate finished feature commits into your release worktree; coordinate cherry-picks/merges rather than having all agents change the root checkout. Drive meaningful tests, staging migration/backup/restore and release checks. Use the QA owner for independent review. Recheck whether mandatory PR-Agent is available; do not invent a substitute authorization or use private qapture infrastructure from this personal repo. If unavailable, send the root a precise approval question after completing other work. Follow required review loops; you alone may merge green PRs according to policy, never past an unresolved security issue or missing required reviewer. Reconcile old stacked PRs and #10 only with evidence. Production deployment requires verified configuration, backup/rehearsal, accepted release checks and coordination with root/Telnyx desktop; no blind deploy. Keep docs/launch/readiness.md current with actual evidence.

## Scope and exclusions
Own this workstream only; root coordinates overall scope and integration owner owns shared release branches. Read common rules.

## Completed work
Prior launch/carrier state and validation are preserved in root .agent/archive/current-task-2026-09-12-before-provider-expansion.md.

## Incomplete work
Complete the objective above, starting with independent state verification.

## Files changed
Record your explicit changed files in .agent/workstreams/integration.md in your worktree.

## Confirmed findings
Root source b730480 includes disabled Telnyx and existing launch work; PRs #13, #14 and #15 are stacked and open. Real carrier pilot has not passed.

## Decisions and rationale
Isolated worktrees keep concurrent implementation safe; preserve Kataleptic defaults and add usable alternatives.

## Validation performed
Root read-only inspection only for this new delegation. Prior results are evidence at their recorded commits, not the new result.

## Validation still required
Run checks appropriate to your changes and record exact commands/results.

## Known failures, risks and unresolved questions
Existing readiness doc records outstanding fixes, unverified provider credential, operator details and unavailable mandatory reviewer. Reverify before relying on them.

## Actions not to take
Do not overwrite unrelated work, publish marketing, expose secrets, blindly deploy, bypass missing reviewers, or act in another owner's browser.

## Recommended first command
`git status --short --branch` in your assigned worktree.

## Recommended next action
Read the common rules, create your workstream checkpoint, coordinate shared interfaces, and implement the objective.

Verify repository state independently before relying on any of this handoff.
