# Production preflight

## Current production deployment — country and saved-voice controls, 2026-10-07

OpenFon Web is deployed at **https://openfon.ai** with explicit business country, reviewed phone eligibility and guidance for unavailable saved voices. PR56 is merged; production and staging run its exact reviewed application tree. This documentation closeout does not redeploy the application or repeat audio/provider tests.

| Item | Production | Staging |
| --- | --- | --- |
| Application source | `d15d19d9c5279696e1f8b75b43a245ed6411a729` | Same |
| Worker version, 100% | `e6269da7-5af7-4677-b2fe-55f117752152` | `c6a26d5b-7a29-40e5-a278-a11b1d3e54de` |
| Node image | `sha256:932c493f119592eb4b8152f521ccfd23daf3971ff33c05eb7dbecc91b97670ec` | Same, unchanged |
| Node source | `22d2519c1686155f3abe1edcfd32b5df5c9c18de` | Same; voice-agent tree unchanged through d15d19d |
| D1 migrations | 0001–0029, preserving historical 0024 | 0001–0023, 0025–0029; never replay 0024 |
| Private-test recording | Enabled; owned test/web scope and seven-day retention | Same |
| Billing verification, checkout, charging, carrier ingress, phone purchases | Disabled | Disabled |

The reviewed `ef6de45` and squash merge `d15d19d` have identical trees. Genuine PR-Agent security/major clearance and local Codex review passed; exact CI `37552138416` passed all five jobs with deploy skipped. Full local validation passed 2,381 Worker tests/106 files, both typechecks and build. Five selected browser cases passed: the original run retained three passes and two exact-label fixture failures, with only the affected cases rerun after selector correction. A real review finding about nonexistent carrier response metadata was fixed using the documented exact-match response and re-reviewed before merge. No saved voice was rewritten.

### Data preservation and rollout

Both environments used fresh restricted backups, exact local rehearsals and one explicit 0028/0029 import followed by independent exports. All 45 old table projections were preserved apart from the two intended ledger additions. Existing business countries and quote approval pins remained null, both revision triggers were present, integrity was `ok` and foreign-key violations were zero. No historical 0024 data migration was replayed.

| Evidence SHA256 | Value |
| --- | --- |
| Staging backup | `1e846589ad27ec0db85b100c70216970ea0babdd20a073a743003913eac3a7e4` |
| Production backup | `0006acef8431be541e4b1148ac66ccdbdcf6dae6048a5483b9c8900fc04dee6a` |
| Exact shared 0028/0029 import | `3726080b3bf6cce8defade0509caabb1da803e954bccdd520944767a749553b8` |
| Independent staging after-export | `889dfd36dc6b6bc1a22cef10a05d15c2ab44cf3b213e3de03b7f10862632def3` |
| Independent production after-export | `00af4fda0da2ff25e3b0d171936610efb234d4190a1f24da7d0a06fb81654fc5` |

The initial intended staging export used the unmatched positional name `openfon`; Wrangler resolved the production name despite the staging config. The absent-0024 guard caught this before any mutation. That restricted read-only export and failed attempt remain retained. Corrected commands used binding `DB` after checking the exact configuration/account/database UUID. Production later received its own fresh correctly targeted backup. The local workerd rehearsal's unsupported integrity PRAGMA also remains an original failure; a separate read-only SQLite integrity check passed without repeating its migrations.

After staged acceptance, the canonical production deployment command preserved the tracked recording flag. Node containers, runtime secrets and persistent usage/outbox/cursors were unchanged. Both environments ended healthy with zero active calls/rooms/restarts. Each passed 12 bounded account checks for country changes, invalid country, missing business, closed phone setup, ten compatible voices, customer projection and deletion of the synthetic account. These are no-inference checks; missing-business 404 is not cross-account-isolation evidence.

Landing, sign-in, health, robots and sitemap returned 200 and served HTML matched the exact built index/canonical URL. Native in-app browser inspection of exact staging confirmed that the existing legacy voice was retained, choose-and-save guidance was visible, Start/inactive publication were blocked, unknown business country remained unset and phone setup showed prerequisites without invented markets. No fields, previews or calls were changed in that inspection.

### Remaining limits and rollback

Dodo invoice aggregation/subscription lifecycle acceptance, actual carrier regulatory approval/purchase/rental policy and physical microphone/speaker/noise/all-voice acceptance remain open. Phone eligibility code does not establish an approved business or working carrier service. Public Azure tariffs now match deployed model/region/Global SKU identities; actual consumed-meter/invoice reconciliation remains unverified. See [billing and costs](../commercial/billing-and-costs.md), [phone eligibility](../commercial/phone-eligibility.md) and [readiness](readiness.md).

Prior compatible Worker rollback targets are production `d005e405-6037-4a78-869e-b60b8913aa55` and staging `0531d3b8-d8de-4962-88a1-bb2bda28e4fe`, both source `6499e349`. Node remains the same immutable image. Retain additive 0028/0029 data and current usage/outbox/cursors; do not restore an older database or overwrite live usage as a rollback. Earlier records below are historical, with their original failures and acceptance limits preserved.

## Historical private recording rollout — 2026-10-07

OpenFon Web is deployed at **https://openfon.ai** for owner testing. PRs 54 and 55 added private-test recording and repaired deleted-recording availability responses. At this recording checkpoint, business-country/phone-review changes, saved-voice guidance and migrations 0028/0029 were still pending.

| Item | Production | Staging |
| --- | --- | --- |
| Application source | `6499e349f16c4b361421945e086a9c6e553ffd6d` | Same |
| Worker version, 100% | `d005e405-6037-4a78-869e-b60b8913aa55` | `0531d3b8-d8de-4962-88a1-bb2bda28e4fe` |
| Node image | `sha256:932c493f119592eb4b8152f521ccfd23daf3971ff33c05eb7dbecc91b97670ec` | Same |
| Node source | `22d2519c1686155f3abe1edcfd32b5df5c9c18de` (identical Node source through application 6499e349) | Same |
| Private-test debug recording | Enabled | Enabled |
| Inference | Azure `gpt-realtime-2.1-mini`; delegated/post-call `gpt-5.4-mini` | Same |
| D1 migrations | 0001–0027, preserving historical 0024 | 0001–0023, 0025–0027; never replay 0024 |
| Billing verification, checkout, charging, carrier ingress, phone purchases | Disabled | Disabled |

PR55's exact reviewed tree passed genuine PR-Agent security/major clearance, local Codex review and CI `37548929634` (all five jobs). Its full Worker suite passed 2,345 tests/104 files, types and build. PR54 passed 150 serial Node tests and both Node checks. Recording required no migration.

The single authorized staging recording call completed in 55 stored seconds with six transcript turns, summary, open callback action, measured realtime/reasoning/transcription/text observations and nonzero generated audio. Its complete customer-projected download contained 6,286 records with strict sequence/count, allowlisted-field/privacy and no-store checks. The captured raw PCM payloads contained 2,461,920 caller bytes and 1,093,440 assistant bytes at 24 kHz; offline WAV extraction additionally inserts timing-gap silence. Anonymous access returned 401, another owner 404 and deletion 200. Both synthetic accounts were deleted.

**The original harness failed** after deletion because the availability response became an empty JSON body and returned 500. PR55 preserves that JSON response instead of processing it as recording lines. The first immediate repaired staging control still returned 500; the cause remains unconfirmed. A later unchanged-source control passed all four checks. These failures are retained separately, not relabeled as passes. Production passed the same four no-inference availability/deletion controls, with its synthetic account deleted; there was no new paid production call.

Production readbacks verified exact Worker/Node identities, protected configuration and credential identities, persistent usage/outbox/cursors, health 200, zero rooms/active calls/restarts. Landing, sign-in, health, robots and sitemap returned 200; served HTML matched built bytes with the production canonical URL. Native in-app browser inspection independently verified the private-test recording disclosure before Start. No physical microphone, speaker, smart-glasses noise or all-voice acceptance is claimed by software-received PCM.

The production rollout used the canonical deployment checks and exact production build, then the corresponding Wrangler command with only `TEST_CALL_DEBUG=true` overridden: the deployment wrapper did not forward this selected flag. The tracked staging/production configuration now retains that already-selected true flag for future canonical deployments; no new recording scope is enabled. Previous rollback pair: Worker `6557299d-198a-420b-a38b-356d682a6ee3`, Node `sha256:8bfde55695150b015a811c408c5f74b87d50e1bdd0ca13ee87c5e7b711336227`. Restore compatible configuration only; preserve current usage/outbox/cursors and additive database state. Do not overwrite live usage with an old configuration backup.

The following sections retain historical rollout evidence and limits. Their earlier versions and missing-recording statements do not describe the current deployment.

## Historical Mini rollout before private recording — 2026-10-07

The managed OpenFon Web application is deployed at **https://openfon.ai** for owner testing, using direct Azure through the existing LiveKit/Node transport. Production deployment is complete; payment, phone provisioning and unrestricted physical-call acceptance are separate unfinished gates. This section supersedes the pending-production statements in the dated pre-rollout checkpoint below.

| Item | Production | Staging |
| --- | --- | --- |
| Application source | `02e867cc76d8d1d9744877fca96e679c9a3f8933` | `963dc4b1e8cf8096418a3c36bb7843446495c967` |
| Worker version at 100% | `6557299d-198a-420b-a38b-356d682a6ee3` | `14e2d64f-b96e-480e-a784-e319c4b62ccf` |
| Node image, both environments | `sha256:8bfde55695150b015a811c408c5f74b87d50e1bdd0ca13ee87c5e7b711336227` | Same |
| Reviewed Node source | `314215780f52ea55bf005a3618791ca2b0c8000e` | Same |
| Inference | Azure `gpt-realtime-2.1-mini`; delegated/post-call `gpt-5.4-mini` | Same |
| Signaling | `wss://voice.openfon.ai` | `wss://voice-staging.openfon.ai` |
| D1 migrations | 0001–0027, preserving historical 0024 | 0001–0023, 0025–0027; no 0024 |
| Schedule | Every minute | Disabled |
| Billing verification / new charging / phone purchases / carrier ingress | Disabled | Disabled |

Production source is documentation-only above the reviewed application/runtime candidate. PRs 48–52 are merged. PR52's genuine PR-Agent and local Codex reviews cleared the exact reviewed tree; CI `37540236040` passed all five jobs. Application validation remains attributed to PR51: 2,334 Worker tests/103 files, 143 Node tests, types, builds and migration rehearsal. This documentation closeout does not redeploy or repeat provider calls.

### Deployment and preservation verification

Production's fresh restricted backup restored with integrity `ok` and zero foreign-key violations. Exact migrations 0026/0027 plus their normal ledger insertions passed local rehearsal, then the supported remote file import and independent post-import export. All old columns/rows across 20 tables were preserved, apart from the two intended migration-ledger additions; both projection triggers were present and booking-projection mismatches were zero. Existing 0024 was preserved, not replayed. Backup SHA256: `620d5baa26745a5329ef638894248b4f826f8e923b4b8814d9d960dd258f4323`; reviewed import: `6dacb1d1d906b37e8484fd63da8c3aa268b810e555a65e0f7ed077131ed8bab7`; post-import export: `cd7ccfc5efa2bf24a1a3a870e0d9df69bcba21401b0513accce5d0f9910db5a9`.

Canonical `npm run deploy` and the immutable Node image were deployed as a pair after fresh vacancy. The first Worker version `7cb9d482-4979-4dff-9ff6-8faa4a7d1375` omitted public metadata because `OPENFON_PUBLIC_URL` was absent. Its log remains retained; a canonical redeployment with `OPENFON_PUBLIC_URL=https://openfon.ai` produced the current version without repeating migrations or Node preparation.

Actual readbacks verified the fixed production D1 ID, all three unchanged Durable Object namespace IDs, preserved legacy secret names, managed/Azure settings and disabled commercial/carrier flags. The running Node's image/revision, voice/text pins, production callback and signaling, credential-file identity, UID 1000, writable persistent usage mount/mode 0700, no diagnostic overlay and health 200 all passed. Both environments ended with zero calls/rooms and zero restarts; production usage had no queued or dead observations.

The served HTML matched built bytes, with the correct canonical URL, sitemap and robots entry. Landing, sign-in and health returned 200; signed-out account access returned 401. The coordinator's native in-app browser separately rendered the current public landing and sign-in pages, including monthly/annual plan wording. No authenticated browser save, preview or conversation was performed in that inspection.

### Qualified production callback acceptance

The one authorized English production call completed in 57 seconds through actual Azure/RTC with synthetic prerecorded input. It persisted the correct caller name/phone, an open callback action, summary and transcript; all six final transcript events matched saved turns. Measured final observations covered realtime, transcription, delegated reasoning and post-call text. Post-input output contained 720,240 PCM samples with peak 21,554; the final caller phase had one goodbye and no repeated opening greeting. The owned test account was deleted, safe collection succeeded and the service stopped normally.

The original harness **exited 1** because the requested arithmetic answer was missing; it remains a failed probe. Independent offline source review found that this arithmetic expectation conflicted with the fixture's explicit “Take callback messages only” instruction and the compiled business-only/unrelated-question restrictions. The missing answer therefore does not establish a callback-service regression, but arithmetic correctness is not claimed and the model's actual reason remains unknown. Callback-service evidence was assessed separately; the original result was not relabeled. A timed follow-up preceded a shortened final readback; interruption is plausible, but exact provider causality was not captured.

Two earlier staging greeting-stage failures remain unexplained. A later interrupted-greeting call succeeded, which does not prove those failures repaired. The German staging fixture also contained an English reasoning acknowledgement. Software-received PCM does not prove physical audibility, subjective voice identity, smart-glasses restaurant-noise robustness, repeated device calls, all voices or PSTN readiness. LiveKit debug audio recording was not implemented at this historical checkpoint.

### Operating limits and rollback

Keep Dodo billing verification/checkout/charging disabled until usage-to-invoice and subscription lifecycle acceptance is complete. Phone provisioning remains disabled pending the business-country/server-derived eligibility workflow and actual carrier acceptance; no number purchase or PSTN charge occurred. See [billing and costs](../commercial/billing-and-costs.md) and [readiness](readiness.md).

Rollback material retains the prior Worker `a2787074-d3e2-42c7-a862-19c30033bff2`, legacy Node image `sha256:dbdbde5cde5c5f9282fa4d45e6d20120440e3e3c4bfd7bd3b059e161eebdce4f` and original per-environment configuration. After fresh vacancy, restore a compatible Worker/Node/configuration pair; do not overwrite current usage/outbox data or restore the whole configuration backup over the live usage directory. Retain additive D1 data and separate credentials. Wrangler rollback may require explicit confirmation after the Azure secret was added; preserved legacy secret names and backed original Node credentials support the old pair, but rollback has not been executed. `WEB_VOICE_TRANSPORT` is not an admission-off fence in managed Web.

Restricted backups, original failed probes, usage ledgers, provider audio and safe diagnostics are retained outside Git. No additional paid requests or production changes were made during this documentation closeout.

## Historical pre-rollout checkpoint — 2026-10-07

The managed business application and direct Azure Mini voice path are merged through `963dc4b1e8cf8096418a3c36bb7843446495c967`. Bounded actual staging acceptance supports the authorized **owner-testing** production rollout. Production is still on the previous release at this preflight checkpoint; deployment and the separately authorized production smoke remain to be verified.

| Item | Production before rollout | Verified staging candidate |
| --- | --- | --- |
| Application source | `ab0dcd5a5893c4e823c16e5e1a453748f0813f91` | `963dc4b1e8cf8096418a3c36bb7843446495c967` |
| Worker version at 100% | `a2787074-d3e2-42c7-a862-19c30033bff2` | `14e2d64f-b96e-480e-a784-e319c4b62ccf` |
| Node image | `sha256:dbdbde5cde5c5f9282fa4d45e6d20120440e3e3c4bfd7bd3b059e161eebdce4f` | `sha256:8bfde55695150b015a811c408c5f74b87d50e1bdd0ca13ee87c5e7b711336227` |
| Inference | Prior Kataleptic routing | Direct Azure `gpt-realtime-2.1-mini`; delegated/post-call `gpt-5.4-mini` |
| Managed edition | Not enabled | Enabled; no customer routing controls |
| Signaling | `wss://voice.openfon.ai` | `wss://voice-staging.openfon.ai` |
| D1 migrations | 0001–0025 | 0001–0023, 0025–0027; no 0024 |
| Schedule | Every five minutes | Disabled |
| New charging / phone purchases / carrier ingress | Disabled | Disabled |

The staging Node image identifies reviewed `314215780f52ea55bf005a3618791ca2b0c8000e`, whose tree equals merged `963dc4b`. Its full image configuration and all nine filesystem layers match the built image across Docker implementations. Actual runtime checks confirm the exact voice/text pins, staging callback, separate credential identities, `LK_OPENAI_DEBUG=0`, no trace overlay or `NODE_OPTIONS`, and a writable persistent usage directory owned by UID 1000 with mode 0700. After the last call, both environments had zero calls/rooms, health 200 and zero agent restarts; staging had no queued or dead usage observations.

### Reviewed changes and actual staging evidence

PRs [48](https://github.com/duguetlabs/openfon/pull/48), [49](https://github.com/duguetlabs/openfon/pull/49), [50](https://github.com/duguetlabs/openfon/pull/50) and [51](https://github.com/duguetlabs/openfon/pull/51) are merged with genuine PR-Agent security/major clearance and local Codex clearance. PR51 CI `37537905958` passed all five jobs; deployment was skipped. Latest full validation passed 2,334 Worker tests in 103 files, 143 Node tests, both TypeScript projects, both builds and the migration-0027 rehearsal.

The summary request now labels its unchanged serialized transcript as JSON input, correcting an observed Azure HTTP 400. Successful Mini `end_call` avoids an SDK-generated competing reply before the application-owned goodbye. Safe initiating-error diagnostics retain bounded categories, status and hashes without raw error messages, credentials or transcripts; diagnostics are not a reliability fix.

Six bounded staging calls used synthetic prerecorded caller audio through actual Azure and native RTC. The latest exact candidate completed a German call in 67 seconds with correct arithmetic, caller/contact details, summary, callback action, nonzero audio and measured final observations for realtime, transcription, delegated reasoning and post-call text. Its original harness exited 1 because a global farewell count included a farewell before a later caller confirmation. That failure remains retained; separate offline verification found one farewell after the final caller and no repeated opening greeting.

A separately scoped exact-candidate call deliberately began input 999.69 ms after the first nonzero client-received greeting audio. The server recorded an interrupted greeting, then continued through correct arithmetic, callback/contact/summary persistence and a normal stop in 59 seconds. The harness and safe log collector exited 0; the owned test account was deleted. It used the allowed caller follow-up, with two `end_call` requests in different caller phases and one final-phase goodbye. One reasoning acknowledgement was spoken in English during this German fixture. Client enqueue timing does not establish provider speech-onset timing. Measured software PCM is not physical audibility or subjective voice identity.

Two earlier calls failed after their greetings, including one clean run without trace instrumentation. Their initiating causes were not captured and remain unknown; the latest calls did not reproduce them. An earlier answer was 390 instead of 391, also without enough retained reasoning evidence to identify its cause. Successful later calls do not establish a reliability repair. Preserve all original failures and their source attribution. Staged account creation, assistant save, call, persistence and owned-account deletion now have actual API evidence; the older Python-client 403 before account creation remains a separate failed setup attempt.

### Production procedure and preservation

The authorized rollout is for owner testing with billing verification, charging, phone purchasing and carrier ingress disabled. Before changing production: verify fresh call/room vacancy, export to a restricted backup, restore locally with integrity and foreign-key checks, and rehearse exact additive migrations 0026/0027 while comparing every old column/row. Preserve existing assistants, credentials, public links and historical migration 0024; never replay that data rewrite.

Use the previously verified transactional file-import path only: exact reviewed migration 0026, its standard `d1_migrations` insertion, exact migration 0027 and its insertion. The ordinary remote migration query path previously failed twice with SQLite “incomplete input”; both failures rolled back and remain retained. The successful staging file import preserved all old columns/rows across 20 tables except the two intended ledger additions. A staging result is not a production backup or import verification.

After fresh backup and rehearsal, use bounded maintenance with fresh vacancy, preserve the recoverable production Worker/Node/configuration pair, import the reviewed file once, and independently verify integrity, foreign keys, old data, action projections and migration markers. Canonical Worker deployment is **`npm run deploy`**, using `wrangler.production.json` and `scripts/deploy-managed.mjs`; never a naked Wrangler deployment. It validates state bindings, migration markers and secret names but does not apply migrations. Pair it with the reviewed immutable Node image and verify the actual running image, revision, pins, credentials, usage mount, health and callback. The production managed schedule is every minute; staging remains unscheduled.

`WEB_VOICE_TRANSPORT` is **not** an admission-off fence for managed Web. Do not treat a flag flip as a drain. Restore a compatible Worker/Node/configuration pair after confirming vacancy if rollout checks fail; retain additive database data and separate credentials. A single separately authorized cached-English production call, capped at 90 seconds with no new preview or text diagnostic, will verify the deployed owner-test path. No production audio result is claimed yet.

### Remaining acceptance

Physical microphone/playback, smart-glasses restaurant noise, subjective voice identity, repeated physical-device calls, all voices, anonymous public-link calling and PSTN remain unverified for this candidate. LiveKit debug audio recording remains unimplemented. Dodo recurring invoices/meter lifecycle and actual carrier acceptance are separate gates; no customer charges or phone purchases are authorized by this owner test. See [billing evidence](../commercial/billing-and-costs.md) and [readiness](readiness.md).

## Historical deployment evidence — 2026-10-03

This section records the October 3 baseline. Its production identity is the pre-rollout baseline; its staging identity and then-current acceptance blockers are superseded by the current section above. PR #42 was merged and deployed to staging and production. Cloudflare retains application and state authority; separate self-hosted Azure LiveKit and Node services carry audio to Kataleptic. The released interface, accounts, saved configurations and public links are preserved. This deployment does not include the separate editions/redesign prototype.

| Item | Production | Staging |
| --- | --- | --- |
| Application source | `ab0dcd5a5893c4e823c16e5e1a453748f0813f91` | `ab0dcd5a5893c4e823c16e5e1a453748f0813f91` |
| Worker version at 100% | `a2787074-d3e2-42c7-a862-19c30033bff2` | `5d8b2f2f-aa5b-466c-adaf-929bdc947bcf` |
| Voice transport flag | `livekit` | `livekit` |
| Signaling | `wss://voice.openfon.ai` | `wss://voice-staging.openfon.ai` |
| D1 migrations | 0001–0025 | 0001–0023 plus 0025; no 0024 |
| Scheduled cleanup | Every five minutes | Disabled |
| Telnyx / Asterisk | Disabled | Disabled |

Production deployed at `2026-10-03T09:12:32Z`. Cloudflare readback verified the source, Worker version, transport flag, fixed signaling URL, original database binding and exact built index bytes. Root, sign-in and health returned 200; signed-out account access returned 401. The native in-app browser verified the public landing and sign-in screens.

Both Azure agents run image `sha256:dbdbde5cde5c5f9282fa4d45e6d20120440e3e3c4bfd7bd3b059e161eebdce4f`, built from reviewed `ccf62ba`. Its source tree is identical to merged `ab0dcd5`; the squash did not require rebuilding runtime code. Separate environment credentials, fixed callback origins and the pinned LiveKit service remain in place. Azure is a single VM; certificate renewal can restart the SFUs and interrupt calls. See [operations](../../voice-agent/deploy/README.md).

### Release and data preservation

- Final PR CI `37111486710` and merged-source CI `37111794546` passed. Genuine PR-Agent reported no security concerns and no major issues; independent local Codex review was clear. Final local checks passed 2,061 root tests in 86 files, both TypeScript projects and build, plus 34 Node tests and build.
- Exact reviewed runtime source passed a staged real-provider typed conversation: audio, one unchanged caller row, final transcripts, summary/callback extraction, goodbye and automatic closure. The merged tree is identical. Startup readiness took 25.2 seconds in that run; a preceding run took 2.7 seconds. These observations do not establish consistent latency; [issue #43](https://github.com/duguetlabs/openfon/issues/43) tracks this.
- Fresh production backup restored with integrity `ok`, zero foreign-key violations and zero active calls. Local additive-0025 rehearsal preserved all old-column fingerprints across 20 tables. Backup SHA256: `04c194bf8b51e8b7128b9e83489f5ee3a9450a8fb05166dd35ccc04066795c0e`.
- Only additive migration 0025 was applied. The initial Wrangler invocation failed with `fetch failed`; independent database reads confirmed it had applied neither columns nor marker. The same reviewed SQL then succeeded through the D1 query API. Three new columns, migration marker and zero foreign-key violations were verified. Original logs remain retained. Do not repeat this migration or blanket-apply staging's historical 0024: that migration rewrites saved model choices.
- The first production typed-call probe completed with audio, saved primary input, summary/callback details and goodbye, but **failed** its strict expected-row assertion. It attempted a second input after a 16-second wait without recording admission. The saved primary input appears exactly once; this does not establish loss of admitted input. The original failure remains recorded in [readiness](readiness.md#livekit-production-release-2026-10-03). Both environments were healthy with zero rooms/jobs afterward.

- A separate corrected production smoke passed against the unchanged deployed source: one initial typed command with no fallback, one unchanged caller row, three assistant rows, actual output PCM, saved summary/callback details, goodbye and automatic closure. Duration was 25 seconds and client readiness 4.47 seconds. The test account was deleted. This establishes bounded owner test-call acceptance, not physical microphone or all-voice acceptance. The original failing run remains retained.

### Rollback and remaining limits

For that historical non-managed release, transport selection preceded draining. In managed Web, `WEB_VOICE_TRANSPORT` does not disable admission; use the current bounded-maintenance procedure above before stopping the corresponding agent/SFU. Retain current callback-capable code, separate credentials and additive transcript columns so admitted calls can finish authenticated flush. Do not roll back to old code without callback support while calls remain active. Saved configurations and credentials must remain intact.

Debug audio recording is not implemented for the new LiveKit transport; transcripts persist. Physical microphone/noise, subjective voice identity, all-voice and carrier acceptance remain separate. The native iOS source is merged and verified, but TestFlight signing/upload is blocked on the operator unlocking the Mac and completing Xcode Apple authentication. No installable build is claimed.

Restricted backups, original failures, provider audio and deployment records are retained outside Git under `~/.local/share/openfon-audits/2026-10-03-livekit/`. Credentials are excluded from this document. Current acceptance details are in [readiness](readiness.md#livekit-production-release-2026-10-03).

## Historical application deployment — 2026-09-30

The browser application is live at **https://openfon.ai** through Cloudflare.
This launch and production deployment were explicitly authorized. Telephone
carrier activation remains separate and disabled. Dates use Europe/Vienna.
Cloudflare records the production deployment at `2026-09-29T23:40:46Z`, which
is **2026-09-30 01:40:46 CEST**. GitHub's UTC date is therefore the previous day;
the local verification date above is not a future deployment claim.

| Item | Production | Staging |
| --- | --- | --- |
| Worker | `openfon` | `openfon-staging` |
| Application source | `debd746557e4037c9e12bcf623783c5da8965f04` | `debd746557e4037c9e12bcf623783c5da8965f04` |
| Version at 100% | `4788a875-29ee-4bc4-8e92-43948c3b4543` | `20bdd7b2-6fd8-4981-aedb-b69ec1ac81c8` |
| D1 migrations | 0001–0024 | 0001–0023 |
| Test-call debug recording | Disabled | Enabled |
| Realtime / transcription defaults | HD / `gpt-transcribe` | HD / `gpt-transcribe` |
| Pipeline speech | Azure | Browser |
| Telnyx / Asterisk | Disabled | Disabled |
| Scheduled cleanup | Every five minutes | Disabled |

### Verification and rollback

- PR #40 fixes a Pipeline response that asked a question and nevertheless
  requested immediate hangup. Both genuine PR-Agent security/major-issue and
  independent local Codex reviews cleared the candidate. All PR CI jobs and
  merged-commit CI `36646025773` passed. Local validation passed 2,016 tests,
  both TypeScript projects and build. The merged tree equals the reviewed tree.
- Exact merged source was deployed to staging first. Actual German and English
  Pipeline calls passed the corrected assertions: the initial answer leaves the
  call open, both caller turns are saved, and closing follows the goodbye.
  Earlier baseline/failed probes retain their original attribution in
  [readiness](readiness.md).
- Fresh pre-rollout backups of both D1 databases restored locally with integrity
  `ok` and zero foreign-key violations. Active calls were zero before each
  deployment. No remote D1 or Durable Object migration was applied. Staging's
  historical data-only 0024 remains unapplied; saved provider choices were not
  rewritten.
- Cloudflare readback confirms source/version and unchanged database bindings,
  Durable Object namespaces, secret names, provider defaults, debug/carrier
  flags, schedules and observability. Rollback to the pre-release Worker uses
  production `6276cdac-3c6d-4b9e-96e5-6cba3cf5d8b1` or staging
  `88453f1c-9d34-4099-a568-c8100efc94c8` (source `d6f3d3f`). No database
  restore is needed for this code-only rollback.
- `openfon.ai` is bound to the production Worker. Authoritative DNS and public
  resolvers return its Cloudflare addresses. TLS validates for the hostname;
  HTTP redirects to HTTPS. Seven built HTML/JS/CSS/font/robots/sitemap assets
  match the deployed bytes. Canonical, social-image and sitemap URLs use
  `https://openfon.ai`; the GitHub `OPENFON_PUBLIC_URL` variable matches.
- Health and sign-in return 200; signed-out account requests return 401; both
  disabled carrier routes return 503. Six real-provider calls through the new
  hostname passed: HD, GPT-Live and Azure Pipeline in English and German, with
  configured voices, canonical hours, a later caller goodbye, audio and completed
  records. Pipeline playback acknowledgements were paced by decoded MP3 duration.
  Synthetic accounts were deleted through the normal account API.
- The operator's hotspot resolver initially retained the pre-registration
  NXDOMAIN result. Domain probes used the independently verified public DNS
  address while retaining hostname/TLS verification. This establishes public
  deployment and API/WebSocket acceptance; native browser inspection through
  that stale resolver remained pending at the time of the launch record.

Private backups, audio, original failures and verification records are retained
outside Git under `~/.local/share/openfon-audits/2026-09-30-launch/`. These probes
use synthetic caller audio and software playback acknowledgements. Physical
smart-glasses/restaurant noise, acoustic echo, perceived voice identity,
arbitrary BYOK providers and SIP/PSTN acceptance remain separate.

## Historical rollout — 2026-09-28

Both environments now serve the reviewed Brand Identity release from PR #39.
The user explicitly authorized this staged-then-production deployment. Dates below use Europe/Vienna.

| Item | Production | Staging |
| --- | --- | --- |
| Worker | `openfon` | `openfon-staging` |
| Source | `d6f3d3f7f5b128909f7d29d61f2926efb90e2d7c` | `d6f3d3f7f5b128909f7d29d61f2926efb90e2d7c` |
| Version at 100% | `6276cdac-3c6d-4b9e-96e5-6cba3cf5d8b1` | `88453f1c-9d34-4099-a568-c8100efc94c8` |
| Deployed | 2026-09-28 | 2026-09-28 |
| D1 migrations | 0001–0024 | 0001–0023 |
| Test-call debug recording | Disabled | Enabled |
| Realtime default | `kataleptic-realtime-hd` | `kataleptic-realtime-hd` |
| Transcription default | `gpt-transcribe` | `gpt-transcribe` |
| Pipeline speech default | Azure | Browser |
| Telnyx / Asterisk | Both disabled | Both disabled |
| Scheduled cleanup | Every five minutes | Disabled |

### Release verification and rollback

- Exact merged-source CI `36364626590` passed. PR #39's reviewed tree matches
  the merged tree; genuine PR-Agent security/major-issue clearance and local
  Codex clearance passed. Final local validation includes 2013 unit tests,
  both TypeScript projects, build, 169 browser tests, synthetic runtime checks,
  migration rehearsal, scoring and realtime checks.
- Fresh staging and production D1 exports were captured with restricted logs,
  restored locally, and passed integrity `ok` with zero foreign-key violations.
  Active calls were zero immediately before each deployed environment's update.
- No remote migration or configuration cleanup was run. This release needs no
  new schema or Durable Object migration. Staging's pending 0024 is data-only
  and was deliberately not applied: its old rewrite would clear valid GPT-Live
  selections as well as retired values.
- Fresh aggregate checks found no incompatible active/default configuration and
  no production candidates. Staging retains one retired Kataleptic cascade
  preset and its matching legacy profile. Applying that saved preset now gives
  the intended explicit compatibility error; the stored rows were preserved.
  The prior release's silent runtime-retirement fallback is no longer current.
- Staging and production: root, sign-in and health returned 200; signed-out account
  returned 401; disabled Telnyx and Asterisk ingress returned 503. Exact built
  HTML, JS, CSS and both brand fonts matched the public response bytes.
- Cloudflare readback confirms the release SHA and version, unchanged D1/DO
  bindings and secret names, provider defaults, debug/carrier flags, schedules,
  compatibility settings and observability. No provider or carrier call was made.
- Native in-app browser inspection passed on staging: the signed-in reception
  desk renders the approved identity, inset selector, brief, voices, messages,
  rehearsal and staging-only debug disclosure. Production welcome and sign-in
  also passed native visual inspection; both environments had no browser console
  errors. No credentials, account writes or calls were used.
- Rollback targets immediately before this rollout: production
  `0cafc4f0-5b51-42b3-82a2-f9f9e5e8dc0c`, staging
  `adc67113-4005-416f-9413-af81a0d10e63`, both source `804e6f4a522808c71c9dfa7ec1035f9e32e2e001`.
  There are no database changes to reverse for a Worker rollback.

Restricted backups and credential-free rollout/configuration verification
records are retained outside Git in
`~/.local/share/openfon-releases/2026-09-28-d6f3d3f/`.
Deployment verification does not establish new live-provider, physical-audio,
interruption or PSTN acceptance; those remain in [readiness](readiness.md).

## Historical rollout — 2026-09-27

At that rollout, both environments served reviewed source `804e6f4a522808c71c9dfa7ec1035f9e32e2e001`
(UI redesign #37 and verified GPT-Live voices #38). The exact candidate was
validated on staging before production deployment. Dates below use Europe/Vienna.

| Item | Production | Staging |
| --- | --- | --- |
| Worker | `openfon` | `openfon-staging` |
| Source | `804e6f4a522808c71c9dfa7ec1035f9e32e2e001` | `804e6f4a522808c71c9dfa7ec1035f9e32e2e001` |
| Version at 100% | `0cafc4f0-5b51-42b3-82a2-f9f9e5e8dc0c` | `adc67113-4005-416f-9413-af81a0d10e63` |
| Deployed | 2026-09-27 | 2026-09-27 |
| D1 migrations | 0001–0024 | 0001–0023 |
| Test-call debug recording | Disabled | Enabled |
| Realtime default | `kataleptic-realtime-hd` | `kataleptic-realtime-hd` |
| Transcription default | `gpt-transcribe` | `gpt-transcribe` |
| Pipeline speech default | Azure | Browser |
| Telnyx / Asterisk | Both disabled | Both disabled |
| Scheduled cleanup | Every five minutes | Disabled |

### Release verification and rollback

- Exact-source main CI `36276229997` passed; #38's final PR CI
  `36275931429` and both genuine reviews passed. Local final validation:
  1939 tests, both TypeScript projects and build; two targeted Chrome/workerd
  picker tests passed. #37 also passed its review and CI gates before merge.
- Fresh exports of both databases restored locally with integrity `ok` and zero
  foreign-key violations. No remote migrations or data-cleanup SQL were run.
  Staging's pending 0024 changes stored model selections only; it adds no schema
  needed by this release. Runtime model-retirement compatibility remains active.
- Staging then production: root/sign-in/health returned 200; signed-out account
  returned 401; POST to the disabled Telnyx webhook returned 503. An initial
  GET probe used the wrong method and returned 404; the POST check passed.
- Public JS and CSS bytes matched the reviewed local build in both environments.
  Cloudflare readback confirmed source/version, unchanged D1 bindings, Durable
  Object namespaces, secret names, debug flags and disabled carriers. Production
  retained its cleanup schedule; staging retains no schedule.
- Native Chrome inspection confirmed the production landing page renders the
  cleaner layout and Dr. Gruber example. Staging landing/sign-in rendered; exact
  assets were verified after deployment. These are deployment checks, not new
  authenticated voice, microphone, interruption or PSTN acceptance.
- Prior production version: `3e9e542a-1646-431e-8dae-99be37b733c8`.
  Prior staging version: `4b04184e-1de2-4eda-940e-17579b3a1c4e`.
  No database changes need reversal for a Worker rollback. Restore the prior
  staging defaults too if rolling that environment back to its older code.

Restricted backups and credential-free deployment/configuration verification
records are retained outside Git in
`~/.local/share/openfon-releases/2026-09-27-804e6f4/`.
The environments still have separate databases and Durable Objects. Component
BYOK and independent summaries are in both; debug recording remains staging-only.
The earlier GPT-Live rollout skipped staging, but this release did not.
Outstanding provider/physical-call acceptance stays in [readiness](readiness.md).

## Historical preflight evidence — 2026-09-12

The observations below describe their original checks, not current deployments
or pending migrations. Use the current-state table above for release status.

Read-only inspection on 2026-09-12, Europe/Vienna. No remote migration, deployment, secret update, or call was performed. Authentication used the personal project’s scoped `direnv`/`dsecret` environment. Secret values were not read or printed.

### Verified state at the original inspection

- Existing Worker: `openfon`; account Workers subdomain: `duguetlabs`. Worker subdomain and version previews are enabled. No custom domain is attached to this Worker in the account API.
- Latest deployment listed: 2026-07-06T22:31:20.621Z, version `289e186d-34b2-46b4-8c34-d58e233b69b3`, 100% traffic. Recheck immediately before any release or rollback.
- Existing D1 binding: `openfon`. Remote migration listing reports `0007_abuse_limits.sql` and `0008_calm_studio_foundation.sql` pending.
- Worker secret names present: `AZURE_SPEECH_KEY`, `DEFAULT_LLM_API_KEY`, `DEFAULT_STT_API_KEY`. Presence does not establish validity. No separate `REALTIME_API_KEY` name was listed; source can use the default LLM key for realtime.
- Repeated HTTP probes to `https://openfon.duguetlabs.workers.dev/` returned 200 (`text/html`) with browser user agent `Mozilla/5.0 OpenFon-Launch-Check`; `/api/me` returned the expected unauthenticated 401 (`application/json`). Both requests returned 403 with `Python-urllib/3.9`. Public browser access is therefore established at the HTTP level; a deployed authenticated session or provider conversation has not been tested.
- The separately scoped local Kataleptic credential preflight returned403 from the model catalog. This does not establish the validity of the existing Worker’s secret values, which were not fetched.

### Requirements before that rollout

Confirm final hostname/operator identity, verify provider access and the deployed authenticated flow, obtain required reviews, then back up D1 into a restricted location and rehearse migration/rollback before changing production. Do not use this stale deployment version as an automatic rollback target without a fresh check.

### Integration refresh, 2026-09-12

Scoped Cloudflare API reads reconfirmed the personal account, `duguetlabs` Workers subdomain, one D1 database (`openfon`) and unchanged deployed version `289e186d-34b2-46b4-8c34-d58e233b69b3` at 100%. Remote migration listing now includes 0007, 0008 and 0009 pending, matching the integration checkout.

A restricted production SQL backup was exported outside the repository and restored **locally** to SQLite. Applying 0007–0009 preserved legacy configuration, completed call history and public slugs; integrity and foreign-key checks passed before/after. A restricted upgraded binary snapshot was also created. This is stronger than a fictional-data rehearsal but does not verify Cloudflare staging D1, Worker rollback, live providers or a telephone call. No remote migrations or Worker deployment were run. Database contents and local backup paths are not committed; obtain a fresh backup before deployment.


### Separate staging acceptance evidence

The restricted production export was restored into Cloudflare D1 `deployment-ref:2cb0ae33-3897-4c20-be55-67eeb8324f8c` (`e1d93b7d-9024-447a-ae25-6b1e5ed298b3`) and upgraded through 0011. Original-column fingerprints for businesses/settings/presets/completed calls/transcripts and all public slugs matched; foreign-key and quick checks passed. After verification, copied assistants and carrier routes were disabled and copied sessions cleared in staging only.

Worker `openfon-staging` was deployed from `41041c1a3425c1c0ff90697917ce39cdb2394e7a` to version `8439378c-eeda-4fb7-83e5-a01a2f986fb0`, 100% traffic, with the separate D1 binding and separate Durable Objects. Both carrier flags are false and cron is disabled. At `https://openfon-staging.duguetlabs.workers.dev`, root returned 200, signed-out `/api/me` 401, and both carrier endpoints 503 disabled. The V2 webhook path is `/api/telnyx/webhooks`; no real routing was enabled. Configured origin/version/binding/flags were independently read back from Cloudflare.

This does not establish authenticated staging/browser audio, a real AI provider, SIP/PSTN calling, or production launch approval. Production's Worker and database migrations were not changed.


### Historical staging readback and bounded live evidence

At that check, staging ran source `b15ed8769fc798e84a7721d76179fb51ea3bf560`, Worker version `deployment-ref:b9673df2-30d1-4b25-97ca-e1f19c124449`, at 100%, with the same separate rehearsal database through migration0012. Its business/call/turn fingerprints remained exactly unchanged across the latest upgrade; integrity and foreign-key checks passed. Release SHA, binding, secret names and both disabled carrier flags were read back independently; HTTP root200, signed-out account401 and carrier503 checks passed. No production migration or deployment occurred.

The earlier staging-only credential setup enabled real Kataleptic browser audio with a disclosed synthetic caller. Both the [original failed acceptance](demo/audible/README.md) and the [corrective hours/phone acceptance](demo/corrected/README.md) remain preserved with their exact historical staging versions. The corrective call verifies canonical hours, null-phone handling and persisted summary/message; interruption follow-up remains inconclusive due capture sequencing. These recordings establish neither physical-microphone nor SIP/PSTN acceptance. Current review corrections are local and do not change the staged source or original artifacts; see the [release checklist](readiness.md) for remaining acceptance.
