# Realtime provider workstream

- Status: Implementation complete; integration pending; live-provider validation blocked
- Owner: openfon-realtime
- Branch: codex/realtime-providers
- Base at arrival: a9b33c5c46ccb441e4c07f50b81469354d3cf700
- Updated: 2026-09-12T11:52:46.067657+00:00
- Rules: root AGENTS.md, orchestration-rules.md/current-task/manifest, assigned handoff, strategy and readiness read. Root shared documents untouched.
- Ports: 8813 test, 9253 inspector; never 8787.

## Scope and contract
Explicit Kataleptic gateway and independent direct OpenAI realtime resolver, authentication, capabilities and CallSession integration; provider-aware Telnyx admission; regression tests and reproducible runtime smoke. Presets owns schema/API/UI and migration 0010. Telnyx owns synthesized greeting readiness ordering; Asterisk owns carrier channel predicate. Those CallSession regions are preserved for integration.

Agreed provider fields: realtime_provider=instance|kataleptic|openai|custom (default instance), realtime_base_url/api_key. Env REALTIME_PROVIDER defaults kataleptic. Explicit choices require own key; custom is experimental GA protocol. Assistant model/voice overrides remain. Blank direct model -> gpt-realtime. Presets owns static direct catalogs and independent text/STT settings. Realtime owns SELECT/loading including workspace llm_model fallback and STT fifth argument.

## Completed
- Commits: 18d3638 provider helper; 13f037b session/admission/runtime implementation.
- Commit 18d3638: new src/realtime-providers.ts, resolver/capability/telephone eligibility tests and first checkpoint. Shared telephoneRealtimeAvailable helper sent to Asterisk/integration.
- Direct Worker fetch Upgrade uses Authorization header, refuses redirects, and requires matching session.updated before readiness/greeting. Key never enters URL. Gateway token-query path retained.
- Native direct greeting, whisper-1 caller transcription, PCM24, tools, existing recovery/finalization and saved turns/summary. Direct startup fails closed without instance pipeline fallback.
- Direct interruption flush + last-item truncation using bounded elapsed-delivery estimate. Existing media protocol cannot report exact per-item playback position; this limitation is documented.
- CallSession loads realtime/STT fields and workspace text-model fallback, including legacy call-row loading. No carrier transport format changes.
- Telnyx admission now checks resolved workspace provider credentials/greeting capabilities while retaining atomic quota SQL and durable reservation retry behavior.
- docs/realtime-providers.md contains official references, deployment/independence recipe and explicit evidence limits.
- scripts/realtime-smoke.mjs uses actual workerd/D1/DO/WebSockets and intercepted synthetic upstreams; --gateway checks preserved gateway transport on the same reserved ports.

## Files owned
src/realtime-providers.ts; src/call-session.ts; src/telnyx-admission.ts; test/realtime-providers.test.ts; test/call-session.test.ts; test/telnyx-control.test.ts; scripts/realtime-smoke.mjs; docs/realtime-providers.md; this checkpoint.

## Dependencies present for validation only
Copied with presets owner's acknowledgment from its in-progress worktree: src/types.ts, src/providers.ts, src/provider-settings.ts, migrations/0010_provider_capabilities.sql, test/sqlite-d1.ts. These remain presets-owned, are NOT in realtime commits, and must come from presets' final commit during consolidation. Existing untracked node_modules dependency symlink remains untouched.

## Validation
- npm run typecheck — passed with presets dependency snapshot.
- npm test — 450/450 passed across 21 files with dependency snapshot.
- npm test -- test/call-session.test.ts test/telnyx-control.test.ts test/realtime-providers.test.ts — 143/143 passed.
- node scripts/realtime-smoke.mjs — passed actual workerd, synthetic direct OpenAI/carrier only: header auth, signed/idempotent telephone admission with no instance AI/Azure credentials, bidirectional PCM, interruption, end_call, drain/hangup, D1 release, transcripts and summary. Unmatched outbound traffic blocked.
- node scripts/realtime-smoke.mjs --gateway — passed same actual runtime workflow using preserved gateway token auth.
- git diff --check — passed.
- Earlier full-suite failures resolved: missing 0010 caused 24 SQLite failures; after snapshot 13 Telnyx fixtures lacked a REALTIME_BASE_URL now checked by resolver. Added valid synthetic fixture URL and direct workspace admission tests. No assertion was weakened.

## Remaining / limitations
- No OpenAI credential listed by dsecret --list. No live OpenAI, audible browser or PSTN call claimed. Telnyx account browser remains desktop-owned.
- Presets owns independent static catalog API/UI validation; integration must verify full consolidated workflow using its final commit.
- Exact playback truncation awaits a per-item media acknowledgement contract; current implementation is an explicit estimate.
- Integration alone consolidates branches, drives both required reviews and merges. No PR or deployment opened here.

## Next action
Integrate provider module commit, presets final shared commit, then realtime session/admission commit; preserve Telnyx greeting and Asterisk predicate changes. Run both runtime smoke variants sequentially and the consolidated suite. Obtain authorized direct provider credential for live acceptance when available.

## Final dependency verification
Presets final commit ce62114 received; replaced the five dependency snapshots with exact final files. Typecheck and full 450 tests passed again; direct workerd smoke passed again. Adding final presets src/index.ts/src/studio-api.ts snapshots solely to extend the direct runtime smoke through its authenticated static voice catalog; these also remain presets-owned/uncommitted.

Authenticated direct static voice catalog now also passes in the actual workerd independence smoke with all unmatched network destinations blocked. Initial probe failed 401 because the harness used the wrong cookie name; corrected to the application ofs session cookie, then the complete workflow passed. Final dependency snapshots include src/index.ts and src/studio-api.ts from ce62114; none are owned or committed by realtime.

## QA handshake follow-up
QA reported P2 pre-ack application events reaching onUpstreamMessage. Confirmed locally with new startup and proactive rotation regressions: both failed before the fix (binaryCount 1 with no matching acknowledgement; tool event also triggered ending). Added a per-socket direct application-event gate after handshake handling; only a validated session.updated opens that socket. Old acknowledged socket stays readable and writable during replacement handshake.

Validation after fix: focused call-session/telnyx-control/realtime-providers 145/145 pass; typecheck passes with final ce62114 dependency snapshots. Regressions cover pending audio, caller/assistant transcripts, speech-start/flush, both tool event forms, unmatched ack, old socket bidirectional continuity, and successful post-ack handover. Runtime smoke now injects pre-ack audio/transcript/end_call in direct mode and requires exactly three legitimate persisted turns; both direct and gateway workerd runs passed on 8813/9253 with no unexpected outbound requests.


Root status clarification: ca0d9018acce1b885bbe8529a836d7249fffb8f3 only adds catalog smoke/docs and does NOT resolve QA's handshake finding. Exact application fix is 083dae372fa0ca875a5745769e9876213bdd7827, already sent to QA and integration for re-review. Additional regressions cover failed replacement handshake (error and timeout) preserving the acknowledged old socket; full suite 454/454 passed after these test-only additions. No new paid accounts created, no Kataleptic dependency introduced, and no authorized direct OpenAI credential has been found.


Independent QA closure received and verified in release-audit/.agent/workstreams/qa.md: P2 resolved at exact 083dae372fa0ca875a5745769e9876213bdd7827 with ce62114 dependencies; original independent failing probe passes unchanged, QA focused147 (owner145 plus two independent probes), typecheck, adversarial direct/catalog and gateway actual-workerd smoke pass. Scoped no remaining major/new security issues; not a whole-release, live-provider or PR-Agent substitute verdict. Integration notified by QA.
