"""Aggregate Track B into per-arm numbers, including pass^k.

pass^k is the fraction of scenarios an arm got right on *every one* of k trials.
A single-run pass rate rewards luck: realtime speech-to-speech agents are
noticeably nondeterministic, and an agent that succeeds two times in three is
not one a small business can put on its phone line. Reported alongside the
mean so the gap between them is visible.

"Right" here is the strict conjunction: all expected slots captured, expected
tools called, all grounded facts present, no forbidden claim, and the judge's
groundedness verdict is 1.

  python summarize.py --slots results/slots.csv --judge results/judge.csv \
      --out results/tracka_b_summary.csv
"""
from __future__ import annotations

import argparse
import csv
import statistics
import sys
from collections import defaultdict
from pathlib import Path


def read(path: str) -> list[dict]:
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slots", required=True)
    ap.add_argument("--judge")
    ap.add_argument("--out", required=True)
    ap.add_argument("--allow-missing-judge", action="store_true",
                    help="score runs with no judge verdict as failures instead of aborting")
    a = ap.parse_args()

    slots = read(a.slots)
    judge = read(a.judge) if a.judge else []

    # Judge rows may exist for several seeds; average per (arm, trial, scenario).
    jmap: dict[tuple, list[dict]] = defaultdict(list)
    for j in judge:
        jmap[(j["arm"], j["trial"], j["scenario"])].append(j)

    # A run with no judge row must not sail through. `judge.py` skips a scenario
    # it cannot parse, and treating the resulting absence as "no groundedness
    # objection" makes the conjunction vacuously true — so a judge outage would
    # silently *raise* success rates, which is the worst direction for a
    # measurement to fail in. If judge data was supplied at all, every scored run
    # must have a verdict.
    if judge:
        missing = [(s["arm"], s["trial"], s["scenario"]) for s in slots
                   if not jmap.get((s["arm"], s["trial"], s["scenario"]))]
        if missing and not a.allow_missing_judge:
            preview = ", ".join(f"{m[0]}/t{m[1]}/{m[2]}" for m in missing[:5])
            sys.exit(f"{len(missing)} run(s) have no judge verdict "
                     f"({preview}{'…' if len(missing) > 5 else ''}). "
                     f"Re-run judge.py, or pass --allow-missing-judge to score "
                     f"them as failures.")

    per_run = []
    for s in slots:
        key = (s["arm"], s["trial"], s["scenario"])
        js = jmap.get(key, [])
        grounded_judge = (statistics.mean(num(j["groundedness"], 0) for j in js)
                          if js else None)
        resolution = statistics.mean(num(j["resolution"], 0) for j in js) if js else None
        tone = statistics.mean(num(j["tone"], 0) for j in js) if js else None

        slots_all = num(s["slots_all_heard"], 1)    # scenarios with no slots pass
        ok = (slots_all == 1
              and s["tool_ok"] == "1"
              and s["grounded_ok"] == "1"
              and num(s["forbidden_hit"], 0) == 0
              and (grounded_judge is not None and grounded_judge >= 0.5
                   if judge else True))
        per_run.append({**s, "judge_grounded": grounded_judge,
                        "judge_resolution": resolution, "judge_tone": tone,
                        "success": int(ok)})

    # pass^k per (arm, scenario), then averaged over scenarios.
    by_arm_sc: dict[tuple, list[int]] = defaultdict(list)
    for r in per_run:
        by_arm_sc[(r["arm"], r["scenario"])].append(r["success"])

    rows = []
    for arm in sorted({r["arm"] for r in per_run}):
        runs = [r for r in per_run if r["arm"] == arm]
        scs = [v for (a2, _sc), v in by_arm_sc.items() if a2 == arm]
        ttfa = [num(r["ttfa_p50_ms"]) for r in runs if num(r["ttfa_p50_ms"])]
        barge = [num(r["bargein_stop_ms"]) for r in runs if num(r["bargein_stop_ms"])]
        slot_accs = [num(r["slot_heard"]) for r in runs if num(r["slot_heard"]) is not None]
        echoed = [num(r["slot_echoed"]) for r in runs if num(r["slot_echoed"]) is not None]
        jg = [r["judge_grounded"] for r in runs if r["judge_grounded"] is not None]
        jr = [r["judge_resolution"] for r in runs if r["judge_resolution"] is not None]
        jt = [r["judge_tone"] for r in runs if r["judge_tone"] is not None]

        rows.append({
            "arm": arm,
            "runs": len(runs),
            "success_mean": round(statistics.mean(r["success"] for r in runs), 3),
            "pass_k": round(sum(1 for v in scs if all(v)) / len(scs), 3) if scs else "",
            "slot_heard": round(statistics.mean(slot_accs), 3) if slot_accs else "",
            "slot_echoed": round(statistics.mean(echoed), 3) if echoed else "",
            "tool_ok": round(statistics.mean(int(r["tool_ok"]) for r in runs), 3),
            "grounded_ok": round(statistics.mean(int(r["grounded_ok"]) for r in runs), 3),
            "forbidden_hits": sum(int(num(r["forbidden_hit"], 0)) for r in runs),
            "judge_grounded": round(statistics.mean(jg), 3) if jg else "",
            "judge_resolution": round(statistics.mean(jr), 3) if jr else "",
            "judge_tone": round(statistics.mean(jt), 3) if jt else "",
            "ttfa_p50_ms": round(statistics.median(ttfa)) if ttfa else "",
            "ttfa_p95_ms": round(sorted(ttfa)[int(len(ttfa) * 0.95) - 1]) if len(ttfa) > 3 else "",
            "bargein_stop_p50_ms": round(statistics.median(barge)) if barge else "",
            "errors": sum(1 for r in runs if r["error"]),
            "session_min": round(sum(num(r["session_s"], 0) for r in runs) / 60, 1),
        })

    with open(a.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows -> {a.out}")

    detail = a.out.replace(".csv", "_per_run.csv")
    with open(detail, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(per_run[0].keys()))
        w.writeheader()
        w.writerows(per_run)
    print(f"wrote {len(per_run)} rows -> {detail}")


if __name__ == "__main__":
    main()
