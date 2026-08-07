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


FFMPEG_TIMEOUT_S = 120


def load_pcm24k(path: Path) -> bytes:
    """Read a 16 kHz mono WAV and resample to 24 kHz PCM16 via ffmpeg."""
    out = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(path),
         "-ac", "1", "-ar", "24000", "-f", "s16le", "-"],
        check=True, capture_output=True, timeout=FFMPEG_TIMEOUT_S,
    )
    return out.stdout


async def probe(arm_name: str, wav: Path | None) -> dict:
    arm = ARMS[arm_name]
    # Validate each arm with the payload the study actually sends it. Probing
    # every arm with `session_asr` meant the two Voice-Live gpt-realtime arms
    # were sent a combination the service is documented to reject — they run
    # Track B only, and `run_all.sh` keeps them out of ASR_ARMS for that reason.
    # Recording that expected refusal as a failed arm makes the documented
    # pre-flight fail deterministically on arms that are perfectly valid, and a
    # pre-flight that cries wolf is one people learn to skip. Saying it in the
    # exit status is only right when the thing being said is true.
    payload = (arm.session_asr("en", MARKER) if arm.asr_manual_commit
               else arm.session_dialog(MARKER, "en"))
    res: dict = {"arm": arm_name, "url": arm.url.split("?")[0], "model": arm.model,
                 "payload": "asr" if arm.asr_manual_commit else "dialog"}
    loop = asyncio.get_event_loop()
    try:
        async with websockets.connect(arm.url, **connect_kwargs(arm)) as ws:
            await ws.send(json.dumps({"type": "session.update", "session": payload}))

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

            # Manual commit only. On a dialog-payload arm the VAD owns the
            # buffer, so committing by hand would both misbehave and provoke a
            # billed response from a pre-flight.
            if wav and updated is not None and not arm.asr_manual_commit:
                res["transcript_skipped"] = (
                    "dialog payload: this arm does not accept manual commit, "
                    "so a clip round-trip is not part of its pre-flight")
            if wav and updated is not None and arm.asr_manual_commit:
                pcm = load_pcm24k(wav)
                for i in range(0, len(pcm), 9600):  # 200 ms frames
                    await ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(pcm[i:i + 9600]).decode(),
                    }))
                await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                # Keep the longest text rather than the first, and drain for a
                # moment after it: with noise reduction on, Voice Live emits an
                # empty and a non-empty completion for the same item in either
                # order. `caller_transcript` returns a truthy tuple for the empty
                # one too, so stopping at the first match makes the preflight
                # probe report "no transcript" while the real one is still
                # queued — on the arm most likely to send someone here.
                transcript, saw = "", []
                deadline = loop.time() + 40
                settle = None
                while loop.time() < deadline:
                    if settle is not None and loop.time() > settle:
                        break
                    try:
                        ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                    except asyncio.TimeoutError:
                        break
                    saw.append(ev.get("type"))
                    if ev.get("type") == "error":
                        errors.append(ev.get("error"))
                        break
                    got = arm.caller_transcript(ev)
                    if got is not None:
                        if len(got[1]) > len(transcript):
                            transcript = got[1]
                        if settle is None:
                            settle = loop.time() + 3   # let a duplicate land
                transcript = transcript or None
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

    names = [n.strip() for n in a.arms.split(",") if n.strip()]
    if not names:
        sys.exit(f"--arms {a.arms!r} names no arms")
    if unknown := sorted(set(names) - set(ARMS)):
        sys.exit(f"--arms names {', '.join(unknown)}, which are not arms. "
                 f"Known: {', '.join(sorted(ARMS))}")

    wav = Path(a.wav) if a.wav else None
    failed: list[str] = []
    for name in names:
        # Serialised on purpose: parallel handshakes inflated connect time to 3.6 s.
        res = await probe(name, wav)
        print(json.dumps(res, ensure_ascii=False, indent=2))
        sys.stdout.flush()
        # `probe` reports failures in its result rather than raising, so the
        # exit code is the only place left to say the pre-flight did not pass.
        if res.get("exception"):
            failed.append(f"{name}: {res['exception']}")
        elif res.get("errors"):
            failed.append(f"{name}: service errors {res['errors']}")
        elif not res.get("accepted"):
            # The check this file is named for, and the one the first version of
            # this guard left out: `probe` records `accepted: false` when
            # `session.updated` never arrives, with no exception and no error
            # events to show for it — a bare timeout. That collection matched
            # none of the branches above, so a session that was never
            # established passed the pre-flight. The sweep for "work that can be
            # skipped and still exit 0" had this very file open and missed an
            # instance of it; see COMPLETENESS.md.
            failed.append(f"{name}: the session was never accepted — no "
                          "session.updated within 15 s, and no error event "
                          "saying why")
        elif (wav is not None and res.get("transcript_skipped") is None
                and not res.get("transcript")):
            # The whole point of --wav is proving a clip round-trips. Printing
            # `"transcript": null` and exiting 0 is this harness's signature
            # defect in its own pre-flight: absence reading as a pass.
            failed.append(f"{name}: no transcript came back for {wav}")
        await asyncio.sleep(1)

    # This is README step 3, the gate in front of a paid run. A pre-flight that
    # reports every arm broken and still exits 0 cannot gate anything: a caller
    # chaining `probe_session.py && run_all.sh` would spend on a matrix whose
    # arms it has just proved unreachable.
    if failed:
        sys.exit(f"\n{len(failed)} of {len(names)} arm(s) did not pass the "
                 "pre-flight:\n  " + "\n  ".join(failed) +
                 "\nDo not start a paid run until these are resolved.")


if __name__ == "__main__":
    asyncio.run(main())
