# Exact d101ff8 ambiguous PUT response preparation

Status: prepared, **unexecuted; actual QA pending**. Source selection is integration `publication-d101ff8/ambiguous-write-preparation-selection.json` following owner b81f2a9 and independent QA agreement. No runtime grant or shared-source application.

Deliver only `delivery.patch` (four target paths) and its two new fixture copies. `prepared-manifest.json` records exact originals, four targets and 214 protected file identities. The exact-base candidate, byte-exact originals and saved fixed targets persist privately. Never replace an integrated handler from the owner branch. Historical `contract.md`/`source.json` retain their proposal-stage status; this preparation record supersedes that status only for the selected preparation.

## Production and helper boundaries

Assistant PUT adds RETURNING to its first UPDATE, preserving every predicate/bind/value and the immediate legacy/snapshot chain. Its existing full batch completes before boolean first-result409 and returned first-row response. Knowledge-item PUT adds RETURNING to the same UPDATE and executes one-statement batch; first-result409 still precedes response. No extra SELECT, adapter, CREATE, foundation, provider, migration, UI or quota change.

The only existing-fixture edit is `knowledge-concurrency.test.ts` holdWrite: mark matching item statements in a WeakSet, retain item/collection run spies, and use one shared one-shot gate from run or before real db.batch. The held item request waits before BEGIN; the competing request can complete outside its transaction. No batchRun interception. Gate ownership is set before awaiting, so peers cannot take the gate. Both spies restore. Assertions, migration1..20, fake clock, existing hooks outside this helper and all case bodies are byte-identical. New fixtures use migrations1..21.

## Concrete bounded future command proposal

No command below has run. Counts are source-inspection predictions. After actual QA acceptance and a separate sole grant, use only existing verified dependencies, unique absent restricted durable output locations and umask077. Native runner itself refuses an existing evidence directory. Application/inspector ports8812/9252; serial commands, Vitest maxWorkers1. No browser/native old-suite/provider/inference/rehearsal/install proposed.

Original mode substitutes **only** byte-exact original Studio source. The adapted concurrency helper and new fixtures remain frozen. After both original commands exit and fresh vacancy is confirmed, restore fixed Studio in finally, then run fixed commands. No source swaps while any command/MF remains active; preserve unexpected setup/fixture/timeouts rather than retrying/editing.

1. Original new API:6 predicted failures at first response-status assertion (500 versus200),14 intentional skips. All first-state/retry/counter snapshots have already been captured.

```sh
npx --no-install vitest run test/put-response-atomic.test.ts --maxWorkers=1 --reporter=verbose -t 'response fault records fresh retry'
```

2. Original native:1 predicted first-status failure after full state and retry capture.

```sh
OPENFON_PUT_NATIVE_CASE=primary-spare-response-fault OPENFON_PUT_EVIDENCE_DIR="$PUT_ORIGINAL_EVIDENCE" node scripts/put-response-smoke.mjs
```

3. Fixed new API:20 predicted passes, run without a filter.

```sh
npx --no-install vitest run test/put-response-atomic.test.ts --maxWorkers=1 --reporter=verbose
```

4. Fixed affected existing concurrency controls:15 selected,6 intentional skips, separate command so the new fixture is never filtered.

```sh
npx --no-install vitest run test/knowledge-concurrency.test.ts --maxWorkers=1 --reporter=verbose -t 'conflicts on captured|deletion after capture|conflicts even when|activation conflicts if|SQL-time activated_at'
```

Selected existing case names: item `conflicts on captured %s in the same second and fresh retry charges once` for collection_id/kind/status/title/question/answer/content (7); collection same title for name/description (2); item and collection `deletion after capture conflicts with no quota or persisted side effects` (2); item and collection `conflicts even when B installs A's desired value` (2); `activation conflicts if content becomes incomplete after readiness validation` (1); `SQL-time activated_at metadata remains current without an unrelated timestamp CAS` (1). This covers11 item batch holds and4 retained collection run holds. The original item run hook is structurally retained; this proposal does not claim an executed original-item-helper compatibility run.

5. Worker types;6.web types, serial.

```sh
npx --no-install tsc --noEmit -p tsconfig.worker.json
npx --no-install tsc --noEmit -p web/tsconfig.json
```

7. Fixed native:10 predicted passing groups.

```sh
OPENFON_PUT_EVIDENCE_DIR="$PUT_FIXED_EVIDENCE" node scripts/put-response-smoke.mjs
```

## New fixture coverage and limits

API20: primary/secondary/item response faults with spare/final quota (6); actual mutation response/row metadata and chain (3); same-second identical fresh writes charged once each (3); captured-row409/full snapshot equality/all statements0 (3); provider409/full primary chain0 (1); late primary mirror/snapshot execution faults/full rollback (2); item activation/draft timestamps, source call/turn references, readiness/owned destination refusal and privileged0021 missing-parent refusal (1); missing primary mirror unchanged downstream behavior (1).

Original fault injection replaces only the separate response SELECT with an execution-time malformed JSON expression. Original committed first state and explicit fresh retry are captured before first assertion. Fixed never reaches that separate read: it succeeds and still permits a deliberate subsequent accepted identical update to charge again. Final-unit retry429 adds no charge in either variant. This is removal of an avoidable response-read failure, not idempotency/deduplication. First failures limit what later assertions establish.

Native10: primary-spare/item-final response faults (2); primary/secondary/item actual RETURNING results and metadata (3); primary provider/secondary captured row/item captured row conflicts (3); late primary mirror/snapshot rollback (2). Captures include complete persisted tables/counters, SQL chains, returned result arrays and statuses. The late SQL CASE is valid at prepare time and calls malformed JSON only if the first UPDATE's greeting is installed; snapshot fault additionally requires the mirror's updated greeting. Failure is execution-time after requested earlier DML. Zero-row controls require every batch result changes0/rows0; positive primary requires changes2/1/1 and exact mirror/snapshot values. Metadata counts are under test, not assumed proven by old CREATE evidence. Full snapshot equality, not total_changes alone, establishes rollback.

API uses Node production handlers/SQLite; native uses bundled Node handlers/workerdD1. Interleaving hooks and faults are synthetic, not whole-Worker HTTP concurrency. Prior foundation baseline is preserved, but these PUTs do not repair it. Privileged missing-parent fixture is not ordinary HTTP exploit proof. No transport/response-delivery exactly-once, arbitrary after-trigger, provider availability, historical production or live failure-frequency claim.

## Preparation verification

Read-only original/protected byte checks and patch inspection only. All Studio bytes outside two handlers and all existing concurrency bytes outside holdWrite/comment are identical. No application parser/import, test discovery/execution, typecheck, SQL, native/browser process, dependency action or shared source write. During source drafting, inspection caught nonexistent source-reference fixture columns; corrected to exact source_call_id/source_turn_id and seeded their FK parents before freeze. This was not a runtime failure or retried test.

Actual QA must review the four target bytes, original identities, helper admission boundary, fault timing, assertions, proposed filters and native disposal/evidence behavior before runtime selection. Raw future captures/locators stay restricted; publish only safe derived receipts. Later owned process/MF/temp cleanup and fresh scans/explicit release remain mandatory if a slot is granted.
