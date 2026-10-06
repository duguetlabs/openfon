# Test-call debug recordings

Set the non-secret Worker variable `TEST_CALL_DEBUG` to `"true"` on the test deployment to record every authenticated Test Studio call. The default is `"false"`. The flag does not record public widgets, live-environment calls, or telephone/carrier calls. The automated local browser-test server enables it by default; set `OPENFON_E2E_DEBUG=false` to disable it there. No database migration or new storage binding is needed: recordings use the existing CallSession Durable Object storage.

Test Studio displays a recording notice. Call log → open a test call → **Call recording** lets its workspace owner download or delete the recording. If capture could not start, Studio reports that after connection. Older calls have no recoverable audio. Turning the flag off stops new captures; previously saved recordings remain subject to expiry or deletion.

Legacy transport recordings can contain private audio, transcript text, the generated assistant prompt and configuration. LiveKit recordings capture audio and an allowlisted timing timeline, without prompts, configuration, raw errors or transcripts in the debug bundle. The call log retains its ordinary transcript separately. Managed Web downloads project recordings to audio, safe capture events and retention/completeness metadata; operator configuration is excluded. Obtain permission from participants and avoid unrelated conversations. Provider URLs, headers, API keys and arbitrary provider error messages are not deliberately captured. Instructions/transcripts supplied by participants can themselves contain sensitive information. Downloads are private and must not be committed or attached to public issues.

## What is captured

| Track or event | Meaning |
| --- | --- |
| LiveKit caller PCM | Mini: mono 24 kHz samples admitted to the conversation service after resampling. GPT-Live: microphone frames admitted to the input clock; synthetic idle frames are excluded. These are not a raw physical microphone recording. |
| LiveKit assistant PCM | Generated speech pulled by the SDK before RTC output. Playback events describe SDK output, not proof of sound from a physical speaker. Supported mono sample rates are preserved: 16, 24 or 48 kHz; unsupported formats mark the recording partial. |
| LiveKit timeline | Relative worker capture time (`sourceMs`), storage arrival time (`ms`), speech boundaries, interruption, cancel/truncate, SDK playback start/end and terminal events. Raw provider details are excluded. |
| Legacy Realtime caller PCM | Mono 24 kHz signed 16-bit PCM received after browser microphone processing, including whether it was forwarded upstream. |
| Pipeline utterances | Original encoded microphone packets and whether the application admitted them. |
| Pipeline continuous microphone | An additional diagnostic PCM track, including input ignored while its half-duplex VAD waits. It adds upload/CPU overhead only in debug mode. |
| Agent audio | PCM delivered to the browser, or server-generated MP3. Some delivered PCM may later be flushed before playback. |
| Browser speech | Text and speech start/end/error events. The browser's synthesized voice is **not** an audio recording. |
| Timeline | Provider VAD/response identifiers and status codes, connection/recovery events, application controls, browser playback/flush/VAD events and configuration. |

LiveKit uses an asynchronous upload queue capped at 1 MiB, with one request in flight and batches below 48 KiB. The existing service credential, room, job and callback pins protect uploads; the server rechecks persisted private test/web scope. Ordered batch IDs and digests suppress ambiguous-response retries. Acknowledgements wait for storage synchronization; storage failure disables uploads and retains partial status. Capture starts as **partial** and becomes complete only after a producer seal. Shutdown allows at most three seconds for that seal before continuing call finalization. A crash, timeout, owner deletion, expired recording or Durable Object restart cannot create a replacement recording or falsely claim completion. SDK disk recording remains disabled.

Recording does not change interruption thresholds, silence detection, provider defaults or automatic hangup behavior. It is best-effort instrumentation: queued storage is bounded to 2 MiB; a recording stops admitting excess data at 128 MiB serialized data or 100,000 records. Buffers flush about once a second or at 48 KiB, with unconfirmed storage writes so the audio output gate does not wait for diagnostic disk writes. A hard process failure can lose the last buffer. A storage issue or known limit marks the bundle partial. A reconstructed object seals interrupted evidence as partial instead of pretending capture continued. Browser/tab/network failure can lose the last client events; absence of an event is not proof of silence or playback.

Recordings expire seven days after capture starts. The normal call watchdog handles active calls; after finalization, its alarm expires the recording. Downloads also enforce expiry. Deletion during a call stops recording without stopping the call or its watchdog. Account deletion immediately removes access; otherwise inaccessible audio still expires through the retention alarm. Normal call transcripts follow the application's separate call-log retention.

## Extract audio and inspect the timeline

Download the bundle from the call detail page, then run with Node 22.13+:

```sh
node scripts/call-debug-replay.mjs /private/path/call.debug.ndjson --out /private/path/call-audio
```

This creates available `caller.wav`, `microphone.wav`, `agent.wav`, encoded utterance files, and `timeline.json`. Files are private by default. LiveKit WAV tracks use relative worker capture timing; legacy tracks use arrival timing. Neither is a synchronized physical microphone/speaker recording. Rate-specific files use `-16000` or `-48000` suffixes; 24 kHz keeps the original filenames. PCM plays sequentially when arrivals overlap. Keep the bundle as the authoritative packet/event record. Incomplete bundles are rejected; `--allow-partial` allows inspection of known partial captures but does not reconstruct missing audio.

## Compare settings with the same recorded input

**Current LiveKit/Mini and managed Web downloads support offline extraction only.** The existing live replay path uses a legacy session schema and deliberately refuses these bundles. Extraction is not deterministic reproduction of the call, and no current Mini replay compatibility is claimed.

Legacy live replay is an explicit opt-in and incurs provider usage. Use an authorized endpoint and supply its key through the environment, never a command-line literal or saved artifact:

```sh
node scripts/call-debug-replay.mjs /private/path/call.debug.ndjson \
  --out /private/path/comparison --live \
  --url wss://YOUR-PROVIDER/v1/realtime --model YOUR-MODEL --threshold 0.7
```

The command reads `OPENFON_REPLAY_API_KEY`, submits the recorded Realtime session configuration and forwarded caller PCM at recorded arrival offsets, and writes bounded, projected provider events. `--threshold` applies only to recorded server-VAD sessions; omit it for semantic VAD. The configuration acknowledgement establishes receipt, not proof that a provider honored every setting. Replay uses a newly generated greeting based on recorded text; it cannot reproduce the exact original model response or echo interaction. It replays provider input, not the entire OpenFon call lifecycle or physical acoustics. Pipeline recordings are extractable but the CLI does not automatically replay their STT/LLM/TTS chain.

Compare VAD start/stop, response cancellation, audio delivery, playback flushes and connection failures. Test representative quiet and noisy audio before changing shared thresholds. A reproducible input does not make provider responses deterministic.

## Validation and rollout status

The LiveKit recording implementation is covered by synthetic byte-preservation, queue, stream cancellation, admission, retention, retry and failure tests. These do not establish a live RTC capture, audible playback, noisy-microphone reproduction or deterministic model replay. Exact staging validation and a separately bounded live acceptance remain required before enabling recording in production. No historical LiveKit audio can be recovered. The deployment flag remains off until that rollout is selected.
