# Real phone numbers (PSTN)

OpenFon's built-in channel is **browser calling** — it needs no phone number, carrier
contract, or per-minute fees, which is why it's the default for self-hosters.

Bridging a real phone number means connecting a telephony provider's audio stream to
the same `CallSession` voice loop (STT → LLM → TTS). The `calls.channel` column and
the session protocol were designed for this; what differs per provider is the media
transport.

## Twilio (recommended for self-hosters)

Twilio [Media Streams](https://www.twilio.com/docs/voice/media-streams) sends
bidirectional call audio over a WebSocket — a natural fit for Workers:

1. Buy a number in the Twilio console, point its Voice webhook at
   `https://your-deployment/api/twilio/voice` (returns TwiML `<Connect><Stream>`).
2. Twilio opens a WebSocket and streams 8 kHz μ-law audio both ways.
3. A `TwilioBridge` adapts the frames to `CallSession`: μ-law → WAV for the STT
   request, TTS output transcoded to μ-law (Azure Speech can emit
   `raw-8khz-8bit-mono-mulaw` directly, so no transcoding code is needed).

Status: **not yet shipped** — the bridge endpoint is the next planned milestone.
Contributions welcome; the voice loop in `src/call-session.ts` is already
transport-agnostic (it takes audio buffers in, emits audio buffers out).

## Azure Communication Services

ACS Call Automation supports inbound PSTN calls with
[bidirectional media streaming](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/audio-streaming-concept)
over WebSocket (PCM 16 kHz — no transcoding needed at all).

Caveats found while building OpenFon:

- **Phone-number purchase is restricted by subscription type.** Sponsorship/trial
  Azure subscriptions are rejected with `InsufficientPermissions: the subscription is
  unable to purchase numbers at this time`. You need a pay-as-you-go or EA
  subscription whose billing address is in a
  [supported country](https://learn.microsoft.com/azure/communication-services/concepts/numbers/sub-eligibility-number-capability).
- Inbound call events arrive via Event Grid → your Worker, which then answers the
  call with the media-streaming WebSocket URL.

## Design notes for contributors

- One Durable Object instance per call, regardless of channel — keyed by `callId`.
- Keep the channel adapters thin: their only job is audio format conversion and
  signaling. Conversation logic stays in `CallSession`.
- Telephony audio is half-duplex in OpenFon's model: the agent does not listen while
  speaking (barge-in is a future enhancement).
