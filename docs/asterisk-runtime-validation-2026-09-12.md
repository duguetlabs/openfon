# Asterisk runtime evidence — 2026-09-12

Actual local Asterisk runtime validation passed. This establishes PBX/media
interoperability with the current adapter; it does not establish live AI voice
quality, SIP-trunk compatibility, PSTN readiness or production WSS deployment.

## Runtime and reproducibility

- Adapter source: `0737b0b` (no production adapter changes needed in this validation).
- Local validation prerequisites: exact shared realtime helper from `18d3638` and
  presets migration `0010_provider_capabilities.sql`, copied locally as already
  documented in the workstream. Integration owns consolidated provider/session tests.
- macOS Docker Desktop was installed but stopped. `open -a Docker` started it;
  `docker info --format '{{.ServerVersion}}'` reported **29.2.1**. No Colima,
  OrbStack or Lima CLI was installed. The missing socket was a startup condition,
  not a final blocker. No subscription, security change or new runtime installation
  was needed.
- Asterisk **22.11.0**, built from official source for Linux aarch64 in the
  repository's [Dockerfile](../examples/asterisk/runtime/Dockerfile).
- Official source SHA-256:
  `3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94`.
  The Dockerfile pins and verifies this value. Source and checksum were fetched
  from the [official download directory](https://downloads.asterisk.org/pub/telephony/asterisk/).
- Final local image ID:
  `sha256:14a9583366ea60ef185203615ff26a86fe116d33f3d5fe375e5c002aef5e0147`.
- Loaded/running: `chan_websocket.so`, `res_websocket_client.so`,
  `res_http_websocket.so`.

Commands (passed):

```sh
docker build -t openfon-asterisk-runtime:22.11.0 examples/asterisk/runtime
node scripts/asterisk-smoke.mjs --asterisk
node scripts/asterisk-smoke.mjs
git diff --check
```

The [runtime harness](../scripts/asterisk-runtime.mjs) creates a disposable named
container, generated audio and PBX configuration. Worker/inspector ports are
8811/9251; the transparent capture proxy uses 8821, coordinated with integration.
All three are configurable. No SIP ports are published. Cleanup removed the test
container and temporary recordings; `docker ps --filter name=openfon-asterisk`
returned no containers. Docker Desktop and the reusable build image remain
available; unrelated containers were not modified or stopped.

## Final run observations

Final successful call: **11:58:44–11:58:45 UTC**.

| Layer | Actual evidence | Limit |
|---|---|---|
| PBX | Real Asterisk Local channel executes Answer, MixMonitor and Dial(WebSocket), with generated 660 Hz caller audio | No physical microphone or SIP endpoint |
| Authentication | Asterisk's actual WebSocket client authenticates with fixture Basic credentials; revoked-route second attempt creates no call and releases PBX channels | Fixture-only plain WS Docker-to-host hop; production requires verified WSS |
| Caller audio | Real PBX μ-law input reaches mocked AI as non-silent 960-byte PCM24 frames | AI input processing itself is mocked |
| Assistant audio | Asterisk records 17,280 PCM bytes, peak 7,932; measured 440 Hz amplitude 7,981 matches the mocked assistant tone | Generated tone, not live synthesized speech |
| Control | Transparent wire capture: ANSWER 1, MARK_MEDIA 11, FLUSH_MEDIA 1, HANGUP 1 | Interruption is triggered by a mocked provider speech event |
| Playback acknowledgment | Real PBX sends MEDIA_START 1 and MEDIA_MARK_PROCESSED 11 | Congestion/XOFF and lost acknowledgments remain synthetic unit coverage |
| Persistence | One completed D1 call, connected_at and carrier_released_at set; three persisted transcript turns | Transcript/summary content is mocked |
| Cleanup | Zero active Asterisk channels after normal end and after revoked-route attempt | Network-partition/host-crash behavior was not physically fault-injected |
| External telephone/provider | None used | No paid AI, SIP trunk, PSTN, Telnyx account, number, production DB or deployed Worker touched |

Earlier real runs also passed using the same source version before final harness
assertions were added. The final recorded run uses the checked-in pinned checksum
recipe, audio-content checks, explicit wire capture and revoked-route check.

The existing synthetic smoke remained green after adding `--asterisk` mode. The
actual PBX path did not reveal a production adapter defect. Keep rollout disabled
until the deployment-specific WSS, real provider, consented SIP/PSTN and failure
matrix in [the deployment guide](asterisk.md) is satisfied.
