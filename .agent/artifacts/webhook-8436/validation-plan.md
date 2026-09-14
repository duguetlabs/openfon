# Telnyx webhook body budget — prepared, unexecuted

Base: `8436ac9c0055123d440c78760f6bc10ee406fe25`.
Snapshot: `/tmp/openfon-webhook-8436-m8prudc_`.
`manifest.json` records the four prepared files, two original production files,
13 unchanged protected files and patch identity. A full Git blob comparison found
only the two intended existing source files changed in the extracted base.
The new test and native harness are additive. The stale owner application tree
is untouched; integration must use `correction.patch`, not owner source files.

No test, typecheck, import, syntax check, application/native runner or inference
has been executed for this preparation. QA actual-source review and integration's
explicit sole validation slot remain required.

## Selected behavior

Body acquisition has a 5000 ms total deadline, not a per-chunk idle timeout.
Timeout returns generic `408`; overflow remains `413` even if cancellation hangs
or fails. One 128 KiB acquisition buffer and at most 131073 reads (including EOF)
allow one-byte fragmentation while bounding empty-chunk work. Exceeding read work
returns `400`. Missing body, content type, signature, timestamp, payload, routing
and durable-acceptance semantics remain unchanged. The deadline ends before
signature verification and downstream DO dispatch; it is not a total route SLA.

One race observes the consume promise. Checks before/after reads stop late
results; cancellation is attempted once, catches synchronous throws and promise
rejection, and is never awaited. Timer and reader-lock cleanup cannot replace the
original status. This bounds the application wait; it does not guarantee remote
TCP termination, admission capacity, protection from every flood, or any specific
Telnyx retry schedule.

## Proposed serial validation after authorization

1. Prepare a separate untouched original archive at the exact base, copying only
   the new test and harness into it. Reuse the approved existing dependency tree
   without installation or mutation. Record original/fixed source and protected
   hashes before running anything. Never swap source beneath a running process.
2. Original public route suite:
   `npm test -- --maxWorkers=1 test/telnyx-body.test.ts`.
   Preserve the complete nonzero result and per-case actual pass/failure counts.
   Timeout regressions advance a finite fake clock and assert the observed
   response before teardown. Pending original requests fail at that assertion;
   they are then released in teardown. They must not be described as runner
   timeouts. Original overflow/reject/synchronous-throw probes can instead return
   the wrong `503`, and that is a distinct observed failure.
3. Original native harness:
   `node scripts/telnyx-webhook-body-smoke.mjs`.
   Ports are fixed at `8810`/`9250`. It observes each request for at most 7000 ms,
   logs the outcome and public-handler trace before client destruction, and
   continues bounded cases while collecting failures. No handler-entry trace is
   a fixture failure, not an admission negative. Original pending-response and
   wrong-status observations are distinct; runtime cancellation of a synthetic
   promise need not behave like a remote HTTP upload. Preserve all failures and
   controls exactly as observed. Dispose the original runtime before fixed runs.
4. Fixed public route/control/signature suite:
   `npm test -- --maxWorkers=1 test/telnyx-body.test.ts test/telnyx-control.test.ts test/telnyx-webhook.test.ts`.
   The new file additionally checks exact-limit signed UTF8 in one-byte chunks,
   EOF just before the deadline, cleanup/no late dispatch, unknown event success,
   malformed request controls and delayed successful/failed durable acceptance.
   Synthetic reader shims explicitly distinguish late/misbehaving reader methods
   from real stream behavior. Existing tests retain their source and attribution.
5. Worker types: `npx tsc --noEmit -p tsconfig.worker.json`.
6. Fixed native harness, same command/source and serial ports. Eight raw HTTP
   upload cases exercise no-first-byte/partial/trickle/overflow/valid signed/
   bad signature/wrong application/durable refusal. Two separately labelled
   instrumented workerd JS streams exercise pending/rejected cancellation.
   Its actual public app uses a synthetic DO acceptance stub and forbidden D1/
   outbound access: no real carrier owner persistence, signature ingress at a
   deployed edge, account setting, provider, or physical transport exhaustion
   claim. It does not run migrations because no database operation is authorized
   on these route boundaries.
7. Preserve log hashes, exact exits, source/protected before/after identities,
   application response timing, native cleanup record and fresh process/listener
   vacancy. Explicitly release the sole slot only after disposal. Integration
   assembles/publishes; QA independently verifies evidence and final bytes.

The native harness supports `--case=name1,name2` for a justified targeted repeat,
not an automatic full rerun. Startup/bundling/fixture errors must be fixed and
retained as fixture failures; they cannot stand in for original application
negatives. Any source refinement requires new identity and QA review before the
next granted sequence.
