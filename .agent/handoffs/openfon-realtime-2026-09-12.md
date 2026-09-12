# Independent realtime provider handoff

- Sender: root orchestration task 01a09543-75cb-7c52-8c7f-4b5a24ed5c75
- Intended recipient: openfon-realtime, Codex CLI gpt-6-astra / medium
- Reason: explicit user delegation, 2026-09-12
- Repository path: /Users/cristian/projects/fun/openfon-worktrees/realtime-providers
- Branch: codex/realtime-providers
- Base commit: b730480685b56de0e785a400621459e3896a7fb1 (Telnyx existing branch starts at d616fff)
- Current commit: verify independently on arrival
- Working-tree status: new isolated worktree, or existing Telnyx worktree with untracked dependency symlink
- Applicable AGENTS.md: root AGENTS.md plus root .agent/orchestration-rules.md containing user-provided rules
- Read first: root .agent/current-task.md, .agent/orchestration-rules.md, this handoff, docs/launch/readiness.md

## Objective
Implement direct independent OpenAI Realtime plus the existing Kataleptic gateway using explicit adapters and supported capabilities, based on current official OpenAI documentation. Coordinate immediately with presets owner, who owns shared configuration/schema/UI; agree the contract before editing those shared files. Own realtime transport/session logic and its tests. Preserve existing gateway behavior, telephone audio requirements, greeting, interruption, tools, finalization, summaries and transcript persistence. Do not treat an OpenAI model selected through Kataleptic as independence. Provide a reproducible full workflow with Kataleptic credentials removed and its endpoints unavailable, including catalogs/greetings/summaries. Use authorized vault credentials only if available; never claim live-provider verification from mocks. Record untested live paths explicitly. Coordinate CallSession changes with Telnyx and Asterisk owners and give integration owner clean commit boundaries.

## Scope and exclusions
Own this workstream only; root coordinates overall scope and integration owner owns shared release branches. Read common rules.

## Completed work
Prior launch/carrier state and validation are preserved in root .agent/archive/current-task-2026-09-12-before-provider-expansion.md.

## Incomplete work
Complete the objective above, starting with independent state verification.

## Files changed
Record your explicit changed files in .agent/workstreams/realtime.md in your worktree.

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
