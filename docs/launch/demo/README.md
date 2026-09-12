# Silent product walkthrough

Prepared marketing asset, not published. Fictional business: **Northwheel Bicycle Workshop**. The permanent caption identifies this as a synthetic demo and explicitly states that it is not a real voice demonstration.

- `openfon-walkthrough.mp4`: silent 1280 × 900 walkthrough, H.264 with fast-start metadata.
- `poster.png`: matching captioned cover frame.
- `capture.mjs`: reproducible capture and export, using the actual local app, isolated temporary D1 database, repository deterministic provider, installed Playwright Chromium and ffmpeg.
- `capture.json`: capture dimensions, timing and timestamp.

The sequence shows the workspace overview, draft assistant configuration, a knowledge answer being approved, and a persisted private test conversation. Its question and answer traverse the actual Worker/WebSocket/database path against a deterministic local text provider. There is no microphone input, synthetic speech, real provider call, carrier call, testimonial, or claim that an existing phone number is connected. The assistant remains a draft.

## Reproduce

From the repository root, first run `npm run build`. Then run:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE='/absolute/path/to/installed/Chromium' node docs/launch/demo/capture.mjs
```

Omit the executable override if the browser revision expected by the installed Playwright package is already installed. Requires existing ffmpeg with drawtext support; nothing is installed by the script. This macOS export uses `/System/Library/Fonts/Helvetica.ttc`; adjust the font path on another OS.

The script checks that ports 8791 and 9233 are free before starting. Override `DEMO_PORT` and `DEMO_INSPECTOR_PORT` if needed. It reuses `scripts/e2e-server.mjs` through a disposable copy with those alternate ports, seeds only fictional local data, and removes temporary server/database state on exit. It does not read production credentials or deploy anything. Existing provider responses are intentionally deterministic, so this asset is UI evidence only.

## Audible demonstration

The [60–90 second audible script](audible-script.md) uses the Northwheel fictional scenario approved by root on 2026-09-12. Recording awaits authorized working provider configuration only; no additional scenario approval is needed. No audible recording is supplied yet; the silent MP4 above remains UI evidence only.
