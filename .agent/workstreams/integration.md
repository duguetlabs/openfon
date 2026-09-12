# Integration checkpoint

- Status: In progress — QA found recovery loss in ccdd85d; atomic repair and collection quotas are validating locally
- Owner: openfon-integration, gpt-6-astra / medium
- Branch/worktree: codex/integrated-release, /Users/cristian/projects/fun/openfon-worktrees/integration
- Updated: 2026-09-12
- Application candidate: ccdd85df0145607736d9705760aebaafc082dffe
- Published PR16 head: 7a8cb53c167d20e33b9f71ee4937182bdbecc5d7 (unchanged while corrections are local)
- Validation slot: QA exclusively; integration and all other owners run no validation until QA releases it
- Ports: integration8814/9254, optional real-PBX proxy8824; never8787
- Read first: root orchestration-rules/current-task/manifest (read-only), this file, docs/launch/readiness.md
- Earlier detailed milestones and failures remain in this file's history through ccdd85d and the linked original review reports. This checkpoint records current state.

## Authorization and ownership
Sole consolidation/release owner. Preserve root coordination commits, user research and other worktrees. Root alone edits shared current-task/manifest. Personal Duguet Labs secrets use dsecret; never expose values, signed export links or legacy credential files. Capture private command output in restricted files. Existing staged keys are retained; no extra live call, purchase, carrier routing or production mutation is part of this correction round.

User requires exactly one local validation process across owners during host overload. All owners have been notified; grants/releases are explicit. Source-only review/editing may continue. Existing owners remain Telnyx, Asterisk, presets, realtime, launch and QA. QA alone owns genuine official PR-Agent execution. No duplicate inference, substituted reviewer, filtered output or security waiver.

## Current application and corrections
Provider presets0010, Asterisk0011, assistant-essential repair0012 and knowledge budgets0013 are consolidated locally. Default provider identity is preserved. Realtime supports direct OpenAI GA/custom and existing gateway; matching session acknowledgement gates events, replacements preserve the old acknowledged socket on failure, and carrier native readiness waits for bounded first valid PCM. Piper catalogs are endpoint-partitioned and bounded. Carrier DOs retain only a nonidentifying retired marker after durable terminal reconciliation; startup waits are bounded outside lifecycle locks and late sockets are closed.

Studio preserves drafts and explicit activation, excludes reservations from connected metrics, bounds export serialization, supports retry/pagination without lost edits, and distinguishes confirmed saves from refresh errors. Authentication denial and explicit sign-out still clear private state. Root's production dispatch gate remains opt-in/main/true with all prerequisite checks; merge alone does not deploy.

Latest corrections from the completed7a8 review round:

| Finding | Integrated correction | Evidence |
| --- | --- | --- |
| CI Asterisk startup polling race | b821a08, owner25e3632 | Explicit stub-start signal; delayed real-auth regression; owner60 focused/typecheck |
| Asterisk full queue plus FIR tail | d7adc58, ownercae9b46 | Owner21 adapter/typecheck; actual-workerd500-frame XOFF queue waits for marks,501 total frames completes |
| Telnyx input during goodbye3996464087 | 9861e85, owner40e35bf | Owner81 media/control + worker typecheck; two old-source negatives fail; pending input/reorder cancelled |
| Connected duration3996464076 | fc61922, ownerf497799 | Connection origin with legacy null fallback, frozen end and zero clamp;11 SQLite clock regressions |
| STT custom base-path corruption | 98e65d5, owner8e9699e | Explicit resource pathname append; resolved sole merge conflict retaining workspace key/model/validation/manual redirects; owner141 focused/both typechecks with duration |
| Sibling Settings draft loss3996464100 | b7248d6, ownerbb5c951 | Old7a8 browser negative fails; fixed4 provider E2E/both typechecks; final integrated14-browser suite passes |
| Profile restores stale workspace credentials3996464064 | ccdd85d | Apply engine/model/language/voices only; provider and legacy credentials unchanged after apply/bootstrap; old-source negative fails |
| Knowledge persistence security3996484838 | ccdd85d /0013 | Atomic500 items,2MiB UTF8,500 accepted creates/updates per UTC day; refusal before counter write; all collections/statuses/writers |
| Duplicate Telnyx CI invocation / missing public origin | ccdd85d | One scoped invocation retained; actual deploy shell refuses absent origin before mocked npm; build validates supplied HTTPS origin before migrations |
| Alleged lockfile mismatch | Declined5646673872 | Tracked package-lock root ranges equal package.json; exact7a8 npm ci jobs succeeded |

Knowledge quota details: indexed business_id COUNT/SUM; SQL triggers enforce concurrent boundaries; compatibility source and projection share one transaction, with read-only preflight for known refusals. Deletes remain available; shrinking uses the daily edit allowance. Pure FK source-reference cleanup is exempt. Existing oversized data is preserved. Missing default collection refuses writes and bootstrap restores the collection/attachment/projection. Tests cover mixed legacy prefixes, quota429 with item room, stale-preflight competing writer, zero-write refusals, byte/NUL boundaries, tenant isolation, day reset, FK cleanup and legacy migration preservation.

## Current validation
- `node node_modules/vitest/vitest.mjs run --maxWorkers=1`: **660/660 tests,28 files PASS12.93s** after final fixture correction.
- `npm run typecheck`: worker and web PASS.
- Explicit8814/9254 Chrome/workerd E2E: **14/14 PASS51.5s**, including sibling provider/draft refresh and prior guards/retries/export/private calls.
- Quota/profile focused69/69 PASS. Original7a8 profile code fails stale-provider assertion; removing0013 enforcement makes three quota tests fail. Fixed bytes restored.
- `python3 -O scripts/migration-rehearsal.py .`:0006→0013 preservation, binary/SQL restore, rollback/re-upgrade, integrity/FK PASS. Missing0013 copy rejected under-O.
- Actual production deploy shell tested only with mocked npm and synthetic credentials: absent public origin exits1 before deployment; configured origin reaches mock. No deployment executed.
- Earlier integrated Telnyx native/synthesized/retirement, Asterisk call/playback/retirement, direct/gateway workerd smokes passed at their recorded commits. Latest changed transport boundary runtime evidence is owner-attributed above; no new live provider/PSTN claim.
- Existing quality220 tests/one skip, realtime206, report checker122 figures/four allowlisted/zero unresolved, audit0 vulnerabilities were previously verified; not rerun merely for documentation.

Failures preserved accurately: initial profile negative under extreme host load timed out in setup and was not valid evidence; later exact original-source assertion failed normally. Initial focused quota run67/69 exposed an invalid two-workspace test fixture and real missing-default recovery gap; corrected69/69 passed. First full660 run659 passed with old export fixture attempting5MiB after new quotas; fixture now seeds0012 historical data then migrates13, affected17/17 and final660/660 pass. Both published7a8 CI runs34698345800/34698379358 failed the100-event-loop-turn Asterisk test; browser/bench jobs passed and deploy skipped. No blind reruns or timeout increases.

## Independent review and remaining gate
QA independently scoped prior carrier/auth/provider fixes and used original-source negatives. Its restored Astra source recheck preserves prior159-test evidence accurately: those159 cover Studio, route security, presets and Telnyx control, not Asterisk cleanup tests; cleanup has separate owner/runtime evidence. Official reviewer remains unchanged gpt-5.6-sol medium, distinct from owner agent model. Root verified QA's native Astra-medium restoration at14:22Z; earlier Luna interval is not relabelled.

QA source review of0013 identified and drove fixes for outer-save atomicity, FK cleanup, missing index, NUL test design, mismatched legacy prefix and missing-default recovery. Candidate ccdd85d is now assigned to QA for **bounded independent actual-workerd quota/atomicity** with the sole validation slot. No final security closure is assumed before that result and renewed full reviews.

Original genuine official reports are unchanged:

| Reviewed head | Original report | Reported result |
| --- | --- | --- |
|526be52|https://github.com/duguetlabs/openfon/pull/16#issuecomment-5645886103|2 chunks351937 tokens; no security; retained-state finding|
|4a498c8|https://github.com/duguetlabs/openfon/pull/16#issuecomment-5645957875|3 chunks369783; no security; six findings|
|b15ed876|https://github.com/duguetlabs/openfon/pull/16#issuecomment-5646036324|3 chunks391915; no security; six findings|
|04f7613|https://github.com/duguetlabs/openfon/pull/16#issuecomment-5646184566|3 chunks407736; no security; three findings|
|c436c07|https://github.com/duguetlabs/openfon/pull/16#issuecomment-5646226706|3 chunks411584; no security; two findings|
|7a8cb53|https://github.com/duguetlabs/openfon/pull/16#issuecomment-5646511433|3 chunks425785; no security; FIVE findings, not six|

No report above supplied the required clean latest-head major-issue verdict. Hosted7a8 code/security findings are separate and locally corrected as listed. Prior false allegations (Telnyx raw payload/connected token, missing text key before realtime startup, changed deploy ordering) have evidence-backed PR replies. All true current findings need final exact-head hosted code/security and genuine official full re-review after publication. Required close/reopen plus separate @codex review/@codex security review. No merge before both required clean reviewers and CI.

## Staging, production and live evidence
- Staging origin: https://openfon-staging.duguetlabs.workers.dev
- Sourceb15ed8769fc798e84a7721d76179fb51ea3bf560; Worker14edbcb0-a26d-4ff6-b82e-a14b70469e9d,100% at last API verification.
- Separate D1 openfon-release-rehearsal-20260912, e1d93b7d-9024-447a-ae25-6b1e5ed298b3, through0012. **0013 is local only.** Both carrier flagsfalse, cronempty, isolatedDOs; sessions cleared/copied assistants/routes paused except private approved fixture.
- Staging key names REALTIME_API_KEY and DEFAULT_LLM_API_KEY retained through safe vault/stdin injection; no credential values in code/logs/messages. Last verified root200,/api/me401,Telnyx503,Asterisk503; root independently corroborated. Prior0011→12 upgrade preserved business/call/turn fingerprints, FK/integrity.
- Production Worker/DB untouched; no production migration or dispatch. Restricted backup directory /Users/cristian/.local/share/openfon/backups/2026-09-12-integration; explicit staging config/private logs remain restricted. Never print exports/signed links. Historical signed-link exposure expired and is documented in prior checkpoint history; not repeated.
- Original real Kataleptic Northwheel58s/10turn capture remains in docs/launch/demo/audible/: Saturday fixture conflict and literal-null phone preserved. Phone fix696a34a and authorized corrective capture on526be52/versiona1bc90ea passed hours/JSONnull/UI/message/summary,68s/12turns, docs/launch/demo/corrected/. Synthetic caller disclosed; interruption follow-up inconclusive due capture sequencing. No physical microphone/handset/directOpenAI/PSTN claim or extra call authorized in this round.
- Real source-built Asterisk22.11 Local-channel audio passed earlier with mocked AI:660Hz caller,440Hz assistant amplitude7981,11 marks,flush/hangup,rejected revoked route,completed/released D1,zero channels. Latest tail/startup corrections have synthetic workerd evidence; do not relabel older real-PBX run.
- Offline capture helper ce6eccb has14 tests and requires reviewed correlated input/response/playback events. Public anonymous PCM cannot satisfy it; no complete interruption acceptance claim.

## Root/stack reconciliation and next actions
Preserve root branch codex/launch-studio's original coordination commits and untracked docs/research/sim-ai-voice-gateway-2026-09-08.md. Preserve research-only codex/telephony-options/worktree; its8340544 memo is nongating. PR13/14/15 and researchPR10 remain open for coordinated disposition after consolidated acceptance; do not merge old defective heads or delete another owner's worktree. Telnyx account desktop task01a09561-5595-7a20-8871-c9e2b72ecef9 owns pending identity/country/provider choices; no competing account mutation.

Next: receive QA runtime/scoped result and fix any actual issue; finish current docs/replies; publish one validated exact head, close/reopen and retrigger both hosted reviews plus QA official full review. Keep remote/staging freeze until normal coordinated next candidate. After exact-head clean reviewers and CI, squash merge/delete release branch under existing authorization and coordinate root/stack reconciliation without losing research. Staging refresh remains separate, explicit and production-preserving; no competing live call.

## Active independent runtime finding
QA actual-workerd ccdd85d reproduced missing-default recovery loss at exhausted daily quota: first bootstrap429 created empty collection; second200 and next-day200 left knowledge empty because deterministic collection ID matched stale sync marker. Source fix pending validation: collection creation/attachment/projection/sync marker share one batch; quota preflight happens before publishing the repair. Added repeated429/no-collection then next-day restored-item regression. QA still owns sole slot for bounded remaining byte/cleanup probe; integration starts no runner until release. No security closure or new published head.

- QA released sole slot; integration now owns validation. Additional knowledge-scope bypass confirmed: unlimited collection metadata. Local0013 extension adds64 collections/256KiB names+descriptions/100 accepted collection edits per UTCday, rejects before counter write, permitsdelete and exempts is_default-only maintenance. Existing local0013 has not been staged/deployed; no new migration number needed. Tests and atomic-repair regression pending validation; remote remains7a8.

- Collection quotas added locally to unreleased0013:64 collections/256KiB UTF8 metadata/100 accepted collection saves perUTCday. Missing-default creation/attachment/projection/live-call attribution now atomic.71 focused PASS; oldccdd recovery negative and two absent-collection-guard negatives fail. Updated662 full/typecheck/optimized13rehearsal PASS. Further named-existing repair guard avoids a redundant INSERTORIGNORE consuming/rejecting collection quota; added cap64/spent100 regression, current663 full+typecheck+14browser running sequentially in sole integration slot. No current-source runtime security closure yet.

- Corrected follow-up validates663/663 tests28files PASS13.13s, both typechecks PASS,14/14 actual-workerd Chrome PASS46.6s (8814/9254), optimized13rehearsal PASS. No active integration runner. Committing repair/metadata follow-up then QA receives sole slot to rerun unchanged failed actual-workerd repair probe plus bounded collection quota checks; no security closure before independent result.
