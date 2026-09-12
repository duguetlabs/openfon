# Production preflight

Read-only inspection on 2026-09-12, Europe/Vienna. No remote migration, deployment, secret update, or call was performed. Authentication used the personal project’s scoped `direnv`/`dsecret` environment. Secret values were not read or printed.

## Verified state

- Existing Worker: `openfon`; account Workers subdomain: `duguetlabs`. Worker subdomain and version previews are enabled. No custom domain is attached to this Worker in the account API.
- Latest deployment listed: 2026-07-06T22:31:20.621Z, version `289e186d-34b2-46b4-8c34-d58e233b69b3`,100% traffic. Recheck immediately before any release or rollback.
- Existing D1 binding: `openfon`. Remote migration listing reports `0007_abuse_limits.sql` and `0008_calm_studio_foundation.sql` pending.
- Worker secret names present: `AZURE_SPEECH_KEY`, `DEFAULT_LLM_API_KEY`, `DEFAULT_STT_API_KEY`. Presence does not establish validity. No separate `REALTIME_API_KEY` name was listed; source can use the default LLM key for realtime.
- Repeated HTTP probes to `https://openfon.duguetlabs.workers.dev/` returned 200 (`text/html`) with browser user agent `Mozilla/5.0 OpenFon-Launch-Check`; `/api/me` returned the expected unauthenticated 401 (`application/json`). Both requests returned 403 with `Python-urllib/3.9`. Public browser access is therefore established at the HTTP level; a deployed authenticated session or provider conversation has not been tested.
- The separately scoped local Kataleptic credential preflight returned403 from the model catalog. This does not establish the validity of the existing Worker’s secret values, which were not fetched.

## Still required

Confirm final hostname/operator identity, verify provider access and the deployed authenticated flow, obtain required reviews, then back up D1 into a restricted location and rehearse migration/rollback before changing production. Do not use this stale deployment version as an automatic rollback target without a fresh check.

## Integration refresh, 2026-09-12

Scoped Cloudflare API reads reconfirmed the personal account, `duguetlabs` Workers subdomain, one D1 database (`openfon`) and unchanged deployed version `289e186d-34b2-46b4-8c34-d58e233b69b3` at 100%. Remote migration listing now includes 0007, 0008 and 0009 pending, matching the integration checkout.

A restricted production SQL backup was exported outside the repository and restored **locally** to SQLite. Applying 0007–0009 preserved legacy configuration, completed call history and public slugs; integrity and foreign-key checks passed before/after. A restricted upgraded binary snapshot was also created. This is stronger than a fictional-data rehearsal but does not verify Cloudflare staging D1, Worker rollback, live providers or a telephone call. No remote migrations or Worker deployment were run. Backup location and hash evidence are in the integration checkpoint; database contents are not committed.
