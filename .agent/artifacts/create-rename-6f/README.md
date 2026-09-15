# Exact6f creation response and normalized rename preparation

Status: source/fixtures prepared, **unexecuted**. Actual artifact QA and an explicit integration sole runtime grant are still required. Reviewed base `6f001779476dcc85f4b6a0ef9cc6d8ae52477a9a`; original comment5671181031 hashbdd0a2e4. Local integration6936eaf has metadata-only differences and was not edited.

Apply `delivery.patch` only after verified base/assembly review. Its six paths comprise three narrow existing-file changes and three new fixtures. Public prepared copies contain only the new fixtures. Full fixed source and byte-exact originals are retained in restricted persistent owner storage for QA; no stale whole-handler replacement. Safe manifest records target/original/protected hashes. No raw local path, process identifier or credential is needed in public provenance.

## Selected behavior

Assistant POST keeps its create INSERT and immediately changes()-gated attachment statement byte-identical. A third response SELECT executes in the same D1 batch. First-result boolean409 precedes returning the third result row. A third-read execution failure rolls back requested draft, attachment and insert charge. Earlier legitimate foundation repairs are outside that batch. Successful response carries the persisted row/defaults without a post-commit database read. This is not transport-loss or ambiguous-acknowledgement idempotency.

Rename normalization reconciles display on normalized no-op and successful acknowledgement only when captured edit version AND raw submitted name still match inside the functional updater. Successful acknowledgement always advances the confirmed baseline, including when newer edits block display replacement. Per-profile serialization, owner-token admission/release, list generations, failure/error ownership, newer drafts and no-autoaction remain unchanged. No refresh is added.

SqliteD1 adds batchRun returning actual rows from one statement execution. It calls the hook once and measures total_changes before/after execution, including triggers; batch order/transaction rollback and standalone run/first/all behavior remain unchanged. Both original and fixed API variants use this selected row-fidelity support so the adapter does not fabricate or drop response rows. Original behavior claims apply to the two original production files, not to the historical row-dropping adapter.

## Bounded proposal, not a grant

From the persistent candidate, original mode temporarily restores only original Studio/Settings while retaining candidate adapter and identical new fixtures. Switch/restore only after all processes exit; restore accepted fixed bytes in finally. Fixed runs use all accepted candidate bytes. Both native variants use migrations1..21. No dependencies installed or linked during preparation.

All commands below are **unexecuted predictions**. Proposed application/inspector ports8812/9252; one worker, zero browser retries, unchanged timeouts. Browser launcher must use the established actual Chrome/workerd configuration after a grant. Native evidence directories must be unique restricted durable locations. No broad/old native/provider suite, migration rehearsal, live provider, browser companion, credential or inference work is proposed.

- `original-api` — 3FAIL5SKIP; first snapshot equality for two fault cases, outside-read count for accepted control

```sh
npx --no-install vitest run test/create-response-atomic.test.ts --maxWorkers=1 --reporter=verbose -t 'response failure rolls back|accepted create returns'
```

- `original-native` — 1FAIL at post-failure snapshot equality after full state/retry capture

```sh
OPENFON_CREATE_NATIVE_CASE=response-failure OPENFON_CREATE_EVIDENCE_DIR="$CREATE_ORIGINAL_EVIDENCE" node scripts/create-response-smoke.mjs
```

- `original-browser` — 5FAIL3not selected; displayed raw value first assertion

```sh
npx --no-install playwright test e2e/profile-normalized-ack.spec.ts --workers=1 --retries=0 --grep 'normalization no-op|successful normalized|queued normalized no-op'
```

- `fixed-api` — 8PASS

```sh
npx --no-install vitest run test/create-response-atomic.test.ts --maxWorkers=1 --reporter=verbose
```

- `worker-types` — exit0

```sh
npx --no-install tsc --noEmit -p tsconfig.worker.json
```

- `web-types` — exit0

```sh
npx --no-install tsc --noEmit -p web/tsconfig.json
```

- `fixed-native` — 5PASS groups

```sh
OPENFON_CREATE_EVIDENCE_DIR="$CREATE_FIXED_EVIDENCE" node scripts/create-response-smoke.mjs
```

- `fixed-browser` — 8PASS

```sh
npx --no-install playwright test e2e/profile-normalized-ack.spec.ts --workers=1 --retries=0
```

## Fixture contracts and boundaries

API8 expanded cases: two failing response-read schedules (reconciled versus repaired foundation), accepted persisted response/defaults/no outside read, provider conflict, late attachment execution failure, batch row/hook/order/trigger-count fidelity, unchanged standalone run, and late SELECT execution rollback. Originals select the first three discriminating cases only, leaving five support/control cases skipped; fixed runs all8. Fault schedules capture initial, post-foundation baseline, in-read state, after-failure and after-explicit-retry before the first state assertion. The retry executes before assertions, so duplicate IDs/charges remain inspectable even when the first equality assertion fails. Later assertions in failing originals are not inferred.

Browser8 expanded cases: empty/whitespace/padded unchanged no-op3; padded successful acknowledgement plus provider-driven refresh1; newer typing and away-and-back version controls2; queued normalized no-op1; successful normalized baseline followed by failed queued rename1. Originals select the five normalization negatives; fixed includes all8. Pending routes are explicitly released/aborted; missed route boundaries/timeouts remain fixture failures, not expected product evidence. Two-frame settling follows observed outcomes, without sleep/timeout increases or injected product events. Refresh case preserves an independently edited business draft. Existing later-click/no-autoqueue policy is untouched.

Native5 groups: response-failure, repair-response-failure, accepted-result, provider-conflict, attachment-rollback. Original selects only response-failure. The third-read replacement is valid SQL and contains a row-dependent CASE/json expression: it errors during execution only for the requested newly inserted row, not during statement construction. Full persisted before/after state includes counters; repaired foundation baseline is captured before the requested batch. Explicit retry and its ID/charge are recorded before the first equality assertion. Accepted case checks actual third SELECT rows/defaults and attachment, while first-result409 control keeps empty response rows from producing a success. Late attachment failure also evaluates SQL after the requested insert.

Native scope is Node-bundled production handlers with local workerd/D1, not full Worker HTTP concurrency. Injected SQL/DB boundaries are synthetic; no ordinary transient failure frequency or remote state is inferred. All D1 statements remain one batch, and preceding committed repairs are not claimed rolled back. The native runner disposes Miniflare even if evidence writing fails, retains owned temp on disposal failure, and reports failures rather than retrying. A later runtime owner must independently verify process/temp/listener cleanup and explicitly release the slot.

## Static verification

Original3 match exact Git; six-path patch passes apply-check and reproduces all target bytes in a disposable reconstruction. All90 protected source/web/migration/config/fixture hashes match exact6f. First two create statements are independently byte-identical. No application parser/import/test collection/SQL/type/browser/native command was run. Counts are from source inspection, not discovery. Persistent candidate/raw-original locators stay private.
