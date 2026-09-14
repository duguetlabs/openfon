# Exact ddce webhook leases — source prepared, not executed

Base: `ddce0bde6c16633541dc65811fbb833865c7af2a`.
Snapshot: `/tmp/openfon-webhook-leases-ddce-qwinacbe`.
Manifest records the four-file patch, the original route, 13 protected files,
and unchanged prior webhook constants/tests/native harness. Comparing all 912
existing Git blobs found only `src/telnyx-routes.ts` changed. The lease module,
public-route test and admission native harness are new files. Owner application
source is stale and untouched; integration must assemble this exact-base patch.

Integration selected the 16-slot/503/full-lifetime/quarantine contract after
QA c4bb26b agreement. This artifact still requires QA actual-source acceptance.
No syntax, import, test, typecheck, build, native runtime, browser, live provider
or inference has been run. No validation slot exists yet.

## Source review points

- Module-level admission precedes reader acquisition, buffer and body timer.
  Configured-route and missing-body responses precede admission. Saturation
  returns generic503/no-store/Retry-After1, does not read/cancel the rejected
  request and queues no task. Retry-After is not a capacity-restoration promise.
- Each lease stays local to its request. Only the count crosses contexts; no
  request promises, readers or cleanup handles enter a shared map. Admission
  allocates its small lease before incrementing the count, so failure to create
  the lease does not increment it without an owner.
- Reader acquisition is inside cleanup ownership. A later buffer allocation
  failure cancels/releases that reader under the same bounded response policy.
  Failure before reader acquisition can release when the route completes.
- Route completion, consume settlement, body cleanup, successful lock release
  and requested cancellation fulfillment are all necessary. Cancellation starts
  before the method call; both synchronous failure and rejection quarantine.
  A failed lock release remains permanently quarantined even if later promises
  settle. There is no TTL, automatic reset or request-abort shortcut.
- Deadline response does not wait for cleanup. The existing single race,
  five-second body deadline, 128KiB buffer, read-work limit and late guards remain.
  EOF does not release a body still retained by crypto or durable acceptance.
  There is no new crypto, DO or total-route timeout.

Sixteen stranded leases can deny that isolate until recreation. Lost callbacks
after request-context destruction can strand capacity too. Other isolates have
independent budgets. This bounds tracked admitted application owners, not total
heap/GC/runtime buffering, opaque source pull operations, TCP, raw rejected
requests or deployment-wide load. Two MiB is only the baseline acquisition-buffer
capacity across sixteen held permits, not an overall memory claim.

## Proposed serial validation after QA acceptance and explicit sole grant

1. Archive the exact original into a separate directory, then copy only the new
   test and native harness into it. They deliberately import no new admission
   module directly and can exercise unchanged original public routes. Reuse the
   approved existing dependency tree; no installation or mutation. Hash original
   and fixed source, protected paths and fixtures before/after. No source changes
   while any validation process is running.
2. Original unit comparison:
   `npm test -- --maxWorkers=1 test/telnyx-webhook-admission.test.ts`.
   The prepared file has 15 parameter-expanded cases. Record actual discovered
   counts rather than trusting this prediction. Public-worker tests inspect the
   seventeenth request's finite response and reader/buffer observations, not a
   runner timeout. Held operations are released in teardown. Original failures
   stop at their actual first assertion; later lease assertions are unproven.
3. Original native comparison:
   `node scripts/telnyx-webhook-admission-smoke.mjs`.
   Four serial scenarios, each in its own fresh Miniflare isolate at8810/9250:
   HTTP saturation/refill, synthetic held cancellation, synthetic failed lock,
   and completed signed bodies held at a synthetic durable-dispatch boundary.
   Missing initial sixteen owners is a fixture failure. The seventeenth probe
   has a nonempty text/plain body, so it is415 if admitted and503 if refused;
   it does not accidentally take the preserved missing-body400 path. Admission
   observations precede assertions and all client/runtime teardown. An original
   failure at this first boundary is not evidence for later cleanup assertions.
4. Fixed unit/control comparison:
   `npm test -- --maxWorkers=1 test/telnyx-webhook-admission.test.ts test/telnyx-body.test.ts test/telnyx-control.test.ts test/telnyx-webhook.test.ts`.
   Existing three suites remain byte-identical. New cases cover both independent
   read/cancel settlement orders, real-stream read resolution while cancel is
   pending, one-slot reuse followed by repeated Promise resolution attempts, setup failures before/after
   reader acquisition, permanently failed cancel/lock cleanup, full crypto/DO
   lifetime, shared module budget across router registrations, and prechecks.
   Synthetic independent readers and allocation/crypto faults are labelled.
   A fresh module is loaded per new unit case because production has no reset.
   Re-resolving a settled Promise does not invoke its actual settlement callbacks
   again. This control must not be reported as repeated lease-callback execution
   or a direct test of every idempotent lease method.
5. Worker types: `npx tsc --noEmit -p tsconfig.worker.json`.
6. Fixed native, same command/harness, serial8810/9250. The raw HTTP scenario wraps
   the actual transport reader for observations. Other scenarios deliberately
   substitute reader methods or DO acceptance and use Node service gates; these
   are instrumented application-lifetime evidence, not real DO/carrier/D1 proof.
   Constructor counting observes explicit JavaScript128KiB allocations only.
   The five-second response and underlying settlement have separate records.
   The native harness does not override production clocks or add waitUntil.
7. Workerd may destroy the timed-out request context before late gate callbacks
   execute. If those callbacks are not observed within the finite window, the
   synthetic late-fulfillment boundary is reported UNAVAILABLE, not silently
   passed. Prior saturation/retention observations remain separately recorded.
   Such a result cannot prove eventual successful refill or quarantine after
   complete cleanup; unit results retain their narrower synthetic attribution.
   Passes/unavailable/failures and cleanup results are reported separately.
8. Each native scenario destroys owned clients, resolves fixture gates, disposes
   its runtime/temp directory, and stops the whole sequence if disposal fails.
   Fresh isolates between scenarios are fixture isolation, not a production
   capacity-reset mechanism. Preserve logs/exits/hashes and fresh process/port
   vacancy before explicitly releasing the sole slot. Integration alone assembles
   and publishes; QA independently closes actual evidence and assembled bytes.

Use `--case=http-saturation,held-cancel` only for a justified targeted follow-up
selected by integration. No native outcome or original failure count is claimed
before execution. Retain setup/transport/context-loss distinctions and any failed
receipts; never manufacture EOF or cleanup to turn a pending observation into a
passing response.

QA76a25da found a literal missing closing brace for `fill` before `signed` in
the prepared unit fixture. Only that brace was added; production and native
bytes are unchanged. Pre-review fixture `4a54a619`, patch `8a605271` and manifest
are retained under `pre-review/`. Refreshed fixture is `13656346`, patch
`1dc6fc61`. This was a source-review blocker, not an observed syntax/setup
execution failure. No syntax check, import or runtime has been run; narrow QA
recheck remains required.
