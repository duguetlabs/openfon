# Realtime provider workstream

- Status: In progress
- Owner: openfon-realtime
- Branch: codex/realtime-providers
- Base/current commit at arrival: a9b33c5c46ccb441e4c07f50b81469354d3cf700
- Updated: 2026-09-12
- Scope: explicit Kataleptic and direct OpenAI realtime adapters, session integration and tests; independent greeting/catalog/summary workflow.
- Coordination: presets owns configuration/schema/UI; Telnyx and Asterisk own carrier adapters; integration owns consolidation. Root shared documents remain untouched.
- Evidence: read root handoff, orchestration rules/current task/manifest, strategy and readiness. Worktree clean except existing untracked node_modules dependency symlink. No worktree AGENTS.md; root AGENTS.md requires dsecret.
- Validation: git status --short --branch and git rev-parse HEAD completed. No implementation tests or live calls yet.
- Ports: test 8813; inspector 9253; never 8787.
- Next action: agree provider contract with presets and session edit boundaries with carrier owners; inspect existing runtime and official OpenAI Realtime protocol.

## Agreed interface direction
Accept presets additive realtime_provider=instance|kataleptic|openai|custom (default instance), realtime_base_url/realtime_api_key; assistant model/voice unchanged. Propose custom explicitly uses OpenAI GA protocol (experimental), kataleptic uses gateway protocol; instance resolves Env REALTIME_PROVIDER default kataleptic. Explicit non-instance choices never inherit instance credentials; OpenAI endpoint pinned to api.openai.com/v1/realtime. Presets owns loading these fields into AgentSettings as well as API/UI and migration. Realtime owns new src/realtime-providers.ts resolver/adapters and CallSession integration. Telnyx owns only runStart synthesized-greeting readiness ordering; preserve that boundary.
Presets confirmed contract: realtime owns CallSession SELECT/loading (also stt_provider/base_url/api_key/model and assistant llm_model || provider llm_model), and passes settings as fifth transcribe argument. Presets adds optional shared types and transcribe implementation. dsecret --list contains no OpenAI credential; direct live verification blocked, synthetic tests continue.

## Implementation checkpoint
- New src/realtime-providers.ts resolves explicit provider/credential/protocol/capabilities; OpenAI uses Worker fetch Upgrade with Authorization header, manual redirects, bounded connection wait. Gateway token URL behavior preserved.
- CallSession direct path waits for session.updated before greeting/ready, uses native PCM24 greeting/transcription, and fails closed instead of silently entering instance pipeline. SELECT includes agreed provider/STT/workspace text model fields (requires presets migration).
- Validation: npm run typecheck passed; npm test -- test/realtime-providers.test.ts test/call-session.test.ts: 99/99 passed, synthetic only. Complete synthetic direct call blocks every non-OpenAI URL and verifies greeting, PCM, interruption flush, end_call, transcript and summary persistence; startup rejection/redirect/session error fail closed.
- Found telnyx-admission.ts uses instance credential guard and model-name SQL greeting gate. Realtime will own narrowly replacing provider eligibility guard with shared resolver/capability check; retain atomic admission quota SQL. Asterisk should use same exported eligibility helper.
- Next: interruption truncation, admission provider eligibility, actual workerd upgrade smoke; integrate presets type/STT changes when ready. Live OpenAI credential remains unavailable.
- Full npm test before presets dependency: 422 passed / 24 failed; failures are Telnyx SQLite admission reads of missing provider_settings.realtime_provider (0010 not yet present). Taking read-only snapshots of presets in-progress migration/types/provider helper/test migration registry into this worktree for validation only; these files remain presets-owned and will not be committed by realtime.
- Actual workerd synthetic direct smoke: node scripts/realtime-smoke.mjs passed using ports 8813/9253. Worker fetch Upgrade Authorization verified, no token query; signed Telnyx admission with no instance AI credentials, PCM, interruption, tool hangup, D1 turns and summary all passed. All outbound traffic intercepted; unmatched hosts blocked. This is real local runtime evidence with synthetic provider/carrier, not live OpenAI or PSTN.
- With presets dependency snapshots full suite exposed 13 Telnyx fixture failures: fakeEnv intentionally had empty REALTIME_BASE_URL, now checked by resolver. Corrected local Telnyx fixture to a valid synthetic WebSocket URL; added direct workspace admission and missing-own-key rejection tests.
