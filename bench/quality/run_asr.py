"""Track A — stream conditioned clips at an arm and capture its caller transcript.

What this measures, precisely: **the STT front-end each serving stack ships**
(whisper-1 on the Foundry GA surface, azure-speech on Voice Live) as experienced
through a live realtime session. It is not a free-standing ASR comparison and
should never be reported as one — but it is what a caller actually gets.

Transcription-only mode: turn detection is disabled and we commit each clip by
hand, so there is exactly one transcript per clip, no VAD segmentation to
confound the WER, and no output audio to pay for.

  python run_asr.py --arm vl-gpt41mini --lang de_de \
      --conditions clean,cafe_snr10 --data ../../..//data/conditions --n 30
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

from engines import ARMS, connect_kwargs

class CommitDesync(RuntimeError):
    """The commit stream fell out of sync; the session must not be reused."""


MARKER = "openfon-bench-asr"
FRAME_MS = 200
LANG_CODE = {"en_us": "en", "de_de": "de", "fr_fr": "fr", "es_419": "es",
             "nl_nl": "nl", "it_it": "it", "ru_ru": "ru", "sv_se": "sv",
             "da_dk": "da", "fi_fi": "fi"}


def pcm24k(path: Path) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(path),
         "-ac", "1", "-ar", "24000", "-f", "s16le", "-"],
        check=True, capture_output=True,
    ).stdout


async def transcribe_batch(arm_name: str, lang: str, clips: list[dict],
                           log) -> list[dict]:
    """One session per (arm, condition, language) batch, clips committed serially.

    Reusing a session across clips keeps handshake cost out of the measurement
    and stays far below the 3600 s session cap for a 30-clip batch.
    """
    arm = ARMS[arm_name]
    code = LANG_CODE.get(lang, "en")
    out: list[dict] = []
    loop = asyncio.get_event_loop()
    pending: dict[str, str] = {}   # item_id -> best transcript seen
    order: list = []               # (clip, item_id, err, nbytes, latency)
    seen: set[str] = set()         # item_ids that got any completed event

    async with websockets.connect(arm.url, **connect_kwargs(arm)) as ws:
        await ws.send(json.dumps(
            {"type": "session.update", "session": arm.session_asr(code, MARKER)}))
        # Wait for OUR session.updated, not merely the first one: proxied paths
        # emit an extra one of their own before the client's takes effect.
        deadline = loop.time() + 20
        ready = False
        while loop.time() < deadline:
            ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            log.write(json.dumps({"t": time.time(), "ev": ev}) + "\n")
            if ev.get("type") == "session.updated":
                s = ev["session"]
                if MARKER in json.dumps(s.get("instructions") or ""):
                    ready = True
                    break
            if ev.get("type") == "error":
                raise RuntimeError(f"session.update rejected: {ev.get('error')}")
        if not ready:
            raise RuntimeError("never saw our own session.updated")

        for clip in clips:
            pcm = pcm24k(Path(clip["path"]))
            step = FRAME_MS * 24000 * 2 // 1000
            t0 = time.time()
            for i in range(0, len(pcm), step):
                await ws.send(json.dumps({
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(pcm[i:i + step]).decode(),
                }))
            await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))

            # Bind the clip to the item the server created for it. Everything
            # else is collected by item_id and resolved after the batch, because
            # the event stream is not well-ordered per clip:
            #   * `conversation.item.created` for clip N arrives *after* clip N's
            #     transcript, so "first transcript-shaped event wins" hands clip
            #     N+1 the previous clip's text, then cascades;
            #   * with noise suppression on, Voice Live emits *two* completed
            #     events per item — one real, one empty — in either order, so
            #     "first event for this item wins" silently drops transcripts
            #     (64 of 200 clips on vl-gpt41mini-dns/en_us before this fix).
            # Hence: keep the longest non-empty text seen for each item_id.
            err, item_id = None, None

            async def pump(timeout: float):
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
                log.write(json.dumps({"t": time.time(), "clip": clip["id"], "ev": ev}) + "\n")
                return ev

            def offer(item: str, text: str) -> None:
                if len(text or "") > len(pending.get(item, "")):
                    pending[item] = text or ""
                pending.setdefault(item, "")
                seen.add(item)

            deadline = loop.time() + 90
            while item_id is None and loop.time() < deadline:
                try:
                    ev = await pump(30)
                except asyncio.TimeoutError:
                    # Do NOT carry on. The commit may still be in flight; if it
                    # arrives during the next clip it is consumed as *that*
                    # clip's, and every subsequent clip is bound to the previous
                    # one's transcript — silently, with no error on any affected
                    # row. Corrupt scoring input is worse than a crash, so the
                    # batch aborts and the caller reconnects on a fresh socket.
                    raise CommitDesync(
                        f"{clip['id']}: no input_audio_buffer.committed within 30 s; "
                        f"the commit stream is out of sync, abandoning this session")
                if ev.get("type") == "error":
                    err = json.dumps(ev.get("error"))
                    break
                if ev.get("type") == "input_audio_buffer.committed":
                    item_id = ev.get("item_id")
                    break
                if (got := arm.caller_transcript(ev)) is not None:
                    offer(*got)

            # Wait only for *a* completed event for this item, not for a
            # non-empty one: when the service emits the empty half of its
            # duplicate pair first, insisting on text blocks for the full
            # timeout on every such clip (this cost ~30 s per clip and turned a
            # 20-minute run into a 90-minute one). The final drain upgrades any
            # empty to the longer text if the real one lands later.
            # Unlike the commit wait, a slow transcript is safe to wait out and
            # then move on: this clip is already bound to its item_id, and the
            # end-of-batch drain attributes any late arrival correctly.
            while item_id and not err and item_id not in seen and loop.time() < deadline:
                try:
                    ev = await pump(30)
                except asyncio.TimeoutError:
                    err = "timeout waiting for transcript"
                    break
                if ev.get("type") == "error":
                    err = json.dumps(ev.get("error"))
                    break
                if (got := arm.caller_transcript(ev)) is not None:
                    offer(*got)

            order.append((clip, item_id, err, len(pcm), time.time() - t0))
            print(f"  {clip['id']} {'OK ' if pending.get(item_id or '') else 'MISS'} "
                  f"{(pending.get(item_id or '') or err or '')[:60]}", file=sys.stderr)

        # Final drain: sweep up duplicates and stragglers still in flight.
        drain_until = loop.time() + 8
        while loop.time() < drain_until:
            try:
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
            except (asyncio.TimeoutError, Exception):  # noqa: B014
                break
            log.write(json.dumps({"t": time.time(), "clip": "drain", "ev": ev}) + "\n")
            if (got := arm.caller_transcript(ev)) is not None:
                if len(got[1] or "") > len(pending.get(got[0], "")):
                    pending[got[0]] = got[1] or ""

    for clip, item_id, err, nbytes, latency in order:
        out.append({
            "arm": arm_name, "lang": lang, "condition": clip["condition"],
            "id": clip["id"], "reference": clip["reference"],
            "hypothesis": pending.get(item_id or "", ""), "error": err,
            "audio_seconds": round(nbytes / 48000, 3),
            "latency_s": round(latency, 2),
        })
    return out


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True)
    ap.add_argument("--lang", required=True)
    ap.add_argument("--conditions", required=True)
    ap.add_argument("--data", required=True, help="root of data/conditions")
    ap.add_argument("--n", type=int, default=30)
    ap.add_argument("--out", required=True)
    ap.add_argument("--logdir", default="logs")
    a = ap.parse_args()

    root = Path(a.data)
    Path(a.logdir).mkdir(parents=True, exist_ok=True)
    results: list[dict] = []

    for cond in [c.strip() for c in a.conditions.split(",") if c.strip()]:
        d = root / cond / a.lang
        manifest = [json.loads(l) for l in (d / "manifest.jsonl").read_text().splitlines()]
        clips = [{"id": m["id"], "path": str(d / m["wav"]),
                  "reference": m["reference"], "condition": cond}
                 for m in manifest[: a.n]]
        print(f"[{a.arm}] {a.lang}/{cond}: {len(clips)} clips", file=sys.stderr)
        logp = Path(a.logdir) / f"asr-{a.arm}-{a.lang}-{cond}.jsonl"
        with open(logp, "w") as log:
            for attempt in (1, 2):
                try:
                    results += await transcribe_batch(a.arm, a.lang, clips, log)
                    break
                except Exception as e:  # noqa: BLE001
                    print(f"  batch failed ({type(e).__name__}: {e}); "
                          f"{'retrying' if attempt == 1 else 'giving up'}", file=sys.stderr)
                    if attempt == 2:
                        results += [{"arm": a.arm, "lang": a.lang, "condition": cond,
                                     "id": c["id"], "reference": c["reference"],
                                     "hypothesis": "", "error": str(e),
                                     "audio_seconds": 0.0, "latency_s": 0.0}
                                    for c in clips]
                    await asyncio.sleep(5)
        await asyncio.sleep(1)  # stagger session opens

    with open(a.out, "a") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    secs = sum(r["audio_seconds"] for r in results)
    print(f"[{a.arm}] wrote {len(results)} rows, {secs/60:.1f} audio-min "
          f"(~${secs/60*ARMS[a.arm].usd_per_min:.2f})", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
