# Production preflight

Read-only inspection on 2026-09-12, Europe/Vienna. No remote migration, deployment, secret update, or call was performed. Authentication used the personal project’s scoped `direnv`/`dsecret` environment. Secret values were not read or printed.

## Verified state

- Existing Worker: `openfon`; account Workers subdomain: `duguetlabs`. Worker subdomain and version previews are enabled. No custom domain is attached to this Worker in the account API.
- Latest deployment listed: 2026-07-06T22:31:20.621Z, version `289e186d-34b2-46b4-8c34-d58e233b69b3`,100% traffic. Recheck immediately before any release or rollback.
- Existing D1 binding: `openfon`. Remote migration listing reports `0007_abuse_limits.sql` and `0008_calm_studio_foundation.sql` pending.
- Worker secret names present: `AZURE_SPEECH_KEY`, `DEFAULT_LLM_API_KEY`, `DEFAULT_STT_API_KEY`. Presence does not establish validity. No separate `REALTIME_API_KEY` name was listed; source can use the default LLM key for realtime.
- HTTP probes to the inferred `https://openfon.duguetlabs.workers.dev/` and `/api/me` both returned403. The response does not establish whether the application, Cloudflare access controls, or this probe environment caused rejection. This is not a successful deployed smoke test.
- The separately scoped local Kataleptic credential preflight returned403 from the model catalog. This does not establish the validity of the existing Worker’s secret values, which were not fetched.

## Still required

Confirm final hostname/operator identity, resolve provider and public access, obtain required reviews, then back up D1 into a restricted location and rehearse migration/rollback before changing production. Do not use this stale deployment version as an automatic rollback target without a fresh check.
