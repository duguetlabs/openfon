# Preset storage and recovery

Migration 0017 bounds each workspace to 64 rows and 512 KiB of UTF-8 configuration text in each of `engine_profiles` and `engine_presets`. These are compatibility copies: a normal preset occupies one row in each table, with a combined ceiling of 128 rows and 1 MiB. IDs and all saved engine/model/voice/name fields count, including obsolete compatibility URL/key fields if restored externally.

The tables share 400 accepted row writes per UTC day, normally 200 mirrored API saves. A read-only preflight checks both copies before saving; SQL triggers enforce the limits for concurrent writers, and the mirrored save is one atomic D1 batch. Known refusals write neither rows nor counters. A concurrent batch failure rolls back persisted changes. Deletes cost no quota and do not refund earlier writes. Shrinking historical data still requires daily allowance.

Existing rows are preserved. Bootstrap compares profiles inside SQL and returns only a scalar decision. It defers compatibility reconciliation when historical row/byte totals or remaining daily allowance cannot accommodate it; the dashboard remains available. Reconciliation deletes stale copies, shrinks changed rows before growing others, and inserts missing rows in one batch. It does not repeatedly rewrite unchanged profiles.

Lists show at most 64 profiles with 256-character field previews. Applying resolves the complete saved row by ID. A truncated historical preview cannot be renamed in Settings, preventing accidental replacement of a full name by its preview. Delete unused profiles to reveal later entries; deletion refreshes the list. Operators can shorten historical configurations through the authenticated update API. Limits prevent additional growth; migration does not silently discard old configurations.

These are workspace storage/write budgets, not a distributed request-rate limit or a cap on existing pre-migration database size.
