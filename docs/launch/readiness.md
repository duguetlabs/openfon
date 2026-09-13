# OpenFon release readiness

Updated 2026-09-14. **Release candidate in progress; not production-launch approved.**

## Current review policy and correction round

The user's [temporary OpenFon policy](../../.agent/decisions/temporary-pr-agent-only-review-2026-09-13.md)
suspends hosted GitHub Codex review until reinstated. Genuine latest-head PR-Agent
security/major clearance and passing required CI remain mandatory. Existing
findings from every reviewer still require verification and disposition. No new
Codex review is requested or awaited. Historical dual-review references below
record earlier requirements; this policy governs the current release.

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
