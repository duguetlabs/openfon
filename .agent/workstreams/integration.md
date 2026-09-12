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

## Final capture consolidation and scoped QA
- Full assembled npm test at696a34a:508/508 PASS. Independent QA4c6c64a approves polling/pagination4a5d562, export63c0487 and exact696a34a phone correction:68 API tests,7 browser scenarios, independent pagination/poll-stop probe,22 contact/summary tests,typecheck/build pass. No major/new security issues in scope; no extra live call.
- Launch e42531a consolidated as63b0708: original58.197s lossless audio,68.24s disclosed video, sanitized result/metadata/report. Real gateway audio and persisted result are established; clean acceptance failed. Provider/readiness documentation refreshed accordingly. Budget ZERO.
- PR16 current696a34a CI application/browser/scoring green; realtime benchmark and Codex code/security pending at inspection. PR-Agent absent; no merge or substitute authorized.

## Root corrective acceptance authorization
Root clarified the prior two-call limit was its batch size and now explicitly authorizes ONE corrective short launch-owned acceptance after canonical fixture verification and staging refresh including696a34a or newer validated code. Original evidence and production preserved. Integration makes no competing live call. QA owns official PR-Agent CLI investigation; integration does not duplicate reviewer setup or assume success. Two newly verified PR14 assistant-load retry findings are being fixed/validated before staging refresh; launch must await exact new version and freeze signal.

## Assistant retry correction / reviewer freeze preparation
- PR14 review3996177417/3996177419 independently verified and fixed in8c78219, integrated26a5658. Separate assistant error/retry state in Test Studio and Knowledge; cleanup on unmount and stale-result cancellation; Knowledge retry preserves editor. Typecheck and actual-workerd browser failure/recovery regression PASS1/1. Findings replied and PR14 close/reopened/Codex requested.
- Latest application includes QA-approved696a34a phone fix. Preparing staging deployment and freezing this candidate for official PR-Agent local review; QA owns reviewer execution. No competing live call; launch alone owns the ONE newly authorized corrective acceptance.

## Corrective staging ready / exclusive launch handoff
- Frozen review source526be52ab15785dfa4ec0c7c87a958295a5ce4b6; staging Worker versiona1bc90ea-dad0-4677-abc0-e8e34cdc9c51 deployed100%. Cloudflare API independently verified exact release SHA, separate rehearsalDB e1d93b7d-9024-447a-ae25-6b1e5ed298b3, REALTIME_API_KEY/DEFAULT_LLM_API_KEY names preserved and both carrier flagsfalse.
- Node HTTP probes root200,/api/me401,TelnyxPOST503,AsteriskGET503 PASS. Initial Python urllib public-root request403; native Node client passed the expected full matrix. Production unchanged; no provider call made.
- Integrated full Chrome/workerd suite at526be52:8/8 PASS36.6s, including independent assistant retries preserving drafts. Typecheck/staging-origin build pass. Launch exclusively owns the ONE newly authorized corrective call after canonical fixture verification. Staging frozen until launch completes.
- QA owns genuine official PR-Agent execution on exact526be52. This local checkpoint append remains uncommitted during reviewer freeze to preserve exact head.

## Corrective live result — owner evidence
Launch completed the sole authorized corrective call on526be52/versiona1bc90ea: session722e6aff-a154-4d86-ad80-a80e83cf7dec,68s,12turns. Correct spoken Saturday09–14 plus closed-now; persisted caller_phone JSON null and clean UI; summary/message persisted. Canonical-hours and phone acceptance PASS. Interruption follow-up remains inconclusive due capture timing predicate, not proven app defect. No retry. Original artifacts retained; distinct79.2s video/67.499s original audio packaging pending. Staging freeze released by launch; code head remains frozen for reviewer execution.
- Both PR16 CI runs fully green at526be52; production deploy skipped. Hosted Codex code/security and official QA-owned PR-Agent still pending at last inspection. Root checkout has separate newer coordination commits98f378c etc; preserve them on final root reconciliation.

## Official PR-Agent finding verified
QA completed genuine official CLI full code/security review on526be52:2 chunks,351937 tokens,no failed/omitted chunks reported; no security concerns,one retained-state finding. Original output/provenance PR16 comment5645886103. Integration confirms src/telnyx-control.ts terminal cleanup clears cleanupAt and alarm but rewrites full control record indefinitely. Must compact/remove operational payload while preserving replay/terminal-first protection; blindly deleteAll is unsafe. Telnyx owner requested bounded implementation/tests; exact resulting candidate will receive required retriggers and genuine official rerun. Review head freeze can end for verified fix; no merge authorized.
- Accepted bounded Telnyx fix design: after successful final D1 reconciliation, replace full control with minimal retired=true marker and remove alarm. Marker permanently rejects late events/media after eviction/restart, including terminal-first objects without D1 rows. No event IDs, correlation, caller data, command bodies or stream token retained. Total object deletion would require a separate durable anti-replay boundary and is not requested. Telnyx owner implements/tests; integration assembles/retriggers.

- Corrective artifactc654788 consolidated as98ea53d. Integration independently decoded both MP4/FLAC successfully and verified original audible directory unchanged relative526be52. Initial decode used an incorrect filename and failed; corrected exact path passed. Provider/readiness docs link the corrective scoped report and official review provenance.

## Hosted Codex findings at526be52
Hosted code review5186423066 completed with four findings: RTP outbound payload contract3996207627 (needs official Telnyx verification), duplicate terminal-retention3996207630 (owner fix underway), provider unsaved-draft guard3996207633 (presets owner requested), legacy incomplete assistant migration3996207634 (integration verifies/fixes). No clean code verdict. Original exact-head evidence preserved; all verified corrections will assemble before fresh hosted/official review.
- Legacy migration finding3996207634 confirmed/fixed locally: unreleased0008 seeds active/activated_at only when name/persona/language trim nonempty using ECMAScript whitespace set; otherwise draft/null, original values/slugs preserved. Regression covers each field with blank/ASCII/Unicode whitespace and public404.54 studio tests PASS; synthetic0006→0011 backup/restore/rollback/reupgrade PASS. Production has not applied0008; no new migration number needed for this pre-release seed correction.

## Reviewed-findings assembly ready
- Official cleanupc06bf4d integrated4cc27c4; provider guard27631cb integratedadd9a61; migration correction1ba6e83; corrective artifactc654788 integrated98ea53d. Full assembled522/522 tests/typecheck PASS;9/9 Chrome/workerd PASS39.2s; actual persisted workerd retirement smoke PASS. CI now also runs that retirement smoke. Migrationthrough11 rehearsal PASS.
- All four hosted findings replied: cleanup/provider/migration fixed; RTP-header allegation declined after independently reading official streaming-start raw-audio contract and pinned team-telnyx demo transformOutbound/buildMediaFrame. No media-header change or carrier pass claim. Original official526be52 report retained.
- Preparing exact next head for required close/reopen, hosted Codex code/security and genuine official full PR-Agent rerun; no clean final verdict/merge yet. Staging remains526be52/versiona1bc90ea with both carriersfalse; no additional live call.

## Frozen final review candidate
Exact head4a498c8a6f19f9f9278503e438be94d993013282 published toPR16. CLI push rejected workflow scope; existing authorized GitHub connector update_ref(force=false) published exact uploaded commit without scope expansion. Required close/reopen and separate hosted Codex code/security retriggered; QA notified for genuine official full rerun. Independent QA additionally closed exactc06bf4d compaction with52 focused tests/typecheck/original failing probe now passing and persisted actual-workerd restart. No further committed changes during review. Staging remains capture526be52; production unchanged. This checkpoint tail stays local to preserve exact review head.

## Official rerun4a498c8 — six findings
Original official full report comment5645957875:3 chunks,369783 tokens,no failed/omitted chunks reported; no security concerns,six findings,not clean. Telnyx retention did not recur. Assignments: presets stale OpenAI voice transition; Asterisk terminal/rejected state compaction; integration quota-insert refund, Settings partial-save disclosure/behavior, optimization-proof migration checks, Unicode trigger invariant. Verify each, preserve original reports, assemble one next tested head then required hosted+official reruns. Current completed-run freeze released; production/carrier flags unchanged.
- Hosted security review additionally reports3996213110 at4a498c8: isolate-global Piper voice-map cache unpartitioned by provider endpoint; cross-workspace custom endpoint can contaminate another endpoint's voice mapping. Realtime owner requested bounded verify/fix/tests, no real provider call. Security gate remains open until addressed and re-reviewed.
- Integration fixes so far:133651d refunds workspace/IP spend on failed ticket insert and aligns migration triggers/reconciliation SQL with ECMAScript whitespace;55 studio tests/typecheck PASS.1489ce1 replaces all rehearsal asserts with unconditional checks; optimized positive run PASS and corrupt-history negative copies rejected with-O/PYTHONOPTIMIZE. Settings staged save-status handling passes actual-workerd rejection/retry browser1/1; no atomic-save claim. Voicec4ad882 integrateda16eb7b.
- Integration reserves0012_assistant_essentials.sql for already-migrated databases: replace ASCII triggers with full ECMAScript whitespace checks and demote invalid active rows to draft/null activation, preserving values/slugs. Fresh0008 correction alone cannot repair the rehearsalDB's previously applied triggers. Registry/CI advance through12; explicit additive upgrade will be rehearsed before staging refresh. No collision with presets0010/Asterisk0011; no other owner assigned migrations.

- Asterisk7128478 integrated4fe166c: transactional nonidentifying replay marker, operational key/alarm deletion after projection/rejection, serialized callbacks. Owner33 focused/457 full/typecheck and actual-workerd persistence/rollback/media checks PASS; integration independently running new retirement smoke. CI adds retirement smoke for both carriers. No media protocol/live call changes.

- Local capture sequencing0609c37 integratedce6eccb after root-authorized isolated follow-up. Independent node offline14/14 PASS; CI includes them. Module requires real input/response IDs and complete played chunks; anonymous PCM cannot advance. It is not wired to live capture and does not claim new interruption acceptance or mutate recordings/staging.
- Assembled pre-Piper-fix552/552 tests/typecheck and10/10 actual-workerd browser PASS36.5s. Independent Asterisk retirement smoke PASS with actual D1,transaction rollback,Miniflare restart and replay after D1 deletion.
- Hosted security3996213110 fixed by2de49e5 integrated1a605ba; checkpoint-only conflict resolved to owner latest checkpoint, application merges cleanly. New Piper module partitions public unauthenticated voice map by normalized catalog destination, bounds32 endpoints/1h/64KiB/64voices/128char IDs/4096URL, refuses redirects and falls back independently on failure. Owner six pre-fix regression failures,119 final focused/typecheck PASS; no live request. Security is implementation-fixed, not reviewer-closed until exact-head rerun.

## Next exact-head assembly validation
Post-Piper assembly566/566 tests across25 files/typecheck PASS.10browser PASS36.5s,14offlinecapture PASS,Telnyx andAsterisk actual persisted retirement smokes PASS,optimized migrationthrough12 PASS plus deliberate corruption rejected under-O/PYTHONOPTIMIZE. CI runs both retirement checks,offlinecapture andoptimizedrehearsal. Original official reports526be52 and4a498c8 remain unchanged; six findings and hosted security have concrete implementations and will receive explicit replies plus required exact-head reruns. No clean reviewer verdict assumed.
