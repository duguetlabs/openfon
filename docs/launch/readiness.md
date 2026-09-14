# OpenFon release readiness

Updated 2026-09-14. **Release candidate in progress; not production-launch approved.**

## Current review policy and correction round

The user's [temporary OpenFon policy](../../.agent/decisions/temporary-pr-agent-only-review-2026-09-13.md)
suspends hosted GitHub Codex review until reinstated. Genuine latest-head PR-Agent
security/major clearance and passing required CI remain mandatory. Existing
findings from every reviewer still require verification and disposition. No new
Codex review is requested or awaited. Historical dual-review references below
record earlier requirements; this policy governs the current release.

## Asterisk WebSocket protocol negotiation

The second [ce7830cf finding](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5658194913)
was verified: a public client offering no subprotocol received an unsolicited
`media` selection. The internal route did explicitly offer `media`, contrary
to that part of the report; the defect was manufacturing this offer regardless
of the public client's request.

The public route now validates the complete offer list and forwards only the
selected `media` token, or no selection for an absent offer. Unsupported or
malformed lists are rejected before admission. The owner selects `media` only
when offered; its separate CallSession socket is unchanged. Empty-present
rejection applies to values exposed to the application. Some local transport
paths remove empty/whitespace-only headers first, so the handler sees absence.

Original focused cases yielded20 failures/6 passes/85 skips. A direct ws client
against original public workerd reproduced the unsolicited-protocol error after
one call/session reservation. Fixed171 focused cases and both types pass.
Initial fixed native validation remains14 passes/2 failures: the two header
options arrived as absent. A targeted serialization probe yielded3 passes,
2 unavailable policy proofs and0 failures. Node serialized each empty/whitespace
header, but the public handler observed null and correctly made no selection;
this is not packet capture or attribution to a specific normalizing layer.
Both initial and targeted runs disposed all clients and Miniflare successfully.

Native evidence uses the real public route, Asterisk owner, D1 and PBKDF2 with
an accepted synthetic CallSession socket. No provider, audio, PBX or Linux
execution is claimed. Initial failures, later unavailable results and their
separate attribution remain retained. Independent QA closed exact3b95ce3
source/evidence/assembly; combined1,332 tests across56 files pass in24.75s,
with both Worker/web typechecks passing. Fresh published-head review/CI remain
release gates.

## Account export endpoint sanitization

The [ce7830cf review](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5658194913)
identified credential-bearing provider URLs in account archives. Both CI runs
passed, but that review has no security or major-issue clearance. The export
correction is local; independent QA closed exactba72fe3 source, evidence and
assembly. Public disposition and fresh release gates remain required.

Export now removes userinfo, every query parameter and fragments from exactly
five provider URL fields. Malformed or unsupported URLs become empty; null and
empty values remain. Endpoint scheme, host and path remain metadata. Query
routing is intentionally omitted, so this archive is not a credential-restorable
configuration image. Stored settings, provider routing and other exported user
data are unchanged. This is not a generic scrub of secrets written in paths or
free text. The existing authenticated owner scope and no-store policy remain.

The original bounded single SQL snapshot and preallocation checks remain, with
additional transformed-row, aggregate and final response byte checks for URL
serialization growth. Original ten cases yielded nine failures, one null control
pass and39 skips; fixed account/auth suites pass62 tests and both typechecks.
A current API query save was asserted in storage before the original export
failed its URL assertion; historical userinfo coverage is separate. Failed
originals stop at their first assertion, so later checks are not claimed.
Fixed checks preserve the database except the existing export-rate charge.
Null payload and post-transformation budget cases inject SQL results; ordinary
SQL preallocation, authentication, snapshot and size-limit cases also pass.
No native workerd-handler, live provider or cross-account exposure is claimed.

## Capture helper retained-error hardening

The [77a9eab review](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5658098092)
reported no security concerns and two recommendations. Both exact-head CI runs
passed. Coupled Providers is [qualified-declined](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5658115276):
missing default text credentials are allowed; explicitly invalid custom text
configuration intentionally fails at pickup. Historical startup evidence stays
attributed to its original source and was not rerun.

The capture helper now retains an earlier error separately from termination.
For a spawned live child it attempts one SIGTERM, waits for actual exit and then
rethrows the first error. Failed signal delivery preserves the earlier and new
errors without claiming exit or retrying. Terminal or failed-spawn children are
not signalled. Capture, temporary-state removal and escalation policy are unchanged.

This is defensive helper hardening: no current capture caller was found to
produce an early error on a live child. A real owned child with explicitly
injected errors showed zero signals and immediate rejection on the original;
the fixed helper showed SIGTERM, exit, then rejection retaining the first error.
Original15 cases yielded11 passes/4 failures; fixed15 passed, and both syntax
checks passed. Two original failures stop at the kill-count assertion, before
error-aggregation assertions. Failed-kill controls are synthetic; no full capture,
browser, provider or app suite was rerun. Prior1,266 tests/types remain attributed
to01912c2. Independent QA closed exactbb36830 source/evidence/assembly;
fresh published-head CI and genuine review remain required.

## Preset concurrency and Docker ownership

Original `a8752a36` [review](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657939149)
reported no security concerns and four recommendations, without clean-major
clearance. Both exact-head CI runs passed; deployment was skipped.

Both partial preset/profile PUT routes now compare the seven fields captured
by their merge before the first write. A conflict skips the mirrored write and
returns409; successful writes preserve existing quotas, credential scrubbing
and missing-mirror behavior. This covers handler-read-to-write changes, not a
full client payload already stale before the request or values changed and
restored identically.

Apply now requires the selected saved source to still exist in the same
workspace with its six copied values at the first assistant write. This is an
explicitly selected stronger source-at-write contract. Source name-only renames
remain allowed. Intentional replacement of the target assistant's six engine
fields remains unchanged; unrelated greeting/persona fields survive. No whole
assistant CAS, source generation/version, schema or target-identity redesign
is added. Prior qualified target-overwrite declines do not cover this new
source-snapshot guarantee.

Owner126 focused tests and both types pass. Original46 tests retain35failures/
11controls; original production Node-handler/native-D1 evidence confirms a
concurrent accepted voice was erased from both profile rows. Fixed16native
groups cover four409/all-zero/full-snapshot conflicts, accepted save2/Apply1
charges, name-only source rename/intentional target replacement, missing mirrors
with one charge, and quota/late rollback. These are held-batch Node-handler+
workerd-D1 tests, not full workerd-handler concurrent-request or live evidence.

The Asterisk runtime ownership correction requires an invocation label and
verified immutable full container ID before exec, diagnostic logs or removal.
Ambiguous creation can recover only the attempted invocation's matching label;
pre-run proxy failure triggers no lookup. Unknown ownership authorizes no
container effect, and name reuse cannot redirect cleanup. Daemon selection,
Desktop/Linux networking and loopback containment remain unchanged. Real
Docker/Linux execution is not implied by the command-flow tests.

Ownership validation passes21 tests (12new plus9 unchanged runtime/network),
syntax and both types. Original12 retains11 failures and one automatic-removal
control pass; cases stop at their first failing assertion. These tests exercise
the actual runtime with fake Docker/HTTP/WebSocket, not real daemon or OS socket
teardown. Independent QA closed the exact eight-file combined assembly01912c2.
Its full suite passes1,266 tests across55 files in23.83s and both Worker/web
typechecks pass. Fresh published-head review and CI remain pending; prior
review findings do not constitute clean-major clearance.

## Legacy profile engine validation

Original `8f5b1d59` [review](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657859272)
reported no security concerns and two recommendations, without clean-major
clearance. Both exact-head CI runs passed; deployment was skipped.
The repeated preset Apply claim is [qualified-declined](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657879347):
Apply deliberately assigns all six selected preset fields without restoring
captured assistant fallback values. No assistant-revision/CAS contract is added.

Legacy profile PUT now rejects a supplied engine unless it is exactly `pipeline`
or `realtime`, before preparing writes or checking their budget. Omission retains
the current engine, including historical unknown values; this does not migrate
or normalize existing rows. Shared null/nonstring rejection, language/auth/owner
precedence, mirrored fields, credential scrub and quota atomicity remain intact.
The verified defect was invalid-string persistence; no enum CHECK or resulting
constraint500 was present.

Exact application `87a1c7b` matches the tested two-file delivery. Original twelve
cases produced four200-versus400 failures and eight passing controls; fixed31
cases across the new, provider and budget suites pass, as do both typechecks.
No source changed during validation. Evidence uses Node handlers and the SQLite
adapter, with synthetic late-mirror rollback; no native/browser/broad suite was
repeated. Independent QA closed exact `87a1c7b` source/evidence/assembly.
Original failures stop at the status assertion, so no separate persisted-state
negative is claimed. Fresh published-head review/CI remain required; earlier
full-suite receipts retain their original source attribution.

## Capture cleanup and current review dispositions

Original `7c95e53` [review](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657754590)
reported no security concerns and three recommendations, without clean-major
clearance. Both exact-head CI runs passed; deployment was skipped.
[Realtime Blocked](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657789177)
is declined: default text configuration accepts an empty key, while the
independent realtime key permits startup. Invalid custom text configuration is
a separate existing rejection policy; successful summaries need working text
service. Prior startup evidence retains its original attribution.
[Broken Workflow](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657771817)
is declined against exact YAML indentation and both successful workflow runs;
production deployment was not exercised.

The capture helper now observes child exit/error immediately after spawn,
recognizes both terminal fields, and observes completion before sending SIGTERM.
Nested cleanup attempts child shutdown and temporary removal even if browser
shutdown fails. Errors are surfaced separately from confirmed exit: failed kill
can leave a child alive, and no timeout, escalation or process supervisor is
introduced. A later cleanup error may supersede an earlier error.

Exact helper application `b310154` matches the owner-tested three-file patch.
Original process cases: four pass and six fail, including the already-signalled
child hang bounded by a test-only watchdog. Fixed ten cases and three syntax
checks pass. OS natural/signalled/running/spawn-error cases are distinct from
synthetic kill-error and event-order controls. Tests extract the cleanup body
without importing the capture workflow; the original fixture also has an error
observer, so it does not reproduce original top-level spawn-error behavior.
No browser/app/provider/capture/media regeneration or broad/type suite ran.
Independent QA closed exact `b310154` source/evidence/assembly, including the
unchanged protected Git objects. Fresh published-head review/CI remain required.

## Receipt negotiation and timing disposition

The original `884e43e` [review](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657644440)
reported no security concerns and two recommendations, without clean-major
clearance. Both exact-head CI runs passed; deployment was skipped.

The [Timing Overwrite disposition](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657690535)
declines the reported producer premise. Connected Telnyx failure projection
leaves timing to the session; its unconnected end-time assignment also makes
the row terminal, outside the final active-only UPDATE. Session ending time is
persisted before summarization and reused on retries. No timing behavior or
final UPDATE was changed. Using observed carrier release to cap a later first
finalization would be a separate policy, which this correction does not adopt.

Asterisk accepts legacy PCM before ready. Its receiver must not turn that PCM
into required receipt debt when the first valid ready enables receipts. The
bounded correction clears only that prior pairing state; playback queues,
marks and carrier transport debt remain intact. Pre-ready markers remain
compatible, and negotiated missing receipts or repeated ready still fail closed.
Current carrier greeting producers send ready first and pair every realtime
binary with its receipt; no current normal-greeting production failure is claimed.
Exact receipt application `14f8dc4` matches the owner-tested two-file delivery.
Four original transition cases fail with `invalid_session_frame` (nine other
cases deliberately skipped); fixed45 tests across the transition, Asterisk media
and transport-debt files pass, as do both typechecks. No source changed during
validation. Prior full1183 tests belong to `3e950c8`; no duplicate local broad or
native suite was run for this four-line source change. Independent QA closed exact `14f8dc4` source/evidence/assembly without a
duplicate runner. Fresh published-head review and CI remain required.

## Telnyx reservation and parser helper correction

Original `d2b72617` review
[5657485256](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657485256)
reported two security allegations and five recommendations; both CI runs passed.
Independent owner/QA source checks support the published
[security and Apply dispositions](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657536432)
and [lockfile disposition](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657505404).
Endpoint identity already includes query strings, and the sole production
realtime parser caller discards the native exception before fixed-error logging
or persistence. Preset Apply intentionally writes its explicit selected fields,
without the stale omitted-field fallback corrected in partial saves. Exact
manifest maps match, and both clean CI `npm ci` steps passed. These scoped
dispositions do not constitute a clean latest-head review verdict.

Separately, the parser helper now normalizes malformed JSON to its fixed error,
matching its other rejection paths. Five original helper-contract cases fail
with native SyntaxError, while one valid control passes; fixed20 tests and both
types pass. No production payload leak was reproduced. Exact two-file assembly
`9ca9558` is QA-closed; CallSession/audio/Piper behavior is unchanged.

Telnyx admission now validates one route/assistant/provider snapshot and pins it
in the call INSERT. The immediately following link INSERT is gated by that
write and matching identity; the final lookup requires complete carrier
correlation. Existing exact-match recovery remains first and incurs no new
reservation. Conflicts create no new call/link or answer action; rejection
hangup/control state is intentional. Admission is a value snapshot at INSERT,
not a lifetime configuration freeze or arbitrary inconsistent-row repair.

Owner original31 tests yield18 assertion failures and13 controls passing. Fixed
200 focused tests and worker types pass. Actual workerd owner/migrated-D1 checks
retain original16-case11failure/5pass evidence and the final17-case11failure/
6pass run with an added exact-link recovery control. Fixed17/17 scenarios pass:
configuration/identity conflicts, ignored calls, mismatched correlation, quotas,
late SQL rollback and recovery. Recovery seeds committed D1 rows then invokes a
fresh owner after route/provider edits; no real crash was injected. Full row
equality is asserted in the executed harness; retained logs record counts and
results, not full serialized row snapshots. Verified-event/carrier responses are
synthetic; public signatures, live carrier/media/provider behavior are unclaimed.
The two-owner fixture correction happened before execution. A packaging-only
missing-new-file-mode check failure was retained and corrected without rerunning
application validation.

Final application `3e950c8` passes1,183 tests across51 files in22.73s and both
typechecks. Independent QA closed exact3e950c8 source/evidence and all five delivered
file identities; owner artifacts are retained; no unrelated browser/native suite was repeated. Fresh published-head
PR-Agent security/major clearance and CI remain mandatory. No staging or
production deployment occurred.

## Concurrent assistant saves and Asterisk admission

Official `1ba053df` review
[5657301610](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657301610)
reports no security concerns and three recommendations, without clean-major
clearance. Both CI runs passed. All three findings were verified against source
and corrected in the next application candidate `9f7215b`.

Studio assistant PUT and the adjacent legacy Settings PUT now compare the
original eleven overwritten fields and lifecycle state in their first UPDATE,
using null-safe predicates alongside existing provider/credential pins.
Conflicts return409; the same atomic batch gates mirrors and snapshots and
incurs no refused-write charge. This detects changes between handler read and
write. A full client payload already stale before that read remains explicit
write intent; there is no client revision protocol or automatic retry.
Owner29 original API conflicts fail200-versus409 with four controls passing;
the original native case confirms a competing voice edit was lost. Fixed96 API
cases, both types and11 production-Node-handler/native-D1 checks pass. Seven
native conflict snapshots preserve all tables with every batch statement changing
zero rows; retries charge once and quota/late failures roll back. This native
scope is not full-workerd-handler concurrency.

Asterisk readiness reads now pin authenticated route identity, and reservation
INSERT pins provider presence/raw realtime fields plus assistant engine/model/
voice. Existing direct-OpenAI compatibility validation runs before reservation.
Conflicts return403 with no call row or session dispatch; intentional DO
retirement still occurs. INSERT is the admission linearization point; startup
continues to reread current settings, not a frozen lifetime configuration.
Original17 admission cases yield11 expected failures and six passes, including
the existing engine guard. Fixed124 focused cases and both types pass. Actual
workerd owner/migrated-D1 checks reproduce the original reservation+dispatch,
then verify eight refused interleavings, two admission controls and retired
state across restart. Trusted binding and synthetic session fixtures are explicit.

The PBX harness now chooses a complete local transport path: native rootful
Linux uses host networking/loopback; Docker Desktop retains its host forwarding.
Every Docker lifecycle command stays pinned to the resolved local daemon.
Unsupported transports are rejected before fixture startup; arbitrary forwarded
Unix/VM locality remains an operator responsibility. No wildcard proxy or image
pull was added. Native Linux remains unexecuted. Platform-selection tests and
an actual macOS Desktop Asterisk22.11 Local-channel run pass:19,200 recorded PCM
bytes,12 marks, and revoked-route401 with zero rate writes. AI/audio are synthetic;
this is not live-provider/SIP/PSTN evidence. See
[dated Asterisk validation](../asterisk-admission-validation-2026-09-14.md).

Final application `9f7215b` passes1,146 tests across50 files in22.41s and both
typechecks. Owner native/Desktop evidence is reused with attribution; no
frontend changed and no broad browser run was repeated. QA independently
closed exact assembled source/evidence at9f7215b, including all12 delivered files,
retained originals and evidence hashes; final publication still
requires genuine latest-head security/major clearance and passing CI.

## Field layout, profile recovery and foundation repair

Official `b18d60bb` report
[5657164248](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657164248)
is retained unchanged. Its missing account-export cache header premise is
[declined with source evidence](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657211054):
the registered middleware already supplies `Cache-Control: no-store`. Existing
successful export/attachment and unauthorized cases now assert that header;
both pass. This is retention coverage, not a production cache-policy change.

Field roots now carry a stable class used by the two affected flex selectors.
Native filter labels and accessible label/hint associations remain intact.
Owner original two baseline cases pass with expected flexGrow0; fixed two cases
pass with flexGrow1 and filled geometry across all six affected rows at desktop
and mobile widths. Original baseline passes are not failed negatives. QA checked
assembled source identity, geometry, screenshots and retained provenance.

Both b18 browser CI failures came from profile Delete recovery issuing three
list reads where the unchanged test expects two. Delete now retries its list
only; Apply retains business/session recovery. Two affected actual Chrome/workerd
cases pass, including confirmed deletion followed by a failed read and read-only
retry. No assertion was relaxed.

The official migration INSERT concern has a qualified decline: inspected old
onboarding inserts blank defaults, changed-credential UPDATE remains guarded,
and current foundation repairs a missing counterpart. An insert between0016
and0018 may require explicit reconciliation before0018 can apply. No applied
migration or strict INSERT trigger is changed; see
[migration compatibility](../migration-compatibility.md).

A separate verified recovery defect is corrected: when both assistant rows are
missing but a provider survives, foundation now copies its text pair at SQL
execution instead of reconstructing blanks and overwriting the provider.
Blank essentials/private drafts, absent-provider fallback, winning concurrent
repair and speech/realtime settings remain intact. Three original API negatives
and native credential-loss evidence are retained. Owner14 focused cases, both
types and six production-Node-handler/native-workerd-D1 scenarios pass. This
is not full-workerd-handler concurrency or ordinary primary-deletion reachability.
QA verified all19 artifact hashes and exact assembled three-file identity.

Final application `381b3fe` passes1,091 tests across49 files in22.18s and both
worker/web typechecks. The affected browser and owner native evidence above is
reused with attribution; no duplicate broad browser/native run was needed.
Independent bounded source/evidence closure is complete. Publication adds docs
only; fresh published-head PR-Agent security/major clearance and CI remain
required before merge. Production and staging are unchanged.

## Assistant creation and confirmed frontend recovery

The unchanged official review of `8c6ec553`
([5656926555](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5656926555))
reported no security concerns and three recommendations, without clean-major
clearance. Both CI runs passed. The repeated onboarding uniqueness claim is
[declined with verified evidence](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5657065414):
workspace POST returns the canonical existing workspace, and the following PUT
intentionally applies the current retry draft. A call-site comment documents
that contract without changing behavior.

Assistant creation now rereads and validates provider state after foundation
repair, then pins that snapshot in the draft INSERT and gates the default
attachment in the same batch. Conflicts return409 without the requested draft,
attachment or insert charge. Earlier legitimate foundation repairs remain outside
that batch's rollback guarantee. Exact source is assembled in `d2c23fe`;
owner167 APIs/types and native source-extracted D1 create-batch checks pass,
with six original201-versus409 failures retained. QA independently verified
source identity and evidence. These are not full-workerd-handler concurrency
or live-provider claims.

Knowledge confirms accepted items, statuses, deletions, attachments, collection
fields and counts before refreshing. Separate read-only recovery preserves new
drafts and missing-collection identity. A bounded frontend inventory corrected
the same class in profile Apply/Delete and signup/login: confirmed operations
have read-only recovery; rejected or ambiguous mutations remain unconfirmed.
Authentication clears the submitted password after success and preserves the
existing sign-out guards. Profile recovery blocks repeated writes until reads
are accepted, while retaining unrelated drafts. Effect and explicit Settings
reads share ordering and reject superseded responses.

Eleven original browser failures establish the confirmation gaps; the initial
Knowledge deletion locator failure is retained separately. An additional
`a81d56c` ordering negative observes a newer server assistant not being adopted
while an older read is held. Combined `c1ecf8d` passes1,085 tests across48 files,
both types and25 affected actual Chrome/workerd browser cases. Final frontend
read-acceptance guards in `609a6fc` pass12 targeted browser cases and both types;
the earlier combined run is reused with attribution. A held-effect retention
probe also passes the preceding candidate, so it does not establish the proposed
late-effect defect: that guard is defensive hardening, not a reproduced failure.
Original text logs and source snapshots remain. The second original browser run
reused and overwrote the first run's trace directory; later runs use separate
output directories. These limits remain explicit in the integration/QA checkpoints.

Fresh exact-published-head PR-Agent security/major clearance and CI remain
mandatory. No staging, production or live-provider changes occurred.

## Earlier integrated correction evidence

The published `8bd4204` browser CI failed because three profile tests bypassed
the existing signup-isolation fixture. Local `ac80e7d` corrects those imports;
29/29 actual Chrome/workerd cases passed without changing production limits.
The official Alarm Churn finding is corrected by cleanup-deadline scheduling
and an atomic CallSession write preserving Telnyx's failure classification.
Owner 198 focused tests, types, and persisted-workerd ordering checks pass,
with original-source negatives preserved.

Local `34b274e` includes assistant mutation/refresh separation and explicit
modern browser-ticket provenance in migration0020. Its 34 account tests, both
typechecks and migration20 preservation/rollback/re-upgrade rehearsal pass.
The save/previous editor browser cases passed; publish/pause passed a targeted
recheck after correcting a test interception pattern. Historical failures remain
recorded. Account deletion preserves unknown legacy sessions; see the mandatory
cutover and rollback boundaries in [migration compatibility](../migration-compatibility.md).

Provider activation pins the checked assistant/provider configuration atomically;
instance speech credentials are rejected or cleared rather than reported as
runtime credentials. Owner 91 focused API tests and types pass, with the prior
one-case browser pass retained. Realtime cumulative-output/receipt accounting passes279 owner-focused checks,
both types, direct/gateway workerd smokes and four stalled/progress carrier probes.
The assembled application passes1,007 tests across45 files, both typechecks and
33/33 actual Chrome/workerd browser cases. Initial12 fixture failures and their
corrections remain recorded. Independent QA on `ba78f84` passes actual workerd/D1
legacy migration1–20/bootstrap provenance, public/private ticket issuance, held
lookup/delete/claim refusal with zero DO dispatch, and four activation
interleavings. Its narrow output/Telnyx suite passes12 tests with91 deliberate
skips, including five independent adversarial receipt/debt cases. Owner and
combined evidence above is reused with attribution. QA found no remaining
concrete issue in this bounded scope and released its slot (checkpoint0656837).
Clean latest-head PR-Agent/CI remain pending; this is not production-launch approval.

## Latest provider-write and settings correction

The published `3d0da345` passed both CI runs. Its original genuine PR-Agent
report [5656369526](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5656369526)
reported no security concerns and five recommendations, without clean-major
clearance. Onboarding retry deadlock was disproved: the creation endpoint
returns the canonical existing workspace on retry; three existing interrupted
setup browser cases pass. The public disposition records those evidence limits.

Provider writer races are corrected in all three Studio/preset/legacy paths:
conditional first writes pin validated provider state, and subsequent mirrored
writes remain gated in the same atomic transaction. The legacy path additionally
pins the earlier text credential read. Owner133 focused APIs/types and actual-D1
batch conflict, trigger/quota and rollback checks pass;22 original failures are
retained. Exact validated source is assembled in `01d159e`.

Settings now confirms each successful stage before later requests and skips
accepted unchanged stages. Clean saves are disabled; read failures have a
refresh-only retry. Reads begun before or during a write cannot replace its
confirmed baseline, and newer drafts survive recovery. `2d11180` includes the
QA-driven read-order fences. Six affected actual Chrome/workerd browser cases
pass across two three-case runs; three original read-order negatives fail on
`9321adc`. The first fixed read-order log was accidentally named negative;
it is classified only as fixed evidence. Actual negative logs are separate.
The assembled `2d11180` suite passes1,052 tests across47 files and both typechecks; the later isolated Piper settlement delta has its own27 focused/type/native passes.

Piper cold/expired catalog work uses scalar admission and immediate fallback,
sharing completed catalog data only. Final `bfa7d2c` retains reservations until
lookup/cancel settlement; elapsed time cannot refill unsettled capacity. A lost
context can strand a slot until isolate recreation, causing static fallback;
cached catalogs remain available. Owner27 focused tests/types and a tighter
native nonfinishing-body probe pass: cancellation near1.5s, physical peak32,
replacement observed after old transport close. This is observed native ordering,
not forced-DO-destruction or universal remote-teardown proof. Earlier ordinary
request/DO probes remain attributed to the preceding candidate. Two mocked
unresolved-I/O negatives fail the expiry-reclamation candidate; no native abort
failure is claimed. Independent QA on `bfa7d2c` passes all three actual workerd/D1 full-handler
provider interleavings:409, all batch statements unchanged, full post-switch
persisted snapshots retained, and fresh incompatible retries400. QA3529c94
found no remaining concrete issue in the bounded scope and released its slot.
Clean latest-head PR-Agent/CI remain pending; local evidence is not merge or
launch approval.

## Account admission and remaining provider guards

The published `bc0799c3` review raised account-deletion KDF admission and the
remaining legacy profile-apply race. Both were verified and corrected. Deletion
now shares password rotation's per-isolate four-active/16-start/two-per-second
budget before credential lookup, releasing in finally. Original0020 deletion,
password/session CAS and success-only cookie behavior remain. Five original
regressions fail;39 fixed account cases and both types pass.

The fourth profile-apply path now pins provider state and gates its atomic
mirrors. A bounded writer inventory additionally found stale partial provider
PUT could restore OpenAI over an active custom model. Provider writes now pin
the full captured provider state; a read-only assertion aborts a conflicted
transaction before mirrors or optional cleanup. Owner150 distinct API cases
pass across the documented initial/recheck runs. Native D1 conflict markers map
to409 in the production Node handler; six full persisted snapshots remain
unchanged, accepted zero-row cleanup continues correctly, and quota/late-error
failures roll back. Four source-extracted native chains also pass. This is not
new full-workerd-handler execution. Independent QA verified all28 evidence
hashes, six snapshots and exact assembly with no concrete remaining issue.

Final `3829795` passes1,074 tests across47 files, both typechecks and11 affected
actual Chrome/workerd browser cases. Earlier full38/38 passes on `6524a7a` after
correcting the stale enabled-Save assertion, whose two originalCI37/1 failures
are retained. The original onboarding, generic-string-validation and frozen-host-
clock claims were independently disproved and publicly declined with limits.
Fresh exact-head PR-Agent security/major clearance and CI remain mandatory.
No staging, production or live-provider changes occurred.

## Previous correction evidence

The [official d73514e report](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5650010745)
reported no security concerns but two findings. Exact-source startup probes
independently confirm that realtime-only credentials can connect; invalid custom
text configuration still rejects intentionally. The failed profile-rename finding
is corrected locally with serialized writes and a confirmed saved-name baseline.
QA's additional two-failure case is covered; unsuccessful draft names are not
promoted to saved state.

Hosted security identified a persistent password-rotation lockout. The local
correction removes rotation from the account mutation bucket and uses a scalar,
isolate-local CPU guard:16 requests initially, two refills per second and four
active requests. A successful rotation performs two sequential password KDFs.
This leaves no account/session/IP-keyed password counter or persistent lockout;
it does not guarantee availability during global saturation. Export and deletion
limits remain separate, and credential/session changes stay transactional.

The published d73514e application passed887 unit tests, both typechecks, five
affected browser cases, actual-workerd ingress and synthetic Asterisk lifecycle.
The newer password delta passes27 focused account tests and both typechecks;
the assembled rename correction passes five browser cases and both typechecks.
Independent scoped QA passes actual-workerd wrong-password/deletion-exhaustion,
transaction rollback, copied-token revocation and held-work admission/release
probes, and reviews the rename failure sequences. The active-model switch and insecure-local realtime provider corrections are
assembled; final combined validation passes898 tests and both typechecks.
The final predicate follow-up passes76 owner-focused tests and both types.
Independent QA passes22 focused tests and actual-workerd checks for all four
JavaScript line terminators, quota rollback, draft privacy and local ws opt-in.
An exploratory NUL projection failure was localized to node:sqlite text readback;
actual D1 preserves the full value through read, projection and switching. Fresh exact-head
CI and official/hosted reviews remain mandatory; no merge clearance is claimed.

Migration0019's conservative pause and identification limits are described in
[migration compatibility](../migration-compatibility.md). Earlier actual-D1
privacy, concurrent repair, migration barriers, session rollback and carrier
checks remain recorded with their exact source versions. Staging remainsb15/0012,
production is unchanged, and no additional live call occurred.

## Product truth

| Capability | State |
|---|---|
| Public website with original CSS 3D telephone, interactive examples, responsive layout | Implemented; desktop/mobile inspected |
| Workspace signup and setup | Implemented; browser flow passed |
| Multiple assistants; draft, active and paused lifecycle | Implemented; browser persistence test passed |
| Private Test Studio with audio/text and transcripts | Real Kataleptic audio recorded with synthetic caller; failed clean acceptance retained |
| Knowledge collections, attachments, drafts and approval | Implemented; browser creation/approval/attachment/reload flow passed |
| Calls, filters, summaries and caller-question draft creation | Implemented; typed mock-provider call verifies persisted transcript, summary and detail rendering; question drafts covered by API tests |
| Password change, private export, account deletion | Implemented; API and browser password/export/deletion flows passed |
| Inbound Telnyx number | Implemented behind disabled rollout flag; unit and synthetic workerd tests pass; actual carrier pilot required |
| Outbound calling / number purchasing / porting | Not implemented |
| Calendar booking | Not implemented; only request capture |
| Email verification / forgotten-password recovery | Not implemented |
| Hosted support identity, production domain and legal disclosures | Operator details pending |
| Marketing strategy, social asset and announcement drafts | Prepared; not distributed |

## Consolidated validation — 2026-09-12

Latest candidate `5a9f185` also preserves available assistant choices after a stale link, guards conflicting profile drafts, handles an OpenAI instance default during cleanup, and keeps Azure suggestions independent of realtime selection. Integration146 focused tests/both typechecks/four Chrome-workerd scenarios pass; independent QA30 plus actual-D1 effective-provider privacy/rollback checks pass. Earlier QA103 validates the conservative export and Telnyx prelookup admission changes. These are scoped corrections; fresh full reviews and CI remain merge gates.

Browser account export uses a conservative preflight: six times the raw exported value bytes plus JSON key/null/punctuation overhead must fit below4MiB before JSON rows are constructed. This can refuse an account whose eventual JSON would be smaller; the413 response directs the operator to a database export. The limit bounds serialization work and is not a promise that every4MiB account can use browser export.

Follow-up2026-09-13: candidate `2bcd30b` fixes the [officiala20 draft-activation and smoke findings](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5649387055). Provider cleanup updates its compatibility snapshot atomically, preserving private drafts. The real-PBX harness now waits for a fresh correlated401 and asserts zero rate writes. Integration105 focused/both typechecks and independent QA8 plus actual-workerd privacy/rollback probe pass. The [new real Asterisk22.11 report](../asterisk-runtime-validation-2026-09-13.md) confirms Local-channel audio/marks and revoked-route rejection with mocked AI. Original runtime evidence remains intact; no live-provider/PSTN or staging change is implied.

Latest candidate `486bb25` includes single-KDF private Asterisk admission, bounded64KiB/15-second text and STT responses, abnormal signed Telnyx hangup classification, credential-independent assistant compatibility checks, and established realtime error handling. QA independently closed these deltas with317 focused tests and an actual-workerd synthetic-stream probe. The [official5e0 report](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5647413380) identified duplicate KDF work; its repeated rehearsal-target and smoke-count allegations were declined with unchanged evidence. All latest-head review and CI gates remain required. Staging stays onb15/0012; these corrections are not staged.

Implementation through `d43a3ff` includes presets `ce62114`, realtime `18d3638`/`13f037b`/`ca0d901` plus handshake fix `083dae3` and replacement regressions `5411999`, Telnyx `37b3575`, Asterisk `aac57a2`/`0737b0b`, launch documentation, and three PR #14 correction rounds (`a50bc84`, `f839527`, `cf1f6ec`), export metadata preservation and missing-phone normalization. Default providers are preserved; carrier rollout flags remain false.

- Latest application `42077ab` passes **813/813 unit/API tests** across 35 files and both typechecks. Candidate `486bb25` adds reporting-only rehearsal wording. Independent QA passes317 focused tests and an actual-workerd HTTP reader boundary/deadline probe; synthetic streams do not establish live transport behavior.
- Earlier adapter validation passed actual local-workerd smoke tests for Telnyx native and synthesized greeting modes, Asterisk auth/admission/media/drain/hangup, direct OpenAI GA protocol and the existing gateway. The direct path includes an authenticated static voice catalog, blocks unmatched hosts, and uses no Kataleptic/instance AI/Azure credentials. All upstreams/carrier events are synthetic.
- Both published `5e0ece3` CI runs passed, including the16-scenario Chrome/workerd suite. Earlier local14-pass/two-failure output and the successful targeted recheck remain preserved in the checkpoint. The latest correction candidate still requires its own CI pass. Coverage includes private calls, account export, provider settings/mobile layout, draft guards, search/retry recovery and historical profile preview/deletion recovery.
- Quality benchmarks: **220 tests, one skip**. Realtime benchmarks: **206 tests passed**. Standalone report checker: 122 verified figure rows, four allowlisted, zero unresolved. Dependency audit: **zero vulnerabilities**.
- Synthetic `python3 -O scripts/migration-rehearsal.py .` passed 0006→0017 preservation, binary/SQL restore, pre-upgrade rollback and re-upgrade. Migration0016 intentionally erases obsolete profile credential snapshots; behavior/current workspace credentials are preserved.
- A restricted production D1 SQL backup was restored into a **separate Cloudflare rehearsal D1 database** and upgraded through 0011. Six legacy-data fingerprints (businesses, settings, presets, completed calls, turns, public slugs) matched exactly; foreign-key and integrity checks passed. Production migrations were not applied. New additive migration0012 repairs previously installed Unicode essentials guards; its optimized local rehearsal and separate staging upgrade passed. Staging business/call/turn fingerprints remained identical and foreign-key/integrity checks passed.
- Independent QA approved the initial launch fixes and explicit deployment gate, and closed the direct pre-ack event leak at exact fix `083dae3` with independent failing-then-passing probes and actual-workerd checks. QA approved assembled `6e64872` and independently approved polling/pagination/export/phone follow-ups through exact `696a34a`. Hosted PR review remains separate.

[Provider configuration and compatibility](../providers.md), [direct realtime recipe](../realtime-providers.md), [Asterisk recipe](../asterisk.md), and [production/staging evidence](production-preflight.md) separate implementation from live acceptance. The [actual audible capture](demo/audible/README.md) verifies a 58-second real Kataleptic browser conversation, ten turns and persisted summary/message with synthetic caller audio. Clean acceptance failed because canonical Saturday hours conflicted with the scenario and missing contact was displayed as literal null. The latter is fixed and QA-checked at `696a34a`; original evidence is retained unchanged. No physical microphone/handset or clean acceptance claim is made. A separately authorized [corrective call](demo/corrected/README.md) on `526be52` passed canonical hours and missing-phone handling with persisted summary/message. Interruption follow-up remains inconclusive because of capture timing; no full barge-in acceptance is claimed. Real source-built Asterisk 22.11.0 Local-channel validation also passed on the integrated branch: generated caller/assistant audio, 11 mark acknowledgements, flush/hangup, revoked-route rejection and completed/released D1 history, with zero remaining channels. AI was mocked; no SIP trunk/PSTN or public WSS PBX pass is claimed. See the [dated runtime report](../asterisk-runtime-validation-2026-09-12.md).

## Isolated staging

https://openfon-staging.duguetlabs.workers.dev runs Worker version `14edbcb0-a26d-4ff6-b82e-a14b70469e9d` from source `b15ed876`. Its D1 binding is the separate rehearsal database upgraded through 0012. Both carrier flags are false; copied assistants/routes are disabled and copied sessions cleared. HTTP checks returned 200 for root, 401 for signed-out account and 503 for each disabled carrier endpoint. The private fictional captures used earlier staging versions and staging-only provider secrets; the phone and assistant-retry corrections remain deployed. The newer review corrections through `d43a3ff` and migrations0013–0017 are not yet staged. This is not carrier or clean release acceptance. Production remains on its prior version.

## PR and review state

PR #13 `d6ea5d2` has Codex no major issues and green applicable checks. PR #15 `37b3575` has green CI and Codex code/security no-issues results. PR #14 `cf1f6ec` fixes all three verified rounds, including active-call polling, assistant-list retry and bounded Knowledge pagination; it was pushed, closed/reopened and separately requested for Codex review. Its latest CI/review result remains pending. Every finding has a reasoned reply.

Consolidated [PR #16](https://github.com/duguetlabs/openfon/pull/16) has separately requested Codex code/security reviews; current-head CI and review results must be checked before acceptance.

A genuine official PR-Agent CLI full code/security review completed on `526be52`, with [original output and provenance](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5645886103): two chunks, no failed/omitted chunks reported, no security concerns, one verified Telnyx terminal-storage finding. The verified finding is fixed by `4cc27c4`: transactional removal of full control state/alarm retains only a nonidentifying replay marker. Unit failure/restart probes and actual persisted workerd restart pass. Hosted findings also led to provider unsaved-edit guards (`add9a61`) and complete-essentials migration seeding (`1ba6e83`); the RTP-header finding was declined with official protocol/reference-code evidence. Clean exact-head review reruns remain required. Hosted automation remains absent; independent QA is not being substituted for PR-Agent. No PR has been merged. PR #10 remains open; integrated `8666e7e` already qualifies the semantic-VAD research without changing the detector, so do not merge stale wording over that correction.

## Required release gate

1. Resolve every confirmed test/review finding and rerun the relevant matrix against the final commit.
2. Satisfy the repository review requirement. Current instructions require PR-Agent and Codex. Official local PR-Agent now runs; resolve verified findings and obtain the actual clean rerun alongside hosted Codex. Do not merge around either review.
3. Choose the real hostname and operator/support identity. Set absolute canonical/Open Graph URLs and an origin-correct sitemap. Write accurate hosting/privacy terms using actual operator and processor details; obtain any needed review.
4. Confirm the production Cloudflare account, Worker, D1 binding, migration status and configured provider secrets through scoped tools. Never output values or use credentials from old plaintext files.
5. Backup and separate D1 migration rehearsal through 0011 passed for the recorded snapshot. Refresh the production backup and confirm any intervening schema/data changes immediately before an approved production migration.
6. Verify a real provider test on the intended configuration: mic allow/deny, text fallback, interruption, hangup, transcript/summary persistence, unknown question and message capture. Then verify a consented live browser call on the target HTTPS origin.
7. Verify application/log error reporting and a rollback path to the previous Worker version. Keep additive schema compatibility when rolling back code.
8. Start with a small consented pilot. Do not launch phone-number marketing until the carrier transport passes its separate release gate.

## Deployment procedure

Use this repository's Cloudflare deployment, not an unrelated website host. The target account must be Duguet Labs and credentials must come from `dsecret`/the scoped environment. `npm run deploy` includes **remote migrations** and is not a preview command.

Before production deployment, refresh the recorded Worker version and migration list, export D1 with stdout captured to a restricted file (Wrangler prints a signed download URL), and verify backup restoration on a temporary database. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run test:telnyx`, both Python benchmark suites, `npm run test:e2e`, and `npm run build`. The browser CI job runs the local-workerd suite, and the deployment job depends on application, browser, and both benchmark checks. Production deployment additionally requires an explicit CI workflow dispatch on `main` with `deploy_production=true`; merging code does not deploy. The workflow was published through the GitHub connector’s existing authorization; no permission expansion is required. Verify these checks on the exact release commit before deployment.

After an approved release, check public root, authentication, existing-account data, draft/paused public-link rejection, private test ownership, exports and account settings. Perform one real test/live call and inspect its record. If acceptance fails, roll back Worker code to the recorded prior version, leave additive schema in place, and investigate before resuming traffic.

## Operator decisions still needed

- Final production hostname and support/operator identity.
- Hosted service versus self-hosting-only launch; data retention and processor choices for the hosted instance.
- Satisfy mandatory exact-head PR-Agent and Codex review gates.
- Whether PSTN is required for the initial public launch. The current website truthfully describes browser-only calling.

- Actual realtime authentication/ack/audio and text completion succeeded with the existing scoped credential. One preflight conversation and one recorded Northwheel conversation exhausted authorization; root subsequently authorized one corrective launch-owned acceptance with consistent fixture data and corrected staging code; canonical hours and missing-phone checks passed, interruption follow-up remains inconclusive.
- Inbound Telnyx control and media runtime is included behind the disabled rollout flag. The synthetic workerd harness proved ingress, bidirectional PCM, interruption, playback drain, hangup and release without external calls. The public website still describes browser calling until a real carrier pilot passes.

## Subsequent review corrections

Official full rerun on `4a498c8` reported no security concerns and six findings; [original report and provenance](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5645957875) remain preserved. Corrections refund failed test-ticket insert reservations, validate OpenAI voices independently of model choice, report partial Settings saves accurately, keep rehearsal checks active under Python optimization, compact Asterisk terminal state to a replay marker, and align Unicode essentials guards including upgrade migration0012. Hosted security finding3996213110 additionally led to endpoint-isolated, bounded Piper catalog caching with failure fallback; it still requires reviewer closure.

Both carrier retirement smokes pass actual persisted workerd restarts; Asterisk also uses actual D1 and transaction rollback. Optimized migration rehearsal through0012 passes and intentionally corrupted history fails under-O/PYTHONOPTIMIZE. Fourteen offline capture-sequencing regressions pass; the module requires a response-aware observer before live use and does not change the recorded interruption qualification. New exact-head hosted and official full reviews remain required before merge.


## Latest review and CI corrections

The [official full review on `b15ed876`](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5646036324) completed three chunks with no failed or omitted chunks reported and no security concerns, but six findings. Four verified issues are corrected: native carrier readiness waits for bounded first valid audio (`87948fa`), confirmed provider saves remain distinguishable from refresh failures (`dc3057c`), Asterisk playback yields in cancellable batches (`ae0c860`), and call-detail failures stop on permanent errors or after three transient attempts (`984ef6e`). Independent QA reproduced the native defect on the old source and closed the correction; direct/gateway synthetic runtime checks retain pre-ack isolation checks. The paced adapter also passed the real Asterisk Local-channel harness with mocked AI.

The missing-text-key startup allegation was independently disproved on the exact reviewed source for web and Telnyx: a direct realtime key alone reaches readiness and requests the greeting without contacting a text endpoint. Successful summaries still require a working text backend. The deployment command is unchanged from main. Migration0012 affects the new assistants lifecycle and preserves legacy data used by the old main Worker; deployment is not transactional. If Worker upload fails after migrations, retain the compatible schema, verify the recorded prior Worker is serving, and investigate before retrying. Do not reverse migrations or claim the failed deployment completed.

The intermittent CI search failure was a real draft race: delayed completion of the prior search navigation replaced newer input. `984ef6e` preserves the newer draft on the page's own filter navigation and synchronizes external/Back/Forward navigation before paint. A scheduler-controlled browser regression fails the old code and passes the correction without increasing timeouts. Full candidate validation passed 585 tests, typecheck and 13 browser scenarios; exact-head hosted and official full reviews remain required. Staging remains `b15ed876` during this review round.


Hosted `b15ed876` findings also led to [bounded whole-item knowledge selection](../call-knowledge.md) before D1 materialization (`9019639`), rejection of WebSocket URLs for custom STT (`48fc185`), and explicit deployment failure when the token is missing (`a5c6cd0`). Independent QA then exposed that the provider refresh callback swallowed parent failures and cleared a still-authenticated page. `8bfec51` retains the existing snapshot on transient refresh errors and propagates recovery to the saving page, while authentication denial and explicit sign-out clear private state. A browser negative control reproduced the lost page; the correction passes read-only recovery, retained empty credential inputs and 401 clearing. No additional provider call or staging deployment was made for these fixes.


The [official full review on `04f7613`](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5646184566) reported no security concerns and three findings. That correction advanced the rehearsal default to migration12 (`223c315`), verified by optimized full-chain success and a missing0012 negative control. Asterisk preserves XOFF across flush until actual XON (`862bf1f`); the updated actual-workerd playback, synthetic call and persistent-retirement checks pass. This latest flush correction has synthetic runtime evidence; the earlier real PBX evidence remains separately dated. The Telnyx connected-token allegation was declined against the [official AsyncAPI contract](https://developers.telnyx.com/api-reference/websockets/stream-call-media-over-websocket), which explicitly includes the configured token in both frame metadata and the upgrade header. Authentication is unchanged. Both CI runs on04f7613 passed; exact-head reviews of the corrections remain required.


The [official c436c07 review](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5646226706) reported no security concerns and two carrier lifecycle findings. Telnyx now performs its bounded CallSession connection outside the lifecycle lock and revalidates current state before installation (`0ba15d8`), preserving hangup/alarm progress and closing late sockets without prematurely releasing reservations. Asterisk records connection only after validated PBX/session readiness and classifies failed startup immediately (`16dbc74`); its startup wait is also bounded outside the lock. Actual-workerd checks cover invalid start, timeout, pending readiness writes with adjacent audio, late sockets and durable cleanup. The subsequent assembly passes624 tests/typecheck; independent scoped reviews and required full exact-head reviews remain distinct gates. No new live provider/PBX/PSTN or staging claim is added by these corrections.

Hosted c436 follow-ups preserve draft publication until explicit activation, reject unsupported realtime query/fragment configuration before persistence, honor future Asterisk cleanup deadlines and classify connected media errors. Unauthenticated carrier handshakes no longer consume D1 rate writes: Telnyx uses a read-only call lookup followed by owner authentication/one-time claim; Asterisk authenticates before its retained authorized rate cap. Original-source negative controls reproduce the defects; the corrected application passes624 tests, typecheck and13 Chrome/workerd scenarios. Independent scoped QA passed159 focused tests and both typechecks. Fresh full exact-head reviewer clearance remains required; no security waiver or new staging/live claim.

The [official7a8cb53 report](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5646511433) contains five findings. The lockfile mismatch allegation was declined against tracked matching dependency ranges and successful exact-head `npm ci` jobs. Corrections defer the Asterisk FIR tail until acknowledged playback frees capacity, construct STT resource URLs without replacing custom base-path text, remove the duplicate native Telnyx CI invocation, and require a public origin for explicit production deployment. Hosted findings also led to preserving workspace credentials when applying an engine profile, measuring duration from connection, ignoring caller input during Telnyx goodbye, preserving sibling Settings drafts, and atomic [knowledge persistence budgets](../call-knowledge.md) in migration0013. A deterministic session-start signal replaces the Asterisk test polling race that failed both7a8 CI runs.

Application `6ff5058` passes663 unit/API tests, both typechecks and14 fresh Chrome/workerd scenarios. Optimized0006→0013 preservation/restore/rollback rehearsal passes, while a missing0013 copy fails. Staging remains on0012/sourceb15ed876; production is unchanged. Independent runtime quota review passed; fresh full exact-head hosted/official reviews and CI remain gates; earlier clean scoped results do not replace them.

Independent workerd review of `ccdd85d` exposed a quota-exhausted default-collection repair that could return an empty completed-looking workspace. Follow-up `6ff5058` restores collection, attachment, legacy call attribution, knowledge and sync marker atomically; a failed repair remains retryable. Collection metadata is also bounded (64 collections,256KiB names/descriptions,100 accepted edits per UTC day), alongside item quotas. Updated663 tests, both typechecks and14 browser scenarios pass; independent workerd recheck of this exact repair passes the unchanged original failing probe. Separate actual-D1 checks pass collection count/UTF8/day limits, refusal snapshots, batch rollback, deletion without refund, named-default repair at limits, and atomic missing-default repair including legacy call attribution. Required hosted and official full reviews remain separate.


The [official1428a50 report](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5646912988) raised an explicit Asterisk credential-storage security concern and Telnyx normal-close classification. Both are corrected locally: migration0014 disables legacy PBX routes and removes fast verifiers; operator rotation/reprovisioning with salted PBKDF2 is mandatory, with no legacy fallback. Route identity and revocation are preserved. Telnyx normal socket close remains provisional until authenticated terminal reconciliation; signed normal clearing does not erase explicit transport/provider failures. Owner negative controls and bounded workerd checks pass. Neither carrier was enabled or called live.

Hosted1428 corrections also bound realtime JSON/audio before parsing/decoding, preserve old acknowledged sockets when replacement input is invalid, remove credential snapshots from engine presets (including one-time0016 cleanup), and reject presets incompatible with the current realtime provider before writes. Migration0015 adds [assistant storage/write limits and bounded session/list metadata](../assistant-limits.md), with guarded deletion preserving call history and paged historical selectors. The assistant editor explicitly labels its provider check as text-only. The new pagination regression proves a later-page Test link keeps its requested assistant.

Exact application0b88ae7 passes719 tests, both typechecks,15 Chrome/workerd scenarios and optimized migration16 rehearsal. Both prior1428 CI runs passed, but its official/hosted reports had findings; those CI results are not final-candidate review clearance. Independent scoped checks of0b88ae7 pass:111 focused tests plus9 realtime cases, unchanged page2 browser regression, and actual-D1 assistant limits/rollback/history/metadata plus PBX credential migration/authentication. QA found no new major/security issue in those bounded deltas. Fresh full exact-head hosted/official reviews and CI remain required. Staging remains b15/0012, production unchanged. The Telnyx account is blocked with routine polling suspended pending user/support action; there is no fresh PSTN eligibility or acceptance claim.


The [official3d8e892 report](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5647170258) raised an explicit pre-KDF CPU concern plus PBX configuration characters, browser playback rejection and earlier rehearsal targets. The target allegation was declined after unchanged optimized targets9–16 all passed. Corrections add a constant-size isolate-local PBX authentication budget (16-start burst, two per second, four concurrent), require configuration-safe tokens, and complete pending browser hangup when playback rejects. Hosted findings also led to classifying abnormal PBX close codes, limiting transcript fields to8KiB and total call text to256KiB, and [preset persistence/reconciliation budgets](../preset-limits.md) in0017. The PBX limiter does not claim distributed protection across isolates or restarts.

Applicationd33e43f passes753 tests, both typechecks and optimized17 preservation/restore/rollback rehearsal; a missing17 copy fails. Owner negative controls and bounded runtime evidence remain recorded separately. Independent scoped QA passed219 focused tests and actual-D1 quota/recovery checks on this assembly; the subsequent NUL-preview guard also passes the unchanged independent actual-D1 old/fixed probe; fresh full hosted code/security, genuine official PR-Agent and CI clearance are required before merge. Remote3d8 CI was green, but its reviews had findings and do not clear this correction. No production/staging migration or additional live call occurred.
