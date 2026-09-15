# Provider presets handoff

- Sender: root orchestration task 01a09543-75cb-7c52-8c7f-4b5a24ed5c75
- Intended recipient: openfon-presets, Codex CLI gpt-6-astra / medium
- Reason: explicit user delegation, 2026-09-12
- Repository path: private-ref:e8fc3e85bf6842178fcf3cf86c3dd9b9
- Branch: codex/provider-presets
- Base commit: b730480685b56de0e785a400621459e3896a7fb1 (Telnyx existing branch starts at d616fff)
- Current commit: verify independently on arrival
- Working-tree status: new isolated worktree, or existing Telnyx worktree with untracked dependency symlink
- Applicable AGENTS.md: root AGENTS.md plus root .agent/orchestration-rules.md containing user-provided rules
- Read first: root .agent/current-task.md, .agent/orchestration-rules.md, this handoff, docs/launch/readiness.md

## Objective
Implement user-selectable provider presets for Kataleptic, OpenRouter, Hugging Face Inference Providers, direct OpenAI, and custom OpenAI-compatible endpoint/key/model configuration. Kataleptic remains the existing default; presets are alternatives, not new defaults. Verify current provider endpoints, model naming and capability limits from official documentation. Separate text LLM, STT, TTS and realtime capabilities; never label OpenRouter/Hugging Face as realtime voice providers merely because chat works. Preserve custom models/URLs and safe per-workspace credentials. Include clear maintainer/optional paid Kataleptic disclosure and actionable connection/configuration errors. Own shared provider configuration/schema and settings UI. Coordinate immediately with realtime owner on one shared persisted configuration contract and reserve migration numbers with integration owner. Make alternatives genuinely accessible. Add meaningful API/UI/security tests appropriate to credentials/configuration. Do not introduce unrequested paid plans or send credentials to a changed endpoint.

## Scope and exclusions
Own this workstream only; root coordinates overall scope and integration owner owns shared release branches. Read common rules.

## Completed work
Prior launch/carrier state and validation are preserved in root .agent/archive/current-task-2026-09-12-before-provider-expansion.md.

## Incomplete work
Complete the objective above, starting with independent state verification.

## Files changed
Record your explicit changed files in .agent/workstreams/presets.md in your worktree.

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
