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

## Protocol Rejection disposition — official full04f7613 report5646184566
Decline; no authentication/media change.

- Read original PR16 report https://github.com/duguetlabs/openfon/pull/16#issuecomment-5646184566 and exact04f7613 configured-token path. src/telnyx-media.ts matches local bytes. src/telnyx-control.ts354 always sends stream_auth_token;407 validates upgrade header against that token before bridge creation. Parser validates the same token in the configured connected frame.
- Current official page: https://developers.telnyx.com/api-reference/websockets/stream-call-media-over-websocket — Connected Frame description explicitly says a configured stream token is sent in both connected.x-telnyx-streaming-auth-token and the identically named WebSocket header.
- Actual rendered AsyncAPI schema obtained from official Markdown https://developers.telnyx.com/api-reference/websockets/stream-call-media-over-websocket.md ; it identifies source openapi/asyncapi/media-streaming/media-streaming.yml. Lines143–150 define connected object and nested token string. Lines159–161 state configured delivery in both places. Generic schema marks connection metadata optional and token-free example contains event/version only; this supports streams without configured token, not the report's assertion that nested metadata is undocumented/never present.
- Official Markdown snapshot SHA256329a96344ad5aa073d2a44777a4232b32c5c01b7710ea21641653cca7b56846a (fetched2026-09-12).
- Pinned Telnyx demo a8c52b0 src/telnyx/api.ts50 sets stream_auth_token; src/telnyx/media-stream.ts53–54 ignores connected events. It neither asserts token absence nor disproves the explicit schema; do not cite that permissive example as runtime evidence for removing authentication.
- `npx vitest run test/telnyx-media.test.ts -t 'connected|authenticates'`:4pass/11unselected. Valid configured token progresses; wrong/missing metadata/version rejects. No test edits, no new commit, no real provider/carrier request.
- Integration owns posting this evidence-backed decline and coordinating next full-head review with unrelated genuine findings. Real handset protocol validation remains a rollout gate; no claim of live compatibility from schema/tests alone.

## Official c436c07 blocking-lock finding — implementation resumed
Read original PR16 report5646226706 and current owner source: media() holds exclusive across unbounded CALL_SESSION.fetch, so a stalled connection queues hangup/alarm behind it. Confirmed. Plan: authenticated claim/persist under lock; 5-second session upgrade outside lock; fresh state/route/flag/deadline/token revalidation under lock before bridge install; close abandoned/late sockets and finalize through current state without releasing unconfirmed reservation. Add deferred stub hangup/alarm/duplicate/timeout/late-close tests. Shared admission and other owners' code unchanged; integration assembles/reviews next head.

## Bounded media connection correction — ready for integration
- Claim/authenticate/persist under exclusive; connect CALL_SESSION outside the lifecycle lock with a5second timer and best-effort AbortSignal. If abort is ignored, late returned socket is accepted/closed by the retained completion handler.
- Reacquire exclusive and reload current state, retired marker, rollout, claimed identity/token, terminal/ending flags, setup/hard/token deadlines, live route/assistant policy and socket readiness before bridge install. Failure calls terminate using freshly loaded state, never the old claim snapshot. Closed/retired calls cannot be resurrected; duplicate media claims remain409.
- Reservation remains occupied on connect rejection/timeout until authenticated carrier terminal confirmation. Alarm and signed hangup processing can proceed while stub remains unresolved; returned unused sockets close independently. Shared realtime admission and native/synthesized greeting paths untouched.
- `npx vitest run test/telnyx-control.test.ts`:62/62pass (11 new bounded-connect regressions). Cases: signed hangup/DB release while pending, alarm/hangup command while pending, duplicate409, exact5second timeout, ignored abort/late101 close, six install revalidation failures, terminal compaction while awaiting result.
- `npm run typecheck`:PASS after correcting a TypeScript closure-narrowing error for the carrier socket cleanup reference.
- `npm test`:448/448pass across20files on this bounded branch.
- `npm run test:telnyx`:native+synthesized workerd PASS; `node test/telnyx-retirement-smoke.mjs`:persisted-restart workerd PASS. All synthetic; ports8810/9250, no real provider/carrier.
- Negative control: temporarily restored pre-fix HEAD control under try/finally; four new progress/timeout tests all fail by the500ms test deadline because original lock blocks them. Restored fixed bytes and62focused tests pass again. `git diff --check`:PASS.
- Next: integration cherry-picks bounded commit and combines separate Asterisk owner fix; QA verifies exact assembled bytes and runs genuine official full review on frozen new head. No old PR15 push, account action, live call or rollout change from this workstream.

## Hosted security3996387851 — unauthenticated media D1 writes
Confirmed Telnyx public media route upserts rate_counters before read-only call lookup and durable token authentication. Removing that redundant public D1 limiter: invented IDs stop at SELECT; real-call bogus tokens stop at owner token read/check before persistence; authenticated duplicate is blocked by durable mediaClaimed. Existing paid-call admission quotas/replay and bounded session connection stay unchanged. Add total_changes/security regressions using real durable owner for bogus real-call tokens and public duplicate path. Integration owns other carrier/index fixes and next exact reviewed assembly.

Validation: `npx vitest run test/telnyx-control.test.ts` — 64 passed; `npm test` — 450 passed across 20 files; `npm run typecheck` and `git diff --check` — passed. `npm run test:telnyx` — native and synthesized actual-workerd synthetic smokes passed on reserved ports, no external requests. Negative control restoring only HEAD route: all three new regressions failed, with 125 extra D1 changes for invented IDs and real-call bogus tokens, and one extra change for authenticated duplicate; fixed route restored. Fixed assertions cover zero D1 changes, unchanged durable payload/alarm for bogus real-call tokens, duplicate 409 without writes, and signed hangup/release while connection is pending. Scope is public handshake writes; read-only call lookup and durable token authentication remain. No control/admission/shared-owner changes or live/staging actions. Integration receives this bounded commit for assembly and exact-head reviews.

## Hosted 7a8 goodbye input finding 3996464087
Verified original hosted finding against frozen 7a8cb53 and local adapter (only frozen difference is a protocol comment). Media checks drained, not ending; pending 100ms reorder recovery can also forward input after ending. Narrow local correction rejects incoming media at ending and cancels/clears buffered input and its gap timer at the transition. Outbound goodbye PCM, mark drain, 12s deadline and control/capacity/retirement remain unchanged. Two regression cases cover direct/missing-packet input, delayed goodbye chunks, final-mark completion, and timeout cleanup. Source work only so far; awaiting integration validation slot before any test/typecheck.

Validation completed under integration sole-slot grant, serially: frozen `7a8cb53:src/telnyx-media.ts` with the two new tests fails both at actual post-ending PCM-forwarding assertions (exit1); fixed bytes restored in finally. `node node_modules/vitest/vitest.mjs run test/telnyx-media.test.ts test/telnyx-control.test.ts --maxWorkers=1` — 81/81 PASS. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.worker.json` — PASS. No broad suite, runtime/live/staging tests, push or duplicate inference. Slot released after these processes finished. Integration owns assembly and exact-head rerun; preserve its existing protocol comment on cherry-pick.

## Official 1428 False Failure — 5646912988
Verified original report and frozen control bytes match local. socket_closed projects failed before signed hangup and persists forever. Source correction makes ordinary carrier close provisional until terminal confirmation and consumes signed normal_clearing as a fixed normalHangup flag; status reconciliation without cause remains conservative. Bridge distinguishes session close and explicit/abnormal socket errors so normal carrier hangup cannot erase them. Both event orderings, provisional restart/capacity, abnormal/unknown cause, retirement/replay and wrapper reason tests prepared. Official Telnyx call tracking documentation uses hangup_cause normal_clearing: https://developers.telnyx.com/docs/voice/programmable-voice/call-tracking . No validation started; Asterisk owns slot.

Scoped validation under sole-slot grant: exact frozen1428 control+media with new regressions produced6 expected assertion failures (premature socket_closed D1 failure, explicit streaming.failed hidden, four abnormal/session wrapper classifications),3 unchanged cases passed. Fixed bytes restored in finally. `node node_modules/vitest/vitest.mjs run test/telnyx-control.test.ts test/telnyx-media.test.ts --maxWorkers=1` —95/95 PASS; `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.worker.json` —PASS. Both normal event orders, restart before signed normal clearing, abnormal/unknown cause, explicit streaming.failed after provisional close, capacity until confirmed terminal, compaction/replay and wrapper timer cleanup covered. All processes finished; slot released to integration. No broad/runtime/live/staging/push/inference.

## Hosted5e0 abnormal webhook-first —3996991110
Verified original report and integration assignments; frozen5e0 control equals local. Signed abnormal/missing cause before socket close leaves reason empty and terminal prevents amendment. Narrow fix records fixed carrier_hangup_failed before terminal for abnormal/unknown cause, preserving specific established failure reasons and signed normal clearing. Six regression cases cover abnormal/missing/unrecognized causes in both orders, finalization overwrite/restart reprojection, release, retirement/replay. Normal fixture now explicitly supplies normal_clearing (internal fixed flag in control fixtures), including synthetic smoke. Sole slot granted for sequential focused negatives/fixed/types/bounded runtime; no other owner runner authorized concurrently.

Validation complete serially in granted sole slot: exact5e0 control with six new tests fails6/6; webhook-first actual SQLite remains completed/answered/null after restart, socket-first retains generic socket_closed rather than new terminal cause. Fixed restored in finally. `node node_modules/vitest/vitest.mjs run test/telnyx-control.test.ts test/telnyx-media.test.ts --maxWorkers=1` —101/101 PASS; worker tsc noEmit —PASS; `node scripts/telnyx-smoke.mjs --native` —PASS actual-workerd signed ingress/authenticated media/greeting/playback/carrier confirmation/D1 release with local synthetic providers and no external requests. No broad suite/live/staging/push/inference. All validation processes exited; slot released.

## Handoff complete —2026-09-13
Root resumed owners after usage reset. Independently verified local8b8f9df is assembled as348dd9c (same bounded four-file correction); QA checkpoint records317/317 scoped checks including signed normal/abnormal/missing Telnyx ordering and no new bounded concern. Combined813/type/runtime evidence is integration-owned, not rerun here. Root/integration retain publication, finding replies and fresh exact-head review/CI gates; no uncompleted Telnyx assignment found. Own tracked tree was clean, with only existing node_modules symlink untracked. Available for newly assigned findings; no runner without explicit sole-slot grant, no completed-review polling/account/live/staging work.

## Official351 pre-auth read budget —5649450367
Verified original report: valid random IDs/tokens trigger unbounded public SELECTs. Added constant-scalar per-registration/isolate budget before D1: burst16, refill2 starts/sec,4 pending lookups; starts are not refunded, permits release in finally on success/error before owner upgrade. No caller map/persistent counter/new secret. Reset on isolate restart; independent isolates each have their own budget, so this is not global/distributed attack protection and saturated admission can temporarily reject valid upgrades. Signed lifecycle webhook route and established sockets bypass it; token/claim/replay checks stay with owner. Existing zero-write regressions continue with paced requests; new burst/source-spoof/concurrency/error/owner-pending/backwards-clock cases prepared. Taking granted sole slot next, sequential focused negatives/fixed/types/native runtime only.

Validation completed serially: original351 route fails the new budget regression at17th valid-shaped bogus request (404 vs required429); fixed bytes restored in finally. Focused admission/control/media `--maxWorkers=1`:105/105 PASS; worker tsc noEmit PASS; native actual-workerd synthetic smoke PASS signed ingress, real owner token/claim/media/audio/terminal confirmation/release, no external requests. Burst probe accepts16/125 into read-only lookup, rejects109 without D1/DO dispatch, then admits one after500ms; concurrent/error/release and five pending owner upgrades covered. Existing125-request zero-D1-write bogus-ID/token probes now pace at500ms to exercise all rejected lookups within budget. All processes exited; slot released. No broad suite/account/live/staging/push/inference.
