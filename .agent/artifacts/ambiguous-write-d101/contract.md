# Exact d101ff8 ambiguous PUT response contract

Status: SOURCE-ONLY PROPOSAL; independent QA and integration selection pending. No application/fixture preparation or execution.

Base: `d101ff8e8558f3d953c8876f495d5e26cddd6cc7`. Original report: [5672071968](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5672071968). `source.json` records the unchanged original, authoritative integration contract, six source files and all 21 migration identities. Source references below refer to this exact Git object, not the older owner checkout.

## Supported findings

Both entries describe real post-commit failure points. Assistant PUT (`src/studio-api.ts:1071–1152`) commits its UPDATE and any primary compatibility mirror/snapshot in `DB.batch` at 1146, checks first-result changes, then performs a separate response SELECT at 1150. Knowledge-item PUT (1566–1611) commits its UPDATE with `run()` at 1606, checks changes, then SELECTs at 1608. A failure of either final SELECT reaches the generic 500 handler after the requested write has committed. A later writer can also change/delete the row between mutation and that response read; the current response is not necessarily the accepted mutation row.

The assistant's first UPDATE retains the provider presence/selection predicate and captured 11-field-plus-state predicate. Primary classification adds an immediate `changes()>0` legacy UPDATE and then a similarly gated compatibility snapshot UPDATE. Secondary assistants have only the first statement. No response operation may be inserted between those DML statements. Existing missing-mirror/snapshot behavior is preserved; this proposal does not repair it.

Knowledge-item validation retains owned lookup, destination ownership/404 precedence, supplied enum validation, readiness and seven-field null-safe CAS. Its SQL controls `updated_at` and `activated_at` (preserve first active timestamp, clear on draft). Source references and tenant guard 0021 remain unchanged.

`ownedAssistant`, `isCompatibilityAssistant` and `ownedItem` (754–792) are read-only. These PUT handlers do not call foundation repair. Previously committed foundation state is part of the pre-request baseline; no new foundation behavior or repeated CREATE proof belongs in this scope.

## Actual quota and client semantics

Migration 0015's `assistant_update_budget BEFORE UPDATE` charges each matched assistant row once, with no equal-value exemption, up to 200 daily writes. Primary legacy/snapshot statements add no assistant-budget charge. Migration 0013's `knowledge_update_budget BEFORE UPDATE OF ...` covers the columns this route sets, including `updated_at`, with no equal-value exemption and a 500 daily limit. No later migration removes these rules. The response SELECT itself adds no persistence charge.

A fresh explicit retry rereads current state, so its new CAS can match even when the submitted values already equal storage, including in the same second. With capacity remaining, that accepted retry consumes another unit. A zero-row CAS miss adds no row-trigger charge. At exhausted quota, the trigger refuses before incrementing; the error mapper (`src/index.ts:33–64`) returns 429. Thus a first write using the final available unit can return 500 from the separate read, followed by a retry returning 429 without a second charge. Ownership/input refusals also do not charge. Neither universal retry charging nor deduplication is claimed.

Studio assistant mutation handling (`web/src/pages/Studio.tsx:89–107`) accepts the result/baseline only after its promise resolves; Knowledge action/editor handling (357–370) likewise retains the editor on failed mutation. The API wrapper throws on non-2xx. This supports a user making an explicit retry, not an automatic-retry claim. Existing post-success refresh recovery remains a separate contract.

## Recommended narrow correction, not yet selected

1. Append `RETURNING *` to the assistant's first UPDATE without changing its predicates, binds or values. Keep the existing batch order and length. Await the entire batch, retain the first boolean `meta.changes` 409 check, then return the first result's mutation row. Any later mirror/snapshot failure must still reject and roll back the whole batch, even though the first statement computed returned rows.
2. Append `RETURNING *` to the unchanged knowledge-item UPDATE. Execute it in a one-statement `DB.batch<KnowledgeItem>` to obtain rows and change metadata through the existing accepted adapter; retain the zero-change 409 check before returning its row. Remove the separate response SELECT.
3. Keep the exact existing adapter, migration files, CREATE response batch, foundation, provider/assistant CAS, quota rules, compatibility projections, validation/error precedence and UI untouched. No schema/version/idempotency key, retry, new repair or broader writer contract.

`test/sqlite-d1.ts` already executes batch statements once with row fidelity, one hook, trigger-inclusive change metadata and whole-transaction rollback. Its standalone `all()` lacks change metadata; no adapter edit is proposed. The exact migration inventory contains no AFTER trigger rewriting either returned assistant/item afterimage; subsequent primary statements only update legacy/snapshot tables. Future schema changes that add such triggers would require reassessing response semantics.

Returning actual mutation rows preserves DB timestamps, defaults and unchanged fields. A hand-constructed response risks omitting DB-derived state. Appending an unconditional final SELECT to the batch is another possible design, but on a CAS miss it can read the existing row or fail before the intended 409; the proposed RETURNING avoids that extra operation entirely. Native batch RETURNING rows/metadata and downstream `changes()` behavior still require new bounded proof; prior CREATE SELECT evidence is not that proof.

The guarantee is limited to removing these separate post-commit response reads and returning the accepted mutation row after batch completion. It does not guarantee exactly-once delivery under transport loss, JSON response failure, or ambiguous batch acknowledgement. A later accepted independent write may supersede the returned snapshot.

## Bounded future evidence proposal — not prepared or run

- For primary assistant, secondary assistant and item: inject failure only at the original standalone response SELECT. Capture initial, post-failure and explicit-retry persisted snapshots/counters before the first assertion. Spare-capacity cases should show original committed write plus accepted charged retry; final-unit cases should show original persistence then 429 with no extra charge. Fixed cases should return the mutation row with one charge and never reach the injected outside read.
- Accepted row controls should compare all response fields to persisted mutation state, including timestamps, item activation/draft behavior and preserved source references. Include an equal-value same-second accepted update to retain the existing charging contract; do not label it deduplicated.
- Focused provider/captured-assistant/item conflicts must retain 409, no requested effects and no added charge. A primary late mirror or snapshot execution fault must roll back the first UPDATE and counters despite computed RETURNING rows. Preserve missing-mirror behavior rather than adding repair. Keep readiness/owned-destination/0021 controls scoped to affected item SQL.
- A new bounded native probe should establish actual primary/secondary/item UPDATE RETURNING rows and boolean change metadata, uninterrupted changes gates, zero-row refusal and late primary rollback with complete persisted snapshots. Exercise execution-time failure, not merely invalid prepare syntax. Raw `total_changes` is not a rollback snapshot.
- API fixtures would use Node handlers/SQLite; native fixtures would use Node handlers against workerd D1 with synthetic holds/faults. Neither establishes full Worker concurrency, live failure frequency or exhaustive schedules. No browser or old CREATE/foundation/provider/native suite replay is proposed. Exact case counts/commands follow only after implementation preparation is selected and actual fixtures reviewed; runtime requires a separate sole grant.

## Current evidence and next gate

Read-only Git/source/report inspection and hash verification only. No application tests, types, imports, SQL/native/browser process, dependency action, inference or publication. Prior create/rename and 0021 closures stay closed. Request independent QA contract agreement, then integration's concrete selection before any source/fixture preparation.
