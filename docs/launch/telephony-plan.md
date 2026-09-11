# Telnyx inbound calling implementation plan

Status: proposed, not implemented or carrier-tested. Reviewed 2026-09-12 against
working-tree source based on commit `66943f1` and current official Telnyx docs.
No credentials were fetched, numbers purchased, account settings changed, or calls placed.

## Recommendation and launch boundary

Implement an opt-in **inbound-only Telnyx Voice API adapter**, initially for explicitly
supported realtime assistants. Keep browser calling operational and the Telnyx feature
disabled by default until a real carrier call passes the acceptance matrix below.
Number purchasing, porting, outbound dialing, transfers, emergency calling, and automated
recording are separate work. Do not advertise PSTN support as shipped on the strength of
mock tests or this plan.

Use Call Control commands plus a bidirectional media WebSocket. Prefer the documented
PCMU/8 kHz path for the first release; adapt it to OpenFon's existing PCM16/24 kHz realtime
engine boundary. This avoids assuming that every provider behind OpenFon's gateway
accepts G.711, or that arbitrary L16 sample rates will work end to end.

## What the repository actually supports

- `docs/telephony.md` describes unshipped Twilio/ACS ideas. Its claims that the loop is
  already transport-agnostic and uniformly half-duplex are incomplete for current code.
- `src/index.ts` exposes `/api/public/call/start` and `/ws/call/:callId`, with browser
  ticket admission, assistant publication checks, session-cookie protection for private
  tests, concurrency accounting, and stale-call sweeping. No carrier ingress exists.
- `src/call-session.ts` stores one caller WebSocket, parses browser control messages,
  accepts whole encoded utterances in pipeline mode, and sends raw MP3 replies. In
  realtime mode it forwards binary input as PCM24 and sends decoded PCM24 audio deltas.
  `flush` already represents realtime interruption, and `ending` delegates playback
  drain to the browser before the server's finalization fallback.
- `web/src/voice.ts` currently supplies pipeline VAD and browser TTS fallback. A PSTN
  caller supplies neither. Realtime startup can fall back to pipeline; that fallback
  must become capability-aware before a telephone channel is allowed.
- `migrations/0001_init.sql` has an unconstrained `calls.channel` string; migration 0008
  adds assistant, environment, direction, outcome, and failure fields. There is no
  provider call identity, number routing, webhook inbox, or carrier command ledger.
- `wrangler.jsonc` already sends `/api/*` and `/ws/*` through the Worker and binds
  `CALL_SESSION`; proposed ingress paths fit that configuration.

These are source observations, not evidence that a real telephone transport works.

## Verified external contracts

**Control plane.** Voice API applications deliver call events to configured webhooks.
The event envelope includes an event ID and call identifiers. Use `call.initiated`,
`call.answered`, `call.hangup`, and streaming lifecycle events; validate exact payloads
against the current event schemas while implementing. [Voice API webhooks](https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks)

**Webhook trust and delivery.** Preserve the raw body, verify Ed25519 signatures and
request timestamp, acknowledge promptly after durable acceptance, and expect duplicate
and out-of-order deliveries. The application's replay window must be explicit.
[Webhook fundamentals](https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks)
The documented Node helper is `client.webhooks.unwrap(rawBody, { headers })` using the
account public key; `unsafeUnwrap` does not authenticate. Prove SDK/runtime compatibility
under workerd before selecting it, or implement a Web Crypto verifier checked against
SDK-generated fixtures. [Node webhook verification](https://developers.telnyx.com/docs/development/sdk/node/webhooks)

**Stream setup.** `streaming_start` accepts `stream_auth_token`, `stream_codec`,
`stream_bidirectional_mode`, `stream_bidirectional_codec`, sampling rate, and target
legs. The answer schema does not expose the same complete token/sampling contract in
its displayed fields; use separate answer and stream-start commands for the first
implementation. [Streaming start](https://developers.telnyx.com/api-reference/call-commands/streaming-start),
[Answer call](https://developers.telnyx.com/api-reference/call-commands/answer-call)

**Wire format.** Telnyx sends JSON `connected`, `start`, `media`, and `stop` frames.
Inbound media is base64 codec payload without RTP headers. Validate `start.media_format`
and stream/call identifiers before accepting media. The configured stream token is
carried in the `x-telnyx-streaming-auth-token` upgrade header and connected frame.
`mark` reports playback completion; `clear` also returns queued marks, so a returned
mark does not by itself prove audible completion. [WebSocket protocol](https://developers.telnyx.com/api-reference/websockets/stream-call-media-over-websocket)

**Audio limits.** PCMU is documented at 8 kHz; L16 at 16 kHz in the streaming guide.
The command schema lists additional sampling rates without establishing every codec/rate
combination. MP3 mode queues whole files and limits submissions to once per second;
that is not an interchangeable route for continuous PCM deltas. The guide warns that
media events can arrive out of order. [Media streaming guide](https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming)

**Retries and carrier release.** Persist one command ID per intended action and reuse
it, with identical body, after uncertain outcomes. Telnyx documents duplicate-command
suppression for the same call-control ID and command ID. A socket close alone is not
our carrier-release contract: explicitly request `/actions/hangup` and reconcile the
`call.hangup` event. [Command retries](https://developers.telnyx.com/docs/voice/programmable-voice/command-retries),
[Hangup call](https://developers.telnyx.com/api-reference/call-commands/hangup-call)

## Proposed files and internal interfaces

| File | Responsibility and contract |
|---|---|
| `src/telephony/telnyx-webhooks.ts` | `verifyAndParse(request, env): Promise<VerifiedTelnyxEvent>`; raw body limit, signature, timestamp, shape validation; no paid actions before verification. |
| `src/telephony/telnyx-api.ts` | `answer`, `startStreaming`, `hangup`; fixed Telnyx API origin, encoded call-control path segment, bounded request timeouts, stable command IDs and bodies; no raw provider-error disclosure. |
| `src/telephony/telnyx-media.ts` | `connected/start/media/mark/stop/error` decoder, authenticated stream binding, sequence handling, bounded queues, outgoing media/mark/clear encoder. |
| `src/audio/telephony-pcm.ts` | Stateful PCMU ↔ signed PCM16 conversion and 8↔24 kHz resampling; anti-alias filtering on downsampling; chunk carry state and no drift across frame boundaries. |
| `src/call-transport.ts` | Typed caller transport interface; browser and Telnyx implementations expose audio capabilities and explicit playback completion/end semantics. |
| `src/call-admission.ts` | Shared atomic workspace/environment admission and release used by browser and PSTN, including calls answered but awaiting media. |
| `src/call-session.ts` | Own carrier lifecycle/inbox/command state in the existing per-call Durable Object; replace direct caller `ws.send` sites with transport methods; keep conversation/history/summary logic shared. |
| `src/index.ts` | Register Telnyx ingress and trusted internal DO dispatch; retain public/browser guards; extend reconciliation sweep for pending carrier release. |
| `src/types.ts`, `wrangler.jsonc` | Optional disabled-by-default bindings/configuration, explicit supported telephony engine capabilities. |
| `migrations/<next>_telnyx.sql` | Number routes, unique provider call identity, reservation timestamps, minimal carrier status/failure data. Select the next migration number at implementation time. |
| `test/telnyx-*.test.ts`, `test/telephony-pcm.test.ts` | Signed-fixture ingress, lifecycle/crash-replay, cross-channel admission, protocol and codec tests using existing SQLite-backed D1 test support. |

Suggested transport boundary (an internal proposal, not a Telnyx API):

```ts
interface CallerTransport {
  readonly channel: 'web' | 'telnyx';
  readonly supportsBrowserTts: boolean;
  sendEvent(event: CallerEvent): void;
  sendAudio(audio: ArrayBuffer, format: 'pcm24' | 'mp3'): void;
  clearPlayback(): void;
  endAfterPlayback(): Promise<void>;
  close(reason: string): Promise<void>;
}
```

Incoming decoded PCM24 is delivered directly to the session's existing engine input,
not back through a browser-accessible route. Browser protocol behavior must remain
covered by its existing tests. Metadata/transcripts remain in D1; do not send them
unnecessarily to the PSTN media socket.

## Ingress, routing, and call state

1. `POST /api/telnyx/webhooks`: feature disabled → 503; malformed/unauthenticated →
   400/401; durable enqueue failure → retryable 503; accepted or already durably
   accepted → 200. Body limit proposal: 128 KiB. Unsupported authenticated event
   types are acknowledged without starting a session. Do not make a carrier API call
   before acknowledgment, and do not treat `waitUntil` alone as a durable queue.
2. Verify the expected Telnyx connection/application ID. Route the signed destination
   E.164 number through an operator-managed `telephony_numbers` row to one workspace
   and assistant. Number routing is independent of the business contact-phone field.
   Never accept a workspace or assistant identity chosen in untrusted query parameters.
3. Derive a stable local call ID from a namespaced hash of the validated provider leg
   identity, and use `CALL_SESSION.idFromName(localCallId)`. Persist the Telnyx
   call-control, leg, session, and connection identifiers separately. Enforce unique
   provider/account/leg identity in D1. Carrier call-control IDs are sensitive control
   tokens: keep them out of public DTOs, URLs, and logs.
4. Durably append each verified event to that DO's inbox and arm a retry alarm before
   returning 200. Persist pending/processed state and planned command bodies. Duplicate
   event IDs resume unfinished work instead of skipping it. A terminal event received
   first creates a tombstone; a delayed initiation cannot resurrect it.
5. On valid inbound initiation, check number enabled, assistant active, supported
   engine/TTS capability, workspace daily limit, and shared live concurrency. Atomically
   create the call/reservation before answering. `channel='telnyx'`, `environment='live'`,
   `direction='inbound'`; a browser test remains a different environment.
6. Answer once. On a reconciled `call.answered`, start the authenticated stream once.
   Media may race HTTP acknowledgments or webhook deliveries: persist the intended
   transition before sending its command and merge observations monotonically.
7. `GET /ws/telnyx/:callId`: require WebSocket Upgrade and the expected per-call token
   in the documented header; check pending nonterminal call and token expiry; compare
   in constant time; atomically claim one stream. Validate the subsequent `start`
   identity, expected stream, inbound track, mono PCMU/8000 format, and version before
   forwarding audio or starting the engine. Reject media arriving before valid start.
8. `stop`, disconnect, streaming failure, provider error, timeout, and hangup events
   converge on the same idempotent finalizer. Persist a pending carrier-hangup command
   and retry after DO restart. A failed D1 summary write must not keep a PSTN leg alive;
   release carrier resources first, then retry accounting. A hangup webhook confirms
   carrier termination; duplicate terminal events cannot overwrite a useful outcome.

Proposed persisted phases: `received → reserved → answering → answered → streaming →
ending → ended`, plus terminal failure/rejection. An observed later phase can arrive
before an earlier acknowledgment; it must not be overwritten by it.

The current concurrency query only counts `connected_at`. Introduce a short-lived
`reserved_at` claim for pre-media PSTN pickup and count it alongside connected calls
in **both** browser and telephony admission. Otherwise simultaneous PSTN answers can
bypass the cap, or browser calls can ignore occupied telephone lines. Stamp
`connected_at` only when authenticated media is accepted, retain a separate carrier
answer timestamp, and expire reservations via durable alarms. A stale reservation
must request carrier hangup, not merely disappear from the count.

## Proposed first stream command

After answer confirmation, persist and send this body to
`POST https://api.telnyx.com/v2/calls/{encodedCallControlId}/actions/streaming_start`:

```json
{
  "command_id": "<persisted UUID for this action>",
  "stream_url": "wss://<configured origin>/ws/telnyx/<local call ID>",
  "stream_auth_token": "<ephemeral per-call random capability>",
  "stream_track": "inbound_track",
  "stream_codec": "PCMU",
  "stream_bidirectional_mode": "rtp",
  "stream_bidirectional_codec": "PCMU",
  "stream_bidirectional_sampling_rate": 8000,
  "stream_bidirectional_target_legs": "self"
}
```

`self` is the proposed destination for the directly answered inbound leg; verify
actual audible routing on a carrier call before fixing it as a production default.
The account/API key belong only in the HTTPS Authorization header. Do not send the
stream capability in the URL. Keep enough protected persisted command state to retry
with the same capability; expire and remove it on termination.

The adapter should decode PCMU, resample continuously, and frame outgoing PCMU at
20 ms (160 samples/bytes). Use a bounded reorder window based on media chunk/timestamp,
count duplicates/gaps, and define silence insertion/drop policy. Never accumulate an
unbounded late-audio queue. Start with a 200 ms queue ceiling and measure before tuning.

Translate realtime `flush` to carrier `clear`, invalidate queued playback marks, and
track playback generations. On `ending`, wait for a mark corresponding to the last
non-cleared response, with a bounded timeout, then hang up the carrier. Do not copy the
browser's fixed playback-delay timers as evidence the PSTN caller heard the goodbye.

Initial eligibility is **realtime with audible greeting/replies and tested codecs**.
If the engine fails, terminate with a clear stored failure and carrier release. A later
pipeline adapter needs server-side utterance VAD, WAV wrapping for STT, and guaranteed
server-generated audio; browser TTS fallback must never produce a connected silent call.

## Required external configuration

| Value/action | Source and handling |
|---|---|
| `TELNYX_ENABLED=false` initially | Operator-controlled rollout flag. |
| `TELNYX_API_KEY` | Authorized Telnyx account; personal project secrets via `dsecret`, then Worker secret binding. Never commit or print it. |
| `TELNYX_PUBLIC_KEY` | Account webhook-verification public key from Mission Control; not interchangeable with API key. |
| `TELNYX_CONNECTION_ID` | Voice API/Call Control application assigned to the inbound number; validate it on incoming events. |
| `TELNYX_PUBLIC_ORIGIN` | Fixed HTTPS origin with a valid certificate and working WSS upgrades; never derive command destinations from an arbitrary Host header. |
| Number route | An actually owned/routed, voice-capable E.164 number assigned to that application and mapped to an active assistant in D1. Country availability/account eligibility must be checked in the real account. |
| Webhook settings | V2 POST callback to `/api/telnyx/webhooks`; optional failover to the same durable processing authority. |
| AI credentials/configuration | Existing realtime provider key, model, and supported voice; server TTS configuration if that tier requires a synthesized greeting. |
| Carrier limits | Funded/eligible account and explicit spend/concurrency/duration limits; no assumption that a test account can reach every destination. |
| Operator fallback | Document how to disable the route/application or reroute the number if the AI service is unavailable. |

Proposed security defaults: 5-minute webhook timestamp skew/replay window, bounded
inbox retention, 256-bit random per-call stream capabilities with short handshake
expiry, and no media acceptance based only on a guessed call ID. A duplicate valid
webhook inside the replay window is acknowledged after checking durable event identity;
a delayed legitimate event outside that window requires reconciliation, not disabling
signature checks. Log correlation IDs, phase changes, codec, queue depth, and failure
codes; omit authorization headers, capability tokens, complete webhook bodies, and raw
caller audio. Carrier ingress needs its own bounded request budget, not the public
browser IP quota that would group many Telnyx calls behind shared provider addresses.

## Validation and implementation order

1. **Control plane, disabled feature.** Add schema, signed ingress, state transitions,
   durable retries, routing, and shared admission. Tests generate a throwaway Ed25519
   key pair; reject altered bytes, missing headers, wrong key, old/future timestamps,
   oversized body, wrong connection, and cross-workspace routes. Assert zero carrier
   or AI requests on rejected input.
2. **Crash and concurrency simulation.** Inject failure after enqueue, reservation,
   command dispatch before acknowledgment, and finalization. Replay/reorder every event;
   assert one local call, stable command IDs, no duplicate greeting, terminal state not
   resurrected, and shared browser/PSTN caps respected. Invalid or absent media starts
   must time out and request hangup. Test DO re-instantiation from durable state.
3. **Media adapter fixtures.** Test known PCMU vectors, silence and clipping, sample
   counts for arbitrary chunk partitions, anti-alias attenuation, malformed base64,
   unexpected codec/rate/channel, mismatched stream/call IDs, duplicate/out-of-order
   chunks, marks after clear, and queue overflow. Verify output duration and waveform
   against an independent reference, not the implementation itself.
4. **Local synthetic end-to-end run.** A fake Telnyx peer sends signed lifecycle events
   and authenticated WSS frames through the actual Worker/DO to a fake realtime provider.
   Assert greeting, two turns, interruption, goodbye, disconnect, and accounting. Run
   `npm run typecheck`, `npm test`, `npm run build`, migration tests, and workerd integration.
5. **Controlled real carrier pilot.** Configure a real application/number/key and call
   from a separate handset. Verify audible inbound/outbound routing, actual announced
   codec, token header, greeting beginning, transcript correctness, barge-in/clear,
   goodbye drain, caller hangup, provider failure, two concurrent calls at a cap of one,
   and no continuing carrier leg after a forced media disconnect. Inspect carrier call
   status and charged duration as well as OpenFon rows.
6. **Release gate.** Preserve a dated, sanitized pilot report with deployment SHA,
   model/voice, number country, call IDs safe for internal use, observed p50/p90 turn
   latency, failure cases, and limitations. Enable only the validated route/model set.
   Update `docs/telephony.md` and product claims only after this gate passes.

No real number or Telnyx key is needed for steps 1–4. An authorized key/application can
confirm command permissions and ingress configuration, but does not prove audio quality
or end-to-end routing. A real carrier call is required for step 5. Documentation does not
resolve observed codec fallback, `self` leg audibility, carrier buffering/mark timing,
regional routing quality, or account-specific availability; these remain explicit pilot
checks. This plan does not mark any of those checks complete.
