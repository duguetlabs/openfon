# Released Web voice worker

This candidate preserves the released OpenFon application and uses LiveKit for browser audio and direct operator Azure inference. It does not replace authentication, business APIs, public links or call history with the prototype application. Telephone integrations remain on their existing transports.

## Operator setup

Use Node 22.22 or newer (development: 24.20.0). Install the root and worker dependencies with `npm ci` and `npm --prefix voice-agent ci`. Build the worker with `npm --prefix voice-agent run build`.

A LiveKit server and this long-running Node worker are required **in addition** to the Cloudflare application. Cloudflare Workers cannot run the Node agent. The browser must be able to reach LiveKit over secure WebSocket/WebRTC; LiveKit also needs appropriate TURN/UDP connectivity. The agent must reach LiveKit, Azure and the application's operator callback route.

Configure the Cloudflare application:

- `WEB_VOICE_TRANSPORT=livekit` (absent means the existing transport).
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- `LIVEKIT_AGENT_SERVICE_TOKEN`: a separate high-entropy operator credential.
- `OPENFON_MANAGED_WEB=true`: operator-controlled managed edition; it also enables the LiveKit browser transport.
- `AZURE_OPENAI_ENDPOINT`: HTTPS Azure resource root, with no path, query or embedded credentials.
- `AZURE_OPENAI_API_KEY`: operator resource credential.
- `AZURE_OPENAI_LIVE_DEPLOYMENT=gpt-live-1` and `AZURE_OPENAI_TEXT_DEPLOYMENT=gpt-5.4-mini` (these defaults are pinned; unsupported deployments fail setup).

Configure the Node process:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`: the same LiveKit service.
- `OPENFON_API_URL`: the application origin. HTTPS is mandatory except loopback development.
- `OPENFON_AGENT_SERVICE_TOKEN`: matches the application's service token.
- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`: the same authorized Azure resource, provisioned through the vault/environment.
- `OPENFON_USAGE_DIR`: an absolute, persistent, restricted writable directory, separate for staging and production.

Then run `npm --prefix voice-agent start`. It registers as `openfon-released-web`. The application creates each room before dispatching its agent. For loopback development a separately installed LiveKit server may run with `livekit-server --dev --bind 127.0.0.1`; its documented development key/secret are for that loopback instance only. A local application must use local D1 and local Durable Objects. Do not point a local candidate at production state.

Saved voice compatibility preserves the released default: when both stored voice fields are empty, the effective voice remains Marin, without rewriting the assistant. A nonempty saved selection must be supported; it is never replaced by that default. New assistants store their chosen default explicitly, and blank customer edits remain invalid. Browser and carrier admission resolve the same saved fields; carrier reservation pins both fields before starting a call.

Inference is pinned to genuine `realtime.GPTLiveModel`, `gpt-live-1`, mono PCM 24 kHz and delegated `gpt-5.4-mini` with `maxOutputTokens: 512`. Voice/persona instructions belong to `voice.Agent`. Model, voice, format and delegated-model acknowledgements are checked. No alternative model or speech fallback is used. Wire debug logging must stay disabled.

## Self-hosted infrastructure

LiveKit Cloud is optional. A self-hosted LiveKit server carries audio; the Node worker coordinates the call and connects directly to Azure for inference. Neither service requires an inference GPU. The existing Cloudflare application, D1 database and Durable Objects remain the account, transcript and call-lifecycle authority.

The worker has a separate container build: `docker build -t openfon-voice-agent voice-agent` from the repository root. Its build context allowlist excludes credentials, local state and recordings. The runtime uses a non-root user and a digest-pinned Node image. Supply the operator settings listed above only at runtime. The image does not include a LiveKit server, TLS termination or a TURN relay.

The existing Azure Linux VM hosts separate staging and production LiveKit/Node services. Keep their credentials, rooms, usage volumes and callback origins separate. The existing Cloudflare application and state remain in place. Changing inference routing does not change the media network, certificates or telephone carrier transport. This source change alone does not establish a new Azure deployment or high-availability guarantee.

## Migration and existing choices

Apply additive migration `0025_livekit_call_events.sql` **before** enabling the flag. It adds transcript source ID, revision and finality; historical rows remain final and unchanged. No assistant, account, credential, engine choice or public link is rewritten. Remote migration and deployment are separate approval gates.

The managed flag pins Web browser and carrier inference, previews and post-call processing to operator Azure configuration. It does not rewrite saved assistant/provider choices or credentials. Managed voices are the compatible saved selection; incompatible choices require explicit correction. Carrier admission retains route/account ownership, source snapshot and quota checks. The unmanaged mode retains existing provider choices.

Voice previews use direct Azure's selected GPT-Live voice and live audio protocol without creating a LiveKit room. Call summaries and structured actions use direct Azure Responses independently of voice selection. Apply the product/action and usage-ledger migrations with the corresponding release before enabling managed processing. Do not remove additive columns on rollback. Operator rollback must restore a reviewed complete Worker/Node/configuration pair; toggling the flag alone does not turn this direct-Azure Node build into the older gateway build.

The pinned LiveKit SDK has a minimal reproducible authentication extension: `scripts/patch-livekit-azure.mjs` verifies exact source/distribution hashes for version 1.9.1, adds an `api-key` header option, and leaves the default bearer behavior unchanged. Installation fails on unexpected hashes. No dependency version is silently replaced.

## Usage evidence and recovery

Provider voice seconds remain cumulative decimal seconds; delegated token counters retain response identity and distinguish input, output, cached and reasoning subsets. Provider cost and customer billing are separate. Missing provider usage stays unknown; it is never replaced by zero or local wall time. Customer service duration uses server-owned start/stop timestamps and preserves failed calls too.

Before a paid Node session, the persistent usage volume must be writable and have capacity. Each observation is durably written before callback delivery and deleted only after acknowledgement. Local writes have a separate serial queue from ordered callback delivery, so a slow callback cannot delay writing a later terminal snapshot. Shutdown checks local persistence separately from remote delivery, with a seven-second deadline for each wait. A local disk/lock timeout is unconfirmed durability, not proof that all pending records survived; late persistence failures remain observed. Disk/capacity failure remains explicit, never a claim that queued memory was durable or that missing usage was zero. Replay reserves a bounded rotating batch using an atomically persisted filename cursor, so persistent failures do not starve later calls across supervisor restarts. Cursor metadata does not change observation identity, payload or original expiry; unconfirmed delivery never deletes a record. Restarts replay the original identity and timestamp. Files are mode 0600 in a 0700 directory, capped at 1,000 records of 16 KiB each. They contain numeric usage, call/room/job identity and a callback capability, never audio, transcripts, provider credentials or destination URLs. Protect this volume as sensitive. Revoked/deleted/malformed records are quarantined; records expire after seven days, with numeric backlog/expiration diagnostics. An active writer's lock is never expired by a timer. The journal publishes a fully initialized lock directory with a unique owner identity for each acquisition; stale-process recovery removes only that observed identity. Use a local filesystem with atomic directory rename (the deployment uses a local bind-mounted volume), not a shared network filesystem.

For an upgrade from the old fixed-name `writer.lock/pid` protocol, stop **all** supervisor and job processes using that environment's volume before starting the new image. Do not run old and new writers concurrently. A leftover legacy lock or unknown lock contents deliberately blocks admission; age alone never authorizes deletion. With all writers stopped, inspect the selected environment's usage directory and remove only the stale `writer.lock` directory after confirming its owner is gone. Keep all `.json` and `.dead` usage records. A crash before lock publication can leave an unused `.writer-<uuid>` candidate directory; it contains only lock metadata and may likewise be removed with all writers stopped. New-format locks left by a dead process recover automatically. Startup checks must verify this migration condition rather than assume the volume is empty.

Carrier usage uses Durable Object storage and the same idempotent ledger. The existing graceful provider close waits at most two seconds; missing final usage records an unknown, non-final observation and does not extend the call. Node close and callback flush also have explicit deadlines. Uncertain usage delivery remains queued for reconciliation. Call summary attempts are admitted once before inference; an ambiguous crash/failure does not silently pay for a second attempt. Invalid or partial extraction preserves usage but never seals a successful action snapshot.


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

Vendor SDK logging is set to the supported `silent` level in the supervisor and inherited job-process options, and reapplied at each job entry. The pinned SDK’s `lk.pii.*` attributes are not redacted on stdout, so its raw payload/error logging is deliberately disabled. OpenFon’s separate structured diagnostics remain enabled; process exits and health checks still expose availability failures.

Node startup diagnostics contain only a validated call identifier, fixed phase names and capped counts. They distinguish AgentSession startup, accepted provider startup, readiness acknowledgement, speech-handle creation and the provider `_generateReply` authorization seam. In pinned SDK 1.9.1, `openai_client_event_queued` fires inside `wsSend` immediately before the socket send: the commentary count establishes a send attempt, while `session.commentary.appended` establishes the provider acknowledgement. Neither logs content. Idle-frame counts establish forwarding to the SDK, not network delivery. At most twelve periodic count snapshots and one final snapshot are emitted per call; no raw audio, text, tool arguments, tokens or provider payloads enter these diagnostics.

Local tests cover real SQLite migration/revisions/isolation, scoped callback admission, SDK-matched microphone grant serialization/signatures, SDK transcript streams, selected routing, and controlled browser cancellation/speaking/audio cleanup. The separate `node voice-agent/scripts/local-rtc-smoke.mjs` check uses an already-cached, pinned Docker LiveKit image on loopback and synthetic PCM. It passed room/dispatch creation, SDK-authenticated microphone publication and receipt of 20 nonzero frames (4,800 samples), then removed its own container and disposed the native SDK. It makes no provider calls. This does not establish composed application/provider or physical-noise acceptance. Remaining release gates are in `docs/launch/readiness.md`; no deployment is implied by this candidate.
