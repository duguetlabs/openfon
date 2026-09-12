# Integration checkpoint

- Status: In progress — implementation/staging complete; final PR reviews pending
- Owner: openfon-integration
- Branch: codex/integrated-release
- Base: a9b33c5c46ccb441e4c07f50b81469354d3cf700
- Updated: 2026-09-12T12:03:00Z
- Rules: root AGENTS.md, .agent/orchestration-rules.md, assigned handoff; root shared documents remain read-only
- Ports: application 8814, inspector 9254; real-PBX fixture proxy 8824; never 8787
- Read first: this file, docs/launch/readiness.md, docs/launch/production-preflight.md

## Objective / scope
Sole release consolidation owner. Complete old launch findings, preserve stacked PRs, consolidate provider/carrier/docs owners, validate release and staging, enforce both required reviewers. No production deployment, live routing, spending, or substitute-review approval inferred.

## Consolidated implementation
- Launch fixes a50bc84 ->51bfe28; second reviewed round f839527 ->6e64872. Navigation guards now cover assistant, knowledge item, collection details and onboarding. Search follows URL/filter changes. Headline total excludes unconnected reservations. Boolean false preserved. Export raw/count budget precedes bounded JSON construction in one snapshot.
- Telnyx 37b3575 ->e974f08: synthesized greeting readiness before input; native+synthesized runtime coverage.
- Presets ce62114 ->087d394: migration 0010, provider API/schema/UI, separate text/STT/realtime credentials, write-only key handling and preserved defaults.
- Realtime18d3638/13f037b/ca0d901 ->137b4c9/71c2d14/9efef65; actual pre-ack fix 083dae3 ->db6f4ce; failure-rotation tests 5411999 ->3cb2895. ca0d901 is catalog-only, NOT the handshake fix.
- Asterisk aac57a2/0737b0b ->adcaf9b/b0ec747: migration 0011, v3 DO, hashed route auth, shared realtime eligibility. Real Asterisk harness 0c25c99 ->c0ab614.
- Launch 52b73ee/45fb33a/24d8321/7f9c30c consolidated; quickstart anchor conflict resolved to final provider contract. Northwheel fictional audible scenario explicitly approved; no further scenario question needed. Working provider remains required for recording.
- Integration reconciles test migration registry through 0011, shared per-attempt browser limiter fixture, all smoke-port overrides, provider truth table, reproducible migration rehearsal and CI runtime/migration checks.
- f95be36 requires explicit production workflow dispatch on main, deploy_production=true default false, preserving all check dependencies. Merging alone no longer deploys. No dispatch executed.

## Actual validation
- Assembled application at 6e64872: typecheck PASS; npm test 496/496 across 24 files; Chrome/workerd browser 7/7 PASS (39.5s), including provider/mobile, editor/onboarding guards, search URL, account export and private typed call.
- Actual workerd synthetic: Telnyx native+synthesized, Asterisk, direct OpenAI and gateway PASS. Direct authenticated static voice catalog/greeting/PCM/interruption/tools/summary persistence works without instance/Kataleptic/Azure keys; unmatched outbound hosts blocked. No live provider/PSTN inference from these tests.
- Independently reran real Asterisk 22.11.0 Local-channel/audio on integrated c0ab614, ports8814/9254/proxy8824: caller PCM960 bytes; assistant recording18240 bytes,440Hz amplitude7981; ANSWER1/MARK11/FLUSH1/HANGUP1; MEDIA_MARK_PROCESSED11; revoked route rejected;3 turns, completed/released D1;0 remaining channels. Mock AI, no SIP trunk/PSTN/public-WSS claim. No test container remains.
- Quality220 tests/one skip PASS using /tmp/openfon-integration-venv. Initial system-Python quality run lacked jiwer; isolated CI-equivalent dependencies fixed environment. Realtime206 PASS; report checker122 verified/four allowlisted/zero unresolved; npm audit0 vulnerabilities.
- Synthetic migration rehearsal `python3 scripts/migration-rehearsal.py . --through 11` PASS:0006→0011, binary/SQL restores, rollback and re-upgrade.
- QA independently approved initial launch patch51bfe28 and deploy gatef95be36. QA closed pre-ack issue at083dae3 (147 focused tests/adversarial runtime). Final scoped assembled QA at exact6e648723562171475799bbd5c5b1a7d171f68a07: no major/new security findings; independently496 tests/typecheck,7 browser, all runtime smokes, migration rehearsal and extra export raw/escape budget probes.

## Production backup and separate staging
- Personal scoped Cloudflare account verified. Production Worker remains version289e186d-34b2-46b4-8c34-d58e233b69b3; production D1c45afdaa-c04e-4401-af5c-801bb79fc88c has0007–0009 pending at inspection. No production migrations/Worker deployment executed.
- Restricted backup: /Users/cristian/.local/share/openfon/backups/2026-09-12-integration/pre-release.sql; mode600 under mode700 directory;189751 bytes; SHA256 prefix79ab670c40518de3. SQL contents never committed/printed.
- Restored backup locally and into separate Cloudflare D1openfon-release-rehearsal-20260912 (e1d93b7d-9024-447a-ae25-6b1e5ed298b3), applied0007→0011. Six exact legacy fingerprints (businesses/settings/presets/completed calls/transcripts/public slugs), FK and quick_check PASS. Restricted fingerprints/report/config/logs in backup directory.
- After preservation verification, staging-only copied assistants paused, carrier routes disabled, sessions cleared. Counts independently verified zero; no cron; separate DO namespaces.
- Validated origin: https://openfon-staging.duguetlabs.workers.dev
- Worker version:8439378c-eeda-4fb7-83e5-a01a2f986fb0 at100%; deployment44be36d9-0f17-42a9-8361-d22fbb8f0d7a.
- Deployed source:41041c1a3425c1c0ff90697917ce39cdb2394e7a, independently read from OPENFON_RELEASE_SHA binding. Later changes are runtime harness/docs only; app remains6e64872.
- DB binding and TELNYX_ENABLED=false/ASTERISK_ENABLED=false independently read back. HTTP root200, signed-out/api/me401, Telnyx webhook503 and Asterisk endpoint503 disabled.
- V2 webhook for later coordinated setup: https://openfon-staging.duguetlabs.workers.dev/api/telnyx/webhooks
- Origin/version/binding/gates sent to Telnyx and desktop thread01a09561-5595-7a20-8871-c9e2b72ecef9 via authorized queue. No routing enabled; account identity review and numbers pending.
- Operational incident: initial Wrangler export printed a one-hour signed download URL in tool output. No URL copied into docs/messages; later private/deploy operations capture stdout to mode600 logs. URL expiry2026-09-12T12:39:48Z; treat original transcript as sensitive until expiry.

## PR/review gates
- Consolidated PR16: https://github.com/duguetlabs/openfon/pull/16 — separate Codex code/security requested. Refresh exact latest head/CI/reviews before acceptance.
- PR14 latest f839527: all four new findings replied; pushed, closed/reopened and Codex requested. Earlier a50bc84 passed CI; latest review/CI pending.
- PR15 head 37b3575: both CI runs green, Codex code no major issues and security no issues confirmed by owner. PR13 d6ea5d2: applicable checks green and Codex no major issues.
- Mandatory PR-Agent absent after retriggers; public repository exposes CI only. Independent QA and Codex security are NOT an authorized substitute. No PR merged.
- PR10 remains open; integrated 8666e7e already fixes/qualifies semantic-VAD research. Do not blindly merge stale wording or close stacked work until accepted consolidation.
- Initial release push rejected missing workflow scope. Instructed gh auth refresh was started then cancelled; already-authorized GitHub connector published the exact uploaded 41041c1 ref, avoiding any permission expansion. Subsequent branch updates preserve intended workflows.

## Files / next action
Committed owner files plus integration migration rehearsal, test fixture/registry/port reconciliation, CI gate/runtime checks and evidence docs. Only pre-existing node_modules remains untracked after checkpoint commit.
Next: publish latest evidence/harness head to PR16, retrigger required reviews, watch/fix real findings and CI. Ask root the concrete mandatory-reviewer decision only when candidate otherwise reviewable. Preserve production and disabled staging routes; real provider/audio/PSTN and account gates remain. Do not end at a plan or merge around missing PR-Agent.

## Post-consolidation export correction
Independent integration inspection found account export's explicit provider allowlist still omitted migration0010 non-secret settings (model, STT choice/URL/model, realtime choice/URL). Adding those fields while retaining key exclusions; regression verifies all three credentials absent and configuration preserved. This is an integration-only migration0010 follow-up, not applicable to stacked PR14's older schema. Targeted validation running before push/review retrigger.

## Working staging provider configuration — 2026-09-12T12:09Z
- Realtime owner independently validated personal vault item `kataleptic api key - broser-use`, field `credential`: real gpt-realtime-2 upgrade101 + matching session.updated +146400 PCM bytes/transcript, and llama-3.3-70b chat completion200. One short Northwheel call consumed; ONE authorized short conversation remains.
- Integration injected only REALTIME_API_KEY and DEFAULT_LLM_API_KEY into explicit openfon-staging config via subprocess memory/stdin. No values emitted/stored in files/messages. Readback verifies both secret names and both carrier flags false.
- Current staging version76a515eb-877e-48ef-bdcd-1ab8ea7095ef at100%, source718d233e3754e53b800a397b1e600ffea492bb79. D1 remains separate rehearsal target. No production mutation.
- Approved private Northwheel assistant must set engine=realtime, realtime_model=gpt-realtime-2, realtime_voice blank (provider default); instance model default llama-3.3-70b must be overridden. No Azure/STT key needed for verified native path. Remaining conversation belongs to realtime/launch capture; integration makes no extra provider call.

## Review continuation / staging freeze
- PR16 at718d233 has all CI checks green; Codex code/security reviews still running. PR-Agent remains absent.
- PR14 f839527 latest findings independently verified: active CallDetail fetches only once before finalization; assistant filter load does not retry; Knowledge details/items load unbounded rows. Implemented active-call polling, assistant-list refresh and20-item keyset pages with stable status/created/id cursor in launch-review. Typecheck and initial49 API tests pass; new pagination/regression browser suite running.
- Staging frozen at76a515eb/source718d233 while launch owns the ONE remaining live call. Do not deploy or trigger a duplicate provider conversation during capture.
- PR14 cf1f6ec fixes third confirmed round; integrated4a5d562 and pushed to PR16. Required close/reopen and separate Codex code/security retriggered; all three findings replied. Fifty targeted API tests/typecheck and six launch browser scenarios pass. Assembled rerun ongoing. Staging intentionally remains source718d233/version76a515eb for exclusive launch capture.

## Permitted live capture and confirmed phone normalization defect
- Launch completed the final permitted short Northwheel staging call (58s,10 turns, summary/message persisted). Call budget is ZERO; no retry/new provider conversation permitted. Launch preserves original WAV/video and labels failed acceptance honestly.
- Saturday closed answer followed contradictory fixture data: onboarding hours_json closed Saturday while description/instructions said09–14. This is a fixture conflict, not established provider hallucination. Preserve original evidence.
- Independently verified literal string "null" phone defect: summary persistence copied raw parsed.caller_phone and UI treated any nonblank string as a number. Added shared normalizeCallerPhone at persistence and historical-row display, preserving actual numbers and legitimate caller surname Null. No historical data rewritten.
- Local typecheck/build and22 focused summary/contact tests pass, including null/case/whitespace/invalid-type suppression. Staging not redeployed yet; original capture remains unchanged. No real call used for the correction.
