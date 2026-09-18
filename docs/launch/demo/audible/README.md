# Northwheel audible staging capture — 2026-09-12

**Actual real-provider recording with known failures retained. Prepared for review, not distributed and not a clean release-acceptance pass.**

- [68-second video](northwheel-staging-call.mp4): actual private Test Studio capture and saved result, with permanent disclosure and known-issue captions.
- [Original lossless audio](northwheel-original-audio.flac): the full 58.197-second browser audio mix, without removed pauses, replaced replies, normalization or speed changes.
- [Poster](poster.png), [sanitized saved result](result.json), [capture metadata](capture.json).

## What ran

One private draft assistant on the isolated staging origin used the real Kataleptic gateway, model `gpt-realtime-2`, blank voice (provider default; resolved voice ID not recorded), and `llama-3.3-70b` for its real summary. Staging source was `718d233e3754e53b800a397b1e600ffea492bb79`, Worker version `76a515eb-877e-48ef-bdcd-1ab8ea7095ef`. Carrier flags/routes stayed disabled. Kataleptic is the OpenFon founder’s optional paid inference service.

Root approved the fictional Northwheel scenario. Caller speech was generated locally with macOS Samantha and fed into the browser microphone stream. The normal browser capture/downsampling/WebSocket path sent that audio to the provider; this was not a text-only request or a mocked response. Provider playback was captured through the browser audio graph, including interruptions and hangup. There was **no physical microphone, handset, SIP/PSTN call or direct OpenAI connection**.

The session lasted 58 seconds, completed, and persisted ten turns, a summary and a message. This was the last authorized conversation: **remaining budget zero; no retry was made**.

## Actual outcomes, including failures

| Check | Observed result |
| --- | --- |
| Caller audio and real assistant response | Both captured. Offline speech recognition independently recovers the greeting, questions and replies from the saved audio. |
| Known Saturday answer | **Failed intended scenario.** Assistant said closed. Read-only inspection found canonical business hours still had onboarding defaults (Saturday closed), while description/custom instructions said 09:00–14:00. This was the launch capture setup’s conflicting fixture, not proven provider hallucination. |
| Repair timing | Persisted reply refuses a same-day guarantee. Do not assume every word of a persisted reply was heard before interruption. |
| Unknown espresso-machine question | Reply says it lacks that information. |
| Interruption | Scripted caller overlaps ongoing replies; original interrupted playback is retained. No exact latency or human-perceived interruption rating is claimed. |
| Message and summary | Caller name Alex Example and repair-timing request persisted, with message_taken outcome. Caller explicitly declined a phone number. |
| Missing phone handling | **Defect:** provider summary extraction stored literal string `"null"`; UI displayed it. Reported to integration, not altered in this artifact. |
| Hangup | Session completed and result persisted. Manual hangup may truncate the final spoken reply; the persisted text is not a guarantee that every word was played. |

The known-hours fixture must be corrected in canonical business hours before another acceptance run. Integration subsequently corrected phone-field normalization/rendering in `696a34a`: shared persistence and historical UI handling suppress the literal missing-value string while preserving real numbers and the surname Null. The owner reports typecheck, build and 22 summary/contact tests passed. The original staged row and this recording remain untouched, and no live retest was performed. Another live conversation requires renewed root authorization; do not treat this failed acceptance as permission to retry.

## Capture and verification

Local capture preparation and audio-mixing self-test made no provider calls. A single armed Playwright run initiated the private call. Five locally generated prompts covered hours, services, an interruption, an unknown question and a message without contact number. Authenticated session state and raw preparation files stayed outside the repository in a restricted temporary directory; no credential or cookie is included here.

The video preserves the entire screen sequence and original audio, encoded as H.264/AAC. A one-second audio offset approximately aligns the screen capture; **do not measure latency from the video**. The lossless FLAC preserves original audio samples without that presentation offset. Added captions identify fictional business, synthetic caller, real AI, affiliation and failures. No dialogue was overdubbed, no alternate response substituted, and no pause removed.

Verification: video decodes fully; H.264 1280×1060, AAC 48 kHz mono, duration 68.24 seconds. Original audio is 48 kHz mono, 58.197 seconds; peak −0.9 dBFS and mean −19.9 dBFS. Provider-only intervals contain speech around −25 dBFS. Local `faster-whisper` base.en recovered both sides without another provider request; its approximate transcript/timestamps have errors and are not substituted for the saved call record. The poster and saved-result screen were visually inspected. No independent human listening/voice-quality verdict is claimed.

This is real browser/provider audio evidence with a synthetic caller. It does not upgrade direct-provider synthetic tests, real Asterisk with mocked AI, or still-pending SIP/PSTN evidence into a live telephone success.
