# Clean-room functional contract

This document describes product behavior from Worker/domain code. It imposes no navigation, layout, component, editor, or visual system. The product lets a business configure a voice receptionist, teach it business facts, rehearse conversations, make it available, and inspect conversations and callback requests. Provider connections remain interchangeable.

## Domain and authentication

- One signed-in account owns one workspace (`Business` in storage). Workspace facts include name, description, address, phone, website, timezone, hours and closures. Existing JSON-backed hours/closures must survive unrelated writes.
- A workspace has up to 32 assistants. Each has a public slug, `draft | active | paused` state, name, greeting, persona, language, message-taking flag, custom instructions, conversation engine, and optional model/voice overrides. No credential belongs to an assistant.
- A collection groups knowledge; assistants explicitly attach collections. Items are `faq | service | note`, independently `draft | active`. Calls consume only active items from attached, owned collections.
- A conversation records assistant, channel, environment (`test | live`), direction, timestamps, status, summary, intent, callback/contact JSON, outcome, failure information, and caller/agent transcript turns.
- POST `/api/auth/signup` and `/api/auth/login` take `{email,password}` and establish an HTTP-only session cookie. POST `/api/auth/logout` retires it. GET `/api/me` returns account or 401. Password minimum is eight characters. All private APIs enforce ownership server-side; same-origin writes are required.
- GET `/api/me/bootstrap` returns `{account,workspace,assistants,setup,readiness}`. A missing workspace is `null`, not an error. `setup` has account/workspace/firstAssistant/firstTest booleans. `readiness.providerConfigured` means key presence; `firstTest` means a test connected at least once. Neither means successful audio or provider acceptance.

## Create, configure and rehearse

POST `/api/me/business` takes partial workspace fields with a required name. It atomically creates a blank primary draft assistant, a default collection, its attachment, and provider settings. Repeated creation returns the canonical existing workspace. Complete the created primary assistant rather than unintentionally creating a second one. PUT `/api/me/business/:id` updates workspace facts; send changed fields only.

GET `/api/me/assistants` returns bounded summaries, not complete editable records. GET `/api/me/assistants/:id` returns all fields plus `collectionIds`. Fetch this complete record before editing. POST `/api/me/assistants` creates a draft with required name; defaults persona/language/message taking/engine where omitted. PUT `/:id` saves partial configuration and returns the acknowledged complete assistant. Never claim a save succeeded before receiving success. A test uses saved server configuration, not unsaved browser fields.

POST `/:id/activate` makes an assistant available at its public browser URL. It requires name/persona/language and compatible provider/model/voice choices. POST `/:id/pause` prevents new public availability. This is not a carrier routing or production deployment action. DELETE `/:id` refuses primary assistants, active assistants, active/reserved calls, or attached carrier routes.

POST `/:id/test-calls` creates an owner-authenticated browser test ticket `{callId,assistantId,environment:'test'}`. DELETE `/api/me/test-calls/:callId` cancels an unused ticket idempotently; it never terminates an established call. A call is connected through `/ws/call/:callId` using the session cookie. Tickets are single-use. Cancel tickets when starting is abandoned before connection.

The UI-independent `VoiceCall` transport handles microphone capture, pipeline utterance encoding, realtime PCM, audio receipts, interruption, browser synthesis fallback, and graceful ending. Call `prepareAudio()` synchronously during the start gesture before network awaits, then `connect(callId)`. `sendText(text)` permits typed participation. `hangup()` stops the session and device resources. Subscribe to status, transcript, agent_text, thinking, speaking, level, engine, and audio events. Microphone denial permits text-only participation and must be described honestly. Audio playback blocked/error requires a visible enable-audio recovery action. Do not call a failed or merely connected session a successful rehearsal.

GET `/api/public/agent/:slug` returns `{assistantId,businessName,agentName,language}` only for an active assistant. POST `/api/public/call/start` takes `{slug}` and returns `{callId}`. The documented public route is `/call/:slug` (README). Public calls count as live calls even when they originate in a browser.

POST `/api/me/assistants/:id/voice-preview` takes exactly `{engine,language,voice,realtime_model,realtime_voice}` for a short audio sample, returning WAV. This is a saved-provider / draft-voice preview; it does not save assistant changes or validate a complete conversation. Browser synthesis previews happen on the device. Full rehearsals, provider checks, and server voice previews can invoke configured AI providers and have bounded budgets; never run them implicitly just to render a page.

## Knowledge and grounded answers

- GET/POST `/api/me/knowledge/collections` list/create collections. GET `/collections/:id` returns collection details, attached assistants and a 20-item page `{items,nextCursor}`. PUT/DELETE update/remove a collection. The default collection cannot be deleted.
- POST `/collections/:id/items` creates a typed item, default draft. GET/PUT/DELETE `/api/me/knowledge/items/:id` read/update/delete. An active FAQ needs question and answer; an active service needs title; an active note needs content. Retain drafts until users deliberately approve their content.
- POST/DELETE `/api/me/assistants/:assistantId/knowledge-collections/:collectionId` attach/detach existing collections. Merely creating a collection does not attach it.
- POST `/api/me/knowledge/drafts/from-turn` takes `{callId,turnId,collectionId?}`. Only an owned caller turn may become an FAQ draft; its question is copied, answer is blank, and source provenance is retained. It never invents or activates an answer.
- Knowledge loading has real limits: at most 32 oldest active items, each at most 8 KiB of prompt fields, within a 32 KiB overall prompt budget. Large or newer entries can fall outside the call context; do not promise that every saved item is included. Source: `src/call-knowledge.ts`.

## Conversations, messages and outcomes

GET `/api/me/calls` supports `environment` (defaults live; explicitly use all/test where required), assistantId, status, intent, direction, search, from/to, cursor and limit. It returns `{items,nextCursor}`; results are newest first. Dates are RFC 3339 with timezone; `from` is inclusive, `to` exclusive. Search covers caller, summary and turns. GET `/api/me/calls/:id` returns detail and ordered turns `{id,role,text,ts}`. SQLite timestamps without offsets are UTC.

`message_json` parses as `{caller_name,caller_phone,message}`. A phone or name alone is not a callback message. The outcome `message_taken` requires a nonblank message; other normal outcomes include `booking_requested` and `answered`; failures retain failure status and context. A booking request is not a confirmed appointment. No callback-completed update, outbound callback trigger, booking integration, or owner-authored conversation mutation API is present. Do not invent these capabilities. Summaries are generated at call finalization and may arrive after ending; transcripts are persisted separately. Refresh a concluded conversation to retrieve final state.

GET/PUT `/api/me/call-summaries` configures summary generation independently with mode `legacy | workspace | custom`. The update must contain `{mode,baseUrl,model,apiKey,revision}`; revision is the value last read (including null). Conflicts are explicit 409s. A custom summary provider needs a distinct key, endpoint, and model.

## Pluggable providers and secrets

GET `/api/me/provider` returns masked connection settings, effective defaults, key-presence booleans, text presets, and optional dated routing evidence. PUT uses the fields below; omitted keys retain valid saved values. Never persist replacement keys to browser storage, logs, recipes, or draft recovery. Read responses never return their secret values.

| Capability | Selection and write fields |
| --- | --- |
| Text | `baseUrl`, `model`, `apiKey`, `clearApiKey`; advertised presets include instance, Kataleptic, OpenRouter, Hugging Face, OpenAI, custom OpenAI-compatible |
| Realtime | `realtime_provider`: instance/Kataleptic/OpenAI/custom; `realtime_base_url`, `realtime_api_key`, `realtime_clear_api_key`; model/voice override belongs to assistant |
| Transcription | `stt_provider`: instance/OpenAI/custom; `stt_base_url`, `stt_model`, `stt_api_key`, `stt_clear_api_key` |
| Synthesis | `tts_provider`: instance/browser/Azure/OpenAI/custom; `tts_base_url`, `tts_model`, `tts_api_key`, `tts_clear_api_key`; voice belongs to assistant |

Instance selections inherit operator configuration. Explicit providers require their own keys and do not borrow another component's keys. Changing a saved endpoint requires a replacement key or explicit removal; keys stay bound to the destination that was authorized. Realtime endpoints require secure WebSockets (operator local opt-in exception) and no query/fragment. Direct OpenAI endpoints/models/voices have compatibility rules; custom adapters retain their model namespaces. Backend validation is authoritative.

GET `/api/me/provider/catalog` provides models by capability and voices by exact realtime model, plus `live` indicating catalog retrieval. Offline fallback is useful but must not be called a live connection check. Kataleptic routing evidence is dated configuration/deployment evidence with `liveSessionVerified:false`, never proof about a new session. Preserve instance defaults; do not infer that every engine choice uses a distinct serving model.

POST `/api/me/provider/check` with `{assistantId}` sends a minimal text generation request using saved configuration. It validates text generation only, not transcription, synthesized audio, realtime calling, or physical telephony.

GET/POST `/api/me/engine-presets`, PUT/DELETE `/:id`, POST `/:id/apply` with `{assistantId}` manage reusable engine/model/language/voice settings. These never include credentials or endpoint snapshots and are checked against the current provider when applied.

## Secret-free recipes

Use the UI-independent versioned recipe parser/exporter. JSON shape is `{format:'openfon-assistant',version:1,assistant:{...allowlisted fields}}`, maximum 64 KiB. Only behavior, engine, language, model and voice fields transfer. IDs, state, workspace facts, knowledge, conversation history, URLs, keys, and provider connection settings are excluded. Unknown fields/versions are rejected. Import remains a local review until **Save this recipe** explicitly persists it; users may retain destination engine/language/voice choices. Export serializes an explicit allowlist, never arbitrary API response spreads.

## Failure and persistence guarantees

- Preserve editable drafts when save fails. Distinguish loading, missing data, no results, offline/transport errors, authentication expiration, and successful saves. Do not replace known data with invented examples.
- Surface backend validation text (400), unauthorized session (401), forbidden operation (403), missing record (404), concurrent change/limits (409), oversized request (413), rate limit (429 with Retry-After), and provider failure (502). Never automatically replay uncertain mutations.
- Concurrency protection varies by route. Assistant/provider/knowledge updates compare server snapshots during each request; summary settings have an explicit client revision. Do not claim universal protection from an older browser draft overwriting a newer save.
- Reloads recover acknowledged server state. Local unsaved drafts are not durable unless intentionally implemented, scoped to the signed-in owner, and free of secrets. Clear sensitive state on logout. A logout failure is not a completed logout.
- Activation, connection checks, tests, public sharing, carrier routing, staging deployment, production deployment and physical-call acceptance are distinct states. No deployment, migration, or carrier spend is part of this frontend rebuild.

Typed client and helpers live in `web/src/cleanroom-runtime`. Primary evidence: `src/index.ts`, `src/studio-api.ts`, `src/types.ts`, `src/provider-settings.ts`, `src/provider-catalog.ts`, `src/call-session.ts`, `src/call-knowledge.ts`, and `src/summary-settings.ts`.
