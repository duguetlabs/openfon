# Asterisk workstream
- Status: Complete — bounded implementation; real PBX pilot remains unverified
- Owner: openfon-asterisk
- Branch: codex/asterisk-integration
- Base verified: a9b33c5c46ccb441e4c07f50b81469354d3cf700
- Last updated: 2026-09-12T11:44:00Z
- Read first: root handoff/orchestration rules; docs/asterisk.md

## Delivered
- aac57a2: authenticated inbound Asterisk chan_websocket adapter, durable call owner, route migration 0011, runnable PBX configuration, deployment guide, protocol/control tests and synthetic workerd harness. Integration reports consolidated as adcaf9b.
- Follow-up (this commit): shared telephoneRealtimeAvailable admission eligibility, workspace-provider coverage, public browser-route isolation and alarm outage tests. Retains integration owner's OPENFON_TEST_PORT / OPENFON_INSPECTOR_PORT overrides, defaults 8811/9251.
- Minimal shared hooks: index import/export/register and carrier browser/sweep exclusions; Env ASTERISK_CALL/ENABLED; CallSession requiresCarrierAudio predicate only; wrangler AsteriskCall binding/v3 migration and disabled flag. No default provider changes, root documents, or migration 0010 edits committed.

## Contract and evidence
- Official Asterisk docs read 2026-09-12: JSON controls require 20.18+,22.8+,23.2+. Direct binary ulaw/8000/mono -> existing PCM24 FIR transport; MARK_MEDIA/FLUSH_MEDIA, XOFF/XON, bounded queues, startup/drain timeouts, hangup and restart cleanup.
- Operator-owned route binds exactly one workspace/assistant, with random-password SHA-256 only in D1. Rate-limited Basic auth; deterministic per-route/PBX-call durable identity rejects replay. Atomic SQL quotas include existing carrier reservations. Provider readiness uses shared resolver before reservation; CallSession revalidates later.
- Actual Asterisk unavailable locally: command -v asterisk returned no path; docker info failed because /Users/cristian/.docker/run/docker.sock does not exist. No real PBX, live AI provider, SIP or PSTN success claimed.

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
