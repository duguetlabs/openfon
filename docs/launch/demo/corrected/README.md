# Corrective Northwheel staging capture — 2026-09-12

**The canonical-hours and missing-phone corrective checks passed in this real-provider run. Interruption follow-up remains inconclusive; this is not blanket release or voice-quality acceptance.**

- [79-second corrective video](northwheel-corrected-staging-call.mp4)
- [Lossless original corrective audio](northwheel-corrected-original-audio.flac)
- [Actual saved result](corrected-result.json), [capture metadata](corrected-capture.json), [verified fixture](verified-fixture.json), [poster](corrected-poster.png)
- [Original failed capture](../audible/README.md), preserved unchanged with its original recording, result and report

## Authorized run and fixture preflight

Root explicitly authorized one additional short corrective run as part of implementation/validation. The earlier two-call limit was an operational batch bound, not a user spending restriction. Integration refreshed and froze staging, then handed exclusive initiation to launch. One corrective conversation was made; no competing call or automatic retry occurred. No account or credits were purchased.

Staging source: `526be52ab15785dfa4ec0c7c87a958295a5ce4b6`; Worker version: `a1bc90ea-dad0-4677-abc0-e8e34cdc9c51`. The source includes phone normalization fix `696a34a`. Staging used its separate D1 database; both carriers remained disabled. The assistant stayed a private draft on realtime `gpt-realtime-2`, blank provider-default voice, with `llama-3.3-70b` for summaries. Kataleptic is the founder’s optional paid inference service.

Before initiating, launch saved and read back all relevant fixture inputs:

- Canonical hours: Monday–Friday 09:00–17:00, Saturday **09:00–14:00 with closed=false**, Sunday closed.
- Timezone: **Europe/Vienna**. At preflight it was Saturday 12 September 2026, 14:24 CEST, already after closing. No special closures.
- Description, assistant instructions, active attached knowledge and services agree with those hours. Repair timing needs staff confirmation; no espresso-machine service is asserted.
- Expected hours response: regular Saturday 09:00–14:00, with “closed now” appropriate after 14:00. The question explicitly asks for Saturday opening hours.
- Expected contact result: Alex Example requests repair timing and declines a phone number; missing phone must be JSON null/absent and invisible as a number in the UI.

## Actual result

Session `722e6aff-a154-4d86-ad80-a80e83cf7dec` completed in 68 seconds with twelve persisted turns, a summary, and `message_taken` outcome. No failure message was stored.

| Check | Result and evidence |
| --- | --- |
| Regular hours and current-time context | **Pass.** Assistant said Saturday 09:00–14:00 and correctly explained it was currently closed because it was past 14:00. Both appear in the recorded speech and saved result. |
| Missing-phone correction | **Pass.** Saved `caller_phone` is JSON null. The result screen shows Alex Example and the request without the original literal-null phone display. |
| Unknown service | **Pass for this fixture.** Assistant says it has no espresso-machine repair information, rather than inventing that service. |
| Message and summary | **Pass.** Alex Example’s repair-timing request and decision to contact the workshop without giving a number are preserved. |
| Final playback and hangup | **Pass for capture.** Recorder waited for the final response playback to drain before hangup; offline audio recognition recovers the complete final message. Call completed and result persisted. |
| Interruption and same-day guarantee follow-up | **Inconclusive.** Caller interrupts services audio, but the script advances before a substantive follow-up is established. Saved response is “Let me think.” No successful guarantee/refusal follow-up or exact interruption latency is claimed. |

## Local diagnosis of the capture limitation

The recorder’s completion predicate used cumulative playback-source count plus an empty playback queue and a quiet interval. After interruption, chunks from the old services response could satisfy that count. Queue drain does not prove completion of a new provider response.

The interruption began at +27.720 seconds; the next question began at +32.151 seconds. The saved “Let me think” turn is timestamped 12:26:37 UTC, after the next prompt started. Local inspection found no hardcoded “Let me think” in the application. This evidence supports an automation-sequencing limitation and does not establish a new application/provider defect. Future capture sequencing should associate completion with the relevant new response, not cumulative playback activity; no live retry was made here.

## What the audio proves

Caller speech was generated locally with Samantha and injected through the browser microphone stream. Actual Kataleptic replies traversed the normal browser audio/WebSocket path and were recorded as played, including interruption. This is real provider audio with a **synthetic caller**, not a physical microphone, handset, direct OpenAI, SIP/PSTN or human listening-quality test.

The 79.2-second H.264/AAC video retains the full screen sequence and uncut call audio, with permanent disclosure and the unresolved interruption qualification. A one-second presentation offset approximately aligns screen and audio; do not derive latency from it. The 67.499-second FLAC is lossless original audio: decoded PCM was hash-compared and exactly matches the original captured WAV. No replacement dialogue, removed pause, audio speed change or alternate take was used.

Validation: full video decode passed; 1280×1060 H.264, 48 kHz mono AAC; original audio 48 kHz mono. Local `faster-whisper` base.en independently recovers the hours answer, caller prompts, unknown-service response and complete final message without a cloud/provider request. Its transcription errors/timestamps are not ground truth. The poster and saved result were visually inspected. Original failed artifact files remain byte-for-byte unchanged in git.

Prepared source artifact only; no external marketing distribution or production routing occurred. Real Asterisk with mocked AI, synthetic direct-provider tests and unverified SIP/PSTN remain distinct evidence categories.
