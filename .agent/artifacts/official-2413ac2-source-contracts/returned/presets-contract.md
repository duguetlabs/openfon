# Reservation Leak — exact 2413 source contract

Authority: Root653a7f5, integration selection a0b32c89 and citation map606f8c41. Original PR16 comment5683817963, SHA59caa88d. Base2413ac285754202c791178d4bf713a50116d8acc. `source.json` pins twelve committed=working integration files; Studio9855b8c5. No prior owner2413 contract found. This is a source assessment and future proposal, not preparation, selected policy, execution evidence or clearance. Integration alone routes the existing QA request.

## Supported finding and exact boundaries

The original recommendation is supported for **confirmed earlier reservations left behind when a later acquisition throws**. A thrown D1 request is not itself proof that its statement failed to commit. Both facts matter; a blanket catch that manufactures or retries refunds would be unsafe.

`src/studio-api.ts:94–112` atomically increments one `(bucket,window_start)` via UPSERT RETURNING. A returned row confirms one increment and produces a token; null means no capacity was acquired. A rejection returns neither token nor definitive commit information. There is no multi-bucket transaction or persistent request/reservation identity.

Source-derived schedules, with sufficient capacity and a definite pre-execution failure of the indicated statement:

| Boundary | Earlier confirmed increments currently retained | Requested work |
| --- | --- | --- |
| Either caller: IP-minute acquisition throws | workspace minute | No ticket insertion/provider fetch reached |
| Either caller: IP-day acquisition throws | workspace minute + IP minute | No ticket insertion/provider fetch reached |
| Provider check: provider-day acquisition throws | workspace minute + IP minute + IP day | No provider fetch reached |

Test caller1231–1245 and provider caller1877–1891 construct their combined token array only **after** `reserveStudioIpSpend` resolves. The helper157–171 loses its locally confirmed minute token when its awaited day acquisition throws. Provider-day1904–1911 is a further unguarded await, even after the combined array exists. A caller catch alone cannot recover the helper's hidden token; helper cleanup alone cannot recover the caller's workspace token. Workspace acquisition itself may throw after an ambiguous commit, but there is then no earlier confirmed token to refund.

These are concrete control-flow counterexamples with injected database failure, not observed production outages or new executed tests. Repeated definite acquisition faults can consume workspace minute capacity10 and, at provider-day failure, shared IP daily capacity150 without upstream work. This is capacity loss/false throttling, not a demonstrated quota bypass. Fixed-window expiry bounds active throttling; cron later removes old rows (`index.ts:1476`). No loss frequency is established.

## Existing quota, errors and attempt semantics

- Workspace minute10 is shared by both routes. IP minute20 and IP day150 are shared across workspaces/routes; absent or blank CF-Connecting-IP uses `local`. Provider day50 is a separate workspace fixed-day bucket. Test day100 is a rolling count of stored test calls, regardless of call status, using the captured request time and conditional INSERT. These are not the assistant/knowledge/preset write-budget buckets.
- Known-full reads reject429 before reservation writes, with existing minute/fixed-day/rolling-day Retry-After. A later null IP or provider-day reservation refunds only returned earlier tokens, then429. Preflight is not a concurrency guarantee; UPSERT/conditional call INSERT remain authoritative.
- Provider check1823ff runs foundation, target selection and configuration resolution before spend. Invalid config400 makes no Studio reservation/upstream request, but earlier foundation can legitimately write/charge other budgets. Test-call ownership404 is before spend; admitted test-call foundation1261ff runs after reservation. Its caught failure refunds Studio tokens; completed foundation writes are not rolled back by refunds.
- Generic acquisition/refund database errors escape to `index.ts:33–64` and normally500; known budget marker errors retain existing409/429 mappings. There is no automatic route retry or reservation-repair worker. A subsequent explicit client retry is a new attempt subject to retained counters. No invented retry charge or idempotency promise.
- Test-call foundation failure/missing workspace, call INSERT catch, and confirmed zero-insert already refund (`1264–1303`). Successful insertion returns201 and keeps the three Studio increments. Unused-ticket cancellation1310ff deletes eligible call rows, freeing the rolling test-day count, but does not refund Studio fixed-window spend. Ticket admission is not proof of connected conversation/provider spend.
- After confirmed provider-day admission, `chatComplete` is intentionally outside any refund behavior. Success200 and upstream error502 (or the existing LlmConfigError400 branch) retain all four counters. `providers.ts:164–207` and `provider-response.ts:11–72` perform one bounded fetch/read attempt without a retry loop. Failure, timeout or invalid response does not prove no upstream work occurred. Do not make failed provider attempts free through a broad finally/catch.
- `rate_counters` has aggregate count/starts and composite key, no per-request receipt (`0007:8–18`). Studio changes count only; starts stays unchanged. Other budget triggers use separate namespaces. No schema change is needed for the bounded confirmed-token correction.

## Safe proposed correction, requiring integration selection

Use a single per-request acquisition journal visible to both caller and IP helper. Add a token immediately after its individual await successfully returns a row, before another acquisition can throw. Keep the existing null/blocked result and gate order. A narrow acquisition error boundary attempts to refund the accumulated **confirmed** tokens once, then propagates the acquisition error. It includes the provider-day acquisition boundary and ends before provider attempt dispatch. Existing later test-ticket cleanup can consume that same confirmed ownership without double refund.

There must be one cleanup owner for a token, with the journal drained/marked before an awaited refund so nested catches or a refund rejection cannot submit it twice. Alternatively explicitly partition helper/caller ownership, but do not independently refund the same token in both. Preserve the primary acquisition error if cleanup itself rejects, without exposing raw database/provider detail or pretending cleanup succeeded. A failed/uncertain cleanup must remain an acknowledged residual; no automatic refund retry.

Retain current reverse-order, exact-window decrement-then-delete batch (`115–136`). With one increment confirmed and one refund submission, aggregate arithmetic preserves peer increments in the same bucket; count>0 prevents negative values but **does not provide ownership/idempotency**. Never recompute the window, clear an entire bucket, infer acquisition from a later aggregate read, or refund a token for the currently rejected/unknown write. Example: A's IP write fails before execution while B acquires that bucket; A fabricating a token and decrementing the now-positive row would refund B's spend. The same risk applies if a refund commits but its acknowledgement is lost and A retries it.

Do not wrap provider execution or existing refund branches in an indiscriminate cleanup finally. A transaction alternative requires its own semantics for zero-row gates and outcomes; merely batching UPSERTs does not abort peers when one returns no row. No such redesign, migration, policy expansion or implementation is selected here.

## Explicit residuals

1. A reservation that commits then rejects to the caller has no returned token. Confirmed-token cleanup can recover earlier writes but must conservatively leave this uncertain increment. Process death and refund DB failure can also retain capacity. This proposal is exception cleanup, not all-or-nothing durable admission or exactly-once refunds.
2. Existing test-call INSERT catch1293ff refunds confirmed counters even if that INSERT committed before its response failed. The call may remain and still count toward the rolling day while fixed-window counts are reduced. Current source cannot distinguish precommit failure from lost acknowledgement. This is an adjacent existing uncertain-outcome limitation, not proof of the reported acquisition leak nor a selected redesign. A generic enlarged catch must not silently claim to solve it. Existing insertion-failure test is pre-execution only.
3. A refund batch's atomic DML does not make all earlier standalone reservations or foundation writes transactional. Successful repair remains separate. No promise of full unchanged workspace snapshot on a route failure.
4. Aggregate tokens are local bookkeeping, not persisted unique receipts. Stronger recovery after termination/uncertain commit would require separately selected durable ownership/idempotency semantics. No speculative schema proposed.

## Bounded future evidence proposal — no fixtures or commands prepared

- Discriminate both callers at IP-minute and IP-day definite prewrite faults, plus provider-day prewrite fault: full before/after counter rows, starts, calls and fetch count, including preexisting peer increments. Original should retain only the earlier acquired increments; proposed fix should restore that baseline without requested work.
- Separate commit-then-reject faults from prewrite faults for each acquisition. Earlier confirmed increments may be refunded; the ambiguous increment must remain, and an unrelated peer's increment must never be decremented by guessed ownership.
- Exercise helper partial ownership, one cleanup submission, refund-before-execution failure and refund-committed-then-rejected outcomes. Verify no duplicate refund/retry and preservation of primary error. Include minute/day boundary crossing and a peer increment before refund; inspect old and new windows independently.
- Preserve existing controls for known-full read-only429, null final gate refund/Retry-After, invalid target/config, successful test admission, conditional test-day loser, and provider success/upstream failure charging. Explicit retry after a definite acquisition fault should consume once; no automatic retry assertion.
- If separately granted, minimal native D1 evidence should establish actual UPSERT RETURNING/null and refund-batch rollback/peer counts. Transport ambiguity would still be a synthetic wrapper outcome, not proof of deployed D1 failure frequency. No browser, inference, whole-suite or closed CREATE/PUT/POST replay is indicated.

Existing `test/studio-api.test.ts:1321–1758` covers shared caps, invalid preflight, captured-window null provider-day, pre-execution ticket INSERT failure and raced test-day refusal. The test named “failed provider-day reservation” exercises **null capacity**, not a thrown acquisition. `test/sqlite-d1.ts:23–25` invokes its hook before the write; that adapter alone does not model committed-then-rejected outcomes. Existing cancellation source covers call-row deletion, not Studio counter refunds. No new execution or native result is claimed.

All prior evidence remains closed. Original574 omissions, rebuilt/historical coverage and transport/unknown-outcome limits are preserved; this assessment provides neither broad review coverage nor clearance. No application/fixture, policy, dependency or shared-source changes, no imports/tests/types/SQL/native/browser/runtime/inference/publication. Next: integration routes this exact contract once to existing pK before any correction selection.
