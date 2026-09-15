# Temporary OpenFon PR-Agent-only review requirement

Date: 2026-09-13
Status: Accepted

## Context

The inherited review policy requires PR-Agent and hosted GitHub Codex reviews.
The user reports exhausted Codex credits and explicitly instructed: "Suspend the
Codex review requirement for now and leave only PR-Agent for openfon."

## Decision

Suspend the hosted GitHub Codex review requirement for OpenFon until the user
reinstates it. Do not request or wait for new Codex reviews as a merge gate.
Require genuine PR-Agent clearance against the latest commit (no security
concerns and no major issues) and passing required CI before integration merges.

## Rationale

The user authorized this scoped exception to avoid blocking OpenFon on an
unavailable reviewer while preserving the available review and validation gates.

## Alternatives considered

Keeping dual review would retain the reported credit blocker. Removing all
review requirements would exceed the user's instruction. Neither is adopted.

## Consequences

PR-Agent remains mandatory and must be re-triggered after every fix. Verify all
findings, fix real issues and explain declined findings. Existing Codex findings
remain subject to this process; their origin does not invalidate them. Never
merge with an unresolved security finding. Integration alone publishes/merges.
Production deployment remains separately opt-in. Other repositories are unaffected.

## Affected components

Root AGENTS.md, orchestration rules, coordinator current-task/manifest, active
integration and QA owners, release-readiness documentation and heartbeat prompt.

## Related material

- ../../AGENTS.md
- ../orchestration-rules.md
- ../current-task.md

## Follow-up work

The master reconciles shared coordination state; integration carries this policy
into the release branch/readiness documentation and checks for any actual hosted
Codex gate. Preserve all other gates. Restore the Codex requirement only on the
user's instruction. Historical handoffs remain historical.
