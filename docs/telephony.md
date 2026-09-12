# Telephone calling

Browser calling remains the default supported channel. This branch adds an opt-in
**inbound Telnyx adapter**, disabled by default. Local tests use simulated providers;
a real carrier pilot is required before claiming production telephone support.
The public website continues to describe browser calling until that pilot passes.

## Scope

The adapter answers an operator-routed Telnyx number using a published realtime
assistant. It verifies signed webhooks, reserves shared workspace capacity before
answering, authenticates the media stream, converts PCMU/8 kHz to the engine's
PCM16/24 kHz audio, and supports interruption and playback-aware hangup.

Number purchasing, porting, outbound dialing, transfers, emergency handling,
recording, Twilio, and Azure Communication Services adapters are not implemented.
Calendar requests remain requests; no calendar booking is performed.

## Before configuration

Use a staging Worker and an authorized Telnyx Voice API application and number.
Confirm account eligibility, pricing, and call limits directly with the provider.
Do not buy a number or enable traffic merely to run the local tests.

Apply all migrations, including `0009_telnyx_inbound.sql`, before deploying this
Worker version. The migration is additive. Carrier reservations count toward the
same live concurrency cap as browser calls, including the interval between an
answer and media startup and the interval before carrier release is confirmed.

Keep `TELNYX_ENABLED` set to `false` until the controlled pilot is ready. Configure:

| Binding | Purpose |
|---|---|
| `TELNYX_API_KEY` | Secret used only against the fixed Telnyx HTTPS API. |
| `TELNYX_PUBLIC_KEY` | Account Ed25519 webhook verification key, raw base64. |
| `TELNYX_CONNECTION_ID` | The expected Voice API application/connection. |
| `TELNYX_PUBLIC_ORIGIN` | Fixed HTTPS origin, without a path, query, or fragment. |
| `TELNYX_CALL` | Durable Object binding configured in `wrangler.jsonc`. |

Set secret values through your authorized secret manager and `wrangler secret put`;
never commit credentials. In this personal project use `dsecret`, not `qsecret`.
The existing realtime provider also needs working credentials. Native engine
voices can speak their greeting; tiers with an externally synthesized greeting
require configured Azure server TTS. Telephone calls never fall back to browser
speech synthesis or the browser pipeline.

## Route an owned number

Configure the application's V2 webhook URL as
`https://YOUR_ORIGIN/api/telnyx/webhooks`. The adapter sends the media URL and a
fresh per-call token through a separate `streaming_start` command.
That command requests `inbound_track`, PCMU in both directions, `rtp` bidirectional
mode, 8000 Hz and target leg `self`. The bridge expects mono PCMU/8000 in the
`start` frame and rejects a different codec; include PCMU in the application's
allowed codecs when configuring the pilot. These settings follow the
[streaming command contract](https://developers.telnyx.com/api-reference/call-commands/streaming-start). Do not place
that token in a URL or configure a shared media token manually.

Only the instance operator provisions `telnyx_number_routes`. A business's contact
phone number does not grant ownership or create a route. Confirm the destination
number is assigned to the configured Telnyx application, and map it to an existing
workspace and published assistant:

```sql
INSERT INTO telnyx_number_routes
  (connection_id, phone_number, business_id, assistant_id, enabled)
VALUES
  ('YOUR_CONNECTION_ID', '+YOUR_OWNED_E164_NUMBER', 'YOUR_BUSINESS_ID', 'YOUR_ASSISTANT_ID', 0);
```

These are placeholders. Use an actual E.164 number and verified IDs. The database
checks that the assistant belongs to the workspace. Start disabled; enable only
the specific route for the controlled pilot, then set the Worker rollout flag.
No tenant-facing API can claim or purchase a telephone number.

## Staging handoff and setup diagnostics

Before changing account routing, record the agreed HTTPS staging origin, Worker
version/commit, D1 migration result, application ID, route/assistant IDs and the
owner of the pilot. Do not substitute a local `.invalid` harness URL or an
unverified workers.dev hostname. No staging origin or deployed version was
validated by this workstream on 2026-09-12. The desktop account owner configures
the portal only after integration provides those verified references.

Use this sequence to narrow setup failures without exposing credentials:

| Observation | Check |
|---|---|
| Webhook returns 503 | Required DO binding, account public key and application ID; when rollout is enabled also API-key presence and a valid fixed HTTPS origin. A configured name does not prove the credential works. |
| Webhook returns 401 | Account Ed25519 key and signature/timestamp headers; proxy must preserve the exact body. Do not log the body or signature. |
| Webhook returns 403 | The event's application ID differs from `TELNYX_CONNECTION_ID`. Check number assignment against the intended application. |
| Webhook returns 200 but no answered call | Acknowledgement only means accepted processing. Check rollout flag, exact owned E.164 route, enabled route, active realtime assistant, server greeting capability and workspace call limits. |
| Media upgrade returns 403/404 | Match current active reservation and route; token must come from that call's streaming command. Never replay or print a token to diagnose this. |
| `start_timeout` / `media_setup_timeout` | Public WSS reachability, upstream realtime handshake and greeting synthesis. The bridge's ready deadline is 10 seconds; slow synthesis now fails closed instead of admitting caller input early. |
| `invalid_carrier_frame` | Check only sanitized event type, codec, rate and identity-match result against the documented configured-token protocol. Do not dump full frames. |
| `session_error` / failed greeting | Verify realtime credentials/model and, for external greetings, Azure TTS configuration. Telephone calls cannot use browser speech fallback. |
| `drain_timeout` / unreleased reservation | Inspect mark acknowledgements and actual carrier-leg status. Wait for signed hangup/status confirmation; do not clear reservation rows manually. |

For a private database inspection, this aggregate query omits caller identities,
transcripts, carrier control IDs and stream credentials:

```sql
SELECT status, failure_code, COUNT(*) AS calls,
       SUM(CASE WHEN reserved_at IS NOT NULL AND carrier_released_at IS NULL
                THEN 1 ELSE 0 END) AS unreleased
FROM calls WHERE channel='telnyx'
GROUP BY status, failure_code;
```

Keep rollout and the route disabled during configuration. Only enable the agreed
pilot route when account access, deployment and a consented test caller are ready.
A successful unsigned HTTP probe is not carrier verification.

## Operation and failure handling

`TelnyxCall` owns carrier lifecycle, durable event processing and command retries;
`CallSession` continues to own the conversation. Stable command IDs survive retries.
A signed hangup or an authenticated matching provider status confirming the call
is no longer alive releases the reservation. An ambiguous HTTP response does not.
The scheduled sweep wakes outstanding durable owners after interrupted processing.

The media adapter validates the stream token, identity, codec and ordering before
forwarding input. It retains at most the latest second of input while the realtime
provider starts. Missing input packets are skipped after a bounded reorder wait;
output uses 20 ms frames and bounded queues. Interruption clears queued playback
and invalidates old acknowledgements. The goodbye waits for current playback marks
with a deadline. These policies still need observation on an actual carrier leg.

Disable the number route to stop new admission. Set `TELNYX_ENABLED=false` for a
broader shutdown; existing authenticated terminal callbacks can still complete
cleanup. Confirm release in both Telnyx and OpenFon. Do not manually clear a live
reservation to bypass account deletion or concurrency checks. If provider status
remains ambiguous, investigate the actual carrier leg first.

Failure codes are intended for the workspace owner. Carrier control IDs, stream
tokens, webhook bodies and authorization headers must not enter public DTOs or
logs. Avoid adding caller audio or transcript content to diagnostic logging.

## Validation

Run the application tests and typecheck, then the local runtime harness:

```sh
npm test
npm run typecheck
npm run test:telnyx
```

The harness uses application port 8810 and inspector port 9250; run its two modes
sequentially (the default command runs both; `-- --synthesized` runs only the
synthesis regression). The synthesized mode holds a local TTS response pending, sends early
caller audio, verifies no upstream input is released, then checks the greeting and
normal conversation after releasing synthesis. The native mode exercises an
engine-generated greeting. Neither mode uses a real AI or telephone provider.

The harness bundles the real Worker, uses ephemeral D1 and generated signing keys,
and replaces outbound provider services with local mocks. It makes no real calls
and rejects unexpected outbound destinations. It complements codec, signature,
routing, retry, admission, account-deletion and lifecycle unit tests; it is not
proof of carrier compatibility or voice quality.

Before enabling public traffic, complete the controlled handset pilot and retain
sanitized results described in [the carrier acceptance plan](launch/telephony-plan.md).
Check actual audio in both directions, first greeting, interruptions, goodbye,
caller disconnect, provider failure, a cap-of-one concurrent attempt, and carrier
release after a forced media disconnect. Record the deployment version and model.

Protocol references: [Telnyx WebSocket protocol](https://developers.telnyx.com/api-reference/websockets/stream-call-media-over-websocket),
[streaming start](https://developers.telnyx.com/api-reference/call-commands/streaming-start),
[webhook verification](https://developers.telnyx.com/docs/development/sdk/node/webhooks).
