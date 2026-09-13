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
