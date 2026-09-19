# Graceful call closing

`end_call` requests closing. OpenFon waits for the corresponding response to
finish and reuses a successful spoken farewell from the current caller turn.
If it is missing, the controller requests one short goodbye in the language of
the last caller message, with tools disabled. An empty or failed replacement is
not retried. Pipeline calls follow the same policy and preserve any useful reply
before appending the farewell. The assistant's business prompt stays unchanged.

Once generation finishes, the server drains its paced audio queue and sends an
`ending` marker with a fresh ID. The browser returns matching `playback_complete`
after its AudioBuffer nodes, HTMLAudio or local speech utterances finish; errors
return `playback_failed`. Telnyx and Asterisk adapters acknowledge their existing
queue/mark drainage. This confirms software playback completion, not physical
audibility. Earlier `audio_received` receipts still mean buffer admission only.
Legacy clients may hang up without the new acknowledgement.

Closing suppresses new microphone/text input and barge-in flushes; a caller can
still hang up immediately. Provider disconnection before completed generation
ends with a diagnostic; disconnection after completion does not discard queued
speech. Generation gets 30 seconds (reset once for the replacement), playback
acknowledgement gets 25 seconds after server drainage, and the whole close is
bounded at 90 seconds. Existing carrier drainage deadlines remain in force.
Transport failure, manual hangup and hard call limits cannot guarantee a farewell.

Identified replies are correlated by provider socket and response ID. Gateways
without IDs support serial responses on one socket; arbitrary concurrent,
unlabelled replies cannot provide the same correlation guarantee. Farewell
recognition uses the existing multilingual heuristic, so unfamiliar wording can
cause one additional goodbye.

## Diagnostics and stored data

Transcripts, summary and outcome remain in the existing call history. Normal
calls do not record raw audio. No schema or retention policy changes are made.
Structured Workers logs `call_closing_requested` and `call_closing` contain the
call ID, trigger, phase timestamps and completion/timeout/failure reason, without
transcripts, audio or provider credentials. Missing phase timestamps identify
where progress stopped. These diagnostics are not permanent call-history fields.
Workers observability is enabled; retention and sampling follow the deployed
Cloudflare account configuration, which this repository does not set. Operators
must export logs if they need a longer investigation window.
