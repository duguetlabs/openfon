"""Diagnose Voice Live's `input_audio_noise_reduction` on clean English audio.

The main run showed azure_deep_noise_suppression taking clean en_US WER from
4.8 % to 47.8 % while leaving de_DE alone (3.7 -> 3.9). A feature cannot
plausibly be neutral in one language and catastrophic in another, so this probe
exists to either reproduce the effect at higher n or expose the artefact.

Legs (each against the same clean FLEURS clips, one session per leg):
  off            control, no noise reduction
  deep           azure_deep_noise_suppression
  near_field     the other accepted values, to test whether the damage is
  far_field      specific to the deep model or common to the whole feature
  deep@16k       deep model with a 16 kHz input contract, to test whether the
                 damage is a sample-rate interaction rather than the model

Reports empty-transcript rate and WER separately, because they are different
failure modes: dropping an utterance and mis-recognising one have different
product consequences.

  python probe_dns.py --lang en_us --n 50 --data $DATA/conditions
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import subprocess
import sys
from pathlib import Path

import jiwer
import websockets

from engines import AZURE_HOST, VOICELIVE_API_VERSION, azure_key

sys.path.insert(0, str(Path(__file__).resolve().parent / "prepare"))
from score_wer import normalize  # noqa: E402

MARKER = "openfon-dns-probe"
LANG_CODE = {"en_us": "en", "de_de": "de"}

LEGS = {
    "off":        (None, 24000),
    "deep":       ("azure_deep_noise_suppression", 24000),
    "near_field": ("near_field", 24000),
    "far_field":  ("far_field", 24000),
    "deep@16k":   ("azure_deep_noise_suppression", 16000),
}


FFMPEG_TIMEOUT_S = 120


def pcm(path: Path, rate: int) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(path),
         "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"],
        check=True, capture_output=True, timeout=FFMPEG_TIMEOUT_S,
    ).stdout


async def run_leg(leg: str, lang: str, clips: list[dict]) -> list[dict]:
    nr, rate = LEGS[leg]
    url = (f"wss://{AZURE_HOST}/voice-live/realtime"
           f"?api-version={VOICELIVE_API_VERSION}&model=gpt-4.1-mini")
    session = {
        "instructions": MARKER,
        "modalities": ["text"],
        "turn_detection": None,
        "input_audio_transcription": {"model": "azure-speech",
                                      "language": LANG_CODE.get(lang, "en")},
        "input_audio_format": "pcm16",
        "input_audio_sampling_rate": rate,
    }
    if nr:
        session["input_audio_noise_reduction"] = {"type": nr}

    out: list[dict] = []
    pending: dict[str, str] = {}
    seen: set[str] = set()
    order: list = []
    loop = asyncio.get_event_loop()

    async with websockets.connect(
        url, additional_headers={"api-key": azure_key()}, max_size=32 * 1024 * 1024
    ) as ws:
        await ws.send(json.dumps({"type": "session.update", "session": session}))
        while True:
            ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
            if ev.get("type") == "error":
                raise RuntimeError(ev.get("error"))
            if ev.get("type") == "session.updated":
                break

        def offer(item: str, text: str) -> None:
            if len(text or "") > len(pending.get(item, "")):
                pending[item] = text or ""
            pending.setdefault(item, "")
            seen.add(item)

        for clip in clips:
            raw = pcm(Path(clip["path"]), rate)
            step = rate * 2 // 5          # 200 ms
            for i in range(0, len(raw), step):
                await ws.send(json.dumps({
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(raw[i:i + step]).decode()}))
            await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))

            item_id = None
            deadline = loop.time() + 60
            while item_id is None and loop.time() < deadline:
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
                if ev.get("type") == "input_audio_buffer.committed":
                    item_id = ev.get("item_id")
                elif ev.get("type") == "conversation.item.input_audio_transcription.completed":
                    offer(ev.get("item_id") or "", ev.get("transcript") or "")
            while item_id and item_id not in seen and loop.time() < deadline:
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
                if ev.get("type") == "conversation.item.input_audio_transcription.completed":
                    offer(ev.get("item_id") or "", ev.get("transcript") or "")
            order.append((clip, item_id))

        end = loop.time() + 8
        while loop.time() < end:
            try:
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
            except Exception:  # noqa: BLE001
                break
            if ev.get("type") == "conversation.item.input_audio_transcription.completed":
                offer(ev.get("item_id") or "", ev.get("transcript") or "")

    for clip, item_id in order:
        out.append({"leg": leg, "lang": lang, "id": clip["id"],
                    "reference": clip["reference"],
                    "hypothesis": pending.get(item_id or "", "")})
    return out


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="en_us")
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--data", required=True)
    ap.add_argument("--condition", default="clean")
    ap.add_argument("--legs", default=",".join(LEGS))
    ap.add_argument("--out", default="results/dns_probe.jsonl")
    a = ap.parse_args()

    # Same validation as run_asr.py, and for the same reason: this probe's
    # output is not a diagnostic, it is the source `check_report.py` recomputes
    # the merged report's noise-suppression tables from — the numbers carrying
    # "never enable Azure noise suppression". A duplicated clip id would
    # double-weight that WER, and both legs are paid for before anything reads
    # the file. The manifests are shared with run_asr.py, which validates them;
    # validating on one path and not the other is a uniqueness assumption held
    # in one place and trusted in two.
    legs = [x.strip() for x in a.legs.split(",") if x.strip()]
    if not legs:
        sys.exit(f"--legs {a.legs!r} names no legs")
    if dupes := sorted({x for x in legs if legs.count(x) > 1}):
        sys.exit(f"--legs {a.legs!r} names {', '.join(dupes)} more than once; "
                 "the repeat is a second paid pass whose rows are indistinguishable "
                 "from the first's in the output")
    if unknown := sorted(set(legs) - set(LEGS)):
        # `LEGS[leg]` raised KeyError after the earlier legs had been billed.
        sys.exit(f"--legs names {', '.join(unknown)}, which are not legs. "
                 f"Known: {', '.join(LEGS)}")

    d = Path(a.data) / a.condition / a.lang
    mpath = d / "manifest.jsonl"
    if not mpath.exists():
        sys.exit(f"no clip manifest at {mpath}")
    manifest = [json.loads(l) for l in mpath.read_text().splitlines() if l.strip()]
    clips = [{"id": m["id"], "path": str(d / m["wav"]), "reference": m["reference"]}
             for m in manifest[: a.n]]
    if len(clips) < a.n:
        sys.exit(f"{mpath} lists {len(manifest)} clip(s) but --n is {a.n}")
    ids = [c["id"] for c in clips]
    if dupes := sorted({i for i in ids if ids.count(i) > 1}):
        sys.exit(f"{mpath} lists {', '.join(dupes[:5])} more than once in its "
                 f"first {a.n} entries; duplicate ids double-weight the WER")
    if absent := [c["path"] for c in clips if not Path(c["path"]).exists()]:
        sys.exit(f"{len(absent)} clip(s) named by {mpath} do not exist:\n  "
                 + "\n  ".join(absent[:10]))

    rows: list[dict] = []
    for leg in legs:
        print(f"[{leg}] {len(clips)} clips", file=sys.stderr)
        rows += await run_leg(leg, a.lang, clips)
        await asyncio.sleep(1)           # serialise session opens

    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"\n{'leg':12s}{'n':>4}{'empty':>7}{'empty%':>8}{'WER_all':>9}{'WER_nonempty':>14}")
    for leg in dict.fromkeys(r["leg"] for r in rows):
        rs = [r for r in rows if r["leg"] == leg]
        ne = [r for r in rs if r["hypothesis"].strip()]
        wa = jiwer.process_words([normalize(r["reference"], a.lang) for r in rs],
                                 [normalize(r["hypothesis"], a.lang) for r in rs]).wer * 100
        wn = (jiwer.process_words([normalize(r["reference"], a.lang) for r in ne],
                                  [normalize(r["hypothesis"], a.lang) for r in ne]).wer * 100
              if ne else float("nan"))
        print(f"{leg:12s}{len(rs):4d}{len(rs)-len(ne):7d}"
              f"{100*(len(rs)-len(ne))/len(rs):7.1f}%{wa:9.2f}{wn:14.2f}")


if __name__ == "__main__":
    asyncio.run(main())
