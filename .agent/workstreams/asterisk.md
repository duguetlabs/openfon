# Asterisk workstream
- Status: Complete — implementation and real local PBX runtime; live AI/SIP/PSTN pilot unverified
- Owner: openfon-asterisk
- Branch: codex/asterisk-integration
- Base verified: a9b33c5c46ccb441e4c07f50b81469354d3cf700
- Last updated: 2026-09-12T12:00:00Z
- Read first: root handoff/orchestration rules; docs/asterisk.md

## Delivered
- aac57a2: authenticated inbound Asterisk chan_websocket adapter, durable call owner, route migration 0011, runnable PBX configuration, deployment guide, protocol/control tests and synthetic workerd harness. Integration reports consolidated as adcaf9b.
- Follow-up (this commit): shared telephoneRealtimeAvailable admission eligibility, workspace-provider coverage, public browser-route isolation and alarm outage tests. Retains integration owner's OPENFON_TEST_PORT / OPENFON_INSPECTOR_PORT overrides, defaults 8811/9251.
- Minimal shared hooks: index import/export/register and carrier browser/sweep exclusions; Env ASTERISK_CALL/ENABLED; CallSession requiresCarrierAudio predicate only; wrangler AsteriskCall binding/v3 migration and disabled flag. No default provider changes, root documents, or migration 0010 edits committed.

## Contract and evidence
- Official Asterisk docs read 2026-09-12: JSON controls require 20.18+,22.8+,23.2+. Direct binary ulaw/8000/mono -> existing PCM24 FIR transport; MARK_MEDIA/FLUSH_MEDIA, XOFF/XON, bounded queues, startup/drain timeouts, hangup and restart cleanup.
- Operator-owned route binds exactly one workspace/assistant, with random-password SHA-256 only in D1. Rate-limited Basic auth; deterministic per-route/PBX-call durable identity rejects replay. Atomic SQL quotas include existing carrier reservations. Provider readiness uses shared resolver before reservation; CallSession revalidates later.
- Initial Asterisk executable/socket absence was resolved by starting installed Docker Desktop and building Asterisk 22.11.0. Actual local PBX validation now passes; live AI, SIP trunk and PSTN remain unverified.

## Validation
- npm test: 441/441 passed across 22 files after shared readiness integration, before last three additional regression tests.
- npx vitest run test/asterisk-control.test.ts test/asterisk-media.test.ts: final 20/20 passed, including last three tests (browser exclusion, outage rearm, drain timeout).
- npm run typecheck: passed with exact realtime helper 18d3638 copied locally as an untracked validation dependency.
- node scripts/asterisk-smoke.mjs: passed actual local workerd/D1/DO with simulated PBX/provider; authentication, duplicate rejection, concurrent cap, greeting PCM, inbound PCM24, interruption flush, marks/drain, hangup, D1 finalization, disabled route. All provider traffic intercepted; no external calls.
- git diff --check: passed before final checkpoint update.
- Corrected test-only failures: cross-workspace fixture initially used same owner (violated existing one-workspace trigger); first dependency copy used incorrect 0010 filename. Rechecked after corrections; both resolved.

## Dependencies / next action for integration
- Apply realtime helper 18d3638 and presets 0010_provider_capabilities.sql before this follow-up. Those exact dependency files are copied untracked in this worktree for validation only and are NOT owned/committed here; node_modules symlink likewise untouched.
- Preserve realtime owner's full CallSession adapter and Telnyx owner's synthesized-greeting readiness ordering on consolidation; my only CallSession hunk is carrier recognition.
- Consolidate this follow-up, run integrated matrix on assigned ports, satisfy release review gates. Keep ASTERISK_ENABLED=false until a real consented PBX/provider call and failure matrix in docs/asterisk.md pass.

## Real runtime follow-up — completed
- Docker Desktop started via open -a Docker; daemon29.2.1. No alternative Colima/OrbStack/Lima CLI found. No paid subscription/security changes required.
- Built pinned official Asterisk22.11.0 arm64 with verified source SHA256. Final image14a9583366ea60ef185203615ff26a86fe116d33f3d5fe375e5c002aef5e0147.
- Final node scripts/asterisk-smoke.mjs --asterisk passed at11:58:44–45UTC: real Local-channel660Hz caller tone -> PCM24 input, real PBX MixMonitor440Hz assistant signal (17,280 bytes, peak7932/amplitude7981), actual ANSWER1/MARK_MEDIA11/FLUSH_MEDIA1/HANGUP1, real MEDIA_MARK_PROCESSED11, completed/released D1 call,3 transcript turns,0 channels. Actual revoked-route follow-up rejected before reservation.
- Synthetic AI only; no SIP trunk, physical microphone, real AI provider, PSTN or production WSS test. Final synthetic smoke and git diff --check also passed. No production adapter changes were necessary.
- Owned runtime files: examples/asterisk/runtime/Dockerfile, scripts/asterisk-runtime.mjs, smoke --asterisk mode, docs/asterisk.md and dated runtime evidence. Transparent test proxy8821 coordinated with integration; Worker8811/inspector9251 unchanged, all configurable.
- Test container and recordings removed; Docker/image retained for repeatability, unrelated containers untouched. Evidence: docs/asterisk-runtime-validation-2026-09-12.md.
- Next integration action: consolidate runtime harness/docs commit, optionally repeat --asterisk with assigned port overrides, preserve distinction between real PBX and mocked AI/PSTN evidence. Production rollout remains disabled pending deployment-specific live pilot.
