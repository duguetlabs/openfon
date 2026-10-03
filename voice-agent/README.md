# Released Web voice worker

This candidate preserves the released OpenFon application and moves browser audio to LiveKit. It does not replace authentication, business APIs, public links or call history with the prototype application. Telephone integrations remain on their existing transports.

## Operator setup

Use Node 22.22 or newer (development: 24.20.0). Install the root and worker dependencies with `npm ci` and `npm --prefix voice-agent ci`. Build the worker with `npm --prefix voice-agent run build`.

A LiveKit server and this long-running Node worker are required **in addition** to the Cloudflare application. Cloudflare Workers cannot run the Node agent. The browser must be able to reach LiveKit over secure WebSocket/WebRTC; LiveKit also needs appropriate TURN/UDP connectivity. The agent must reach LiveKit, Kataleptic and the application's operator callback route.

Configure the Cloudflare application:

- `WEB_VOICE_TRANSPORT=livekit` (absent means the existing transport).
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- `LIVEKIT_AGENT_SERVICE_TOKEN`: a separate high-entropy operator credential.
- `REALTIME_API_KEY`: operator Kataleptic key for voice samples.

Configure the Node process:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`: the same LiveKit service.
- `OPENFON_API_URL`: the application origin. HTTPS is mandatory except loopback development.
- `OPENFON_AGENT_SERVICE_TOKEN`: matches the application's service token.
- `KATALEPTIC_API_KEY`: authorized Kataleptic key; provision through the vault/environment, never through customer data or a tracked file.

Then run `npm --prefix voice-agent start`. It registers as `openfon-released-web`. The application creates each room before dispatching its agent. For loopback development a separately installed LiveKit server may run with `livekit-server --dev --bind 127.0.0.1`; its documented development key/secret are for that loopback instance only. A local application must use local D1 and local Durable Objects. Do not point a local candidate at production state.

Inference is pinned to genuine `realtime.GPTLiveModel`, `gpt-live-1`, mono PCM 24 kHz and delegated `gpt-5.4-mini` with `maxOutputTokens: 512`. Voice/persona instructions belong to `voice.Agent`. Model, voice, format and delegated-model acknowledgements are checked. No alternative model or speech fallback is used. Wire debug logging must stay disabled.

## Self-hosted infrastructure

LiveKit Cloud is optional. A self-hosted LiveKit server carries audio; the Node worker coordinates the call and connects to Kataleptic for inference. Neither service requires an inference GPU. The existing Cloudflare application, D1 database and Durable Objects remain the account, transcript and call-lifecycle authority.

The worker has a separate container build: `docker build -t openfon-voice-agent voice-agent` from the repository root. Its build context allowlist excludes credentials, local state and recordings. The runtime uses a non-root user and a digest-pinned Node image. Supply the operator settings listed above only at runtime. The image does not include a LiveKit server, TLS termination or a TURN relay.

The proposed Azure deployment is a dedicated Linux VM in Europe running the self-hosted LiveKit service and worker, with secure signaling, WebRTC media connectivity and TURN fallback. Ordinary HTTP-only hosting is insufficient. Keep staging and production credentials, rooms and callback origins separate. VM size, region, cost, network configuration and resource creation remain pending selection of the billing subscription and budget. No Azure deployment, high-availability guarantee or Azure audio acceptance is established by the container build.

## Migration and existing choices

Apply additive migration `0025_livekit_call_events.sql` **before** enabling the flag. It adds transcript source ID, revision and finality; historical rows remain final and unchanged. No assistant, account, credential, engine choice or public link is rewritten. Remote migration and deployment are separate approval gates.

The browser feature flag intentionally routes Web calls through GPT-Live regardless of historical engine selection. It does not change telephone routing. The saved voice field for the assistant's existing engine remains authoritative. Compatible voices appear in the existing voice menu; an incompatible saved voice fails explicitly and must be changed deliberately. Samples use the same selected GPT-Live voice and Kataleptic speech protocol, using the existing bounded sample generator rather than a LiveKit room. Its Worker key and the Node key must have access to the same service. Changing a voice does not change summary configuration.

Disable the flag to restore the original browser transport; retain the additive migration and saved transcript rows. Do not remove columns on rollback.

## Lifecycle and transcripts

The original authenticated WebSocket and CallSession Durable Object still admit and own the call. The browser token permits only its own microphone publishing (the installed SDK serializes the numeric grant input as the string `microphone` in JWT claims); the agent subscribes only to the admitted caller. Room creation, dispatch and cleanup use operator credentials. Callbacks require both a separate service credential and a per-call capability pinned to one job and room.

Caller partials use GPT-Live's stable item ID. Assistant partials observe the installed SDK's generation message ID and unchanged text stream. Raw output deltas do not invent identities. Both update the existing transcript UI in place; SDK final messages reconcile to the same stored row. Only final rows enter the original summary/action-extraction path. Partial rows remain recoverable evidence, not confirmed action evidence. Callback retries use the same ID/revision. Queue, field and transcript limits fail explicitly.

Typed messages use the same admitted agent, including microphone-denied sessions. Commands are acknowledged before inference and never replayed after ambiguous delivery; an interrupted handoff may therefore fail a call rather than duplicate inference. Speaking animation follows LiveKit active speakers/audio levels and clears on silence, reconnect, cancellation and disconnect.

A successful end-call request schedules a brief spoken goodbye and waits for SDK playout before shutdown. This is server-side playout evidence, not proof that a physical speaker was audible. Failure/cancellation stops input and closes the provider; shutdown drains transcript callbacks before completion. Deadlines limit waiting but do not claim cancellation of an unresolved promise. The job is shut down after cleanup. Missing transcript completion is recorded as failure rather than clean success.

The worker acknowledges readiness only after the provider accepts the checked configuration and an actual nonzero audio frame passes through the SDK message output. Tool-only generations, empty streams and silent frames do not qualify. Until then, the existing 90-second application startup deadline remains active and the worker continues polling for cancellation or admission loss. Provider acknowledgement itself uses a bounded 15-second wait. The initial greeting request's stored SDK failure is recorded without suppressing later autonomous speech; explicit typed replies and goodbye completion inspect stored SDK errors rather than assuming a resolved playout promise means success. Legitimate interruption is cancellation. Idle input follows scheduled 100 ms slots without replaying missed frames or producing catch-up bursts.

Existing debug **audio recording is not implemented for this transport**. The debug-config response disables that promise for LiveKit calls; transcripts are still persisted. Do not advertise audio-replay debugging until separately implemented and tested.

## Validation boundaries

Run root `npm run typecheck`, `npm test`, `npm run build`, plus worker `npm --prefix voice-agent test` and `npm --prefix voice-agent run build`.

The operator smoke harness requires an explicit deployment grant and paid-inference permission. `node voice-agent/scripts/staging-call-smoke.mjs --stage-ready --allow-paid --typed-only` runs one disposable-account typed call against the fixed staging application and signaling hosts. The separately authorized production equivalent replaces `--stage-ready` with `--production-ready`, targeting only `https://openfon.ai` and `wss://voice.openfon.ai`; the two environment flags are mutually exclusive. Omitting `--typed-only` runs two previews, two synthetic spoken calls, and one typed call, so its larger scope must also be authorized. It preserves restricted local evidence and deletes its own account. A failed call is read through its normal owned API before cleanup; safe control event types/timings are retained without grants or credentials. These commands do not establish physical microphone or subjective voice identity acceptance.

Node startup diagnostics contain only a validated call identifier, fixed phase names and capped counts. They distinguish AgentSession startup, accepted provider startup, readiness acknowledgement, speech-handle creation and the provider `_generateReply` authorization seam. In pinned SDK 1.9.1, `openai_client_event_queued` fires inside `wsSend` immediately before the socket send: the commentary count establishes a send attempt, while `session.commentary.appended` establishes the provider acknowledgement. Neither logs content. Idle-frame counts establish forwarding to the SDK, not network delivery. At most twelve periodic count snapshots and one final snapshot are emitted per call; no raw audio, text, tool arguments, tokens or provider payloads enter these diagnostics.

Local tests cover real SQLite migration/revisions/isolation, scoped callback admission, SDK-matched microphone grant serialization/signatures, SDK transcript streams, selected routing, and controlled browser cancellation/speaking/audio cleanup. The separate `node voice-agent/scripts/local-rtc-smoke.mjs` check uses an already-cached, pinned Docker LiveKit image on loopback and synthetic PCM. It passed room/dispatch creation, SDK-authenticated microphone publication and receipt of 20 nonzero frames (4,800 samples), then removed its own container and disposed the native SDK. It makes no provider calls. This does not establish composed application/provider or physical-noise acceptance. Remaining release gates are in `docs/launch/readiness.md`; no deployment is implied by this candidate.
