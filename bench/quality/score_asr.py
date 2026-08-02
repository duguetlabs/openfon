"""Score Track A: WER/CER per (arm, language, condition) plus robustness summaries.

Normalisation is shared with prepare/score_wer.py and applied identically to
hypothesis and reference — WER without a stated normaliser is not a number,
it is an opinion. See that module for the per-language rules.

Robustness summaries
  dWER      WER(condition) - WER(clean), the degradation the condition causes
  SNR50     interpolated SNR at which WER reaches 2x the clean WER. One number,
            in dB, directly comparable across arms. Higher = more fragile.
            Reported as ">20" / "<0" when the curve never crosses in range.

  python score_asr.py --hyp results/asr.jsonl --out results/asr_scores.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import jiwer

sys.path.insert(0, str(Path(__file__).resolve().parent / "prepare"))
from score_wer import normalize  # noqa: E402

SNR_RE = re.compile(r"_snr(-?\d+)$")


def wer_cer(rows: list[dict], lang: str) -> tuple[float, float, int]:
    refs = [normalize(r["reference"], lang) for r in rows]
    hyps = [normalize(r["hypothesis"], lang) for r in rows]
    keep = [(a, b) for a, b in zip(refs, hyps) if a]
    if not keep:
        return float("nan"), float("nan"), 0
    refs, hyps = [k[0] for k in keep], [k[1] for k in keep]
    return (jiwer.process_words(refs, hyps).wer * 100,
            jiwer.process_characters(refs, hyps).cer * 100,
            len(refs))


def snr50(curve: dict[int, float], clean: float) -> str:
    """Interpolate the SNR where WER first reaches 2x clean."""
    target = 2.0 * clean
    pts = sorted(curve.items(), reverse=True)          # 20, 10, 5, 0 dB
    for (s_hi, w_hi), (s_lo, w_lo) in zip(pts, pts[1:]):
        if w_hi < target <= w_lo:
            if w_lo == w_hi:
                return f"{s_lo}"
            f = (target - w_hi) / (w_lo - w_hi)
            return f"{s_hi + f * (s_lo - s_hi):.1f}"
    return ">20" if pts and pts[0][1] >= target else "<0"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hyp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--summary", help="write the robustness summary CSV here")
    a = ap.parse_args()

    rows = [json.loads(l) for l in Path(a.hyp).read_text().splitlines() if l.strip()]
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r["arm"], r["lang"], r["condition"])].append(r)

    out = []
    for (arm, lang, cond), rs in sorted(groups.items()):
        w, c, n = wer_cer(rs, lang)
        misses = sum(1 for r in rs if not r["hypothesis"].strip())
        out.append({"arm": arm, "lang": lang, "condition": cond, "n": n,
                    "wer": round(w, 2), "cer": round(c, 2),
                    "empty_hyp": misses,
                    "errors": sum(1 for r in rs if r.get("error")),
                    "audio_min": round(sum(r["audio_seconds"] for r in rs) / 60, 2)})

    with open(a.out, "w", newline="") as f:
        wcsv = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        wcsv.writeheader()
        wcsv.writerows(out)
    print(f"wrote {len(out)} rows -> {a.out}")

    # Robustness summary per (arm, lang).
    idx = {(r["arm"], r["lang"], r["condition"]): r["wer"] for r in out}
    summary = []
    for arm, lang in sorted({(r["arm"], r["lang"]) for r in out}):
        clean = idx.get((arm, lang, "clean"))
        if clean is None:
            continue
        curve = {}
        for (a2, l2, cond), w in idx.items():
            if a2 == arm and l2 == lang and (m := SNR_RE.search(cond)) and cond.startswith("cafe"):
                curve[int(m.group(1))] = w
        row = {"arm": arm, "lang": lang, "wer_clean": clean,
               "wer_cafe10": idx.get((arm, lang, "cafe_snr10")),
               "wer_tel": idx.get((arm, lang, "tel")),
               "wer_tel_cafe10": idx.get((arm, lang, "tel_cafe_snr10")),
               "wer_tel_loss3": idx.get((arm, lang, "tel_loss3")),
               "snr50_db": snr50(curve, clean) if curve else ""}
        for k in ("wer_cafe10", "wer_tel", "wer_tel_cafe10", "wer_tel_loss3"):
            row["d" + k[3:]] = (round(row[k] - clean, 2) if row[k] is not None else None)
        summary.append(row)

    dest = a.summary or a.out.replace(".csv", "_summary.csv")
    with open(dest, "w", newline="") as f:
        wcsv = csv.DictWriter(f, fieldnames=list(summary[0].keys()))
        wcsv.writeheader()
        wcsv.writerows(summary)
    print(f"wrote {len(summary)} summary rows -> {dest}")


if __name__ == "__main__":
    main()
