# Budget Undercount — exact f265 source contract

Status: source assessment complete; independent QA requested next. No implementation, fixture preparation or runtime selected.

Base: `f265a1f11780c7ad1f6359eadec8e018a90f3ac3`. Original official comment: [5675555931](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5675555931), original SHA256 `137c116caa75e4e9abd33df406847116eb156a48a7a1b60a42e42eac22d0d0ad`. The original report remains unchanged. `source.json` records eleven exact Git source identities and verified integration selection identities `9bfe4f14` / `8865fd32`.

## Proposed disposition

The helper can underproject a Studio mirror UPDATE if its legacy row retains nonempty credential columns. This is a real conditional arithmetic mismatch. It is not established as a successful-write defect on the completed migration schema: migrations 0016/0018 scrub those columns and guard every subsequent INSERT/UPDATE against nonempty snapshots. In documented intermediate recovery, old nonempty rows can remain, but the installed barrier deliberately rejects a Studio UPDATE that retains them. Legacy profile PUT explicitly clears them, so its existing replacement calculation is correct even for that historical row.

Recommend a qualified decline of a current persisted quota defect, with the intermediate-state preflight limitation acknowledged. No production patch is proposed without selecting a stronger recovery-diagnostic contract. The report itself describes preflight versus trigger refusal; do not attribute an explicit quota-bypass or HTTP500 allegation to it.

## Arithmetic and actual writers

`src/preset-budgets.ts:31..57` sums UTF-8 next bytes for id, name, engine, realtime_model, realtime_voice, language, voice and llm_model. Its legacy total and legacy old-row size additionally include URL/key bytes. Let S_old and S_next be shared-field sizes, C be old credential bytes, and T be the current legacy total. The helper projects `T - (S_old + C) + S_next` and treats the operation as growth only when `S_next > S_old + C`.

For retained credentials the actual next size is `S_next + C`, so the helper underprojects by C and can skip a real shared-field growth check. For cleared credentials its projection and growth condition are correct. When C=0, both policies coincide. This distinction must be made at the writer, not inferred from the presence of fields in the input object.

| Caller | Actual next legacy credentials | Projection consequence |
| --- | --- | --- |
| Legacy profile POST, `src/index.ts:798..841` | Explicit empty URL/key binds | Correct next bytes; creation adds two compatibility rows |
| Legacy profile PUT, `src/index.ts:854..897` | Explicit empty URL/key SET binds | Correct subtraction of the full old row and addition of scrubbed next row |
| Studio preset POST, `src/studio-api.ts:1940..1980` | Explicit empty URL/key binds | Correct next bytes; creation adds two compatibility rows |
| Studio preset PUT, `src/studio-api.ts:2037..2071` | Shared fields only; credentials retained | Correct with completed empty-snapshot invariant; conditional underprojection if nonempty |

These are the four helper callers. Both PUTs retain their first-row captured shared-field CAS, immediate changes-gated mirror and first-result boolean409. Adding old credential bytes unconditionally would make the legacy clearing writer's estimate wrong and could reject legitimate shrinking recovery. No automatic credential scrub or CAS expansion is selected.

## Migration, recovery and HTTP boundaries

- `0016_engine_profile_credentials.sql` and `0018_engine_profile_compatibility.sql` remove nonempty profile snapshots and install BEFORE INSERT plus BEFORE UPDATE guards. The UPDATE guard applies to all updates, not just an explicit URL/key SET. New nonempty values raise `OPENFON_PROFILE_CREDENTIAL_SNAPSHOTS_DISABLED`.
- Completed migrations establish the empty-snapshot invariant for ordinary current writers. This inspection does not query or certify any deployed database. Historical test rows deliberately seeded on migrations 1..15 do not establish a post-barrier producer.
- `docs/migration-compatibility.md` explicitly supports an already-0017 database with too many nonempty profiles to scrub in one daily window. `scripts/install-profile-compatibility.sql` runs the provider consistency precondition and installs guards without scrubbing, in one caller-supplied atomic batch. `scripts/recover-profile-snapshots.sql` then clears at most400 eligible rows, respecting each workspace's remaining allowance. Nonempty rows during this guarded recovery are supported intermediate data, not necessarily corruption. Their retaining Studio UPDATE is intentionally refused; a clearing legacy PUT can succeed subject to CAS, storage and quota.
- Migration failure rolls back that migration file when run atomically; earlier successful files remain applied. A failed Worker upload does not undo migrations. Old snapshot-copying requests may fail by design; the contract is not zero-downtime mutation compatibility. Do not drop guards or rewrite shipped migrations to make them succeed.
- `0017_preset_budgets.sql` includes URL/key bytes in the authoritative legacy OLD/NEW/table sizes. It rejects growing rows above512KiB, permits shrinking/equal historical oversized rows, caps creation at64 rows per table, and enforces400 shared compatibility-row writes/day. Normally an accepted mirrored save charges two units; a missing mirror can charge one. The read-only preflight itself charges nothing.
- `src/index.ts:33..41` maps `OPENFON_PRESET_STORAGE_LIMIT` to HTTP409 and the write-limit marker to429. Thus a storage-trigger refusal is already a limit response, with different body text and later work than preflight. The credential-snapshot marker has no dedicated mapping and falls through to the generic error response. For an invalid/intermediate row that violates multiple guards, BEFORE-trigger ordering is not a promised error classification.
- A concurrent table-growth race can independently invalidate any read-only preflight; the authoritative trigger remains necessary. SQL RAISE(ABORT) rolls back the failing statement and its trigger effects. The awaited D1 batch supplies rollback of the preceding mirror/counter changes; ABORT alone does not undo earlier statements in an independently managed transaction. No persisted storage or daily-quota bypass is established here.

## Foundation and creation boundaries

The four budget-helper callers use direct ownership lookups and do not call `workspaceForUser` first. Studio preset POST explicitly avoids reconciliation before a known quota refusal. Both POSTs write blank legacy credentials, and current Studio POST returns its first INSERT RETURNING row only after the full mirrored batch. The closed response correction is untouched.

The separate `PRESET_RECONCILIATION_SQL` projects only shared fields from legacy profiles into engine_presets. Foundation at `src/studio-api.ts:657..674` deletes absent mirrors, updates changed shared values and inserts missing presets; it does not copy credential columns into the destination. Omitting credentials from that destination-size projection is appropriate, not the retaining-update mismatch. This does not imply all earlier foundation work is write-free or rolls back with a later requested operation.

## Minimal optional proposal and bounded future evidence

No application change is presently justified by a supported successful-write counterexample. If integration selects stronger preflight reporting for intermediate nonempty rows, first define whether the intended outcome is a storage diagnostic or a migration-recovery diagnostic; the credential barrier must remain authoritative. A caller-explicit retain/clear policy could then project scalar credential byte lengths inside SQL without fetching credential strings. It must preserve legacy clearing semantics, missing mirrors, UTF-8, quotas, CAS, atomic batches and existing foundation. It cannot make an otherwise barred update valid.

Only after selection and a separate grant, useful discriminating evidence would be:

1. Completed-barrier empty snapshots at an exact UTF-8 storage boundary, covering both table limits and unchanged accepted bytes.
2. A historical nonempty legacy row updated through the clearing PUT: full old bytes subtracted, empty next credentials, legitimate shrink accepted, normal mirror charges.
3. A documented guarded-recovery nonempty row updated through Studio: preflight projection recorded, retaining write refused, whole requested batch and counters unchanged. Do not promise which conflicting guard reports first.
4. A concurrent storage growth after preflight: trigger409 and full requested-batch rollback, distinguished from the credential case.

These are source proposals, not prepared fixtures, commands, predictions of executed counts or runtime receipts. Existing provider/budget fixture source was read for boundaries; nothing was rerun. No live credentials, imports, SQL execution, dependency action, application/fixture edits, shared source application or runner occurred. Prior PUT/POST validation and release remain closed.
