# Provider migration compatibility

Production deployment remains an explicit operator action. Merging does not deploy.
The deployment command builds, applies pending D1 migrations, then uploads the
Worker. A failed upload can therefore leave the previous Worker serving the new
schema. A backup and a successful rehearsal are required before deployment.

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

Once installed, the barrier rejects credential-changing legacy writes unless
the new pair matches the provider row. Current provider and Settings handlers
update that row before the legacy row in one transaction. It also rejects
nonempty credential snapshots written by old profile create/update handlers.
These guards apply to in-flight old requests as well as later requests; safety
does not depend on guessing a request-drain delay.

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
with a private, incomplete draft.

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
