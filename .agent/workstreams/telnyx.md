# Telnyx workstream

- Status: Compaction fix validated — ready for integration and exact-head reviewer rerun
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
Desktop account owner: task 01a09561-5595-7a20-8871-c9e2b72ecef9; its checkpoint is /Users/cristian/.codex/worktrees/8777/openfon/.agent/workstreams/telnyx-account.md. User signed in; account owner observed Pretrial status and empty application/number/API-key inventories. Business Trial identity connection pending; no account keys/numbers/routing changed.

Integration explicitly confirms no validated staging HTTPS origin or deployment version yet. Desktop webhook configuration remains dependent on that gate. V2 webhook /api/telnyx/webhooks; Worker sends per-call WSS URL/token, inbound_track, PCMU both directions, rtp bidirectional mode, 8000 Hz, target self. Do not manually configure a static stream token. Keep rollout/route disabled until controlled pilot.

## Dependencies and blockers
- Real carrier pilot needs Business Trial eligibility verification/configuration, validated staging deployment and consented verified-phone caller.
- Mandatory PR-Agent availability must be resolved by root/integration; no merge around missing reviewer.
- Provider admission currently uses instance REALTIME_API_KEY/DEFAULT_LLM_API_KEY and model-name greeting checks in src/telnyx-admission.ts. Realtime owner notified to adapt for independent business-scoped providers; no concurrent schema edit here.

## Next action
Root/integration must resolve unavailable mandatory PR-Agent. Validated staging references are recorded below; account owner must establish eligibility and number choice before authorized portal setup. A separately authorized consented real carrier pilot remains required before rollout. Integration owns merging; no independent implementation remains in this bounded PR assignment.

## Pre-push verification
- Default `npm run test:telnyx` now runs native + synthesized sequentially; both passed after adding the dispatcher.
- Realtime owner explicitly accepts narrow src/telnyx-admission.ts provider eligibility changes, retaining quota SQL and sharing telephoneRealtimeAvailable with Asterisk. Greeting gate ownership remains here.

## Published checkpoint
- Commit 37b3575948d9be7c47dd236938876c913cd8a988 pushed to origin/codex/telnyx-inbound (PR #15).
- Replied to confirmed finding: https://github.com/duguetlabs/openfon/pull/15#discussion_r3996092245 . PR description refreshed around current implementation/evidence.
- Closed/reopened PR #15 after fix and requested fresh Codex review: https://github.com/duguetlabs/openfon/pull/15#issuecomment-5645648423 . Reviews/CI pending against this head.
- Integration may inspect/cherry-pick 37b3575 when appropriate, preserving realtime owner's admission/provider changes. No merge performed here.

## Integration and reviewer state
- Integration checkpoint read after notification: 37b3575 cherry-picked as e974f08. Its read-only infrastructure inspection found no staging DB; existing production is version 289e186d-34b2-46b4-8c34-d58e233b69b3 (July), with migrations 0007–0009 pending. No production write/deploy is claimed here.
- Fresh CI check and scoring jobs pass; remaining runtime benchmark/browser jobs pending at observation. Codex summary explicitly reports code review running against 37b3575 since 11:38:58 UTC. Requested separate current-head security review because previous security result was d616fff.
- Only .github/workflows/ci.yml exists; PR-Agent remains unavailable. Integration independently confirms the missing workflow; this owner will not install private qapture workflow or waive required review.

## Exact-head CI milestone
Both CI runs for 37b3575 completed successfully: 34691586371 and 34691574132. Application/typecheck/Telnyx runtime, scoring benchmark, realtime benchmark and browser jobs green; deployment skipped. Code/security reviews still running at this observation. No latest-head new finding posted yet.

## Provider dependency handoff
Realtime owner reports helper 18d3638 and session/admission commit 13f037b (plus presets dependency), preserving this workstream's synthesized-greeting branch. Its reported validation: 450 tests and direct-provider synthetic workerd Telnyx call without instance AI/Azure keys. These are owner-reported results, not rerun on this PR branch; integration owns consolidation and verification.


## Final reviewed-head evidence
- PR #15 head: 37b3575948d9be7c47dd236938876c913cd8a988; pushed and integrated as e974f08.
- Codex code review: no major issues at this head — https://github.com/duguetlabs/openfon/pull/15#issuecomment-5645685093 .
- Codex security review: no security issues at this head — https://github.com/duguetlabs/openfon/pull/15#issuecomment-5645685486 . No new inline Codex findings authored against this commit.
- Both exact-head CI runs passed. Required PR-Agent result is absent despite close/reopen; root/integration owns resolving that external gate. PR remains open/unmerged.
- Remaining changes after reviewed commit are this local workstream checkpoint only, deliberately not pushed as a new PR head that would invalidate completed reviews; node_modules remains the original untracked dependency symlink.
- No staging/deployment, carrier-account mutation, number purchase or real call performed. TELNYX_ENABLED remains false.


## Account eligibility milestone
- Read desktop account checkpoint after its authenticated inspection: Pretrial account, zero apps/numbers/API keys. User must complete Business Trial identity connection in desktop-owned tab; no browser/account action taken by this owner.
- Account owner cites official Pretrial restrictions prohibiting Call Control apps and Trial restrictions limiting inbound calls to the verified phone and ten minutes. Treat these as pilot prerequisites and reverify actual post-upgrade eligibility with that owner.
- Validated staging HTTPS origin remains pending. No routing changed. Read-only check of wrangler.jsonc confirms TELNYX_ENABLED=false; reviewed PR source unchanged.

## Remaining configuration and pilot runbook (prepared; not executed)

### 1. Account eligibility — desktop owner
1. Finish user-directed Business Trial identity connection; inspect actual resulting account level and Call Control permission. Successful SSO alone is insufficient.
2. Obtain user's number-country choice; inspect available voice-capable numbers and concrete setup/monthly/usage prices and regulatory requirements. Use an existing/approved choice only after account eligibility is established.
3. Verify the permitted inbound caller identity in the post-upgrade account. Desktop's official-document finding limits Trial inbound to the verified phone and calls to ten minutes; confirm these limits still apply to the actual upgraded account.
4. Establish secure personal-vault storage before generating the account's API key. Pass item names/safe app IDs only. No CLI account mutation or duplicate provisioning.

### 2. Staging acceptance packet — integration owner
Provide all of the following before desktop sets a webhook:
- Exact validated HTTPS origin, Worker name/version and integrated commit SHA; no guessed workers.dev hostname.
- Explicit D1 staging binding and latest migration number for that commit. Current rehearsal DB alone is not a deployed staging service.
- Current-head tests/QA/review status, including disposition of the direct-provider pre-session.updated issue and missing PR-Agent gate. Preserve reviewed Telnyx greeting fix.
- HTTPS reachability and WSS routing verification; Telnyx callbacks must reach the application without an interactive login/Access challenge.
- Worker secret presence verified without values: TELNYX_API_KEY, TELNYX_PUBLIC_KEY; configured TELNYX_CONNECTION_ID, TELNYX_PUBLIC_ORIGIN, TELNYX_CALL binding and working selected realtime provider. Native greeting or validated server TTS for external-greeting tiers.
- Dedicated pilot workspace/assistant IDs; active realtime assistant with fictional knowledge and a tested browser voice path. Use the actual integrated workspace provider resolver, not assumptions from this older branch's instance-key admission code.
- TELNYX_ENABLED=false and exact number route disabled; existing production untouched. Identify who enables/disables the controlled staging pilot and who verifies carrier release.

### 3. Application and number configuration — desktop + integration
- Desktop: create the eligible Voice API/Call Control application using V2 POST webhook `https://<validated-origin>/api/telnyx/webhooks`; record safe application ID. Include PCMU among permitted codecs and confirm account/app inbound limits.
- Desktop: assign the approved owned voice number to that application. Do not infer assignment from a business contact phone field.
- Integration: set expected application ID and fixed origin in staging; install authorized secrets securely; insert the exact E.164 route to the verified workspace/assistant with enabled=0. Verify row identity and assistant ownership before enabling.
- Worker owns streaming_start: unique per-call WSS URL/token; inbound_track; PCMU both directions; rtp; 8000 Hz; target self. No static media token or token query string in portal settings.
- Once all pilot prerequisites and the specific test window are accepted, enable only that staging route and staging rollout flag. This is a controlled-pilot enablement, not production rollout.

### 4. Consented real handset matrix — carrier implementation + desktop observer
Use the account-verified handset caller. Plan short calls (target under three minutes each), never rely on OpenFon's 30-minute carrier watchdog to enforce Telnyx's reported ten-minute Trial limit. Record actual cost/duration and stop if account eligibility or routing differs from expectations.

| Test | Action | Required evidence |
|---|---|---|
| Greeting and conversation | Call approved number; speak early during pickup, ask one known and one unknown question, request callback, then say goodbye. | First greeting audible in correct order; two-way non-silent audio; no browser-TTS dependency; correct saved transcript/result; audible goodbye before carrier release. |
| Interruption | Interrupt a long answer after greeting. | Old playback stops promptly; response follows new input; no old queued audio resumes. Record observed delay. |
| Caller hangup | Hang up handset during an answer. | Carrier confirms ended; OpenFon finalizes once and reservation is released. No continuing billed leg. |
| Provider failure | On isolated staging pilot config, use an agreed unavailable provider configuration; restore after test. | No silent fallback or indefinitely live carrier leg; owner-visible failure and confirmed release. Never change production credentials. |
| Shared concurrency | Set pilot workspace live cap to one; hold one live call, then attempt another permitted live entry. If Trial cannot supply two verified carrier legs, use a browser **live** call plus verified handset, not a private test session. | Second admission rejected while first reservation remains occupied; first call remains intact; another call admitted after confirmed release. Record whether PSTN/PSTN or web/PSTN was actually tested. |
| Forced media loss | Use a deliberate staging-only media disconnect under integration supervision. | Carrier hangup/reconciliation occurs, D1 finalizes, carrier confirms no live leg and reservation is released. Keep untested if no safe disconnect mechanism exists. |

Inspect configured-token connected/start compatibility, actual PCMU/8000/mono start format, self-leg audibility and playback-mark behavior without retaining raw webhook/media frames. These are unresolved real-carrier checks, not established by synthetic smoke.

### 5. Stop, record and decide — integration/root
- Disable staging route and rollout flag after the test window or on the first unsafe/unexplained failure. Flag changes stop new admission; verify all existing legs terminate separately.
- Confirm terminal carrier state and carrier_released_at for every reservation before considering the pilot finished. Do not manually clear a reservation to make the report green.
- Record date, integrated SHA, Worker version/origin, account tier, number country, provider/model/voice, verified-caller eligibility, each matrix result, observed greeting/turn/interruption delay, charged durations/costs and remaining limitations. Use safe local call IDs; omit caller number, transcript contents, control IDs and tokens from shared reports.
- With a small sample, report raw timings/sample count; do not imply statistically useful p50/p90 quality from a handful of calls.
- Root/integration decide rollout only from actual evidence and completed required reviews. This checklist neither enables traffic nor waives missing PR-Agent.

## Coordination state after preparation
Reviewed HEAD remains 37b3575948d9be7c47dd236938876c913cd8a988. Only local checkpoint edited; no code commit, review polling, deployment or account mutation. Latest integration checkpoint reports migrated rehearsal D1 and green synthetic assembly checks, but no validated public staging origin and a pending direct-provider QA fix. Account eligibility and number choice remain desktop/user dependencies.


## Validated staging handoff — configuration reference only
Read and corroborated against integration checkpoint on 2026-09-12; these are integration-owner deployment/probe results, not fresh probes by this owner.

- HTTPS origin: https://openfon-staging.duguetlabs.workers.dev
- Exact V2 webhook URL: https://openfon-staging.duguetlabs.workers.dev/api/telnyx/webhooks
- Worker version: 8439378c-eeda-4fb7-83e5-a01a2f986fb0 (100%)
- Deployment ID: 44be36d9-0f17-42a9-8361-d22fbb8f0d7a
- Source SHA: 41041c1a3425c1c0ff90697917ce39cdb2394e7a; recorded by integration in OPENFON_RELEASE_SHA.
- Separate staging D1: e1d93b7d-9024-447a-ae25-6b1e5ed298b3, migrations through 0011; separate DO namespaces.
- Both carrier flags false; copied routes disabled, assistants paused, sessions cleared; cron disabled.
- Observed HTTP results: root 200, /api/me 401, POST /api/telnyx/webhooks 503 while disabled. This does not establish signed webhook acceptance, authenticated media/WSS, valid provider credentials or a successful real call.
- Direct-provider pre-ack fix was integrated and scoped QA approved the assembled 6e64872; final release review gates remain independent of that scoped approval.

This supersedes earlier statements that no staging origin/version exists. Desktop may use these safe references for its configuration preparation, but this status authorizes neither account mutations, carrier calls nor route/flag enablement. Account Business Trial eligibility, number-country choice, required reviews and explicit pilot authorization remain open. Reviewed Telnyx head 37b3575 remains unchanged; this update modifies only the local checkpoint.

## PR16 terminal retention finding — implementation resumed
- Official PR-Agent report https://github.com/duguetlabs/openfon/pull/16#issuecomment-5645886103 reviewed; QA corroboration read. Exact526be52 control source matches this branch. At cleanup deadline it persists the full control object with cleanupAt=null then deletes the alarm. Finding is confirmed (inbox usually drained; correlation/seen state retained).
- Proposed safe correction: after final D1 reconciliation, replace full control state with one non-identifying retired=true marker, then delete control and alarm. Ingress checks the marker before any new state/admission; this preserves terminal-first and arbitrarily late freshly signed retries after eviction without retaining correlation, event history, commands or stream capabilities. Simply deleting all state would permit terminal-first revival because no D1 call row exists for that case.
- Telnyx owns narrow src/telnyx-control.ts + regression tests. Integration owns assembly/PR16 publication and exact-head reviewer rerun coordination. No account/pilot/rollout changes.

## Terminal compaction implementation and validation
- Integration explicitly accepted permanent minimal retired=true marker (no total object deletion). Full control record and alarm are removed in one DurableObjectStorage.transaction after idempotent D1 final reconciliation. A transaction failure leaves terminal state/replay boundary intact; alarm retries. Retired ingress/media never load/recreate operational state; reconcile and stale alarms compact idempotently without scheduling another alarm.
- Legacy cleanupAt=null terminal records compact when next awakened. This does not enumerate/backfill already dormant objects; namespace-wide historical erasure is not claimed. Normal hangup already clears streamToken; confirmed prior retention is seen/correlation/full control metadata, not an invariably retained live token.
- Tests: 51/51 focused Telnyx control tests; full 437/437 application tests; typecheck passed. Covers terminal-first, admitted/released D1 row, account deletion, restart, fresh late initiation/replay, media/reconcile, deadline, legacy state, D1/marker/delete/alarm/commit failure rollback/retry.
- New `node test/telnyx-retirement-smoke.mjs`: PASS actual SQLite workerd atomic compaction + full Miniflare restart using resourcePersistencePath + inert late events/media/reconcile. Synthetic D1 terminal UPDATE stub only; outbound network rejects all requests; ports8810/9250 with overrides supported. Initial persistence probe failed because convertV4MiniflareOptions ignores old persistence options; native resourcePersistencePath correction verified the persisted restart. No app defect inferred from harness setup error.
- `npm run test:telnyx`: native + synthesized real local workerd modes PASS after compaction fix.
- Negative control: restored original control source with try/finally and reran selected retirement tests; six selected tests fail; actual workerd fails because full control remains with cleanupAt=null. Restored fixed bytes; full checks above pass.
- Cloudflare transaction contract checked: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction ; installed types include txn.put/delete/deleteAlarm. Runtime check independently exercises that API.

## RTP header finding disposition (PR16 inline3996207627)
Decline proposed RTP wrapping; no media-format implementation change justified.

Evidence checked 2026-09-12:
1. Official WebSocket contract https://developers.telnyx.com/api-reference/websockets/stream-call-media-over-websocket describes Client Media Frame media.payload as base64 RTP payload in bidirectional rtp mode; Telnyx Media Frame explicitly excludes RTP headers. No client RTP-header/SSRC fields are specified.
2. Official bidirectional guide https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming#sending-rtp-stream sets rtp and sends JSON event/media/payload, accepting20ms–30s chunks. Official streaming-start reference describes RTP payload as raw audio: https://developers.telnyx.com/api-reference/call-commands/streaming-start .
3. Stronger outbound-code evidence in Telnyx-owned team-telnyx/realtime-ai-demo, pinned commit a8c52b0faa30b97ef7c5fb2ea648f048f9b44a23: README Verified API decisions explicitly describes PCMU8k as raw mu-law without headers and160bytes/20ms; its PCMU transformOutbound returns the provider base64 unchanged (session.ts226–227); onAssistantAudio passes it to sendMedia (201–206); buildMediaFrame wraps only event/media/payload (media-stream.ts105–107). No RTP header constructed. This directly contradicts complete-packet requirement claimed by reviewer.
- Pinned source: https://github.com/team-telnyx/realtime-ai-demo/blob/a8c52b0faa30b97ef7c5fb2ea648f048f9b44a23/README.md#verified-api-decisions-may-2026
- Outbound transform: https://github.com/team-telnyx/realtime-ai-demo/blob/a8c52b0faa30b97ef7c5fb2ea648f048f9b44a23/src/bridge/session.ts#L226-L231
- Sender: https://github.com/team-telnyx/realtime-ai-demo/blob/a8c52b0faa30b97ef7c5fb2ea648f048f9b44a23/src/telnyx/media-stream.ts#L105-L108

160rawPCMU bytes represent20ms at8kHz and match this contract. Existing waveform/resampling/media tests stay unchanged. This is protocol-source evidence, not a real OpenFon carrier pilot; carrier gates remain. Integration owns posting disposition and requesting fresh Codex/official PR-Agent review on the assembled cleanup fix; duplicate cleanup3996207630 is resolved by compaction candidate.


## Compaction handoff
- Deliverable files: src/telnyx-control.ts, test/telnyx-control.test.ts, test/telnyx-retirement-smoke.mjs, this checkpoint. Shared admission/realtime/media files unchanged.
- QA reports independent actual-workerd SQLite compaction passed on current source: retired-only storage, no alarm, no revival from late events/reconcile; original payload-removal negative control fails. QA will compare exact committed bytes and coordinate official PR-Agent rerun with integration.
- Next action: integration cherry-picks bounded commit, includes new retirement smoke in its validation/CI as appropriate, replies to cleanup findings, posts RTP decline with pinned evidence, freezes assembled head and requests official PR-Agent plus Codex reruns. No live calls/account/route actions authorized by this fix.
