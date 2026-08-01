#!/usr/bin/env python3
"""Realtime-voice latency benchmark: Kataleptic gateway vs. direct Azure.

One "turn" = one freshly opened session, one real-time-paced caller utterance,
one agent reply. Fresh sessions keep conversation context identical across
every turn, so no arm gets a growing prompt.

Turns are run strictly serially and interleaved round-robin across arms, so
network drift and time-of-day load hit every arm equally, and every
(round, utterance) cell has one turn per arm — which is what makes the paired
analysis in analyze.py valid.

  python bench.py --rounds 25 --out results/
  python bench.py --rounds 1 --arms native-direct,vl-direct   # smoke test

Credentials (never committed, read from the environment):
  AZURE_REALTIME_KEY   key for duguet-labs-eu   (az cognitiveservices account
                       keys list -n duguet-labs-eu -g qptr-projects --query key1 -o tsv)
  KATALEPTIC_KEY       gateway key; falls back to DEFAULT_LLM_API_KEY in .dev.vars
  AZURE_SPEECH_KEY     Speech key, only needed the first time (caller-audio TTS)
  AZURE_SPEECH_REGION  defaults to westeurope
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import csv
import json
import os
import re
import secrets
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))

import arms as arms_mod  # noqa: E402
from arms import ARMS, ARMS_BY_ID, Arm  # noqa: E402
from audio import FRAME_MS, SAMPLE_RATE, Utterance, load_utterances  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
FRAME_S = FRAME_MS / 1000.0
BYTES_PER_MS = SAMPLE_RATE * 2 // 1000          # 48
SILENCE_FRAME = b"\x00" * (SAMPLE_RATE * 2 * FRAME_MS // 1000)


@dataclass
class Turn:
    """One measured turn. Times in ms; None when the event never arrived."""
    round: int
    arm: str
    brain: str
    utterance: str
    lang: str
    utterance_s: float
    ts: str
    ok: bool = False
    error: str = ""
    connect_ms: float | None = None
    config_ms: float | None = None
    speech_stopped_ms: float | None = None
    ttfa_ms: float | None = None
    ttft_ms: float | None = None
    transcript_ms: float | None = None
    response_total_ms: float | None = None
    audio_out_ms: float | None = None
    transcript: str = ""
    caller_transcript: str = ""
    # responses server VAD started and cancelled mid-utterance (a clause pause
    # longer than silence_duration_ms); their timings are discarded
    false_starts: int = 0
    usage: dict = field(default_factory=dict)


def load_kataleptic_key() -> str:
    if os.environ.get("KATALEPTIC_KEY"):
        return os.environ["KATALEPTIC_KEY"]
    dev_vars = REPO_ROOT / ".dev.vars"
    if dev_vars.exists():
        for line in dev_vars.read_text().splitlines():
            m = re.match(r"\s*(?:REALTIME_API_KEY|DEFAULT_LLM_API_KEY)\s*=\s*(.+)", line)
            if m:
                return m.group(1).strip().strip("'\"")
    raise SystemExit("no gateway key: set KATALEPTIC_KEY or add DEFAULT_LLM_API_KEY to .dev.vars")


async def run_turn(arm: Arm, utt: Utterance, rnd: int, *, azure_key: str,
                   kataleptic_key: str, reply_timeout: float) -> Turn:
    t = Turn(round=rnd, arm=arm.id, brain=arm.brain, utterance=utt.id, lang=utt.lang,
             utterance_s=round(utt.duration_s, 3),
             ts=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    marker = f"MK{secrets.token_hex(4)}"
    url = arm.url(azure_key, kataleptic_key)
    headers = arm.headers(azure_key, kataleptic_key)

    t_dial = time.monotonic()
    try:
        ws = await websockets.connect(url, additional_headers=headers,
                                      max_size=None, open_timeout=20)
    except Exception as e:                                  # noqa: BLE001
        t.error = f"connect: {type(e).__name__}: {str(e)[:200]}"
        return t
    t.connect_ms = (time.monotonic() - t_dial) * 1000

    try:
        async with ws:
            # ── configure ────────────────────────────────────────────
            # Match the echo on our own marker: the gateway injects its own
            # session.update upstream, so the FIRST session.updated on the
            # proxied arms is not ours.
            t_cfg = time.monotonic()
            await ws.send(json.dumps({"type": "session.update",
                                      "session": arm.session_payload(marker)}))
            while True:
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=25))
                if ev.get("type") == "error":
                    t.error = f"config: {json.dumps(ev.get('error'))[:250]}"
                    return t
                if ev.get("type") == "session.updated" and \
                        marker in json.dumps((ev.get("session") or {}).get("instructions") or ""):
                    break
            t.config_ms = (time.monotonic() - t_cfg) * 1000

            # ── stream the caller, real-time paced ───────────────────
            frames = utt.frames()
            speech_end = asyncio.get_running_loop().create_future()

            async def sender():
                """20 ms frames on a wall clock, then silence so server VAD has
                something to time its hangover against."""
                clock = time.monotonic()
                for fr in frames:
                    await ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(fr).decode()}))
                    clock += FRAME_S
                    delay = clock - time.monotonic()
                    if delay > 0:
                        await asyncio.sleep(delay)
                if not speech_end.done():
                    speech_end.set_result(clock)   # when the last frame finishes playing
                for _ in range(int(reply_timeout / FRAME_S)):
                    await ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(SILENCE_FRAME).decode()}))
                    clock += FRAME_S
                    delay = clock - time.monotonic()
                    if delay > 0:
                        await asyncio.sleep(delay)

            send_task = asyncio.create_task(sender())
            audio_bytes = 0
            deadline = time.monotonic() + utt.duration_s + reply_timeout + 5.0
            try:
                while True:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        t.error = t.error or "timeout waiting for response.done"
                        break
                    try:
                        ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=left))
                    except asyncio.TimeoutError:
                        t.error = t.error or "timeout waiting for response.done"
                        break
                    et = ev.get("type") or ""
                    now = time.monotonic()
                    # All reply metrics are measured from the instant the last
                    # speech frame finishes playing out, not from the send call.
                    t0 = speech_end.result() if speech_end.done() else None

                    def since() -> float | None:
                        return (now - t0) * 1000 if t0 is not None else None

                    # A clause pause inside an utterance can exceed
                    # silence_duration_ms: server VAD then commits early, starts a
                    # response, and cancels it ("reason": "turn_detected") when the
                    # caller resumes. That response answers a fragment, not the
                    # utterance — discard everything it produced and keep waiting.
                    if t0 is None:
                        if et == "response.done":
                            t.false_starts += 1
                            t.ttfa_ms = t.ttft_ms = t.transcript_ms = None
                            t.transcript = ""
                            audio_bytes = 0
                        continue

                    if et == "error":
                        t.error = f"session: {json.dumps(ev.get('error'))[:250]}"
                        break
                    if et == "input_audio_buffer.speech_stopped" and t.speech_stopped_ms is None:
                        t.speech_stopped_ms = since()
                    elif arms_mod.is_audio_delta(et):
                        if t.ttfa_ms is None:
                            t.ttfa_ms = since()
                        audio_bytes += len(base64.b64decode(ev.get("delta") or ""))
                    elif arms_mod.is_transcript_delta(et):
                        if t.ttft_ms is None:
                            t.ttft_ms = since()
                        t.transcript += ev.get("delta") or ""
                    elif arms_mod.is_input_transcription_done(et):
                        if t.transcript_ms is None:
                            t.transcript_ms = since()
                        t.caller_transcript = (ev.get("transcript") or "").strip()
                    elif et == "response.done":
                        resp = ev.get("response") or {}
                        if resp.get("status") == "cancelled":
                            # a late cancellation of a fragment response
                            t.false_starts += 1
                            t.ttfa_ms = t.ttft_ms = None
                            t.transcript = ""
                            audio_bytes = 0
                            continue
                        t.response_total_ms = since()
                        t.usage = resp.get("usage") or {}
                        t.audio_out_ms = audio_bytes / BYTES_PER_MS
                        t.ok = t.ttfa_ms is not None
                        break
            finally:
                send_task.cancel()
    except Exception as e:                                  # noqa: BLE001
        t.error = t.error or f"{type(e).__name__}: {str(e)[:200]}"
    t.transcript = t.transcript.strip()
    return t


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rounds", type=int, default=25,
                    help="turns per arm (default 25)")
    ap.add_argument("--arms", default="",
                    help="comma-separated arm ids (default: all five)")
    ap.add_argument("--out", default=str(HERE / "results"))
    ap.add_argument("--reply-timeout", type=float, default=20.0,
                    help="seconds of silence streamed while waiting for the reply")
    ap.add_argument("--gap", type=float, default=0.75,
                    help="seconds between turns; keeps well under the 200 RPM cap")
    ap.add_argument("--tag", default="", help="label folded into the output filenames")
    args = ap.parse_args()

    selected = ([ARMS_BY_ID[a.strip()] for a in args.arms.split(",") if a.strip()]
                if args.arms else list(ARMS))
    azure_key = os.environ.get("AZURE_REALTIME_KEY", "")
    if not azure_key and any(a.creds == "azure" for a in selected):
        raise SystemExit("set AZURE_REALTIME_KEY (see README)")
    kataleptic_key = (load_kataleptic_key()
                      if any(a.creds == "kataleptic" for a in selected) else "")

    utterances = load_utterances(
        region=os.environ.get("AZURE_SPEECH_REGION", "westeurope"),
        key=os.environ.get("AZURE_SPEECH_KEY", ""))

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    suffix = f"{stamp}{'-' + args.tag if args.tag else ''}"
    jsonl_path = out_dir / f"turns-{suffix}.jsonl"
    csv_path = out_dir / f"turns-{suffix}.csv"

    total = args.rounds * len(selected)
    print(f"{len(selected)} arms x {args.rounds} rounds = {total} turns")
    print(f"utterances: " + ", ".join(f"{u.id} ({u.duration_s:.1f}s)" for u in utterances))
    print(f"-> {jsonl_path}\n")

    turns: list[Turn] = []
    started = time.monotonic()
    with jsonl_path.open("w") as fh:
        for rnd in range(args.rounds):
            utt = utterances[rnd % len(utterances)]
            # rotate the arm order every round so no arm always goes first
            order = selected[rnd % len(selected):] + selected[:rnd % len(selected)]
            for arm in order:
                turn = await run_turn(arm, utt, rnd, azure_key=azure_key,
                                      kataleptic_key=kataleptic_key,
                                      reply_timeout=args.reply_timeout)
                turns.append(turn)
                fh.write(json.dumps(asdict(turn)) + "\n")
                fh.flush()
                done = len(turns)
                eta = (time.monotonic() - started) / done * (total - done)
                flag = "ok " if turn.ok else "ERR"
                print(f"[{done:>4}/{total}] r{rnd:<3} {arm.id:<16} {utt.id:<9} {flag} "
                      f"ttfa={turn.ttfa_ms or float('nan'):7.0f}ms  eta {eta/60:4.1f}m"
                      + (f"  {turn.error[:90]}" if turn.error else ""))
                await asyncio.sleep(args.gap)

    fields = list(asdict(turns[0]).keys()) if turns else []
    with csv_path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for t in turns:
            row = asdict(t)
            row["usage"] = json.dumps(row["usage"])
            w.writerow(row)

    ok = sum(1 for t in turns if t.ok)
    print(f"\n{ok}/{len(turns)} turns ok in {(time.monotonic()-started)/60:.1f} min")
    print(f"wrote {jsonl_path}\n      {csv_path}")
    print(f"\nnow run:  python analyze.py {jsonl_path}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
