"""Validate every arm's session payload before spending money on a full run.

Checks, per arm:
  1. the ASR-only session is accepted (turn_detection disabled)
  2. what the service reports back for the audio front-end knobs
  3. a real clip round-trips to a transcript via manual commit

Run:  ../../venv/bin/python bench/quality/probe_session.py --wav <clean.wav>
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import subprocess
import sys
from pathlib import Path

import websockets

from engines import ARMS, connect_kwargs

MARKER = "openfon-bench-probe"


def load_pcm24k(path: Path) -> bytes:
    """Read a 16 kHz mono WAV and resample to 24 kHz PCM16 via ffmpeg."""
    out = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(path),
         "-ac", "1", "-ar", "24000", "-f", "s16le", "-"],
        check=True, capture_output=True,
    )
    return out.stdout


async def probe(arm_name: str, wav: Path | None) -> dict:
    arm = ARMS[arm_name]
    res: dict = {"arm": arm_name, "url": arm.url.split("?")[0], "model": arm.model}
    loop = asyncio.get_event_loop()
    try:
        async with websockets.connect(arm.url, **connect_kwargs(arm)) as ws:
            await ws.send(json.dumps(
                {"type": "session.update", "session": arm.session_asr("en", MARKER)}))

            created = updated = None
            errors: list = []
            deadline = loop.time() + 15
            while loop.time() < deadline:
                try:
                    ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                except asyncio.TimeoutError:
                    break
                t = ev.get("type")
                if t == "session.created":
                    created = ev["session"]
                elif t == "session.updated":
                    updated = ev["session"]
                    break
                elif t == "error":
                    errors.append(ev.get("error"))
                    break

            res["accepted"] = updated is not None
            res["errors"] = errors
            if created:
                res["frontend_fields_offered"] = sorted(
                    k for k in created if "noise" in k or "echo" in k or "denoise" in k)
                res["default_noise_reduction"] = created.get("input_audio_noise_reduction")
                res["default_echo_cancellation"] = created.get("input_audio_echo_cancellation")
            if updated:
                res["turn_detection_after"] = updated.get("turn_detection") or (
                    (updated.get("audio") or {}).get("input", {}).get("turn_detection"))
                res["noise_reduction_after"] = updated.get("input_audio_noise_reduction")
                res["echo_cancellation_after"] = updated.get("input_audio_echo_cancellation")

            if wav and updated is not None:
                pcm = load_pcm24k(wav)
                for i in range(0, len(pcm), 9600):  # 200 ms frames
                    await ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(pcm[i:i + 9600]).decode(),
                    }))
                await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                transcript, saw = None, []
                deadline = loop.time() + 40
                while loop.time() < deadline:
                    try:
                        ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                    except asyncio.TimeoutError:
                        break
                    saw.append(ev.get("type"))
                    if ev.get("type") == "error":
                        errors.append(ev.get("error"))
                        break
                    tr = arm.caller_transcript(ev)
                    if tr:
                        transcript = tr
                        break
                res["transcript"] = transcript
                res["events_seen"] = saw[:14]
                res["audio_seconds"] = round(len(pcm) / 48000, 2)
    except Exception as e:  # noqa: BLE001 - a probe reports failures, never raises
        res["exception"] = f"{type(e).__name__}: {e}"
    return res


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default=",".join(ARMS))
    ap.add_argument("--wav", help="a clean 16 kHz WAV to round-trip")
    a = ap.parse_args()

    wav = Path(a.wav) if a.wav else None
    for name in a.arms.split(","):
        # Serialised on purpose: parallel handshakes inflated connect time to 3.6 s.
        print(json.dumps(await probe(name.strip(), wav), ensure_ascii=False, indent=2))
        sys.stdout.flush()
        await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(main())
