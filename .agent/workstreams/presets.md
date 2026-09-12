# Provider presets checkpoint

- Status: Complete (bounded implementation; integration/runtime validation remains)
- Owner: openfon-presets
- Branch: codex/provider-presets
- Base: a9b33c5c46ccb441e4c07f50b81469354d3cf700
- Updated: 2026-09-12
- Scope: provider schema/settings UI, text presets, workspace credentials, migration 0010.
- Rules read: root handoff, orchestration rules/current-task/manifest, root AGENTS.md, strategy and readiness.

## Verified facts
- Clean tracked working tree on assigned branch; untracked node_modules is existing dependency symlink.
- Existing resolveLlm binds instance key to default endpoint and rejects custom URLs without their own key; preserve this protection.
- Existing migrations end at 0009. Ports reserved 8812 / 9252; never 8787.

## Contract coordination
Propose additive provider_settings fields: llm_provider (kataleptic/openrouter/huggingface/openai/custom; default kataleptic), realtime_provider (instance/kataleptic/openai/custom; default instance), realtime_base_url, realtime_api_key. Existing assistant realtime_model/realtime_voice stay assistant-owned. Presets owns persistence, API validation and UI; realtime owns resolution/adapters. STT will have independent stt_provider/base_url/api_key/model fields; TTS capabilities explicitly distinguished.

## Completed / validation
Read-only repository and coordination inspection. No application tests or real provider calls yet.

## Next action
Agree shared realtime contract, verify official provider docs, implement bounded schema/API/UI and credential tests.

## Contract refinement
Realtime owner accepts instance|kataleptic|openai|custom; explicit choices never inherit instance credentials, custom uses OpenAI GA experimental protocol; Env REALTIME_PROVIDER defaults kataleptic. Add llm_model workspace fallback so selecting a text preset works for assistants without overrides. Launch owns README/Landing/docs/quickstart.md/docs/providers.md; leave these untouched.

## Implementation checkpoint (2026-09-12)
- Actual checkout base is a9b33c5 (dispatch commit); earlier header b730480 is root source base.
- Implemented migration 0010_provider_capabilities.sql, optional shared types including Env REALTIME_PROVIDER; test/sqlite-d1 applies through 10.
- Workspace API saves separate text model, STT and realtime fields and never returns new secrets. URL/protocol changes require new key or explicit removal; same-endpoint blank keeps key. Legacy agent/profile mutation routes receive equivalent retention guards.
- Settings has all five requested text presets plus explicit instance default/custom editable URL/model. Separate STT/realtime fields and explicit pipeline TTS capability explanation; Kataleptic maintainer/optional-paid disclosure. OpenAI selection clears only known gateway assistant model/voice presets.
- Direct OpenAI/custom voice catalog avoids all Kataleptic requests and cache reuse. Direct OpenAI uses static voices; custom fields remain editable.
- npm run typecheck passed; baseline npm test 424/424 passed; added provider-presets suite 15/15 passed after fixing a test fixture missing required business name. New browser test currently running actual local workerd on 8812/9252.
- No real provider credentials used or calls made. Official sources opened 2026-09-12: https://openrouter.ai/docs/quickstart (base /api/v1; namespaced models); https://huggingface.co/docs/inference-providers/en/tasks/chat-completion (router /v1; model repository IDs/optional provider suffix; token needs Inference Providers permission); https://developers.openai.com/api/docs/models/gpt-4.1-mini (Chat Completions model). Kataleptic public root probes failed in web tool; existing repository defaults preserved, no refreshed live catalog claim.
- Files changed: src/types.ts, src/providers.ts, src/provider-settings.ts, src/studio-api.ts, src/index.ts, migrations/0010_provider_capabilities.sql, test/sqlite-d1.ts, test/provider-presets.test.ts, web/src/api.ts, web/src/pages/Settings.tsx, web/src/pages/ProviderSettings.tsx, e2e/provider-presets.spec.ts, this checkpoint. Temporary local browser config/server are validation artifacts, not for commit.

## Validation follow-up
- Full unit suite with new capability tests passed 439/439. Additional legacy-agent/profile endpoint-retention regression then passed with all 48 studio API tests (440 total expected at final run).
- Browser first attempt blocked by missing Playwright bundled Chromium; use installed Google Chrome via PLAYWRIGHT_CHROMIUM_EXECUTABLE. Next attempt exposed test navigation before onboarding save completed; fixed by waiting for workspace navigation. Actual browser then passed all preset/persistence/key-change steps and found mobile overflow; fixed fieldset min-width/select width, rerun underway.

## Final persisted/API contract for integration and docs
- Migration 0010 additive provider_settings columns: llm_model TEXT ''; realtime_provider instance|kataleptic|openai|custom default instance; realtime_base_url/api_key TEXT ''; stt_provider instance|openai|custom default instance; stt_base_url/api_key/model TEXT ''. All credentials write-only to API callers. Defaults unchanged.
- GET /api/me/provider returns existing baseUrl/key-configured flags plus model, presets, realtime_provider/base_url/api_key_configured, stt_provider/base_url/model/api_key_configured, tts_provider. PUT accepts existing baseUrl/apiKey/clearApiKey plus model and snake_case speech columns; speech keys accept null or <capability>_clear_api_key=true for removal. Blank/omitted preserves at same destination; destination/protocol change requires replacement or explicit clear.
- Text preset bases/models: Kataleptic https://api.kataleptic.com/v1 / llama-3.3-70b (existing default); OpenRouter https://openrouter.ai/api/v1 / openai/gpt-4.1-mini; HF https://router.huggingface.co/v1 / openai/gpt-oss-120b; OpenAI https://api.openai.com/v1 / gpt-4.1-mini; custom editable. Text choice does not modify speech choices. Workspace model applies only absent assistant override.
- OpenAI STT https://api.openai.com/v1 / whisper-1 with own key; custom OpenAI-compatible audio/transcriptions requires own URL/key/model. Browser pipeline TTS remains operator-selected browser/Azure, no claim of OpenRouter/HF voice compatibility.
- OpenAI realtime pinned wss://api.openai.com/v1/realtime with own key. Custom requires wss public URL and own key; protocol OpenAI GA experimental. Model/voice stay assistant settings; known gateway presets cleared on switching to OpenAI; arbitrary custom overrides preserved. Runtime adapter integration belongs to realtime owner.


## Completion evidence
- Final code: `npm run typecheck` passed; `npm test` passed 440/440 in 21 files. Added one final gateway/custom-model preservation regression afterward; `npx vitest run test/provider-presets.test.ts` passed 16/16.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npx playwright test --config .presets-playwright.config.ts` passed 1/1 against fresh local workerd/D1, ports 8812/9252. Config/server were temporary copies of repository defaults replacing 8790→8812 and 9232→9252, with testMatch provider-presets.spec.ts. Production build ran successfully in this harness. Temporary files removed after validation.
- Mobile screenshot inspected: test-results/provider-presets-provider--d002a-w-key-when-endpoints-change/provider-settings-mobile.png; no horizontal overflow. Synthetic keys only; no outbound inference in this browser test.
- `git diff --check` passed. Added legacy-key regression in test/studio-api.test.ts is also part of changed files.
- Additional official sources opened: https://openrouter.ai/openai/gpt-4.1-mini (exact model ID, text output); https://developers.openai.com/api/docs/models/whisper-1; https://developers.openai.com/api/docs/guides/realtime-conversations (static voice catalog).
- Remaining integration dependency: realtime owner supplies CallSession SELECT/loading, workspace model fallback and transcribe fifth argument plus realtime runtime adapter. This provider branch alone is not evidence of those runtime features. Integration owns consolidation and review/merge loop; no PR opened or deployment made by presets.
- Recommended next action: cherry-pick the presets implementation commit, consolidate with realtime and Asterisk registry additions, then run combined tests and live provider validation when credentials are available.
