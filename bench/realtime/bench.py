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
from safety import redact, safe_print, scrub_record  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
FRAME_S = FRAME_MS / 1000.0
BYTES_PER_MS = SAMPLE_RATE * 2 // 1000          # 48
SILENCE_FRAME = b"\x00" * (SAMPLE_RATE * 2 * FRAME_MS // 1000)
# How long to keep the socket open after response.done waiting for the
# asynchronous caller transcript. Closing immediately would drop precisely the
# slow samples and make transcript_ms look better than it is.
TRANSCRIPT_GRACE_S = 4.0




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
    # of those, how many got as far as emitting audio — the difference between
    # the caller being talked over and the service silently re-segmenting
    false_starts_audible: int = 0
    false_start_audio_ms: float = 0.0
    # which input item the accepted caller transcript belongs to (split turns
    # commit several, and a late one for an earlier fragment must not be used)
    transcript_item_id: str = ""
    # True once an echo was actually verified; absence of warnings on a turn
    # that never configured is not evidence the controls held
    config_verified: bool = False
    # fields the endpoint echoed back differently from what we asked for.
    # config_fatal means a measurement-critical control could not be confirmed
    # and the turn was aborted; config_warnings is recorded but not fatal.
    config_warnings: list = field(default_factory=list)
    config_fatal: list = field(default_factory=list)
    # the caller transcript never arrived within TRANSCRIPT_GRACE_S of
    # response.done, so transcript_ms is genuinely missing rather than fast
    transcript_timed_out: bool = False
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


def discard_fragment(t: "Turn", resp_audio_bytes: int) -> int:
    """Record a server-VAD fragment response and drop what it produced.

    Whether the fragment emitted audio is the difference between the caller
    being talked over and a silent re-segmentation, so it is counted rather
    than assumed. Returns the reset byte counter.
    """
    t.false_starts += 1
    if resp_audio_bytes:
        t.false_starts_audible += 1
        t.false_start_audio_ms += resp_audio_bytes / BYTES_PER_MS
    return 0


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
        t.error = redact(f"connect: {type(e).__name__}: {e}")[:250]
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
                    t.error = redact(f"config: {json.dumps(ev.get('error'))}")[:300]
                    return t
                if ev.get("type") == "session.updated" and \
                        marker in json.dumps((ev.get("session") or {}).get("instructions") or ""):
                    break
            t.config_ms = (time.monotonic() - t_cfg) * 1000
            # The marker proves our update was processed; it does not prove the
            # endpoint honoured every field. Check what was actually echoed, so
            # the claim that controls are held constant rests on data.
            fatal, advisory = arm.verify_echo(ev.get("session") or {})
            t.config_warnings = advisory
            t.config_fatal = fatal
            t.config_verified = not fatal
            if fatal:
                # A control we cannot confirm is not a control. Abort rather
                # than emit a measurement that would look identical to a valid
                # one — a substituted codec, for instance, silently corrupts
                # audio_out_ms, which is derived from a byte count.
                t.error = "config unverified: " + "; ".join(fatal)
                return t

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
            # Audio for the response currently in flight, whichever side of
            # speech-end it arrives on. A fragment can start before speech ends
            # and be cancelled after, so one counter spanning both is the only
            # way its audio is attributed to the right response.
            resp_audio_bytes = 0
            fragment_items: set[str] = set()   # input items committed mid-utterance
            final_items: set[str] = set()      # input items committed after speech end
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

                    # An upstream error is always fatal to the turn and must be
                    # reported verbatim — a benchmark that misreports *why* a turn
                    # failed is worse than one that fails loudly. Checked before
                    # the pre-speech-end filter below so mid-utterance errors are
                    # not swallowed into a generic timeout.
                    if et == "error":
                        t.error = redact(f"session: {json.dumps(ev.get('error'))}")[:300]
                        break

                    # A clause pause inside an utterance can exceed
                    # silence_duration_ms: server VAD then commits early, starts a
                    # response, and cancels it ("reason": "turn_detected") when the
                    # caller resumes. That response answers a fragment, not the
                    # utterance — discard everything it produced and keep waiting.
                    #
                    # Whether the fragment got as far as EMITTING AUDIO is the
                    # difference between "the caller was talked over" and "the
                    # service silently re-segmented", so it is counted separately
                    # rather than assumed.
                    if t0 is None:
                        if arms_mod.is_audio_delta(et):
                            resp_audio_bytes += len(base64.b64decode(ev.get("delta") or ""))
                        elif et == "input_audio_buffer.committed" and ev.get("item_id"):
                            fragment_items.add(ev["item_id"])
                        elif et == "response.done":
                            resp_audio_bytes = discard_fragment(t, resp_audio_bytes)
                            t.ttfa_ms = t.ttft_ms = t.transcript_ms = None
                            t.transcript = ""
                            t.caller_transcript = ""
                        continue
                    if et == "input_audio_buffer.speech_stopped" and t.speech_stopped_ms is None:
                        t.speech_stopped_ms = since()
                    elif et == "input_audio_buffer.committed":
                        # the input item this turn's reply actually answers
                        if ev.get("item_id"):
                            final_items.add(ev["item_id"])
                    elif arms_mod.is_audio_delta(et):
                        if t.ttfa_ms is None:
                            t.ttfa_ms = since()
                        resp_audio_bytes += len(base64.b64decode(ev.get("delta") or ""))
                    elif arms_mod.is_transcript_delta(et):
                        if t.ttft_ms is None:
                            t.ttft_ms = since()
                        t.transcript += ev.get("delta") or ""
                    elif arms_mod.is_input_transcription_done(et):
                        # On a split turn the service commits several input items,
                        # and a late transcript for an EARLIER fragment would
                        # otherwise become this turn's transcript_ms. Only accept
                        # the completion for an item committed after speech ended.
                        item_id = ev.get("item_id")
                        if item_id and item_id in fragment_items:
                            continue                       # belongs to a fragment
                        if item_id and final_items and item_id not in final_items:
                            continue
                        if t.transcript_ms is None:
                            t.transcript_ms = since()
                            t.transcript_item_id = item_id or ""
                        t.caller_transcript = (ev.get("transcript") or "").strip()
                    elif et == "response.done":
                        resp = ev.get("response") or {}
                        status = resp.get("status")
                        if status == "cancelled":
                            # A fragment response whose cancellation arrived after
                            # speech ended. Its audio may have been emitted on
                            # either side of t0, which is why the counter spans
                            # both — checking only post-t0 bytes would report an
                            # audible fragment as silent.
                            resp_audio_bytes = discard_fragment(t, resp_audio_bytes)
                            t.ttfa_ms = t.ttft_ms = None
                            t.transcript = ""
                            continue
                        if status != "completed":
                            # A failed or incomplete response is not a
                            # measurement. Letting it through would feed a
                            # truncated reply into response_total_ms, the
                            # reply-length figures and the paired statistics.
                            t.error = redact(
                                f"response status={status!r}: "
                                f"{json.dumps(resp.get('status_details'))}")[:300]
                            break
                        t.response_total_ms = since()
                        t.usage = resp.get("usage") or {}
                        t.audio_out_ms = resp_audio_bytes / BYTES_PER_MS
                        t.ok = t.ttfa_ms is not None
                        # Input transcription is asynchronous and often lands
                        # AFTER response.done. Closing here would drop exactly
                        # the slow samples and bias transcript_ms optimistically,
                        # so wait a bounded moment for it.
                        if t.transcript_ms is None:
                            t_deadline = time.monotonic() + TRANSCRIPT_GRACE_S
                            while time.monotonic() < t_deadline:
                                try:
                                    ev2 = json.loads(await asyncio.wait_for(
                                        ws.recv(), timeout=t_deadline - time.monotonic()))
                                except Exception:               # noqa: BLE001
                                    break                       # timeout or closed
                                if arms_mod.is_input_transcription_done(ev2.get("type") or ""):
                                    t.transcript_ms = (time.monotonic() - t0) * 1000
                                    t.caller_transcript = (ev2.get("transcript") or "").strip()
                                    break
                            t.transcript_timed_out = t.transcript_ms is None
                        break
            finally:
                send_task.cancel()
    except Exception as e:                                  # noqa: BLE001
        t.error = t.error or redact(f"{type(e).__name__}: {e}")[:250]
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
    ap.add_argument("--utterances", default="",
                    help="comma-separated utterance ids; narrows the cycle when a "
                         "question only one utterance can answer needs the power "
                         "(e.g. --utterances de-short for clause-pause splitting)")
    args = ap.parse_args()

    selected = ([ARMS_BY_ID[a.strip()] for a in args.arms.split(",") if a.strip()]
                if args.arms else list(ARMS))
    azure_key = os.environ.get("AZURE_REALTIME_KEY", "")
    if not azure_key and any(a.creds == "azure" for a in selected):
        raise SystemExit("set AZURE_REALTIME_KEY (see README)")
    kataleptic_key = (load_kataleptic_key()
                      if any(a.creds == "kataleptic" for a in selected) else "")

    wanted = ([u.strip() for u in args.utterances.split(",") if u.strip()]
              if args.utterances else None)
    utterances = load_utterances(
        region=os.environ.get("AZURE_SPEECH_REGION", "westeurope"),
        key=os.environ.get("AZURE_SPEECH_KEY", ""), only=wanted)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    suffix = f"{stamp}{'-' + args.tag if args.tag else ''}"
    jsonl_path = out_dir / f"turns-{suffix}.jsonl"
    csv_path = out_dir / f"turns-{suffix}.csv"

    total = args.rounds * len(selected)
    safe_print(f"{len(selected)} arms x {args.rounds} rounds = {total} turns")
    safe_print(f"utterances: " + ", ".join(f"{u.id} ({u.duration_s:.1f}s)" for u in utterances))
    safe_print(f"-> {jsonl_path}\n")

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
                fh.write(json.dumps(scrub_record(asdict(turn))) + "\n")
                fh.flush()
                done = len(turns)
                eta = (time.monotonic() - started) / done * (total - done)
                flag = "ok " if turn.ok else "ERR"
                safe_print(f"[{done:>4}/{total}] r{rnd:<3} {arm.id:<16} {utt.id:<9} {flag} "
                      f"ttfa={turn.ttfa_ms or float('nan'):7.0f}ms  eta {eta/60:4.1f}m"
                      + (f"  {turn.error[:90]}" if turn.error else ""))
                await asyncio.sleep(args.gap)

    fields = list(asdict(turns[0]).keys()) if turns else []
    with csv_path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for t in turns:
            row = scrub_record(asdict(t))
            row["usage"] = json.dumps(row["usage"])
            w.writerow(row)

    ok = sum(1 for t in turns if t.ok)
    safe_print(f"\n{ok}/{len(turns)} turns ok in {(time.monotonic()-started)/60:.1f} min")
    safe_print(f"wrote {jsonl_path}\n      {csv_path}")
    safe_print(f"\nnow run:  python analyze.py {jsonl_path}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
