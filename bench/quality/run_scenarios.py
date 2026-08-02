"""Track B — run the Riverside Dental scenarios as live multi-turn calls.

Caller audio is streamed at **1x real time**. That is not politeness: server VAD
decides end-of-turn from silence duration, so blasting the buffer would make
every turn look like one instantaneous utterance and would destroy both the
turn-taking behaviour and the responsiveness numbers.

Per turn we record
  ttfa_ms        last caller audio byte sent -> first agent audio byte
  eou_ms         true end of caller speech (known: we synthesised it) -> same
  agent text, tool calls, and the full raw event log

For a turn flagged `barge_in_after_ms`, the caller's audio starts that many ms
after the agent's first audio byte, and we measure
  bargein_stop_ms   barge-in onset -> agent's last audio byte

  python run_scenarios.py --arm vl-gpt41mini --trial 1 \
      --audio ../../../data/scenarios --out results/scenarios.jsonl
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import subprocess
import sys
import time
from pathlib import Path

import websockets

from engines import ARMS, connect_kwargs, load_prompt
from events import function_call, redact, response_cancelled

FRAME_MS = 40                       # 40 ms frames ~= a realistic RTP cadence
LANG_CODE = {"en_US": "en", "de_DE": "de"}
MAX_TURN_WAIT_S = 25
MAX_SESSION_S = 180                 # hard cap so a runaway session cannot bill forever


def pcm24k(path: Path) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(path),
         "-ac", "1", "-ar", "24000", "-f", "s16le", "-"],
        check=True, capture_output=True,
    ).stdout


class Turn:
    """Accumulates everything the agent did in response to one caller turn."""

    def __init__(self) -> None:
        self.first_audio_t: float | None = None
        self.last_audio_t: float | None = None
        self.audio_bytes = 0
        self.text: list[str] = []
        self.tools: list[str] = []
        self.done = False
        self.cancelled = False
        self.transcript_mark = 0


async def run_scenario(arm_name: str, sc: dict, audio_dir: Path, trial: int,
                       log) -> dict:
    arm = ARMS[arm_name]
    lang = LANG_CODE.get(sc["lang"], "en")
    prompt = load_prompt()["system_prompt"]
    loop = asyncio.get_event_loop()

    turns_meta = sc["turns"]
    result: dict = {"arm": arm_name, "trial": trial, "scenario": sc["id"],
                    "lang": sc["lang"], "intent": sc["intent"], "turns": [],
                    "transcript": [], "tool_calls": [], "error": None,
                    "audio_in_s": 0.0, "audio_out_bytes": 0}

    t_session0 = time.time()
    async with websockets.connect(arm.url, **connect_kwargs(arm)) as ws:
        await ws.send(json.dumps(
            {"type": "session.update", "session": arm.session_dialog(prompt, lang)}))

        # Match on a marker unique to our prompt: proxied paths inject their own
        # session.update first, and waiting for "the" session.updated would start
        # us streaming against a session that is not the one we configured.
        deadline = loop.time() + 20
        ready = False
        while loop.time() < deadline:
            ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            log.write(json.dumps({"t": time.time(), "ev": redact(ev)}) + "\n")
            if ev.get("type") == "error":
                result["error"] = json.dumps(ev.get("error"))
                return result
            if ev.get("type") == "session.updated":
                if "Riverside Dental" in json.dumps(ev["session"].get("instructions") or ""):
                    ready = True
                    break
        if not ready:
            result["error"] = "never saw our own session.updated"
            return result

        cur = Turn()
        seen_calls: set[str] = set()

        async def pump() -> None:
            """Drain server events into `cur` until the task is cancelled.

            Deliberately a bare `async for` with no per-message timeout: wrapping
            `ws.recv()` in `wait_for` cancels the pending read on every timeout,
            and repeatedly cancelling a websockets read kills the reader — the
            first version of this saw exactly one event per session and then went
            deaf. Termination is by cancelling this task, not by polling.
            """
            nonlocal cur
            async for raw in ws:
                ev = json.loads(raw)
                now = time.time()
                log.write(json.dumps({"t": now, "ev": redact(ev)}) + "\n")
                t = ev.get("type", "")
                if t == "error":
                    result["error"] = json.dumps(ev.get("error"))
                    continue
                if (d := arm.agent_audio_delta(ev)):
                    if cur.first_audio_t is None:
                        cur.first_audio_t = now
                    cur.last_audio_t = now
                    n = len(base64.b64decode(d))
                    cur.audio_bytes += n
                    result["audio_out_bytes"] += n
                elif (txt := arm.agent_text_done(ev)):
                    cur.text.append(txt)
                    result["transcript"].append({"role": "agent", "text": txt})
                elif t == "conversation.item.input_audio_transcription.completed":
                    result["transcript"].append(
                        {"role": "caller_asr", "text": ev.get("transcript") or ""})
                elif (call := function_call(ev)):
                    # One invocation surfaces on several events
                    # (`conversation.item.created`, `response.output_item.done`,
                    # `response.function_call_arguments.done`), all carrying the
                    # same call_id. Appending on each produced the
                    # ['end_call', 'end_call'] visible in earlier logs — a
                    # fictitious duplicate that was then shown to the blind judge.
                    call_id, name = call
                    if call_id not in seen_calls:
                        seen_calls.add(call_id)
                        cur.tools.append(name)
                        result["tool_calls"].append(name)
                elif t == "response.done":
                    # An interrupted generation is `response.done` carrying
                    # `response.status == "cancelled"`. There is no top-level
                    # `response.cancelled` event on either service.
                    if response_cancelled(ev):
                        # A cancellation is NOT the turn's answer. VAD stopping
                        # at an intra-utterance pause and resuming mid-clip ends
                        # the tentative response `cancelled` and a replacement
                        # follows. Marking the turn done here let the post-stream
                        # wait exit immediately, so the replacement was recorded
                        # against the *next* turn — which produced time-to-first-
                        # audio values as low as −5.4 s in the committed
                        # `message-de-01` runs. Discard the abandoned response
                        # and keep waiting for the real one.
                        cur.cancelled = True
                        cur.first_audio_t = None
                        cur.last_audio_t = None
                        cur.audio_bytes = 0
                        cur.text.clear()
                        del result["transcript"][cur.transcript_mark:]
                    else:
                        cur.done = True
                elif t == "response.created":
                    # Where this response's agent text starts, so a cancellation
                    # can drop exactly what it contributed.
                    cur.transcript_mark = len(result["transcript"])

        pump_task = asyncio.create_task(pump())

        # An open phone line, not a file upload. The mic task sends a frame every
        # FRAME_MS forever — caller speech when there is any, digital silence
        # otherwise. This is required, not cosmetic: server VAD emits
        # `speech_stopped` only after it *observes* silence_duration_ms of
        # silence. A harness that stops sending at the end of an utterance never
        # delivers that silence, so the turn never ends and no response is ever
        # generated. (Symptom: exactly one `speech_started` per session and
        # nothing after it.) Continuous audio also makes barge-in behave the way
        # it does on a real call.
        STEP = FRAME_MS * 24000 * 2 // 1000
        SILENCE = b"\x00" * STEP
        mic_q: asyncio.Queue = asyncio.Queue()

        async def mic() -> None:
            next_at = time.time()
            while True:
                try:
                    frame, done = mic_q.get_nowait()
                except asyncio.QueueEmpty:
                    frame, done = SILENCE, None
                await ws.send(json.dumps({
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(frame).decode(),
                }))
                if done is not None:
                    done.set()
                next_at += FRAME_MS / 1000.0
                if (slack := next_at - time.time()) > 0:
                    await asyncio.sleep(slack)
                else:
                    next_at = time.time()

        mic_task = asyncio.create_task(mic())

        async def stream(pcm: bytes) -> tuple[float, float]:
            """Queue `pcm` for the mic; return (t_enqueued, t_last_frame_sent)."""
            t0 = time.time()
            frames = [pcm[i:i + STEP] for i in range(0, len(pcm), STEP)]
            if frames and len(frames[-1]) < STEP:
                frames[-1] = frames[-1] + b"\x00" * (STEP - len(frames[-1]))
            last = asyncio.Event()
            for k, f in enumerate(frames):
                mic_q.put_nowait((f, last if k == len(frames) - 1 else None))
            await last.wait()
            return t0, time.time()

        try:
            for ti, tm in enumerate(turns_meta):
                if time.time() - t_session0 > MAX_SESSION_S:
                    result["error"] = "session cap reached"
                    break

                wav = audio_dir / sc["id"] / f"t{ti:02d}.wav"
                pcm = pcm24k(wav)
                result["audio_in_s"] += len(pcm) / 48000.0
                barge_ms = tm.get("barge_in_after_ms")

                meta: dict = {"index": ti}

                if barge_ms is not None:
                    # `cur` still holds the previous turn's in-flight response —
                    # the one we are about to interrupt. Do NOT rotate it before
                    # measuring: the pump appends to whatever `cur` currently is,
                    # so rotating first would send the agent audio we are trying
                    # to time into a fresh, unwatched Turn.
                    victim = cur
                    w0 = time.time()
                    while victim.first_audio_t is None and time.time() - w0 < MAX_TURN_WAIT_S:
                        await asyncio.sleep(0.02)
                    if victim.first_audio_t is None:
                        result["turns"].append(
                            {"index": ti, "barge_in": True,
                             "note": "agent never spoke, nothing to barge into"})
                        continue

                    await asyncio.sleep(max(0.0, barge_ms / 1000.0
                                            - (time.time() - victim.first_audio_t)))
                    onset = time.time()
                    stream_task = asyncio.create_task(stream(pcm))
                    # Agent audio should stop once server VAD notices the caller.
                    # "Stopped" = no new delta for 600 ms.
                    w0 = time.time()
                    while time.time() - w0 < 6.0:
                        if victim.last_audio_t and time.time() - victim.last_audio_t > 0.6:
                            break
                        await asyncio.sleep(0.02)
                    stop_ms = ((victim.last_audio_t - onset) * 1000
                               if victim.last_audio_t and victim.last_audio_t > onset else None)
                    # Whether there was anything to interrupt at all. These
                    # engines push a whole response's audio down the wire far
                    # faster than real time — a 4 s reply can be fully delivered
                    # and `response.done` within ~600 ms — so by the point a real
                    # caller is 500 ms into *hearing* it, the server has usually
                    # finished sending. When `response_inflight` is false, a null
                    # stop latency means "nothing was in flight", not "the engine
                    # failed to stop", and barge-in is purely the client's job.
                    meta.update({
                        "barge_in": True,
                        "response_inflight": not victim.done,
                        "bargein_stop_ms": round(stop_ms, 1) if stop_ms is not None else None,
                        "agent_cancelled": victim.cancelled,
                        "victim_audio_ms": round(
                            (victim.last_audio_t - victim.first_audio_t) * 1000, 1),
                    })
                    _, t_last = await stream_task
                    cur = Turn()          # only now start watching the new reply
                else:
                    cur = Turn()
                    _, t_last = await stream(pcm)

                # Wait for this turn's reply. If the *next* turn is a barge-in,
                # stop waiting the moment the agent starts speaking — waiting for
                # `done` would let the reply finish, and there would be nothing
                # left to interrupt. (First version measured a stop latency of
                # None for exactly this reason.)
                next_is_barge = (ti + 1 < len(turns_meta)
                                 and turns_meta[ti + 1].get("barge_in_after_ms") is not None)
                # `cur.done` alone is enough to stop waiting. A closing turn
                # often produces a response that is *only* an `end_call` tool
                # call, with no audio at all; requiring `first_audio_t` made the
                # loop sit out the full 25 s while the mic kept sending billed
                # silence, inflating session_s, cost and runtime on every call
                # that ended properly. Only a pending barge-in still needs audio.
                w0 = time.time()
                while time.time() - w0 < MAX_TURN_WAIT_S:
                    if next_is_barge:
                        if cur.first_audio_t:
                            break
                    elif cur.done:
                        break
                    await asyncio.sleep(0.03)

                meta.update({
                    "ttfa_ms": round((cur.first_audio_t - t_last) * 1000, 1)
                    if cur.first_audio_t else None,
                    # t_last is also the true end of caller speech, because we
                    # generated the clip and stream it at 1x real time.
                    "eou_ms": round((cur.first_audio_t - t_last) * 1000, 1)
                    if cur.first_audio_t else None,
                    "agent_audio_bytes": cur.audio_bytes,
                    "agent_text": " ".join(cur.text),
                    "tools": cur.tools,
                })
                result["turns"].append(meta)
                # Let a trailing reply land before the next caller turn — but not
                # when we are deliberately leaving one in flight to barge into.
                if not next_is_barge:
                    await asyncio.sleep(0.4)
        finally:
            await asyncio.sleep(0.8)   # let a trailing response.done land
            mic_task.cancel()
            pump_task.cancel()

    result["session_s"] = round(time.time() - t_session0, 1)
    result["audio_in_s"] = round(result["audio_in_s"], 2)
    return result


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True)
    ap.add_argument("--trial", type=int, default=1)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--scenarios", default="fixtures/scenarios.json")
    ap.add_argument("--only", help="comma-separated scenario ids")
    ap.add_argument("--out", required=True)
    ap.add_argument("--logdir", default="logs")
    a = ap.parse_args()

    failed: list[str] = []
    spec = json.loads(Path(a.scenarios).read_text())
    want = {s.strip() for s in a.only.split(",")} if a.only else None
    Path(a.logdir).mkdir(parents=True, exist_ok=True)

    for sc in spec["scenarios"]:
        if want and sc["id"] not in want:
            continue
        logp = Path(a.logdir) / f"sc-{a.arm}-{sc['id']}-t{a.trial}.jsonl"
        with open(logp, "w") as log:
            try:
                r = await run_scenario(a.arm, sc, Path(a.audio), a.trial, log)
            except Exception as e:  # noqa: BLE001
                r = {"arm": a.arm, "trial": a.trial, "scenario": sc["id"],
                     "lang": sc["lang"], "intent": sc["intent"],
                     "error": f"{type(e).__name__}: {e}", "turns": [],
                     "transcript": [], "tool_calls": [],
                     "audio_in_s": 0.0, "audio_out_bytes": 0}
        with open(a.out, "a") as f:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
        ttfa = [t["ttfa_ms"] for t in r["turns"] if t.get("ttfa_ms")]
        print(f"  {sc['id']:16s} turns={len(r['turns'])} "
              f"ttfa_p50={sorted(ttfa)[len(ttfa)//2] if ttfa else '-'} "
              f"tools={r['tool_calls']} err={r.get('error')}", file=sys.stderr)
        # A scenario that connects, says nothing, and exits cleanly is a
        # failure the runner should report, not one the scorer discovers later.
        # (COMPLETENESS.md check #1.)
        if not r.get("error") and not any(
                m["role"] == "agent" for m in r.get("transcript", [])):
            r["error"] = "agent produced no turns"
            with open(a.out, "r+") as f:
                lines = f.read().splitlines()
                lines[-1] = json.dumps(r, ensure_ascii=False)
                f.seek(0); f.write("\n".join(lines) + "\n"); f.truncate()
        if r.get("error"):
            failed.append(sc["id"])
        await asyncio.sleep(1.5)   # stagger session opens

    if failed:
        # Writing an error row is not reporting failure. run_all.sh was taught to
        # propagate child exit codes, but the child always exited 0, so the shell
        # faithfully reported success for a runner that had swallowed its errors.
        sys.exit(f"{len(failed)} scenario(s) errored: {', '.join(failed)}")


if __name__ == "__main__":
    asyncio.run(main())
