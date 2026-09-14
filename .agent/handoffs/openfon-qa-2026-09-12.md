# Independent release audit handoff

- Sender: root orchestration task 01a09543-75cb-7c52-8c7f-4b5a24ed5c75
- Intended recipient: openfon-qa, Codex CLI gpt-6-astra / medium
- Reason: explicit user delegation, 2026-09-12
- Repository path: private-ref:bcbd5721093747e992b07389d0e0c94c
- Branch: codex/release-audit
- Base commit: b730480685b56de0e785a400621459e3896a7fb1 (Telnyx existing branch starts at d616fff)
- Current commit: verify independently on arrival
- Working-tree status: new isolated worktree, or existing Telnyx worktree with untracked dependency symlink
- Applicable AGENTS.md: root AGENTS.md plus root .agent/orchestration-rules.md containing user-provided rules
- Read first: root .agent/current-task.md, .agent/orchestration-rules.md, this handoff, docs/launch/readiness.md

## Objective
Provide independent code/security and release validation for the integration owner, without taking ownership of implementation files. First inspect the current app, test architecture, provider credential isolation, telephony authentication/admission/teardown and existing readiness evidence to identify actionable gaps and a bounded acceptance matrix. Run meaningful independent checks and reproduce actual defects. Coordinate immediately with integration owner and later review each candidate commit that owner gives you. Verify claims from code/runtime, do not invent findings or recite generic checklists. Inspect fresh installation, per-workspace provider independence, migrations, Asterisk/Telnyx media behavior and UI accessibility as relevant. Document evidence and ready-to-reproduce issues in your workstream record; message exact actionable findings to their owner. Do not issue a no-major/security verdict for a commit you have not inspected. Do not modify application files unless root explicitly hands over a fix. This work does not automatically replace required PR-Agent approval.

## Scope and exclusions
Own this workstream only; root coordinates overall scope and integration owner owns shared release branches. Read common rules.

## Completed work
Prior launch/carrier state and validation are preserved in root .agent/archive/current-task-2026-09-12-before-provider-expansion.md.

## Incomplete work
Complete the objective above, starting with independent state verification.

## Files changed
Record your explicit changed files in .agent/workstreams/qa.md in your worktree.

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
