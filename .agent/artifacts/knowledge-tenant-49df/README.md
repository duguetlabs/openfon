# Exact49df tenant guards: prepared delivery

Status: source prepared; actual QA review and explicit integration sole validation grant required. No application, parser, import, collection, type, SQL, native, rehearsal or browser command has executed. Earlier contract.md/source.json are historical proposal/audit records; this preparation record supersedes their not-yet-selected status.

Base: `49df6fc2a5edc0f75a8c922e0178fa6269276f24`. Integration selected owner contract2a79c11 and exclusively reserved migration0021. Apply **delivery.patch only** to the exact base/verified assembly. It adds three files and narrowly modifies four existing files. Do not replace handlers or copy the owner worktree. Prepared files and original four files are independently hashed in prepared-manifest.json.

The new migration has four validation-only triggers and a missing-parent-inclusive read-only consistency precondition before any DDL. No success-path DML, data repair, applied-migration rewrite or defensive read filtering. Runtime application source is unchanged. Compatible issuers and current changes()-gated batches remain intact by source; execution is pending. Statement ABORT does not imply whole-transaction rollback; callers must roll back the failed migration/batch. Corrupt-upgrade refusal does not protect still-running old Studio reads.

Companions are limited to test migration default/name21, rehearsal target21 plus explicit four-guard presence check, CI rehearsal through21, and appended compatibility policy. Existing historical-target fixtures remain historical. The rehearsal is synthetic, not a production backup/deployment claim; no remote database or credentials are involved.

Static checks completed: four originals match exact Git bytes; patch apply-check and disposable reconstruction match all seven prepared files; all84 base src/web/migration files remain byte-identical. These checks neither parse nor execute application/test/SQL code.

## Proposed serial validation, not granted

Run from the isolated exact-base candidate after QA acceptance and a fresh integration grant. Use existing dependencies only after grant, unique private output directories, ports8812/9252 and serial processes. Both original modes explicitly install only shipped1..20; fixed modes add candidate21. There are no source substitutions or edits needed between runs. Preserve failures, full synthetic captures and actual exits; unexpected setup/fixture failures are not product-negative evidence. No automatic retries.

### original-sql

```sh
OPENFON_TENANT_ORIGINAL=1 npx --no-install vitest run test/knowledge-tenant-guards.test.ts -t 'tenant guard refuses' --reporter=verbose
```

7 selected negatives; 27 intentional skips. Predicted 7 FAIL, not observed.

### original-native

```sh
OPENFON_TENANT_ORIGINAL=1 OPENFON_TENANT_NATIVE_CASE=item-refusal OPENFON_TENANT_EVIDENCE_DIR="$TENANT_ORIGINAL_EVIDENCE" node scripts/knowledge-tenant-smoke.mjs
```

One original OR IGNORE mismatch negative, expected first marker assertion failure; not observed.

### fixed-sql-api

```sh
npx --no-install vitest run test/knowledge-tenant-guards.test.ts test/knowledge-budget.test.ts --reporter=verbose
```

34 new + 9 existing = 43 cases, unexecuted.

### worker-types

```sh
npx --no-install tsc --noEmit -p tsconfig.worker.json
```

Unexecuted.

### web-types

```sh
npx --no-install tsc --noEmit -p web/tsconfig.json
```

Unexecuted.

### fixed-native

```sh
OPENFON_TENANT_EVIDENCE_DIR="$TENANT_FIXED_EVIDENCE" node scripts/knowledge-tenant-smoke.mjs
```

11 grouped cases, unexecuted.

### rehearsal

```sh
python3 -O scripts/migration-rehearsal.py . --through 21
```

One synthetic upgrade/restore/rollback/re-upgrade rehearsal, unexecuted.

Evidence-directory variables are privately assigned unique output locations, not credentials or tracked absolute paths. Native default ports are8812/9252; the script disposes its Miniflare instance and removes its owned temp only after confirmed disposal. Preserve any disposal failure, then independently verify owned processes/listeners and explicitly release. No browser, broad suite, old native/CREATE/provider replay, live provider or inference command is proposed.

## Cases and limits

The34 expanded SQL/API cases cover seven original cross-tenant insert/update/OR IGNORE refusals; three missing-parent insert markers; five privileged-corruption pre-DDL refusals; clean preservation and late DDL rollback; explicit transaction ABORT; two quota-trigger registration orders; accepted move/duplicate attach; zero/accepted immediate changes gates; late batch rollback; two spent-budget source deletions; immutable parents/cascade; and eight API/helper controls. The API controls cover derived identity, foreign ownership refusal, historical same-owner two-workspace refusal, existing item CAS, accepted assistant/default attachment, legacy projection/foundation repair, private from-turn source identity, and injected internal-helper rollback. Counts are from source review, not discovery.

Original SQL and native diagnostics capture synthetic before/after tables before the first guard-marker assertion. A failing first assertion does not establish later snapshot assertions. Fixed full snapshots include trigger counters; raw total_changes is not treated as persisted state because rollback need not rewind that accumulator.

Native11 groups are listed in the manifest. They use local workerd/D1 plus Node-bundled production handlers for helper/API paths, not full workerd-handler concurrency. Native prior-statement preservation uses an earlier committed write; explicit open-transaction ABORT is only in the SQLite fixture. Native corrupted-upgrade cases cover mismatches with existing parents; missing-parent upgrade cases use SQLite with explicitly disabled FKs to model privileged corruption. Native missing-parent inserts are separate guard-marker cases. No actual untrusted mismatch producer, remote corruption inventory, all-read safety, historical mixed-version HTTP replay or production migration acceptance is claimed.

Preserved constraints: source reference SET NULL at exhausted quota, prior CAS/provider/legacy chains, existing ownership and engine guards, no hidden schema repair, no new migration status/error-to-HTTP mapping. A trigger marker can lose error precedence to an existing quota/immutability refusal when both apply; atomic no-persisted-side-effects is the invariant, not universal error ordering.
