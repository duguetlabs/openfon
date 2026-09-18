# Production preflight

Read-only inspection on 2026-09-12, Europe/Vienna. No remote migration, deployment, secret update, or call was performed. Authentication used the personal project’s scoped `direnv`/`dsecret` environment. Secret values were not read or printed.

## Verified state

- Existing Worker: `openfon`; account Workers subdomain: `duguetlabs`. Worker subdomain and version previews are enabled. No custom domain is attached to this Worker in the account API.
- Latest deployment listed: 2026-07-06T22:31:20.621Z, version `289e186d-34b2-46b4-8c34-d58e233b69b3`, 100% traffic. Recheck immediately before any release or rollback.
- Existing D1 binding: `openfon`. Remote migration listing reports `0007_abuse_limits.sql` and `0008_calm_studio_foundation.sql` pending.
- Worker secret names present: `AZURE_SPEECH_KEY`, `DEFAULT_LLM_API_KEY`, `DEFAULT_STT_API_KEY`. Presence does not establish validity. No separate `REALTIME_API_KEY` name was listed; source can use the default LLM key for realtime.
- Repeated HTTP probes to `https://openfon.duguetlabs.workers.dev/` returned 200 (`text/html`) with browser user agent `Mozilla/5.0 OpenFon-Launch-Check`; `/api/me` returned the expected unauthenticated 401 (`application/json`). Both requests returned 403 with `Python-urllib/3.9`. Public browser access is therefore established at the HTTP level; a deployed authenticated session or provider conversation has not been tested.
- The separately scoped local Kataleptic credential preflight returned403 from the model catalog. This does not establish the validity of the existing Worker’s secret values, which were not fetched.

## Still required

Confirm final hostname/operator identity, verify provider access and the deployed authenticated flow, obtain required reviews, then back up D1 into a restricted location and rehearse migration/rollback before changing production. Do not use this stale deployment version as an automatic rollback target without a fresh check.

## Integration refresh, 2026-09-12

Scoped Cloudflare API reads reconfirmed the personal account, `duguetlabs` Workers subdomain, one D1 database (`openfon`) and unchanged deployed version `289e186d-34b2-46b4-8c34-d58e233b69b3` at 100%. Remote migration listing now includes 0007, 0008 and 0009 pending, matching the integration checkout.

A restricted production SQL backup was exported outside the repository and restored **locally** to SQLite. Applying 0007–0009 preserved legacy configuration, completed call history and public slugs; integrity and foreign-key checks passed before/after. A restricted upgraded binary snapshot was also created. This is stronger than a fictional-data rehearsal but does not verify Cloudflare staging D1, Worker rollback, live providers or a telephone call. No remote migrations or Worker deployment were run. Database contents and local backup paths are not committed; obtain a fresh backup before deployment.


## Separate staging acceptance evidence

The restricted production export was restored into Cloudflare D1 `deployment-ref:2cb0ae33-3897-4c20-be55-67eeb8324f8c` (`e1d93b7d-9024-447a-ae25-6b1e5ed298b3`) and upgraded through 0011. Original-column fingerprints for businesses/settings/presets/completed calls/transcripts and all public slugs matched; foreign-key and quick checks passed. After verification, copied assistants and carrier routes were disabled and copied sessions cleared in staging only.

Worker `openfon-staging` was deployed from `41041c1a3425c1c0ff90697917ce39cdb2394e7a` to version `8439378c-eeda-4fb7-83e5-a01a2f986fb0`, 100% traffic, with the separate D1 binding and separate Durable Objects. Both carrier flags are false and cron is disabled. At `https://openfon-staging.duguetlabs.workers.dev`, root returned 200, signed-out `/api/me` 401, and both carrier endpoints 503 disabled. The V2 webhook path is `/api/telnyx/webhooks`; no real routing was enabled. Configured origin/version/binding/flags were independently read back from Cloudflare.

This does not establish authenticated staging/browser audio, a real AI provider, SIP/PSTN calling, or production launch approval. Production's Worker and database migrations were not changed.


## Latest staging readback and bounded live evidence

Staging now runs source `b15ed8769fc798e84a7721d76179fb51ea3bf560`, Worker version `deployment-ref:b9673df2-30d1-4b25-97ca-e1f19c124449`, at 100%, with the same separate rehearsal database through migration0012. Its business/call/turn fingerprints remained exactly unchanged across the latest upgrade; integrity and foreign-key checks passed. Release SHA, binding, secret names and both disabled carrier flags were read back independently; HTTP root200, signed-out account401 and carrier503 checks passed. No production migration or deployment occurred.

The earlier staging-only credential setup enabled real Kataleptic browser audio with a disclosed synthetic caller. Both the [original failed acceptance](demo/audible/README.md) and the [corrective hours/phone acceptance](demo/corrected/README.md) remain preserved with their exact historical staging versions. The corrective call verifies canonical hours, null-phone handling and persisted summary/message; interruption follow-up remains inconclusive due capture sequencing. These recordings establish neither physical-microphone nor SIP/PSTN acceptance. Current review corrections are local and do not change the staged source or original artifacts; see the [release checklist](readiness.md) for remaining acceptance.
