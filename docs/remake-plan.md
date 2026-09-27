> Historical proposal: the selected Brand Identity application and [current functional contract](cleanroom-functional-contract.md) supersede this earlier navigation and visual direction.

# OpenFon remake: implementation and acceptance

This plan implements [the product requirements](remake-requirements.md). Base application: `804e6f4`. Work is organized by ownership of files and interfaces; existing deployment documentation changes are preserved.

## Delivery sequence

1. **Establish product truth.** Inspect actual workflows, provider resolution, credential handling and existing acceptance. Agree the three-destination navigation and the difference between model, speech voice and summary model.
2. **Rebuild the customer surface.** Replace the visual system and simplify navigation, assistant setup and contextual testing. Keep current routes, API contracts and async recovery. Independently inspect the rendered desktop and mobile app.
3. **Make backend choices trustworthy.** Audit effective Kataleptic configuration against Azure deployment model metadata; expose qualified model identity and adapter capabilities; reject silent substitution of explicit unknown selections. Test calls and previews against the same resolver.
4. **Implement portable recipes.** Add a bounded versioned schema and import review/export controls. Apply to the destination editor draft; preserve the ordinary save, authorization and compatibility checks.
5. **Integrate and validate.** Run focused tests for touched contracts, then typecheck, full tests, build and applicable browser tests. Verify existing provider selections, data and deep links remain usable.
6. **Complete release acceptance separately.** Validate exact candidate on staging, run authorized real-provider/listening comparisons, and record results in the existing launch process. Production deployment, remote migrations and carrier spending require separate authorization.

## Architecture contract

The implementation retains the tested call lifecycle while separating these responsibilities:

| Boundary | Responsibility | Existing implementation |
| --- | --- | --- |
| Assistant configuration | Name, behavior, language, voice and model choices; no credentials | Assistant records and portable recipe schema |
| Provider configuration | Capability-specific endpoints, credentials and defaults | `src/provider-settings.ts`, `src/providers.ts`, summary settings |
| Provider adapter | Translate a selected capability into the provider's protocol and normalize events | `src/realtime-providers.ts`, `src/gpt-live.ts`, pipeline providers |
| Model descriptor | Explain configured identity, technology and verification limits | Provider/model catalog metadata; does not itself authenticate an upstream deployment |
| Conversation orchestration | Grounding, input/output pacing, interruptions, tools, hangup and persistence | `src/call-session.ts` and bounded audio helpers |
| Channel adapter | Browser, optional Telnyx and Asterisk transport/lifecycle | Widget/voice transport and carrier-specific modules |
| Host adapter | Worker bindings, D1 persistence and Durable Object lifetime | Existing Cloudflare deployment; not replaced in this iteration |

New backend support must supply a compatible capability adapter and its own contract tests. A text endpoint cannot impersonate realtime, a realtime WebSocket URL cannot automatically use an arbitrary protocol, and a browser speech voice cannot supply telephone audio. Assistant recipes refer to model/voice selections without encoding a host's secret or account ownership.

A future host-portability project should extract `ConversationStore`, `CredentialResolver`, `SessionTransport` and `Clock` interfaces from the call lifecycle before adding a second host. Acceptance requires the same tenancy, bounded memory/backpressure, interruption, finalization and persistence suites on both hosts. Merely renaming Cloudflare types is not portability.

## Acceptance matrix

| Area | Required check | Evidence status |
| --- | --- | --- |
| Product workflow (UX1–6, UX8) | Three primary destinations; setup → test → publish → review; old deep links | Implemented; native setup/editor review and targeted browser regression coverage |
| Visual/accessibility (UX7) | Independent desktop/mobile rendered review; keyboard focus; error/empty/loading; overflow | Native desktop and 390px mobile review complete; two material layout issues corrected and rechecked |
| Routing (BE1–5, ID3) | Supported IDs retained; explicit unknown/retired model rejected; default inheritance intentional | Implemented; independent 135-test routing/preview/GPT-Live run passed |
| Kataleptic identity (ID1–2, ID4) | Effective gateway mapping compared with Azure model/version metadata; duplicate detection; dated sanitized findings | Four native Azure model identities verified in a deployment snapshot; HD configured model only. See [routing evidence](kataleptic-routing.md). |
| Voice behavior (BE2, ID3–5) | Same requested model/voice for preview and call; runtime acceptance separate from listening | Wrong/missing preview voice and unsupported GPT-Live selections rejected in synthetic tests; no new audible comparison performed |
| Portable configuration (PO1–2) | Round-trip; strict types/version/size; unknown credential/ownership fields rejected; review before draft apply | Implemented; 25 schema tests and real local-worker browser recipe flow passed |
| Destination safety (BE3, PO3–4) | No endpoint/credential mutation; ordinary authenticated save and compatibility failures | Recipe browser test preserved destination provider, IDs, publication state and knowledge attachments; cross-provider selection retention tested |
| Host portability (PO5) | Explicit portable configuration/adapter boundaries and hosting limits | Recipes and provider registry implemented; Workers/D1/Durable Objects remain the host |
| Regression | Typecheck, unit/API suite, build, relevant browser flow | Final assembled typecheck, **1,985 tests across 82 files**, and build passed; scoped browser results below |
| Deployment | Exact-candidate staging validation and authorized rollout | Not authorized by the remake request |
| Physical audio/PSTN | Real microphone/speaker and consented carrier tests | Existing release gates remain; synthetic tests insufficient |

## Model comparison protocol

Use a dedicated test assistant with the same approved business facts and language for each route. Record gateway model ID, effective configured Azure model/version, adapter, selected/acknowledged voice and evidence source/time. Note that summary routing is independent.

For every distinct model, ask one known-hours question, one unknown question, one callback request with and without a number, interrupt a long reply, and end the conversation. Check spoken output, response behavior, live transcript, saved turns, summary and callback fields. Repeat failed scenarios after any fix; retain the original failure in the evaluation record. Compare response latency and actual provider usage only when measured; do not infer either from model names.

Use the same native voice when comparing reasoning within one compatible family, then deliberately vary voices to compare speech character. For cross-family comparisons, record renderer differences rather than pretending voice labels are universal. Two outputs sounding similar neither establishes nor disproves distinct models. Configuration identity, runtime confirmation and human listening address different questions.

## Migration and rollout

Prefer additive UI/schema contracts and preserve saved configuration. Explicit retired-model errors need actionable UI recovery; they must not silently rewrite a saved choice. Portable recipe import changes only an editable assistant draft until saved. It does not replace the workspace, attach foreign knowledge collections or activate a public link.

No remote schema operation is required merely to rearrange UI or add local recipe transfer. Any later migration has its own backup/rehearsal/approval gate. Keep source/Worker/migration status in `docs/launch/production-preflight.md`, and live-provider/physical-call acceptance in `docs/launch/readiness.md`; this plan does not supersede either.

## Review and verification ledger — 2026-09-27

The independent review used native Codex Browser with a synthetic local account on an isolated test Worker. It inspected onboarding, Conversations, Assistants and the editor on desktop, then the editor, recipe controls and Settings at 390px. The reviewer found a Settings callout with no inner padding and a sticky business-save bar obscuring provider actions. Both were corrected and visually rechecked. The saved `PRODUCT.md`, `DESIGN.md` and workspace surface brief describe the implemented system. This was a local visual/functionality review, not a customer usability study or a comprehensive accessibility certification.

Backend review found another way different selections could sound alike: an unsupported GPT-Live voice was normalized to an empty voice, selecting the default. The fix rejects explicit unsupported voices before connecting, during preview and on assistant save; blank intentionally continues to use the service default. The independent rerun of `test/gpt-live.test.ts`, `test/voice-preview.test.ts`, `test/backend-registry.test.ts` and `test/realtime-providers.test.ts` passed **135 tests**.

Portable recipe validation:

- `npx vitest run test/assistant-config.test.ts` — **25 passed**: round-trip, field limits, byte budget, format/version/type checks, unknown credential/ownership rejection, custom IDs and destination voice retention.
- `OPENFON_E2E_PORT=8793 OPENFON_E2E_INSPECTOR_PORT=9236 npx playwright test e2e/assistant-recipes.spec.ts` — **1 passed** against a real local Worker: download, malformed import rejection, review before apply, apply before save, persistence and unchanged destination connections/ownership/knowledge.
- The first recipe browser launch specified only HTTP port 8793 and failed because inspector port 9232 was occupied. It performed no browser assertions; the isolated rerun above passed.
- Impeccable's detector on `web/src/AssistantTransfer.tsx` — no findings. The frontend design pass reported token/type-scale advisories on other UI files; the rendered review addressed material visual issues separately.

The first assembled `npm run typecheck && npm test && npm run build` passed typecheck, then reported **1,972 passed / 13 failed** tests across provider activation/create/write-race fixtures; build was not reached. Strict model validation caused formerly accepted placeholder model IDs to fail before those tests reached their synchronization barriers. The corrected race fixtures use their intended custom-compatible provider; canonical Kataleptic activation fixtures use supported model/voice IDs. Production validation was not relaxed. The affected files and catalog tests then passed **89 tests**. Review also caught a mixed-modality streaming-transcription catalog entry falling through to a text suggestion; these entries are now excluded before capability classification.

Targeted browser regressions passed in scoped runs: **17/17** launch/guided-voice/settings/navigation cases, **6/6** voice-preview and provider-preset cases, and **2/2** navigation/provenance cases including repair of a saved retired model. Call-summary, prompt-example and playback cases also passed in the design pass; two initial old-label assertions were corrected and rerun successfully. Counts describe those individual runs and should not be summed as distinct tests.

The final assembled rerun of `npm run typecheck && npm test && npm run build` passed: **82 test files, 1,985 tests**, successful Worker/web typecheck and Vite production build. The only subsequent runtime change scoped the custom-model picker to its provider and preserved the current selection when opening it; guided-voice/navigation regression tests passed **4/4**, followed by a fresh final typecheck/build. `git diff --check` was clean. Public canonical/sitemap metadata was intentionally omitted by the local build because `OPENFON_PUBLIC_URL` was unset.

The implementation is locally validated. Exact-candidate staging, new real-provider listening comparisons, physical microphone/speaker acceptance and PSTN remain unperformed. No production deployment, remote migration or carrier purchase occurred. Existing deployment-status edits in the launch documents were preserved. The temporary native review tab was closed and its mobile viewport override reset; the frontend preview remains available for reviewing the result.
