# Realtime provider adapters

OpenFon preserves Kataleptic as the instance default. Direct OpenAI is an explicit
independent transport: selecting an OpenAI model on Kataleptic still uses Kataleptic.

## Configuration

Apply migration `0010_provider_capabilities.sql` before deploying this code. In
workspace provider settings, choose OpenAI realtime and save its own API key.
Leave the assistant realtime model empty for `gpt-realtime`, or select a supported
OpenAI realtime model. Use a native OpenAI voice such as `marin`; empty selects the
provider default. Select the OpenAI text preset and supply its key/model as well:
text generation produces post-call summaries, independently of the realtime key.
The existing per-assistant text model overrides the workspace text model.

| Setting | Meaning |
| --- | --- |
| `realtime_provider=instance` | Use operator `REALTIME_PROVIDER` (default `kataleptic`), endpoint, key and model. Preserves existing deployments. |
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

Kataleptic retains its token-query connection and measured tier-specific voice,
transcription and VAD behavior. Both adapters retain existing turn persistence,
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
pipeline fallback. The `--gateway` variant checks the preserved token-query gateway path on the same
reserved ports; run the two commands sequentially.

This is synthetic provider/carrier validation in a real local runtime. No direct
OpenAI credential was available from `dsecret --list` on 2026-09-12; no live OpenAI
conversation, audible browser session or PSTN pilot is claimed. A live acceptance
run still needs an authorized OpenAI key: remove Kataleptic secrets, block its
endpoints, select both direct voice and text providers, then verify microphone
allow/deny, greeting, knowledge answers, interruption, message capture, hangup and
saved transcripts/summary on the intended HTTPS origin. Keep the telephone rollout
flag disabled until the carrier owner's real-call gate passes.
