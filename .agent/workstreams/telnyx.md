# Telnyx workstream

- Status: In progress — implementation validated; PR review and external pilot pending
- Owner: openfon-telnyx
- Branch: codex/telnyx-inbound
- Base commit: d616fffb2c561bdb44603c288883144d9ec639d7
- Last updated: 2026-09-12
- Rules: root AGENTS.md, root .agent/orchestration-rules.md, Telnyx handoff
- Ports: application 8810; inspector 9250; never 8787

## Objective and scope
Finish inbound Telnyx adapter, greeting/input ordering, setup diagnostics and regression coverage. Integration alone consolidates/merges; realtime owns provider schema/adapter changes. No migrations planned.

## Confirmed facts and decisions
- Initial checkout matched PR #15 head; only untracked node_modules dependency symlink. Root personal-project rules require dsecret; no secrets fetched.
- PR #15 comment 3994125261 is real: ready previously preceded awaited saveTurn/synthesize, releasing buffered carrier input early.
- Carrier ready now waits for successful synthesis and turn persistence; ready and greeting PCM are queued with no intervening await. Late synthesis after hangup emits neither ready nor audio. Browser readiness behavior remains unchanged.
- Realtime owner acknowledged narrow runStart branch ownership and will preserve this fix.
- Telephone rollout remains disabled. No real AI/carrier pilot or staging deployment verified.
- PR-Agent absent from initial reviews/checks; latest existing Codex security review was clean but code review had the now-fixed greeting finding.

## Work completed
- Read root rules/current task/manifest, handoff, strategy/readiness and account/integration checkpoints.
- Implemented greeting race fix and delayed synthesis, empty synthesis, hangup regressions.
- Added synthesized workerd scenario alongside native greeting; default CI command runs both sequentially on reserved ports.
- Added staging handoff requirements, exact media settings and safe setup diagnostic matrix/aggregate SQL to docs/telephony.md.
- Rechecked official Telnyx streaming-start and WebSocket protocol docs on 2026-09-12; existing configured token contract retained.

## Files changed
- src/call-session.ts
- test/call-session.test.ts
- scripts/telnyx-smoke.mjs
- docs/telephony.md
- .agent/workstreams/telnyx.md

## Validation
- `npm run typecheck` — passed.
- `npm test` — 426/426 tests across 20 files passed.
- `npx vitest run test/call-session.test.ts test/telnyx-media.test.ts` — 94/94 passed, repeated after negative control restored fixed source.
- `npm run test:telnyx` native mode and `npm run test:telnyx -- --synthesized` — passed; real local workerd, ephemeral D1/DO/WebSockets, generated signing keys and local mock outbound services only.
- Negative control: temporarily restored original HEAD CallSession using try/finally, ran targeted tests, restored fixed bytes. All 3 unit assertions failed; synthesized workerd failed expected input-gate assertion (1 input vs 0). This establishes regression sensitivity to original defect.
- `git diff --check` — passed.
- No browser UI changes; no new browser test required for this transport-only fix. Real handset/provider tests not run.

## Account/deployment coordination
Desktop account owner: task 01a09561-5595-7a20-8871-c9e2b72ecef9; its checkpoint is /Users/cristian/.codex/worktrees/8777/openfon/.agent/workstreams/telnyx-account.md. Login pending; no account keys/numbers/routing changed.

Integration explicitly confirms no validated staging HTTPS origin or deployment version yet. Desktop webhook configuration remains dependent on that gate. V2 webhook /api/telnyx/webhooks; Worker sends per-call WSS URL/token, inbound_track, PCMU both directions, rtp bidirectional mode, 8000 Hz, target self. Do not manually configure a static stream token. Keep rollout/route disabled until controlled pilot.

## Dependencies and blockers
- Real carrier pilot needs account sign-in/configuration, validated staging deployment and consented caller.
- Mandatory PR-Agent availability must be resolved by root/integration; no merge around missing reviewer.
- Provider admission currently uses instance REALTIME_API_KEY/DEFAULT_LLM_API_KEY and model-name greeting checks in src/telnyx-admission.ts. Realtime owner notified to adapt for independent business-scoped providers; no concurrent schema edit here.

## Next action
Commit explicit files, push PR #15, reply to confirmed finding and close/reopen/request Codex review. Inspect findings against latest head; integration owns eventual merge. Await staging references for account handoff.

## Pre-push verification
- Default `npm run test:telnyx` now runs native + synthesized sequentially; both passed after adding the dispatcher.
- Realtime owner explicitly accepts narrow src/telnyx-admission.ts provider eligibility changes, retaining quota SQL and sharing telephoneRealtimeAvailable with Asterisk. Greeting gate ownership remains here.
