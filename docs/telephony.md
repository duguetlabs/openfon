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
fresh per-call token through a separate `streaming_start` command. Do not place
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
