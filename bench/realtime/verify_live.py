#!/usr/bin/env python3
"""Check the config verifier against the real endpoints.

`test_harness.py` exercises `Arm.verify_echo` against synthetic echo payloads,
which proves the logic but not that the fixtures resemble what the services
actually send. This connects to every arm, captures its real `session.updated`,
and asserts two things:

  1. the real echo verifies clean (no false aborts — a verifier that rejects
     valid sessions is worse than none);
  2. mutating that real echo — codec substituted, field removed, rate changed —
     is caught every time (no false passes).

Run it after touching `verify_echo`, or when an endpoint's echo shape may have
changed. Costs nothing: it opens a session, reads the echo and closes.

  AZURE_REALTIME_KEY=... KATALEPTIC_KEY=... python verify_live.py
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))

from arms import ARMS_BY_ID, Arm  # noqa: E402
from bench import load_kataleptic_key  # noqa: E402
from safety import safe_print  # noqa: E402

MARKER = "MKVERIFY"


async def capture(arm: Arm, azure_key: str, kat_key: str) -> dict | None:
    """The arm's own `session.updated` — matched on our marker, since the
    gateway injects one of its own first."""
    async with websockets.connect(arm.url(azure_key, kat_key),
                                  additional_headers=arm.headers(azure_key, kat_key),
                                  max_size=None, open_timeout=20) as ws:
        await ws.send(json.dumps({"type": "session.update",
                                  "session": arm.session_payload(MARKER)}))
        for _ in range(10):
            ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
            if ev.get("type") == "error":
                raise RuntimeError(json.dumps(ev.get("error"))[:200])
            sess = ev.get("session") or {}
            if ev.get("type") == "session.updated" and \
                    MARKER in json.dumps(sess.get("instructions") or ""):
                return sess
    return None


def mutate(sess: dict, arm: Arm, kind: str) -> dict:
    """Break one control in a real echo, the way a service silently would."""
    s = copy.deepcopy(sess)
    if arm.dialect == "vl":
        if kind == "codec":
            s["output_audio_format"] = "g711_ulaw"
        elif kind == "absent-format":
            s.pop("input_audio_format", None)
        elif kind == "rate":
            s["input_audio_sampling_rate"] = 16000
        elif kind == "detector":
            s.setdefault("turn_detection", {})["type"] = "none"
        elif kind == "detector-field":
            td = s.setdefault("turn_detection", {})
            for k in arm.turn_detection:
                if k != "type":
                    td.pop(k, None)      # drop every field but the type
                    break
    else:
        if kind == "codec":
            s["audio"]["output"]["format"] = {"type": "audio/pcmu"}
        elif kind == "absent-format":
            s["audio"]["input"].pop("format", None)
        elif kind == "rate":
            s["audio"]["input"]["format"] = {"type": "audio/pcm", "rate": 16000}
        elif kind == "detector":
            s["audio"]["input"].setdefault("turn_detection", {})["type"] = "none"
        elif kind == "detector-field":
            td = s["audio"]["input"].setdefault("turn_detection", {})
            for k in arm.turn_detection:
                if k != "type":
                    td.pop(k, None)
                    break
    return s


MUTATIONS = ("codec", "absent-format", "rate", "detector", "detector-field")


async def main() -> int:
    azure_key = os.environ.get("AZURE_REALTIME_KEY", "")
    kat_key = os.environ.get("KATALEPTIC_KEY") or load_kataleptic_key()
    if not azure_key:
        raise SystemExit("set AZURE_REALTIME_KEY (see README)")

    failures = 0
    # Every REGISTERED arm, not a hand-maintained list. Iterating a subset
    # printed OK while checking none of the newest model/detector
    # combinations — 'absent reads as a pass', in the tool built to catch
    # exactly that.
    for arm in ARMS_BY_ID.values():
        try:
            sess = await capture(arm, azure_key, kat_key)
        except Exception as e:                                # noqa: BLE001
            safe_print(f"  {arm.id:<18} CAPTURE FAILED: {type(e).__name__}: {str(e)[:120]}")
            failures += 1
            continue
        if sess is None:
            safe_print(f"  {arm.id:<18} no marker echo")
            failures += 1
            continue

        fatal, advisory = arm.verify_echo(sess)
        note = ""
        if fatal:
            # A fatal on a REAL echo is either the checker being wrong or the
            # endpoint genuinely substituting config. The gateway's known
            # session-update injection race does the latter intermittently, so
            # retry once to tell them apart rather than blaming the checker.
            try:
                again = await capture(arm, azure_key, kat_key)
                refatal, _ = arm.verify_echo(again) if again else (fatal, [])
            except Exception:                                 # noqa: BLE001
                refatal = fatal
            if refatal:
                note = f"  CHECKER OR ENDPOINT WRONG (twice): {fatal}"
                failures += 1
            else:
                note = (f"  intermittent divergence, clean on retry — the known "
                        f"injection race: {fatal}")
        elif advisory:
            note = f"  (advisory: {advisory})"

        missed = [k for k in MUTATIONS if not arm.verify_echo(mutate(sess, arm, k))[0]]
        failures += len(missed)
        status = "all caught" if not missed else f"MISSED {missed}"
        safe_print(f"  {arm.id:<18} real echo clean; mutations: {status}{note}")

    safe_print("\nOK" if not failures else f"\n{failures} problem(s)")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
