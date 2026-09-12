# Integration checkpoint

- Status: In progress — 6ff5058 validated and independently quota-closed; preparing exact-head full reviews
- Owner: openfon-integration, gpt-6-astra / medium
- Branch/worktree: codex/integrated-release, /Users/cristian/projects/fun/openfon-worktrees/integration
- Updated: 2026-09-12
- Application candidate: 6ff505837cbf090f5dceb29bc62abf273ff18b6c
- Published PR16 head: 7a8cb53c167d20e33b9f71ee4937182bdbecc5d7 (unchanged while corrections are local)
- Validation slot: released by QA; no validation process running
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
| Knowledge persistence security3996484838 | ccdd85d +6ff5058 /0013 | Atomic500 items/2MiB/500 item saves per UTC day;64 collections/256KiB/100 metadata saves; independent workerd boundaries and repair pass |
| Duplicate Telnyx CI invocation / missing public origin | ccdd85d | One scoped invocation retained; actual deploy shell refuses absent origin before mocked npm; build validates supplied HTTPS origin before migrations |
| Alleged lockfile mismatch | Declined5646673872 | Tracked package-lock root ranges equal package.json; exact7a8 npm ci jobs succeeded |

Knowledge quota details: indexed business_id COUNT/SUM; SQL triggers enforce concurrent boundaries; compatibility source and projection share one transaction, with read-only preflight for known refusals. Deletes remain available; shrinking uses the daily edit allowance. Pure FK source-reference cleanup is exempt. Existing oversized data is preserved. Missing default collection refuses writes and bootstrap restores the collection/attachment/projection. Tests cover mixed legacy prefixes, quota429 with item room, stale-preflight competing writer, zero-write refusals, byte/NUL boundaries, tenant isolation, day reset, FK cleanup and legacy migration preservation.

## Current validation
- `node node_modules/vitest/vitest.mjs run --maxWorkers=1`: **663/663 tests,28 files PASS13.13s** on final application6ff5058.
- `npm run typecheck`: worker and web PASS.
- Explicit8814/9254 Chrome/workerd E2E: **14/14 PASS46.6s**, including sibling provider/draft refresh and prior guards/retries/export/private calls.
- Quota/profile focused69/69 PASS. Original7a8 profile code fails stale-provider assertion; removing0013 enforcement makes three quota tests fail. Fixed bytes restored.
- `python3 -O scripts/migration-rehearsal.py .`:0006→0013 preservation, binary/SQL restore, rollback/re-upgrade, integrity/FK PASS. Missing0013 copy rejected under-O.
- Actual production deploy shell tested only with mocked npm and synthetic credentials: absent public origin exits1 before deployment; configured origin reaches mock. No deployment executed.
- Earlier integrated Telnyx native/synthesized/retirement, Asterisk call/playback/retirement, direct/gateway workerd smokes passed at their recorded commits. Latest changed transport boundary runtime evidence is owner-attributed above; no new live provider/PSTN claim.
- Existing quality220 tests/one skip, realtime206, report checker122 figures/four allowlisted/zero unresolved, audit0 vulnerabilities were previously verified; not rerun merely for documentation.

Failures preserved accurately: initial profile negative under extreme host load timed out in setup and was not valid evidence; later exact original-source assertion failed normally. Initial focused quota run67/69 exposed an invalid two-workspace test fixture and real missing-default recovery gap; corrected69/69 passed. First full660 run659 passed with old export fixture attempting5MiB after new quotas; fixture now seeds0012 historical data then migrates13, affected17/17 and final660/660 pass. Both published7a8 CI runs34698345800/34698379358 failed the100-event-loop-turn Asterisk test; browser/bench jobs passed and deploy skipped. No blind reruns or timeout increases.

## Independent review and remaining gate
QA independently scoped prior carrier/auth/provider fixes and used original-source negatives. Its restored Astra source recheck preserves prior159-test evidence accurately: those159 cover Studio, route security, presets and Telnyx control, not Asterisk cleanup tests; cleanup has separate owner/runtime evidence. Official reviewer remains unchanged gpt-5.6-sol medium, distinct from owner agent model. Root verified QA's native Astra-medium restoration at14:22Z; earlier Luna interval is not relabelled.

QA source review of0013 identified and drove fixes for outer-save atomicity, FK cleanup, missing index, NUL test design, mismatched legacy prefix and missing-default recovery. QA independently closed the repair and collection follow-up on exact6ff5058 with actual-workerd/D1 probes. The original repair probe passes unchanged (429/429, then200 and one restored Original item after replenishment); its ccdd failure remains preserved. Collection checks pass64-count/256KiB UTF8/100-day boundaries, refusal snapshots, deletion without refund, batch rollback, named-default repair at caps and atomic failed repair including live-call attribution. This scoped closure does not replace renewed full reviews.

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

## Independent quota closure and publication readiness
QA's exact6ff5058 checkpoint records unchanged recovery probe SHA25609d27e915cd82475e4d69a1d02a2f1fc8a70900fc0d8ee40d3a777f5bd38b4c6 and original failing ccdd output. Collection metadata limits and atomic repair passed independent actual-workerd checks; no new major/security issue found in the bounded delta. Both runtimes disposed; QA explicitly released the sole slot. All prior evidence/failures remain in git history. Documentation-only finalization follows the validated application; publish exact head and obtain fresh hosted code/security, genuine official full review and CI before merge. Staging remains b15/0012 and production untouched.
