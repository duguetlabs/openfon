"""Pull a small slice of FLEURS test into 16 kHz mono WAV + .txt pairs.

Same on-disk contract as kataleptic-backend/benchmarks/prepare_librispeech.py
(<stem>.wav + <stem>.txt) so listen_bench.py can consume it unchanged.

FLEURS is CC-BY-4.0 and ungated; streaming mode pulls only the parquet row
groups it needs, so a 60-utterance slice costs ~60-90 MB, not the 400-800 MB
of the full test shard.

Usage:
  python prepare_fleurs.py --lang de_de --n 60 --out data/fleurs/de_de
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import wave
from pathlib import Path

import numpy as np
import soundfile as sf
from datasets import Audio, load_dataset

SR = 16000


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--lang", required=True, help="FLEURS config, e.g. en_us / de_de")
    p.add_argument("--n", type=int, default=60)
    p.add_argument("--out", required=True)
    p.add_argument("--min-sec", type=float, default=3.0)
    p.add_argument("--max-sec", type=float, default=20.0)
    args = p.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    ds = load_dataset(
        "google/fleurs", args.lang, split="test", streaming=True
    ).cast_column("audio", Audio(decode=False))

    manifest, n, total = [], 0, 0.0
    for ex in ds:
        if n >= args.n:
            break
        raw = (ex["audio"] or {}).get("bytes")
        if not raw:
            continue
        arr, sr = sf.read(io.BytesIO(raw), dtype="float32")
        if arr.ndim > 1:
            arr = arr.mean(axis=1)
        if sr != SR:
            from scipy.signal import resample_poly

            arr = resample_poly(arr, SR, sr)
        dur = len(arr) / SR
        if not (args.min_sec <= dur <= args.max_sec):
            continue

        sid = f"{args.lang}-{n:03d}"
        pcm = (np.clip(arr, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
        with wave.open(str(out / f"{sid}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm)
        # `transcription` is already lowercased + punctuation-stripped by FLEURS;
        # `raw_transcription` keeps casing and punctuation. Keep both: the first
        # is the WER reference, the second is what an LLM judge should see.
        (out / f"{sid}.txt").write_text(ex["transcription"].strip() + "\n")
        manifest.append(
            {
                "id": sid,
                "lang": args.lang,
                "wav": f"{sid}.wav",
                "seconds": round(dur, 3),
                "reference": ex["transcription"].strip(),
                "reference_raw": ex["raw_transcription"].strip(),
                "fleurs_id": ex["id"],
                "gender": ex["gender"],
            }
        )
        n += 1
        total += dur

    (out / "manifest.jsonl").write_text(
        "".join(json.dumps(m, ensure_ascii=False) + "\n" for m in manifest)
    )
    print(f"{args.lang}: {n} utts, {total/60:.1f} min -> {out}", file=sys.stderr)

    # The loop ends either at --n or when the split runs out, and those look the
    # same from here: a short manifest is written and this exits 0. Every
    # consumer then treats the file as the declared clip set — `run_asr.py` does
    # refuse a cell shorter than its `--n`, but that refusal arrives when
    # somebody runs the paid benchmark, which is the late-refusal shape this
    # harness keeps moving earlier. Two `continue`s above skip examples silently
    # (no audio bytes, duration out of range), so a filter that is slightly too
    # tight yields a quietly smaller corpus.
    if n < args.n:
        sys.exit(f"only {n} of the requested {args.n} utterances met the "
                 f"filters ({args.min_sec}-{args.max_sec}s with decodable "
                 f"audio) before the {args.lang} split ran out. "
                 f"{out}/manifest.jsonl is SHORT: widen the duration range, "
                 f"lower --n, or pick another split — do not build conditions "
                 "from it, because every downstream cell inherits this size.")


if __name__ == "__main__":
    main()
