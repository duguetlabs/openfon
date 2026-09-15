# Post-connect eligibility failure reason — prepared, unexecuted

Exact base: `49df6fc2a5edc0f75a8c922e0178fa6269276f24`. Selection: owner f10fe33 plus independent QA agreement and integration's final selected49df contract. No runtime or shared-source application grant.

Only two proposed assembly paths:

- `src/telnyx-control.ts`: request-local typed reason defaults to `media_bridge_failed`, changes to `assistant_unavailable` solely when the second post-connect eligibility check returns boolean false, and passes that value to the existing terminate path. No exception-message matching. Boolean false means broad loss of the existing call/route/assistant eligibility, not a diagnosis of one specific configuration field.
- `test/telnyx-control.test.ts`: one nested describe adds 11 expanded cases using the existing pending-session helper. All original test/setup/helper bytes remain unchanged. No new package, schema, timeout, source helper or runtime harness.

Initial refusal remains403; post-connect failure remains502. Existing fresh-lock reload/sticky reason/terminal and retired handling, reservation until authenticated release, allowlisted projection and fixed failure message, alarm retry, socket cleanup and all admission/finalizer/timing/receipt/body-security behavior are unchanged. No new success, retirement or downstream deadline policy.

## Prepared evidence, not run

Three intended original negatives change assistant state, route enabled flag, or engine while a successfully claimed session connection is held. Each returns an open synthetic101 session, establishes502/closed socket/retained reservation/unvalidated media, and logs a fixed structured synthetic `ELIGIBILITY_REASON_BEFORE_ASSERTION` receipt before asserting the reason. Original is predicted to first fail at `media_bridge_failed` versus `assistant_unavailable`; later projection/retry/terminal assertions would remain unclaimed. Corrected cases additionally check one injected projection failure leaves the reason available for alarm retry, fixed-message projection, then signed hangup preservation/release.

Eight controls: four thrown-error sources (session connect, eligibility SQL, WebSocketPair creation, carrier acceptance) all throw the exact text `assistant_unavailable` but must retain `media_bridge_failed`; first-check refusal still returns403 without opening a session; earlier setup-ending, signed terminal, and retired state remain unchanged when a late session reply arrives after assistant pause. The carrier-accept fixture checks independent closure of both acquired sockets. All pending sessions are released/drained in finally and transient SQL hooks removed. Existing fixture teardown closes in-memory SQLite and restores timers/globals.

This is Node/in-memory migrated SQLite plus synthetic session socket/transport errors, real signed webhook verification, and actual owner methods. It is not native workerd/real carrier/provider/CallSession inference or a deployed scheduling guarantee. Genuine successful bridge installation is not newly exercised; controls reach the bridge setup boundary with eligible state. No original result, PASS, syntax/type/import or runtime claim exists yet.

After actual artifact QA and explicit sole grant, proposed serial exact-original-production + new-fixture and exact-fixed-production + same-fixture commands are:

`npx vitest run test/telnyx-control.test.ts --maxWorkers=1 -t 'post-connect failure reason provenance'`

Expected discovery: 11 selected cases per run (original predicted3FAIL8PASS, corrected predicted11PASS); actual discovery/results and first assertions will be authoritative. Other existing cases are intentionally skipped. No old complete control suite,207/native/types/browser/inference, retries or timeout increase are part of this proposal. Preserve any fixture/setup failure separately.

`manifest.json` records original/prepared/patch/protected identities with repository-relative paths. Local snapshot locations are deliberately outside the tracked artifact. Original production and test source are preserved in `original/`; `prepared/` contains only proposed files. Integration alone applies the exact two-path patch after later approval and validation. Prior source/evidence closures remain unchanged.
