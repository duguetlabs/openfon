# Production preflight

## Current deployment — 2026-10-05

The managed business application is merged and deployed to **staging**. Production continues to run the previous Kataleptic-backed release. Production's switch to direct Azure is held until a bounded actual provider/audio acceptance succeeds; staging health and synthetic tests do not establish that acceptance.

| Item | Production — unchanged | Staging — managed release |
| --- | --- | --- |
| Application source | `ab0dcd5a5893c4e823c16e5e1a453748f0813f91` | `24ab5b7b6297c429c1e0d7dd261060342b559579` |
| Worker version at 100% | `a2787074-d3e2-42c7-a862-19c30033bff2` | `e313a2ad-27d3-4045-bbdc-75bf0c4c7a86` |
| Managed edition | Not enabled | `OPENFON_MANAGED_WEB=true` |
| Voice transport | LiveKit | LiveKit |
| Inference | Prior Kataleptic routing | Direct Azure configuration |
| Signaling | `wss://voice.openfon.ai` | `wss://voice-staging.openfon.ai` |
| D1 migrations | 0001–0025 | 0001–0023, 0025–0027; no 0024 |
| Schedule | Prior five-minute cleanup | Disabled |
| Billing verification / new charging | Not enabled | Not enabled |
| Telnyx / Asterisk / number purchases | Disabled | Disabled |

Staging deployed at `2026-10-05T03:28:18Z`. Readback verified its exact source, version, managed/Azure bindings and separate signaling URL. Existing LiveKit and callback credential identities were preserved; the operator Azure key was provisioned only to staging. Historical saved routing and credentials remain stored. Previously blank voice fields retain their established effective Marin choice without a database rewrite; explicit incompatible voices still require a customer choice.

Staging Node runs OCI manifest `sha256:839aff34d31c8c8a6a09f63ad54643500f1005674d9f5c1e5dfa40c5791c1a08`, whose configuration digest is the original local image ID `sha256:8e609e13082616c40704f1b79b32ae430eaa6fdb6eb31f0868994305aa4a2748`. The saved archive's manifest/configuration hash chain, all nine filesystem layers and runtime configuration were verified across Docker implementations. Its `238c8fe` voice-agent source is unchanged in the deployed application tree. Post-start inspection confirmed health 200, zero restarts, matching credential identities, the staging callback, `LK_OPENAI_DEBUG=0`, and a writable persistent usage directory owned by UID 1000 with mode 0700. Production's previous `dbdbde5c…` image and original start time were unchanged.

### Release gates and staging validation

[PR45](https://github.com/duguetlabs/openfon/pull/45) and the [migration compatibility fix, PR46](https://github.com/duguetlabs/openfon/pull/46), are merged. Latest application checks passed 2,316 Worker tests across 101 files, 60 Node tests, both TypeScript projects, both builds and the migration/restore rehearsal. Genuine PR-Agent security/major clearance and local Codex clearance were obtained. PR CI `37258566059` and merged-source CI `37258837051` passed all five jobs; automatic production deployment was skipped.

The native in-app browser verified Home, the loaded actionable inbox and source-call links, historical Call logs and filters, all Settings sections, compatible voice labels/sample control, and monthly/annual plan displays. Annual prices showed €204/€696/€2,508 upfront excluding VAT. Checkout and phone purchasing remained unavailable. This used the existing account read-only: no saves, logout, preview, conversation or payment occurred.

The separate disposable-account HTTP smoke was **blocked before account creation** by Cloudflare HTTP 403/error 1010 for the Python client. No accounts were created or left for cleanup. No client impersonation or security-setting change was used. This leaves staged account-create/save/delete API acceptance unverified; local/CI coverage remains separate. Final reads found zero active calls and zero LiveKit rooms in both environments, healthy agents, and zero staging provider-usage observations. Actual Azure authentication, transport, nonzero audio, selected voice, transcript/summary/action persistence and graceful closure are still required before production routing changes. Physical microphone/noise and carrier acceptance remain separate.

### Migration procedure and preservation

The ordinary remote `wrangler d1 migrations apply` path failed twice with SQLite “incomplete input”; each failure rolled back without new columns, objects or migration markers. PR46 corrects a local Wrangler splitter incompatibility around CASE/END punctuation, but that does **not** establish compatibility with the separate remote REST query parser. Preserve both failures as failures.

The successful staging procedure used the supported transactional **file import** path: `wrangler d1 execute <staging-database> --remote --config <reviewed-staging-config> --file <restricted-reviewed-script>`. The script contained the exact reviewed bytes of migration 0026, its standard `INSERT INTO "d1_migrations" (name) values ('0026_business_actions.sql');`, then migration 0027 and its corresponding ledger insertion. It included no historical migrations or SQL semantic rewrites. Verify the target, pending markers, fresh backup and absence of active calls/rooms before any authorized use; never reapply this pair where its markers already exist. The file-import mechanism documents rollback to the original database on failure; verify actual state after any failure rather than assuming it.

The fresh pre-import staging backup restored with integrity `ok` and zero foreign-key violations. Local combined-script rehearsal and the post-import export verified all original columns/rows across 20 tables, except exactly the two expected migration-ledger additions. Both action-projection triggers and the intended failed-booking descriptions were checked. Backup SHA256: `ec3715d5fb0c70177da04ce170052e439d2cdf012a65a21133b6353784b36918`; combined script: `6dacb1d1d906b37e8484fd63da8c3aa268b810e555a65e0f7ed077131ed8bab7`; post-import export: `31e11d05c59b903b7cd1b1d35705a6da197401c9bad7ddf876a5373fda052bd7`. Original logs, restricted backups and recoverable pre-update service configurations are retained outside Git. Migration 0024 was not applied to staging.

### Production gate and rollback

Canonical production deployment remains `npm run deploy`, using `wrangler.production.json` and `scripts/deploy-managed.mjs`. It verifies managed/Azure routing, unchanged state bindings, required migration markers and secret names; it never applies migrations. `npm run deploy:check` and the script's `--dry-run` do not deploy. Production still needs its own fresh backup, authorized migration procedure, paired Worker/Node update and actual acceptance evidence. Do not treat a naked `wrangler deploy` as the production release command.

Restore a compatible Worker/Node/configuration pair after draining calls; retain all additive data and separate credentials. Old staging service configurations and images remain recoverable. The production managed schedule, when released, runs every minute for bounded commercial maintenance; the staging schedule remains disabled.

Keep `COMMERCIAL_BILLING_VERIFIED`, new charging and phone purchase gates off until their separate invoice/meter/lifecycle and carrier acceptance passes. A sandbox card checkout does not prove accurate recurring usage invoices. See [billing evidence](../commercial/billing-and-costs.md) and [managed product](../managed-web.md). No physical microphone, real Azure audio or PSTN acceptance is inferred from this deployment.

## Historical deployment evidence — 2026-10-03

This section records the October 3 baseline. Its production identity remains current; its staging identity and then-current acceptance blockers are superseded by the current section above. PR #42 was merged and deployed to staging and production. Cloudflare retains application and state authority; separate self-hosted Azure LiveKit and Node services carry audio to Kataleptic. The released interface, accounts, saved configurations and public links are preserved. This deployment does not include the separate editions/redesign prototype.

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

Disable new LiveKit admission using `WEB_VOICE_TRANSPORT`, then drain before stopping the corresponding agent/SFU. Retain current callback-capable code, separate credentials and additive transcript columns so admitted calls can finish authenticated flush. Do not roll back to old code without callback support while calls remain active. Saved configurations and credentials must remain intact.

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
