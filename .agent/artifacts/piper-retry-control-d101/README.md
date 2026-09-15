# Piper retained retry control — preparation only

Selected after QAbb4ccc8 by integration piper-retry-control-preparation.json (SHA2562849779dd0d2d8bbffaf4448cb81b3fbfca1d63eb77a171a236430029fe7a7dc). Only the final six-case failure helper in test/piper-catalog-concurrency.test.ts changes. Natural throw/reject/redirect/oversize/body-error failures no longer receive a synthetic forced caller deadline. Only the abort variant explicitly aborts. Its same-endpoint retry observes actual admission and successful completion, with at most32 attempts of24microtask turns and final exactly2actual fetches. Refused probes must complete as fallback, unresolved probes fail before another attempt, and late rejection is observed. No clock advance, timeout increase, production hooks or removal of signal/manualredirect/1500ms assertions.

The previous original7FAIL10SKIP and fixed43PASS1FAIL/Worker typesPASS remain unchanged evidence in caller-deadline validationf0c770eb. This source-only correction has not executed, and does not turn that run into a pass. Accepted production63f7923b, new17fixturec70602f1 and docca7d4d0e are copied byte-exact into a separate persistent private d101 snapshot for later selected validation; the old accepted snapshot, manifests, patch and raw evidence remain untouched. No dependencies installed/linked. Full source manifest protects673other non-.agent d101 files and separately pins those three accepted candidates.

## Proposed narrow next command — not granted or run

From the new private snapshot after actual-artifact QA and a separate sole grant:

`npx --no-install vitest run test/piper-catalog-concurrency.test.ts --maxWorkers=1 --reporter=verbose -t 'releases a failed lookup for a later retry:'`

Source expansion predicts6selected/7skipped, not a discovery or pass count. Retain actual outcomes/first assertions/unexpected scheduling failures and cleanup. No original7/new17/full44/types/native/browser/provider/inference replay selected. Existing failed run, original negatives and type evidence are reused with exact-source attribution, never relabelled.

## Integration boundary

Test-only patch applies to the identical retained test at both d101ff8e8558f3d953c8876f495d5e26cddd6cc7 and f82a656aeb4ab2d25580fb43e1ce52c709eaca7f. The latter includes the QA-closed PUT delta in src/studio-api.ts, test/knowledge-concurrency.test.ts and two new PUT fixture/probe paths. Manifest records old/current hashes and absent-old-file cases. Those are intentional protected-base exceptions, not Piper delivery files. Do not copy snapshot handlers or remove new integration files. Assemble only the separately accepted original three-path Piper patch plus this test-only delta after their respective gates; this preparation is not an integration apply or passing delivery.

Source/raw locations are supplied by an ignored restricted locator. Public artifacts contain only test source/delta, safe hashes and contract; no raw operational metadata. The admission probes establish mocked scheduling/contract behavior, not native teardown or abandoned-context recovery. Actual QA is required before runtime.
