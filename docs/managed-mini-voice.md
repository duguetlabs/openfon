# Managed Mini voice adapter

The managed application can use Azure `gpt-realtime-2.1-mini` over its existing
LiveKit room, with a parallel Azure `gpt-5.4-mini` reasoning request when the voice
model calls `think`. Customers continue to choose a voice; routing and model
configuration remain operator-only.

## Operator configuration

This change does not alter deployed flags, endpoints, credentials or stored
assistant configurations. Set `AZURE_OPENAI_LIVE_DEPLOYMENT` to
`gpt-realtime-2.1-mini` on **both** the Worker and the Node voice agent when a
separately approved rollout is ready. The existing `gpt-live-1` setting and its
transport remain available for rollback. Unset configuration preserves that
released default. `AZURE_OPENAI_TEXT_DEPLOYMENT` remains `gpt-5.4-mini`.

The Mini connection uses the resource's `/openai/v1/realtime?model=...` WebSocket
with the `api-key` header. It uses GA `session.update` and nested PCM audio
configuration, not GPT-Live's `session.start` protocol. The source candidate
uses the existing Azure `gpt-4o-mini-transcribe` deployment for caller transcript
text. This intentionally differs from the demo's `whisper-1` transcription.
Deployment inventory is not proof that this complete session configuration works.

The selected baseline is PCM16 mono at 24 kHz, server VAD threshold 0.7,
300 ms prefix padding and 550 ms silence duration, with server response creation
and interruption enabled. No extra noise classifier or threshold tuning is added.
Speech-start events cancel pending reasoning; the adapter cannot reliably
distinguish a backchannel from a meaningful correction. An acknowledgment can
therefore cancel work, but a stale answer cannot be spoken as a current answer.

Mini offers Alloy, Ash, Ballad, Coral, Echo, Sage, Shimmer, Verse, Marin and Cedar.
Existing incompatible saved voices are preserved and require an explicit customer
selection before calling or publishing. Preview audio uses the selected Azure
conversation model and voice, with no microphone or tools. It never substitutes
another speech service. Blank historical selections retain the established Marin
interpretation.

## Lifecycle and limits

The application-owned GA session implements the LiveKit SDK's Realtime model
interface. Existing AgentSession room I/O, caller identity, authenticated Worker
callbacks, typed commands, transcript revisions and finalization remain in place.
Only completed responses may dispatch tools. Filtered, incomplete and ordinary
failed responses warn without ending the room or replaying their output. Auth,
quota, configuration and protocol failures remain terminal. Optional warning
notification failure does not itself end a conversation.

`think` does not block microphone ingestion. It has at most two concurrent
requests, a 20-second deadline, 12,000-character input limit, 256,000-byte response
limit and 16,000-character answer limit. Requests use `store:false` and a
1,200-token output cap. Returned usage is retained even if the response is not
completed. Speech, typed corrections, farewell, hangup and reconnect invalidate
obsolete work. The reasoning service has no external action tools. The official
`end_call` path still requires a current spoken goodbye to finish playing;
a filtered or interrupted goodbye is not successful closure.

Recovery has one owner: the application adapter. It permits the initial
connection plus at most two reconnections for the whole call, at 500 and 1,000 ms.
Success does not reset the budget. Initial readiness and response admission each
have a 15-second deadline under the same recovery controller. It keeps the caller
room, clears obsolete speech state, discards outage input,
uses at most twelve historical turns/12,000 characters as untrusted context, and
asks the caller to repeat. This is bounded recovery, not seamless continuity.

Provider output is pulled in 20 ms frames. Pending PCM is bounded below 60 seconds
(2.88 MB at this format), reserving space for the configured 100 ms native queue
and bounded forwarding frames. Overflow cancels that generation and rejects its
late frames; it does not terminate the caller transport. Quiet and silent PCM
is preserved. Application/native queue estimates do not establish browser
playout position or physical audibility.

## Usage and retained business behavior

Mini token counters are recorded under `azure_realtime`, keyed by both provider
session and response. This avoids applying GPT-Live's cumulative seconds maximum
to independent response counters. Cached/audio/text token subsets are recorded
separately and are not added again to totals. Failed/incomplete response usage is
retained; missing usage remains absent, never zero. An unreported session ending
is recorded separately. Separate transcription-event usage is not yet collected;
complete provider costing remains an explicit acceptance gap. Known canceled
reasoning usage is retained; an aborted
request with no received usage does not establish its cost.

Durable usage delivery, account isolation, public links, business/assistant
context, summary routing and action-item extraction are unchanged. Changing the
voice does not change post-call routing. Customer call duration and retail billing
remain distinct from provider inference units. Dodo charging and carrier gates
are not enabled by selecting this adapter.

## Validation and remaining acceptance

Synthetic tests cover protocol selection, compatible voices, preview bytes and
usage, response-local failures, request correlation, stale reasoning, bounded
recovery, typed input, output limits and response-level accounting. A real SDK
AgentSession with a synthetic WebSocket verifies that a filtered response can be
followed by another typed turn. A separate installed SDK ParticipantAudioOutput
and native AudioSource test holds an old capture completion across clear/new
segment and verifies the new silent segment survives. Publication and timing are
synthetic; this is not remote room/receiver or physical playout evidence. These
checks do not establish real Azure audio, voice identity or noise robustness.

The previously observed staging summary fallback remains unresolved; the
correlated Azure HTTP 400 has not been attributed to a specific parameter.
No automatic historical reprocessing is included. Actual Azure session/audio,
transcription and provider usage acceptance, summary/action persistence, injected
recovery, billing invoices and PSTN/carrier acceptance remain rollout gates.
No live defaults, deployments, remote migrations, payments or calls were changed
by this source integration.

Protocol references:
- [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [GPT Realtime 2.1 Mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)
