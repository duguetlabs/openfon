# Realtime provider adapters

OpenFon preserves Kataleptic as the instance default. Direct OpenAI is an explicit
independent transport: selecting an OpenAI model on Kataleptic still uses Kataleptic.

## Configuration

Migration `0010_provider_capabilities.sql` introduced workspace realtime settings.
Current releases also require migrations `0022_workspace_speech.sql` and
`0023_call_summaries.sql`; apply pending
migrations before deploying the matching Worker. See the [component guide](voice-configuration.md)
and [migration/rollback instructions](launch/component-byok.md). In workspace
provider settings, choose OpenAI realtime and save its own API key.
Leave the assistant realtime model empty for `gpt-realtime`, or select a supported
OpenAI realtime model. Use a native OpenAI voice such as `marin`; empty selects the
provider default. Select the OpenAI text preset and supply its key/model as well:
text generation produces post-call summaries, independently of the realtime key.
Configure that model in Settings → Call summaries, outside the voice profile.
Existing configurations retain compatibility mode until explicitly changed.
The existing per-assistant text model overrides the workspace text model.

| Setting | Meaning |
| --- | --- |
| `realtime_provider=instance` | Use operator `REALTIME_PROVIDER` (default `kataleptic`), endpoint, key and model. Gateway endpoints must support header authentication as described below. |
| `realtime_provider=kataleptic` | Workspace gateway endpoint/key; default `wss://api.kataleptic.com/v1/realtime`. |
| `realtime_provider=openai` | Direct OpenAI GA protocol; endpoint pinned to `wss://api.openai.com/v1/realtime`. |
| `realtime_provider=custom` | Experimental OpenAI GA protocol endpoint with its own key, native audio greeting and PCM24 support required. |

Explicit workspace choices never inherit instance realtime or text credentials.
Custom workspace URLs are checked using the same transport/private-address rules
as text endpoints. `ALLOW_INSECURE_LLM_URL=true` is an operator opt-in for isolated
local development. Hostname validation does not prevent DNS rebinding.

For an instance-wide direct setup, set `REALTIME_PROVIDER=openai`,
`REALTIME_BASE_URL=wss://api.openai.com/v1/realtime`, `REALTIME_MODEL=gpt-realtime`,
and a dedicated `REALTIME_API_KEY`. Configure the text endpoint/model/key separately.
Do not put credentials in configuration committed to git; use the deployment secret
store, and `dsecret` for authorized local vault reads in this project.

Direct native calls need neither Azure synthesis nor pipeline STT: the realtime
provider speaks the greeting and emits caller transcripts. Catalogs for the OpenAI
preset are static and provider-specific (owned by the provider settings module).
Pipeline calling remains a separate engine with separate STT/TTS capabilities.

## Protocol and behavior

The Worker upgrades an HTTP request with `Authorization: Bearer …`; it does not
put the OpenAI project key in a query parameter or browser subprotocol. Redirects
are refused. The session uses PCM16 mono 24 kHz, audio output, caller transcription,
and the `end_call` tool. Direct startup waits for a matching `session.updated`
configuration before requesting a greeting. Carrier readiness additionally waits
for the first valid native greeting PCM, queued immediately after the ready event;
ordinary interruption remains enabled once that audio starts. A bounded five-second
wait fails closed if no greeting audio arrives. Browser readiness is unchanged. A rejected or
unconfirmed direct connection fails the call, without falling back to an instance
pipeline. Reconnection retains the existing retry limits and conversation briefing.

Kataleptic gateway connections now use the same Worker HTTP Upgrade transport
with `Authorization: Bearer …`, retaining the gateway protocol and tier-specific
voice, transcription, VAD, readiness and rotation behavior. Both `token` and
`api_key` query aliases are removed from the connection URL, including aliases
already present in an instance endpoint. Model and noncredential routing parameters
remain; explicit workspace endpoints still reject all configured query parameters.
There is no retry using query authentication after a header failure. Existing
credential ownership, five-second connection limits and manual redirect refusal
remain unchanged.

Gateway endpoints must support header authentication. Retained backend commit
`995f35b9b5539417fdf0fd8f991f7a89ea608245` accepts Authorization before query
fallback on both `/v1/realtime` and `/api/v1/realtime` through one handler.
Its header-only GA/beta test source covers `/v1/realtime`; the alias is established
by the shared handler source, not those two tests. This is source compatibility
evidence, not verification of a deployed revision, proxy header forwarding or a
live connection. Older or arbitrary query-only gateway endpoints are unsupported
by this contract. Operators must ensure the endpoint and its proxy support it.
No gateway deployment or endpoint probe is implied by this change.

Removing credentials from the URL avoids this query-retention risk, but cannot
ensure that a remote system never logs Authorization headers. No observed leak,
remote log-policy guarantee or short-lived token exchange is claimed.
Both adapters retain existing turn persistence,
summary finalization and playback-drain hangup handling. Telephone admission uses
the resolved provider's credentials and greeting capability, including workspace
OpenAI credentials when instance AI keys are absent.

Barge-in flushes playback. Direct sessions additionally truncate the model's last
audio item. The current media protocol has no per-item playback acknowledgements,
so the truncation position is an estimate from elapsed delivery time, capped at
emitted PCM duration. It is not an exact browser/handset playback measurement;
network and playback buffering can leave a difference. Exact playback tracking
requires extending the browser and carrier media contract.

Official protocol references (checked 2026-09-12):
[Realtime WebSocket authentication](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime),
[session/audio/events and interruption](https://developers.openai.com/api/docs/guides/realtime-conversations).

## GPT-Live (`gpt-live-1`)

`gpt-live-1` is a full-duplex model with its own protocol, not a Realtime API
tier. It is available only through the Kataleptic gateway: OpenFon derives
`<realtime base>/live/sessions` from the configured realtime URL (by default
`wss://api.kataleptic.com/v1/live/sessions`), with the same header authentication
and credential-alias removal, and no `model` query parameter. Direct OpenAI and
custom realtime providers reject the model at configuration time.

The call runs on the same output admission, pacing, receipts, carrier greeting
gate, transcript budget, closing timeline and hangup as other realtime calls
(`src/gpt-live.ts`, bridged from `CallSession`). What differs:

- **Session.** One strict `session.start` carries the model, instructions, PCM16
  24 kHz in both directions, an optional voice, and a `responses` delegation whose
  only tool is `end_call`. `session.started` must confirm the model, format and
  voice before a caller hears anything. Instructions cannot be updated later.
- **Greeting.** Sent as `session.commentary.append` right after `session.started`.
  Carrier readiness still waits for the first audible greeting audio.
- **Audio.** The service streams output continuously, silence included. OpenFon
  forwards speech and pauses up to 300 ms and drops longer silence, so browser
  and carrier playback queues drain as they do for other tiers. μ-law passthrough
  was verified against the service but is not used: the resampling lives in the
  carrier adapters, and the session contract stays PCM24 for every engine.
- **Interruptions.** Full duplex: no VAD settings, no flush, cancel or truncate.
  Audio already queued (at most about half a second server-side) still plays.
- **Transcripts.** Caller and agent fragments arrive interleaved with no turn
  events. A speaker's turn ends after 1.2 s without a fragment from them; a turn
  over the 8 KiB field limit is split.
- **Typed text.** Sent as a `session.instructions.append` addendum, which the model
  answers aloud.
- **Closing.** `end_call` is answered with `function_call_output` and
  `response.create`, then OpenFon hangs up once the goodbye has been spoken and
  followed by 600 ms of silence, or after 8 s without a goodbye. Delegation is not
  reliable (one of two identical goodbye probes never delegated), so the caller
  farewell backstop is armed on this tier: a caller's goodbye answered by the
  agent's goodbye ends the call, as does a caller's goodbye followed by 8 s with
  no reply. Anything the model says after its goodbye is not played.
- **End.** `session.close`, then up to 2 s for `session.closed` before the socket
  is closed regardless. A session left with an unanswered delegation was seen
  never to send `session.closed`; the gateway bills that case from wall time.
- **Drops.** One replacement session per drop, briefed with the transcript so far
  and without a second greeting, within the whole-call reconnect ceiling.

Evidence: unit tests with a synthetic gateway socket (`test/gpt-live.test.ts`),
and on 2026-09-24 an engine run against Azure's GPT-Live endpoint directly
(greeting, typed question answered, turns assembled, caller-farewell hangup). The
Kataleptic `/v1/live/sessions` endpoint was not yet deployed, so no call through
the gateway, browser call or telephone call is claimed.

## Reproduce independence locally

After installing dependencies and applying the provider changes:

```sh
npm run typecheck
npm test -- test/realtime-providers.test.ts test/call-session.test.ts test/telnyx-control.test.ts
node scripts/realtime-smoke.mjs
node scripts/realtime-smoke.mjs --gateway
```

The smoke uses actual workerd, D1, Durable Objects and WebSockets on test port
8813 and inspector port 9253. All outbound traffic is intercepted by a synthetic
provider Worker. Only explicit OpenAI realtime/text and synthetic carrier endpoints
are accepted; Kataleptic endpoints and every unmatched request are blocked. No
instance AI credentials or Azure credentials are supplied. It checks the authenticated direct voice catalog without network
access, header auth,
signed/idempotent telephone admission, greeting, incoming/outgoing PCM, interruption,
`end_call`, playback drain, carrier release, saved turns and the text summary.
The unit suite also covers direct authentication/redirect/session rejection with no
pipeline fallback. The `--gateway` variant checks synthetic gateway header authentication, removal of
both credential query aliases, and preserved model/routing on the same reserved ports; run the two commands sequentially.

This is synthetic provider/carrier validation in a real local runtime. No direct
OpenAI credential was available from `dsecret --list` on 2026-09-12; no live OpenAI
conversation, audible browser session or PSTN pilot is claimed. A live acceptance
run still needs an authorized OpenAI key: remove Kataleptic secrets, block its
endpoints, select both direct voice and text providers, then verify microphone
allow/deny, greeting, knowledge answers, interruption, message capture, hangup and
saved transcripts/summary on the intended HTTPS origin. Keep the telephone rollout
flag disabled until the carrier owner's real-call gate passes.

### Established provider errors

An established realtime JSON `error` event fails the call, closes upstream sockets, and records a fixed local failure reason. Provider messages, codes, parameter values, URLs and event IDs are never copied into logs, caller errors or persisted failure fields. There is no automatic retry of an unknown application error. Transport-close recovery and pending direct-handshake rejection keep their existing behavior; a failed pending replacement does not retire the acknowledged old socket.

Cancellation is the narrow exception. [Official client-event documentation](https://developers.openai.com/api/reference/resources/realtime/client-events#response.cancel) says cancelling without an active response can return an error while leaving the session unaffected. The [error-handling guide](https://developers.openai.com/api/docs/guides/realtime-conversations#error-handling) documents client-event ID correlation. OpenFon attaches a random ID to its vocabulary-echo cancellation and tolerates only `invalid_request_error` / `response_cancel_not_active` whose `error.event_id` matches that socket's recent local cancellation. The record expires after 10 seconds, is consumed once and is capped at 4 IDs per socket. Missing/wrong/replayed/expired correlation, other error codes, and cancellation errors during a pending handshake fail closed. The reference establishes benign cancellation behavior but does not enumerate the specific error-code vocabulary; this exact code is a conservative compatibility allowlist tested with synthetic events, not a new live-provider verification. Custom gateways must preserve correlation to use the exception.
