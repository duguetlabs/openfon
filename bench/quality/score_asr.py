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


def sibling(out_path: str, suffix: str) -> str:
    """`results/x.csv` + "_per_run" -> `results/x_per_run.csv`.

    `out.replace(".csv", ...)` silently returns the original string when the
    name has no `.csv`, so the second write lands on the first file and destroys
    it. Reject names without a suffix rather than guess.
    """
    p = Path(out_path)
    if not p.suffix:
        sys.exit(f"--out {out_path!r} has no file extension; a companion file "
                 f"cannot be derived from it. Use e.g. {out_path}.csv")
    return str(p.with_name(p.stem + suffix + p.suffix))


def wer_cer(rows: list[dict], lang: str) -> tuple[float, float, int, int]:
    """WER/CER over `rows`, plus how many rows were usable out of how many given.

    A row whose *reference* is empty cannot be scored at all — it contributes no
    words to the denominator — so it is dropped, but the count is returned so the
    caller can see the scored n differ from the submitted n. An empty
    *hypothesis* is kept: that is a real recognition failure and scores as one.
    """
    refs = [normalize(r["reference"], lang) for r in rows]
    hyps = [normalize(r["hypothesis"], lang) for r in rows]
    keep = [(a, b) for a, b in zip(refs, hyps) if a]
    if not keep:
        return float("nan"), float("nan"), 0, len(rows)
    refs, hyps = [k[0] for k in keep], [k[1] for k in keep]
    return (jiwer.process_words(refs, hyps).wer * 100,
            jiwer.process_characters(refs, hyps).cer * 100,
            len(refs), len(rows))


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
    ap.add_argument("--expect-clips", type=int,
                    help="clips expected per (arm, lang, condition); mismatches abort")
    ap.add_argument("--allow-incomplete", action="store_true",
                    help="report incomplete cells instead of aborting")
    a = ap.parse_args()

    rows = [json.loads(l) for l in Path(a.hyp).read_text().splitlines() if l.strip()]
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r["arm"], r["lang"], r["condition"])].append(r)

    # Every cell must be present and the same size. Track A previously had no
    # completeness check at all: a condition that failed mid-run simply produced
    # a smaller cell, and a WER computed over 8 of 25 clips is reported in the
    # same column, in the same units, as one computed over all 25.
    arms = sorted({r["arm"] for r in rows})
    langs = sorted({r["lang"] for r in rows})
    conds = sorted({r["condition"] for r in rows})
    #
    # By clip IDENTITY, not by count. A duplicated id alongside a missing one
    # still totals the right number, marks the cell complete, and
    # double-weights the duplicate in the WER — silently moving the headline
    # number. Corresponding cells must also contain the *same* clips, or the
    # arms are being compared on different audio.
    expect = a.expect_clips or max(len(v) for v in groups.values())
    problems = []
    for arm in arms:
        for lang in langs:
            for cond in conds:
                ids = [r["id"] for r in groups.get((arm, lang, cond), [])]
                dupes = sorted({i for i in ids if ids.count(i) > 1})
                if dupes:
                    problems.append(f"{arm}/{lang}/{cond}: duplicate clip "
                                    f"{','.join(dupes[:3])}")
                elif len(ids) != expect:
                    problems.append(f"{arm}/{lang}/{cond}: {len(ids)} of {expect}")
                rs = groups.get((arm, lang, cond), [])
                if rs and all(r.get("error") for r in rs):
                    # Every row errored: this is an outage, not a 100% WER. The
                    # clip ids are all present, so nothing else here would notice.
                    problems.append(f"{arm}/{lang}/{cond}: every row is an error "
                                    f"({rs[0].get('error', '')[:60]}) — that is an "
                                    f"outage, not a measurement")

    # Same (lang, condition) across arms must mean the same clips.
    for lang in langs:
        for cond in conds:
            sets = {arm: frozenset(r["id"] for r in groups.get((arm, lang, cond), []))
                    for arm in arms}
            distinct = {s for s in sets.values() if s}
            if len(distinct) > 1:
                ref = max(distinct, key=len)
                for arm, s in sets.items():
                    if s and s != ref:
                        problems.append(
                            f"{arm}/{lang}/{cond}: clip set differs from the other "
                            f"arms (missing {sorted(ref - s)[:3]}, "
                            f"extra {sorted(s - ref)[:3]})")

    if problems and not a.allow_incomplete:
        sys.exit(f"{len(problems)} (arm, lang, condition) cell problem(s) "
                 f"({'; '.join(problems[:6])}"
                 f"{'…' if len(problems) > 6 else ''}). Re-run the gaps, pass "
                 f"--expect-clips, or use --allow-incomplete.")

    # Iterate the expected cross-product, not the groups that happen to exist.
    # Iterating `groups` meant an absent cell produced no row at all, so every
    # row carried complete=1 and `complete` could never be 0 — a consumer
    # trusting the documented signal saw a complete matrix because the gaps were
    # invisible rather than because they were filled. Absent data reading as
    # complete, in the field named `complete`.
    out = []
    for arm in arms:
        for lang in langs:
            for cond in conds:
                rs = groups.get((arm, lang, cond), [])
                if not rs:
                    out.append({"arm": arm, "lang": lang, "condition": cond,
                                "n": 0, "n_expected": expect, "complete": 0,
                                "wer": "", "cer": "", "empty_hyp": "",
                                "unscorable_refs": "", "errors": "",
                                "audio_min": 0.0})
                    continue
                w, c, n, submitted = wer_cer(rs, lang)
                misses = sum(1 for r in rs if not r["hypothesis"].strip())
                out.append({"arm": arm, "lang": lang, "condition": cond,
                            "n": n, "n_expected": expect,
                            "complete": int(n == expect),
                            "wer": round(w, 2), "cer": round(c, 2),
                            "empty_hyp": misses,
                            "unscorable_refs": submitted - n,
                            "errors": sum(1 for r in rs if r.get("error")),
                            "audio_min": round(sum(r["audio_seconds"] for r in rs) / 60, 2)})

    with open(a.out, "w", newline="") as f:
        wcsv = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        wcsv.writeheader()
        wcsv.writerows(out)
    print(f"wrote {len(out)} rows -> {a.out}")

    # Robustness summary per (arm, lang). Absent cells now appear in `out` with
    # an empty WER; they must not enter this index, or a missing `clean` reads
    # as the string "" — which is not None, passes the guard below, and then
    # fails on the subtraction. An absent cell is absent here too.
    idx = {(r["arm"], r["lang"], r["condition"]): r["wer"] for r in out
           if isinstance(r["wer"], (int, float))}
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

    # Every robustness figure is relative to that arm's own clean WER, so
    # without a `clean` condition there is nothing to be robust *against*. A
    # condition-only run (`--conditions tel`) produced an empty list and then an
    # IndexError on `summary[0]` — after the detailed CSV had already been
    # written, so the run looked half-successful.
    dest = a.summary or sibling(a.out, "_summary")
    if not summary:
        print(f"no robustness summary: none of the {len(arms) * len(langs)} "
              f"(arm, language) pairs has a `clean` baseline, and dWER/SNR50 are "
              f"both defined relative to it. Detailed WER is in {a.out}.",
              file=sys.stderr)
        return
    with open(dest, "w", newline="") as f:
        wcsv = csv.DictWriter(f, fieldnames=list(summary[0].keys()))
        wcsv.writeheader()
        wcsv.writerows(summary)
    print(f"wrote {len(summary)} summary rows -> {dest}")


if __name__ == "__main__":
    main()
