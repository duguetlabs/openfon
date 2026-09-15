# Gateway header authentication candidate

State: source/fixture preparation only. No application source applied, test discovery,
imports, tests, typechecks, native runtime, endpoint probes or dependency actions.
Integration selection `f70005e7` and source QA `7ae4582` / `2aa14b2` authorize
preparation; actual artifact QA and a separate concrete validation grant remain required.

Base: `f265a1f11780c7ad1f6359eadec8e018a90f3ac3`. Five target files appear in
`prepared/`; `candidate.patch` applies only those files. `manifest.json` records
original/candidate hashes and all 1203 unchanged tracked files from the 1208-file
baseline. Exact original and full candidate snapshots are retained privately;
private locations are sent only to the existing integration/QA owners. No credentials
were read. All key strings added here are synthetic fixture values.

The sole production delta is in `realtimeConnection`: delete both gateway credential
query aliases, then use the existing HTTP Upgrade and Authorization return path.
The resolver, credential ownership, gateway protocol, model selection, CallSession,
voice/session/readiness/rotation/finalization, manual redirects and deadlines remain
unchanged. Direct/custom connection construction is unchanged. No wider caller change
is needed. Gateway endpoints must support Authorization; older/arbitrary query-only
endpoints are unsupported and no automatic downgrade is provided. Backend `995f35b9`
supports both routes through one handler; its inspected header-only GA/beta tests both
use `/v1/realtime`. This is not deployed/proxy or live compatibility evidence.

Fixture changes:

- Gateway helper expectation moves to header authentication. Five additional expanded
  cases cover ws/wss alias removal with routing/model preservation, explicit workspace
  ownership, instance-key precedence and absent instance credentials. Five cases in
  the complete file are tagged `gateway-header-negative`; planned full file: 23 cases.
- The existing CallSession gateway fake now returns a pending fetch Upgrade. Its old
  `emit('open')` control completes that promise; production accepts the returned socket
  immediately, as the unchanged header branch already does. AbortSignal.timeout is
  modeled with the test clock and restores after each case. Pending fake fetches and
  their abort listeners are disposed, and signal timers cleared. These fakes prove no
  native cancellation or remote teardown behavior. The one immediate handover assertion
  gains one microtask to resume fetch while preserving its pre-handover overlap window.
  The old connect-timeout control now names fake-fetch disposal accurately.
- Ten new CallSession cases: two tagged web/Telnyx startup negatives; four pickup
  refusal cases (401, 302, rejection, timeout); four replacement controls (success,
  401, 302, timeout). They cover preserved gateway readiness without direct session
  acknowledgement, voice/model, PCM, old-socket continuity and no constructor/query
  fallback. Fake-clock timeout checks distinguish 4999ms from 5000ms. Each new case
  releases owned pending fetches and hangs up its caller in finally, including after
  its first failed assertion.
- Synthetic smoke gateway authentication requires the header, no token/api_key query,
  preserved model and a synthetic routing query. Only its gateway assertion/instance
  fixture URL change; the direct mock and lifecycle assertions remain unchanged.
- Product docs state the compatibility requirement and logging/deployment evidence
  limits; they no longer promise retained token-query compatibility.

## Proposed bounded validation — unexecuted

Every command below requires a separate actual integration grant and fresh identity /
process / listener gates. Use the isolated candidate with verified dependencies only
if separately authorized. No command has been run or imported to discover cases.

1. Substitute only the exact original `src/realtime-providers.ts` from the private
   original snapshot. Run once:

   ```sh
   npx vitest run test/realtime-providers.test.ts test/call-session.test.ts -t 'gateway-header-negative'
   ```

   Seven source-enumerated negatives: five helper and two CallSession. Expected failure
   is a prediction, never an actual result. Helper first assertions compare the
   header-based connection/header; CallSession's first assertion expects one header
   fetch whereas the original uses the forbidden constructor. Do not claim later
   routing/readiness/PCM assertions after an earlier failure. Preserve actual totals,
   skips, stderr, failure stacks and exit, including unexpected outcomes. Always restore
   fixed bytes in finally **after the command exits**, verify hash, and only then run fixed.

2. Fixed helper file once:

   ```sh
   npx vitest run test/realtime-providers.test.ts
   ```

   Planned 23 cases, including all retained direct/custom ownership/destination controls.

3. Fixed affected CallSession groups and narrow direct controls once:

   ```sh
   npx vitest run test/call-session.test.ts -t 'gateway header transport contract|realtime session payload|session echo read-back|upstream connect timeout|upstream recovery|runs greeting, PCM, interruption, tool hangup and persisted summary with gateway endpoints unavailable|keeps pending direct application events inert|keeps the acknowledged socket when replacement handshake fails|fails closed on .* without pipeline fallback'
   ```

   Source-enumerated 51 selected cases: new10, session payload8, echo14, connect1,
   recovery6, direct12. Preserve actual discovery/skips/counts; no discovery was run.
   Shared fake changes affect this test file; this selection is not a claim that all
   its omitted tests passed. No old cumulative-audio/Piper replay proposed.

4. Worker types once, if granted:

   ```sh
   npx tsc --noEmit -p tsconfig.worker.json
   ```

   Web source/configuration is unchanged; integration can reuse its independently
   matched web evidence. Worker types do not typecheck the test bodies.

5. Synthetic transport checks, only under a later explicit native grant, serially on
   reserved ports 8813/9253 with disposal before the next command:

   ```sh
   node scripts/realtime-smoke.mjs --gateway
   node scripts/realtime-smoke.mjs
   ```

   Two planned cases, no original runtime replay or oversized variant. Existing smoke
   finally closes the carrier, disposes Miniflare and removes its temporary directory.
   Preserve first failures and cleanup errors separately; no retries. These checks
   would exercise actual local workerd with synthetic provider/carrier traffic, not
   deployed gateway/proxy compatibility, live providers or native destruction guarantees.

Record all exits, source/protected identities, original restoration, any authorized
absent-only dependency link removal, owned disposal and fresh vacancy before explicit
slot release. Preparation grants no slot. Prior failed Piper43PASS1FAIL and later
six-case6PASS remain separate immutable evidence; no passing44 claim or replay.
