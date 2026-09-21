# Test-call debug recordings

Set the non-secret Worker variable `TEST_CALL_DEBUG` to `"true"` on the test deployment to record every authenticated Test Studio call. The default is `"false"`. The flag does not record public widgets, live-environment calls, or telephone/carrier calls. The automated local browser-test server enables it by default; set `OPENFON_E2E_DEBUG=false` to disable it there. No database migration or new storage binding is needed: recordings use the existing CallSession Durable Object storage.

Test Studio displays a recording notice. Call log → open a test call → **Debug recording** lets its workspace owner download or delete the recording. If capture could not start, Studio reports that after connection. Older calls have no recoverable audio. Turning the flag off stops new captures; previously saved recordings remain subject to expiry or deletion.

Recordings contain private audio, transcript text, the generated assistant prompt and configuration. Obtain permission from participants and avoid unrelated conversations. Provider URLs, headers, API keys and arbitrary provider error messages are not deliberately captured. Instructions/transcripts supplied by participants can themselves contain sensitive information. Downloads are private and must not be committed or attached to public issues.

## What is captured

| Track or event | Meaning |
| --- | --- |
| Realtime caller PCM | Mono 24 kHz signed 16-bit PCM received after browser microphone processing, including whether it was forwarded upstream. |
| Pipeline utterances | Original encoded microphone packets and whether the application admitted them. |
| Pipeline continuous microphone | An additional diagnostic PCM track, including input ignored while its half-duplex VAD waits. It adds upload/CPU overhead only in debug mode. |
| Agent audio | PCM delivered to the browser, or server-generated MP3. Some delivered PCM may later be flushed before playback. |
| Browser speech | Text and speech start/end/error events. The browser's synthesized voice is **not** an audio recording. |
| Timeline | Provider VAD/response identifiers and status codes, connection/recovery events, application controls, browser playback/flush/VAD events and configuration. |

Recording does not change interruption thresholds, silence detection, provider defaults or automatic hangup behavior. It is best-effort instrumentation: queued storage is bounded to 2 MiB; a recording stops admitting excess data at 128 MiB serialized data or 100,000 records. Buffers flush about once a second or at 48 KiB, with unconfirmed storage writes so the audio output gate does not wait for diagnostic disk writes. A hard process failure can lose the last buffer. A storage issue or known limit marks the bundle partial. A reconstructed object seals interrupted evidence as partial instead of pretending capture continued. Browser/tab/network failure can lose the last client events; absence of an event is not proof of silence or playback.

Recordings expire seven days after capture starts. The normal call watchdog handles active calls; after finalization, its alarm expires the recording. Downloads also enforce expiry. Deletion during a call stops recording without stopping the call or its watchdog. Account deletion immediately removes access; otherwise inaccessible audio still expires through the retention alarm. Normal call transcripts follow the application's separate call-log retention.

## Extract audio and inspect the timeline

Download the bundle from the call detail page, then run with Node 22.13+:

```sh
node scripts/call-debug-replay.mjs /private/path/call.debug.ndjson --out /private/path/call-audio
```

This creates available `caller.wav`, `microphone.wav`, `agent.wav`, encoded utterance files, and `timeline.json`. Files are private by default. WAV tracks use arrival timing, not a synchronized physical microphone/speaker recording. PCM plays sequentially when arrivals overlap. Keep the bundle as the authoritative packet/event record. Incomplete bundles are rejected; `--allow-partial` allows inspection of known partial captures but does not reconstruct missing audio.

## Compare settings with the same recorded input

Live replay is an explicit opt-in and incurs provider usage. Use an authorized endpoint and supply its key through the environment, never a command-line literal or saved artifact:

```sh
node scripts/call-debug-replay.mjs /private/path/call.debug.ndjson \
  --out /private/path/comparison --live \
  --url wss://YOUR-PROVIDER/v1/realtime --model YOUR-MODEL --threshold 0.7
```

The command reads `OPENFON_REPLAY_API_KEY`, submits the recorded Realtime session configuration and forwarded caller PCM at recorded arrival offsets, and writes bounded, projected provider events. `--threshold` applies only to recorded server-VAD sessions; omit it for semantic VAD. The configuration acknowledgement establishes receipt, not proof that a provider honored every setting. Replay uses a newly generated greeting based on recorded text; it cannot reproduce the exact original model response or echo interaction. It replays provider input, not the entire OpenFon call lifecycle or physical acoustics. Pipeline recordings are extractable but the CLI does not automatically replay their STT/LLM/TTS chain.

Compare VAD start/stop, response cancellation, audio delivery, playback flushes and connection failures. Test representative quiet and noisy audio before changing shared thresholds. A reproducible input does not make provider responses deterministic.
