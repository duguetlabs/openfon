# OpenFon provider and telephone implementation

- Status: In progress
- Owner/active agent: root orchestration task 01a09543-75cb-7c52-8c7f-4b5a24ed5c75
- Branch: codex/launch-studio (coordination); codex/integrated-release (integration owner)
- Base commit: b730480685b56de0e785a400621459e3896a7fb1
- Last updated: 2026-09-12T11:28:54.423162+00:00
- Applicable AGENTS.md: repository AGENTS.md; user-provided instructions preserved in .agent/orchestration-rules.md
- Read first: this file, .agent/orchestration.json, .agent/orchestration-rules.md, assigned handoff, docs/launch/readiness.md

## Objective
Finish Telnyx telephone integration, add open Asterisk integration, add alternative provider presets and independent realtime configuration, and finish the remaining onboarding/release work. User explicitly requests Astra medium Codex CLI agents in Herdr openfon, a desktop Telnyx browser task, and ongoing orchestration/check-ins.

## Scope
Separate implementation owners below; root manages dependencies, durable checkpoints, desktop account handoff and recurring progress checks. Integration owner consolidates code and drives release verification/reviews.

## Out of scope
Unrequested marketing distribution, fabricated business identity/application data, unbounded new spending, provider default replacement, and unsupported claims of real-provider/telephone readiness. Existing user research file remains untouched.

## Confirmed facts
- Herdr openfon is workspace w1; original pane w1:p1 is not ours and must remain untouched. User focus is in another workspace.
- Installed Codex CLI is 0.153.4. Agents requested as gpt-6-astra with model_reasoning_effort=medium.
- Local root b730480 consolidates the existing stacked launch/carrier work. PR #13 foundation targets main, #14 launch targets foundation, #15 Telnyx targets launch. PR #10 remains open.
- Prior state and all earlier validations/blockers preserved in .agent/archive/current-task-2026-09-12-before-provider-expansion.md; reverify current status.
- Repository is public and MIT licensed. Telephone adapter remains disabled pending a real carrier pilot.

## Hypotheses
- Existing Telnyx account can supply configuration/number access: desktop task verifies.
- Asterisk chan_websocket fits the current media boundary: Asterisk owner validates with implementation/runtime tests.
- Direct OpenAI realtime can work independently of Kataleptic: realtime owner verifies full workflow, not just URL configuration.

## Decisions
- Each workstream has one owner and an isolated worktree; root owns this document and manifest.
- Presets owner owns shared provider schema/configuration/UI; realtime owner agrees its contract before shared edits. Integration owner reserves migrations and handles consolidation.
- Desktop task alone operates Telnyx account/browser. No secret values enter docs, messages, or source.
- Keep existing Kataleptic default; alternatives are presets.
- Existing mandatory review rules remain until an explicit user decision changes them.

## Work completed
- Read current checkout, historical readiness and Herdr topology.
- Prepared bounded workstream handoffs and common operating rules.

## Work remaining
Launch and verify agents, create desktop Telnyx task, record IDs, install recurring check-in, then resolve findings/dependencies through completed and validated implementation.

| Workstream | Owner | Branch | Worktree | State |
|---|---|---|---|---|
| telnyx | openfon-telnyx | `codex/telnyx-inbound` | /private/tmp/openfon-telephony | Prepared |
| asterisk | openfon-asterisk | `codex/asterisk-integration` | /Users/cristian/projects/fun/openfon-worktrees/asterisk | Prepared |
| presets | openfon-presets | `codex/provider-presets` | /Users/cristian/projects/fun/openfon-worktrees/provider-presets | Prepared |
| realtime | openfon-realtime | `codex/realtime-providers` | /Users/cristian/projects/fun/openfon-worktrees/realtime-providers | Prepared |
| integration | openfon-integration | `codex/integrated-release` | /Users/cristian/projects/fun/openfon-worktrees/integration | Prepared |
| launch | openfon-launch | `codex/launch-kit` | /Users/cristian/projects/fun/openfon-worktrees/launch-kit | Prepared |
| qa | openfon-qa | `codex/release-audit` | /Users/cristian/projects/fun/openfon-worktrees/release-audit | Prepared |

## Files changed
Only root coordination documents in this dispatch; previous user research untouched. Each agent records its own changes in .agent/workstreams/<role>.md.

## Validation
`git status`, `git log`, `git worktree list`, `gh pr list`, `herdr workspace list`, `herdr pane list` inspected. No new app test, real AI call or carrier call claimed at dispatch.

## Blockers, risks and unresolved questions
Desktop task must inspect Telnyx account eligibility and existing numbers. Number country/price and any required identity proof must be concrete before asking user for missing decisions. Prior required-reviewer problem must be reverified by integration owner. Shared interfaces need coordination.

## Recommended next action
Inspect .agent/orchestration.json and each owner's checkpoint, confirm agent model/effort and active state, then advance independent work and resolve precise blockers.
