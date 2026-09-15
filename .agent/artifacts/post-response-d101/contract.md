# Exact d101ff8 four adjacent POST response reads

Status: source-only contract proposed; independent QA agreement and integration selection required before preparation. This assesses root's four observations, not additional entries in the official review. Exact base `d101ff8e8558f3d953c8876f495d5e26cddd6cc7`; `source.json` records 30 exact source identities and the authoritative queue hash.

Closed PUT patch1744a7d6/evidence b288044/summary3ff0e5d9 remain byte-identical. No application/fixture edit, candidate preparation, runner or replay. All prior grants are released: root records Piper’s explicit release at23:37:53Z, retaining43PASS1FAIL. The earlier Piper slot reference was historical; this source-only contract grants no runtime.

## Verified source behavior

All four routes generate a fresh `crypto.randomUUID()` via `src/auth.ts:48`, commit their requested INSERT/run or batch, then issue a separate SELECT for the 201 response. The generic error handler (`src/index.ts:33–64`) returns500 if that read fails. Thus persistence can succeed while the request reports failure. This is supported source behavior under an injected read failure, not newly executed runtime evidence.

| Route and exact Studio lines | Requested writes before separate response SELECT | Same-input explicit retry with unchanged relevant state and available capacity |
| --- | --- | --- |
| Collection POST1451–1467 | One collection INSERT/run; SELECT1466 | Same trimmed name is found by duplicate preflight and returns409. No second requested collection INSERT or charge. |
| Collection-item POST1522–1558 | One item INSERT/run; SELECT1557 | A fresh UUID permits another matching-content item and another knowledge write charge. |
| Draft-from-turn POST1619–1651 | One item INSERT/run; SELECT1650 | A fresh UUID permits another draft for the same source call/turn and another knowledge write charge. |
| Engine-preset POST1940–1983 | Atomic preset INSERT then legacy profile INSERT; SELECT1982 | A fresh UUID permits another same-name preset/profile pair, charging two more compatibility row writes. |

Collection names are trimmed by the handler. Migration0008 has `UNIQUE(business_id,name)` with ordinary case-sensitive comparison, in addition to the preflight. An unchanged exact trimmed-name retry is therefore not a duplicate-create example. A competing request that passed preflight earlier can still fail the UNIQUE constraint; this route does not specially map that error and it is not proposed to change that behavior. A later rename/delete or differently cased name is a different schedule, not evidence of an identical retry bypass.

Migration0008 gives knowledge_items only ID uniqueness; source_call_id/source_turn_id are nullable foreign keys, with a nonunique source-call index. There is no uniqueness by content, collection/source pair or source turn. Item POST ignores submitted source references and uses existing defaults; draft-from-turn intentionally binds the captured source references, caller text trimmed into question, empty answer, faq/draft. It checks call ownership, caller role, collection ownership/default selection; no deduplication query exists. Source deletion SET NULL and tenant0021 validation remain outside this correction's policy scope.

Migration0006 engine_profiles and0008 engine_presets have ID primary keys and nonunique workspace indexes, no name uniqueness. No later migration adds content/source/name uniqueness to these three entities. Preset POST performs no duplicate-name lookup. It stores only engine/voice/model/language values, mirrors the same ID, and binds empty legacy URL/key to retain credential isolation. It intentionally does not validate runtime provider compatibility at creation; Apply has its own contract. No stronger creation policy is proposed.

## Quota and earlier-work boundaries

Migration0013 charges one successful requested collection INSERT in `knowledge-collections:<business>` (100/day,64rows,256KiB), or one item/draft INSERT in `knowledge:<business>` (500/day,500rows,2MiB). Storage/daily refusals precede counter increment. A failed statement rolls back its trigger effects. With a reconciled baseline, the collection's same-name retry returns409 before its insert and does not consume another requested charge, even after the first request used the final daily unit. It is not an idempotent201 response: the first caller still lacks its accepted result.

For item/draft, spare capacity permits two matching rows and two charges across the failed-response request and a deliberate fresh retry. If the first request consumes the final available unit, retry returns429 without another row/charge. Storage or changed authorization/input conditions can also refuse the retry; repeated charging is conditional, not universal.

Preset budget preflight (`src/preset-budgets.ts:33–56`) is read-only, checks both tables'64row/512KiB bounds and requires two units within the400/day bucket. Migration0017 independently charges each insert once. A successful mirrored create consumes two units total. At398, first create can commit both rows/count400 then fail its response read; retry429 writes nothing. At399, preflight refuses before any insert. If capacity changes between preflight and batch, SQL triggers remain authoritative and a second-insert failure must roll back the first row and its charge. The schema does not exempt equal names/content. No hidden one-unit preset-save assumption.

Collection POST calls workspaceForUser before body/name validation; draft-from-turn validates required body fields then calls it. workspaceForUser (`src/studio-api.ts:747–752`) invokes ensureWorkspaceFoundation. That repair may legitimately commit missing primary/provider/default-collection/attachments/knowledge/preset reconciliation before the requested INSERT. A full request is not one transaction; future fault snapshots must use a reconciled baseline or capture the baseline after foundation, immediately before the requested insert/batch. Whole-state unchanged claims must not erase legitimate repair effects. Even collection duplicate refusal can follow earlier foundation work, so 'no second charge' above is about the requested duplicate creation with a stable reconciled baseline.

Item POST uses read-only ownedCollection and does not repair foundation. Preset POST deliberately reads only the owned business ID and avoids reconciliation before quota refusal. Preserve these differences and existing validation/status precedence.

## Actual callers and retry limits

Knowledge UI (`web/src/pages/Studio.tsx:357–370`) accepts returned collection/item rows and clears the submitted draft only after the mutation promise resolves. Failure records an error and releases busy; the retained draft can be explicitly submitted again. The separate post-success refresh recovery is unchanged. CallDetail (`web/src/pages/CallDetail.tsx:117`) awaits draftKnowledgeFromTurn, reports failure and releases drafting; the caller can click again. Neither flow automatically retries.

The exact web source exposes createEnginePreset in api.ts but has no caller of it elsewhere in web/src. Its authenticated HTTP route and client wrapper support an explicit retry contract; a currently rendered Studio preset-creation UI retry is not established. Settings' legacy profile create is a separate endpoint and excluded. No stronger UI or production-frequency claim follows.

## Proposed minimal correction — not selected

Return the row from the INSERT itself with `RETURNING *`, eliminating each separate response SELECT. For collection/item/draft use a one-statement D1 batch so the accepted adapter returns rows without modification. For preset append RETURNING to the first INSERT in its unchanged two-statement batch; await the entire batch before returning the first result row. Preserve all current SQL inputs/defaults, validation/preflight, ownership, quota/credential/tenant guards, foundation boundaries, response status201 and mirror order.

These are unconditional INSERTs, not the conditional PUT/CREATE guard paths: do not introduce a new zero-row409 policy, changes-gated mirror policy, source snapshot pin, deduplication, schema/version column, general retry or UI contract. A late preset mirror failure must still roll back the whole requested pair and both charges, even if the first INSERT computed returned rows. The current migration inventory has no AFTER trigger that rewrites these inserted afterimages.

The goal is the accepted inserted row after requested-write completion, not reconstruction from stale input. It does not make network delivery or an ambiguous commit acknowledgement exactly-once. Two deliberate successful item/draft/preset creations remain two creations; same-name collection retries retain409. The completed assistant CREATE, ack-only collection/preset PUT/Apply, all PUT guard delivery, adapter and migrations remain excluded.

## Bounded future evidence proposal — no fixtures prepared

- Four original response-read fault cases, one per route: capture initial/post-foundation baseline, requested persisted state, returned status/body, generated IDs, row counts/counters and explicit retry before first assertion. Expect original500 despite committed state; collection retry409/one requested row+charge, item/draft retry201/two rows+charges, preset retry201/two mirrored pairs+four charges when capacity permits. Preserve first-assertion limits. Fixed should return201 actual inserted row and never reach the separate injected response read; deliberate retries retain the route-specific semantics above.
- Boundary controls for collection99→100 then same-name409, item/draft499→500 then429, preset398→400 then429, and preset399 preflight429 without DML. These distinguish accepted-write ambiguity from nonexistent duplicate retry behavior or assumed quota charging. Use full persisted snapshots, not total_changes alone.
- Accepted-response controls compare SQL-derived defaults/timestamps, trimmed fields, item active/draft activated_at and source defaults, draft caller/source IDs/empty answer, and preset mirrored ID/empty credentials. Retain focused ownership/readiness/name duplicate refusals; no unrelated route expansion.
- One meaningful repaired-foundation baseline schedule for collection or draft and a scoped source-preservation check for the other: show only requested insert effects belong to the new response contract. Do not replay the closed foundation suite.
- Novel native INSERT RETURNING positives for the affected table/batch shapes, plus row-dependent execution-time preset mirror failure and concurrent quota-consumption-before-batch causing second-insert refusal. Capture full before/after tables/counters to prove whole-batch rollback, distinct from statement ABORT. The new PUT native evidence is context, not proof that these four POST paths have run.
- Prefer bounded Node-handler/SQLite API cases and Node-handler/workerdD1 batch proofs; no browser or broad old-suite replay is currently proposed. Exact fixture counts/commands and any minimal existing hold adaptation must be proposed during separately selected preparation, reviewed as actual source, then receive a separate sole runtime grant. No automatic scope or slot expansion.

Next: one independent QA contract request, then integration selection. Source hashes and this contract are the only new artifacts.
