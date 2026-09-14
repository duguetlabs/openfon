# Exact 1d4 signed-fixture correlation — prepared, unexecuted

Base: `1d4b73331353ecacf07b46ce9d186c032a04fc51`. Selection: integration Selected1d4 / QAae0d578. Only proposed assembled path: `test/telnyx-webhook-admission.test.ts`.

`correction.patch` and `prepared/` correct the two expanded durable-dispatch cases and one crypto-held case. Signed event IDs identify owners independently of entry order. The dispatch stub uses emitted `control.id`; the crypto stub matches the complete signed input bytes. Unknown IDs, duplicate arrivals and unknown signed bytes record an explicit fixture error and throw; there is no default gate. All 16 owners enter before assertions; selecting owner0 releases owner0's identified gate, then the existing bounded waitFor asserts its expected status, one response, zero errors, and 15 held owners before refill. Real dispatch signing/importKey/verify/digest remain. Crypto-held verification remains a mocked result, as originally.

The other 12 cases and existing beforeEach/afterEach bodies are byte-identical. Production routes/helper, prior native harness, all other exact-base tracked files and timeout configuration are unchanged. No assertion timeout argument, test timeout, body timeout or downstream timeout was increased. Original test `13656346...` and both raw CI logs are preserved. Failed CI is still 1468 PASS / 1 timeout; passed CI is 1469 PASS. Both logs identify PR merge `a245c475608fe729c56e12c3e9ca77e23c6a8e62`; this does not claim local inspection of that merge object. The fixture defect is supported; the logs do not prove exclusive CI cause or the exact await that stalled.

## Review variants, not additional production changes

- `variants/reverse-fixed/`: same corrected fixture with only `startSignedBatch` replaced by controlled real streams. All 16 requests start in creation order, then bodies are enqueued/closed from owner15 to owner0. Each identified boundary is observed before releasing the next body. Checks require the exact inverse order, all 16 responses held, and each stage inside the existing 5000ms fake-clock body budget. Existing waitFor and test bounds remain. A missing boundary, expired body, early response, identity error or cleanup failure is a fixture failure, not the desired negative.
- `variants/reverse-original-algorithm/`: same instrumented reverse schedule but releases the first-arriving gate while still expecting creation-order owner0. It first boundedly observes owner15's correct response with owner0 still pending, then logs `ORIGINAL_ALGORITHM_FINITE_OBSERVATION` before the finite wrong-owner assertion. This is an instrumented demonstration of the old indexing algorithm, NOT byte-identical historical CI replay or a production negative. Later refill assertions are not reached on the intended failure. The old shipped fixture is independently preserved in `original/`.

Reverse dispatch retains real crypto; controller timing is synthetic. Reverse crypto-held retains real signing/importKey but mocks verify's result. Neither variant is native/HTTP transport/real durable-object evidence. Teardown resolves gates and errors all controlled bodies (including partial setup) before the unchanged pending-owner drain. Variants are complete replacement test files for separate exact-base snapshots; never overlay them under an active runner. The two relative variant patches expose their differences from the natural correction and each other.

## Proposed bounded evidence after actual-source QA and explicit sole grant

No command below has run. No runtime slot is held. Proposed selection is only the three affected expanded cases in each separately frozen snapshot:

`npx vitest run test/telnyx-webhook-admission.test.ts --maxWorkers=1 -t 'holds completed signed bodies through durable dispatch|holds completed bodies through cryptographic verification'`

Order: instrumented original-algorithm reverse diagnostic; corrected reverse variant; natural corrected variant. Predicted diagnostics are three finite wrong-owner failures only after all positive fixture/ordering/status observations. Record actual discovery/counts, first failure, logs, exits and identities; do not classify setup/ordering timeout as the desired negative. No blind repeat, timeout increase, original15/207/native/types/full/browser/provider/live/inference work is requested here. Existing 207 PASS and native 2 PASS / 2 UNAVAILABLE evidence remains unchanged. Integration may narrow/select later validation independently.

Snapshot pointer and all source/variant/CI/protected identities are in manifest.json. Only the natural one-file patch is proposed for integration assembly; all publication/merge authority remains with integration.
