# Production preflight

## Current deployment state — verified 2026-09-30

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
