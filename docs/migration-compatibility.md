# Provider migration compatibility

Production deployment remains an explicit operator action. Merging does not deploy.
The deployment command builds, applies pending D1 migrations, then uploads the
Worker. A failed upload can therefore leave the previous Worker serving the new
schema. A backup and a successful rehearsal are required before deployment.

Budget triggers in 0013, 0015 and 0017 use `SELECT RAISE(...) WHERE ...`.
Keep this form: the remote D1 query path used by `wrangler d1 migrations apply`
rejects nested `CASE ... END` in trigger bodies with `incomplete input`, even
though local SQLite accepts it. The WHERE form preserves the same conditions,
errors, counters and statement rollback. Existing databases that already applied
these migrations need no data rewrite; this correction enables pending upgrades.

Migration 0016 removes obsolete URL/key snapshots from engine profiles. Older
Workers copy those fields when applying a profile, so an unguarded scrub could
erase a working provider configuration before the upload completes.

The migration's database compatibility barrier checks that every legacy agent's
URL/key pair matches its workspace provider row before scrubbing. A missing or
different pair refuses the migration; it does not choose which credentials are
correct. Inspect only workspace IDs and mismatch counts in routine logs, retain
a restricted backup, and reconcile the authoritative configuration before retrying.
Never print either credential value. Earlier successful migration files remain
applied when a later file fails.

Migration 0018 installs the same barrier on databases that already applied the
earlier, unguarded 0016. It also removes any snapshots an old writer reintroduced.
Existing preset write quotas still apply to that cleanup: if it is refused, the
whole migration rolls back. Already-empty snapshots are not rewritten.

If an already-0017 database contains more than 400 nonempty profiles in one
workspace, waiting alone cannot complete the all-or-nothing migration. Under an
authorized recovery window, first verify that migrations through 0017 are applied
and execute [install-profile-compatibility.sql](../scripts/install-profile-compatibility.sql)
as one atomic D1 batch. It runs the same consistency check and installs the same
guards without scrubbing, so old code cannot keep recreating snapshots during
recovery. A mismatch still requires explicit reconciliation; do not skip the check.

Then execute [recover-profile-snapshots.sql](../scripts/recover-profile-snapshots.sql)
against the explicitly selected database. Each execution clears at most 400 rows
total and respects each workspace's remaining daily allowance through the existing
triggers. When a workspace exhausts its allowance, wait for the next UTC day; other
profile edits share that budget. Repeat until a read-only count of nonempty
snapshots is zero, then apply 0018 normally. The operation preserves profile
behavior and never returns credential values. Keep the restricted backup and
account for concurrent writes. Do not reset counters, remove triggers or mark the
migration applied manually.

Once installed, the barrier rejects credential-changing legacy UPDATEs unless
the new pair matches the provider row. Current provider and Settings handlers
update that row before the legacy row in one transaction. It also rejects
nonempty credential snapshots written by old profile create/update handlers.
These guards apply to in-flight old requests as well as later requests; safety
does not depend on guessing a request-drain delay.

The inspected pre-Studio onboarding handler inserts a legacy row with only its
business ID, leaving the schema's blank text URL/key defaults. It may therefore
create a default-only row without a provider counterpart; the UPDATE guard does
not prohibit that insertion. It cannot insert caller-supplied credentials through
that handler, and a later changed-credential UPDATE still encounters the guard.
An insert between 0016 and 0018 can make 0018's presence check refuse until explicit
reconciliation. After migration, current foundation repair creates the default
provider counterpart. Do not infer that all legacy rows always have providers,
or add a strict provider-present INSERT guard without redesigning the supported
current issuer/repair ordering.

If Worker upload fails after migration, existing calls and unchanged settings
retain their credentials. Old profile/configuration mutations that would violate
the barrier fail instead of erasing or restoring credentials. Finish deploying
the corrected Worker; do not remove the guards to make the old mutation succeed.
Rollback to a credential-copying Worker is not a full service recovery. Use a
validated credential-safe version, or a coordinated database-and-code restore
from the restricted backup, accounting for writes since that backup.

This is a database consistency barrier, not a claim of a zero-downtime deployment
or remote migration acceptance. Staging and production are unchanged by local
rehearsals. Cloudflare documents [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
and [Worker versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
separately; a Worker upload does not roll back an already-applied schema change.

## Missing legacy assistant settings

Migration 0008 activates an imported assistant only when a real, configured
legacy settings row exists. Runtime repair of a missing settings row preserves
the assistant's current activation state; a workspace with neither row starts
with a private, incomplete draft. If a provider row survives loss of both
assistant rows, repair reads its current text URL/key together at SQL execution
and preserves that pair. It uses blank defaults only when the provider is absent;
it does not clear surviving speech or realtime configuration. This is a recovery
boundary, not a claim that ordinary primary-assistant deletion is supported.

Migration 0019 conservatively pauses active canonical primary assistants whose
legacy settings row is still absent. It preserves their configuration and public
slug, but requires explicit activation after repair. This can also pause an
assistant that was legitimately activated before its settings row was lost.
Already-reconstructed historical rows cannot be identified from current data, so
this is not a complete retrospective classification of earlier activation.
Existing assistant write quotas remain enforced; a refused migration must wait
for available quota rather than bypassing its triggers.

## Browser ticket ownership (0020)

Migration 0020 adds `browser_claim_required` with default 0 and never backfills
existing tickets. New public and private browser-ticket issuers set it to 1.
Account deletion can cascade an unused modern browser ticket only when it has no
connection, saved turns, or unreleased carrier reservation. Old or unknown active
tickets retain the conservative refusal, including before their first turn and
after assistant-ID repair. The atomic WebSocket claim and account deletion
serialize: a deleted ticket cannot dispatch a new call session.

Do not gradually mix this issuer with pre-0007 Worker versions whose WebSocket
handler does not claim `connected_at`. Use a full Worker cutover when upgrading
those versions; old in-flight sessions keep their default-0 tickets and remain
protected. Rollbacks to pre-0007 require draining modern tickets/sessions first.
The column is additive for old writers, but its deletion exception assumes the
new ticket is served by a claim-capable WebSocket handler. Migration and staging
validation do not authorize a production deployment.

## Knowledge tenant relationships (0021)

Migration 0021 requires an item's collection to belong to the item's business and
an assistant attachment's two parents to belong to the same business. Its first
read-only check includes missing parents and refuses any inconsistent historical
relationship before installing four validation-only triggers. Apply the entire
file atomically. No rows are backfilled, deleted, detached or assigned a different
owner. A refusal requires restricted inspection and explicit operator
reconciliation; neither side of a mismatch is automatically authoritative.

Keep the backup and inspect mismatch counts before exposing row content. Do not
skip the check, reset quotas, drop guards or manually mark a failed migration
applied. Earlier successful migration files stay applied when a later one fails.
The triggers retain existing foreign keys, cascade deletes and source-call/turn
SET NULL cleanup, including at exhausted editing quota. Valid item writes retain
their existing charges; attachment validation adds no counter writes.

SQLite RAISE(ABORT) rolls back the failing statement and its trigger effects. It
does not roll back earlier statements in an explicit transaction. The migration
runner and D1 batch must provide the whole-transaction rollback on failure.
Rehearse the exact release through 0021, including corrupt-upgrade refusal,
statement versus batch rollback, historical data preservation and valid legacy
projection/foundation repair. Local synthetic evidence is not production backup
or remote migration acceptance.

Current checked HTTP writers derive or verify these relationships. The call
knowledge query also compares all participating businesses. No current untrusted
producer of a mismatch is established. A privileged import or earlier corruption
can nevertheless expose foreign item content or assistant metadata through old
Studio reads that trust the relationships. A refused migration does not protect
those still-running reads or sanitize existing data; use an explicit operator
recovery window for reconciliation. No defensive read-filter change is included.

If the migration succeeds but Worker upload fails, valid old/current issuers
continue to satisfy the guards, including legacy JSON projection and foundation
repair. An invalid direct import now fails. Keep guards installed on code rollback;
use compatible code or an explicitly coordinated database-and-code recovery that
accounts for intervening writes. Do not treat a Worker rollback as a schema undo.


## Legacy knowledge synchronization conflicts

Legacy services and FAQ synchronization checks that its observed source, sync
marker, default collection and complete affected imported rows still match
before applying a replacement. If another request changes them while a plan is
waiting, the request returns a conflict instead of replacing the newer content.
For example, a delayed workspace read cannot overwrite a source save followed by
a typed knowledge edit using the read's older projection. The caller must read
the current state before deciding whether to submit another change; no automatic
retry is added.

The guard covers the associated source, marker, item and quota writes in the
same D1 batch, including missing-default repair. It does not undo foundation
work that completed in an earlier batch. Equivalent cleanup, empty replacement
and no-op synchronization keep their existing behavior. Tenant and editing
quota checks still apply, and this correction requires no schema migration.

This is a conflict check against observed values, not permanent ownership of
legacy-derived rows by the typed editor. A later fresh legacy repair can still
intentionally replace an already-observed typed edit. An exact return to the
previous values is indistinguishable from no change (ABA); no revision counter
or protection against every unrelated business-field merge is introduced. Old
Worker code does not gain these checks from the database schema.

The focused validation uses synthetic interleavings through Node HTTP handlers
and local workerd D1. It distinguishes statement failure from whole-batch
rollback, but does not establish production concurrency, remote migration or
backup recovery behavior. Those require their own release-specific evidence.
