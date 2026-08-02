"""Aggregate Track B into per-arm numbers, including pass^k.

pass^k is the fraction of scenarios an arm got right on *every one* of k trials.
A single-run pass rate rewards luck: realtime speech-to-speech agents are
noticeably nondeterministic, and an agent that succeeds two times in three is
not one a small business can put on its phone line. Reported alongside the mean
so the gap between them is visible.

"Right" is the strict conjunction: all expected slots heard, expected tools
called, all grounded facts present, no forbidden claim, the judge's groundedness
verdict positive, and the run itself free of transport errors.

FAIL CLOSED. Every guard here defaults to failure when data is absent. Six
separate places in this harness once let missing data read as a pass — a missing
judge row, an empty judge file, a missing trial, a missing scenario, an
unparseable numeric, an errored run — and every one of them inflated the result.
A benchmark whose failure modes flatter it produces numbers indistinguishable
from correct ones, so absence is an error here, never a silent pass.

  python summarize.py --slots results/slots.csv --judge results/judge.csv \
      --trials 3 --out results/summary.csv
"""
from __future__ import annotations

import argparse
import csv
import statistics
import sys
from collections import defaultdict


def read(path: str) -> list[dict]:
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def strict_num(v, field: str, key: tuple) -> float:
    """Parse a number that feeds the pass/fail conjunction, or abort.

    Defaulting an unparseable value to 0 (`forbidden_hit`) or 1
    (`slots_all_heard`) silently turns corrupt data into a pass.
    """
    out = num(v)
    if out is None:
        sys.exit(f"{'/'.join(map(str, key))}: {field}={v!r} is not numeric — "
                 f"refusing to guess whether that is a pass or a fail")
    return out


def pct(values: list[float], q: float) -> float:
    """Nearest-rank percentile over the values actually supplied."""
    s = sorted(values)
    idx = max(0, min(len(s) - 1, int(round(q * len(s) + 0.5)) - 1))
    return s[idx]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slots", required=True)
    ap.add_argument("--judge")
    ap.add_argument("--out", required=True)
    ap.add_argument("--trials", type=int, default=3,
                    help="expected trials per (arm, scenario); pass^k uses this k")
    ap.add_argument("--allow-incomplete", action="store_true",
                    help="score missing trials/scenarios as failures instead of aborting")
    ap.add_argument("--allow-missing-judge", action="store_true",
                    help="score runs with no judge verdict as failures instead of aborting")
    a = ap.parse_args()

    slots = read(a.slots)
    if not slots:
        sys.exit(f"{a.slots} has no rows")

    # `--judge path` pointing at an empty file must not read as "no judge
    # requested". A header-only CSV made `read()` return [] and the guard below
    # behaved as though judging had been skipped, so runs passed with no verdicts.
    judge_requested = a.judge is not None
    judge = read(a.judge) if judge_requested else []
    if judge_requested and not judge:
        sys.exit(f"--judge {a.judge} contains no verdict rows. Re-run judge.py; "
                 f"an empty judge file is not the same as no judge.")

    jmap: dict[tuple, list[dict]] = defaultdict(list)
    for j in judge:
        jmap[(j["arm"], j["trial"], j["scenario"])].append(j)

    arms = sorted({s["arm"] for s in slots})
    scenarios = sorted({s["scenario"] for s in slots})

    # Every arm must have run every scenario k times. Without this, `all()` over
    # "the rows present" makes two successful trials a pass^3, and a scenario an
    # arm never ran vanishes from its denominator entirely.
    have: dict[tuple, list[dict]] = defaultdict(list)
    for s in slots:
        have[(s["arm"], s["scenario"])].append(s)
    incomplete = [(arm, sc, len(have.get((arm, sc), [])))
                  for arm in arms for sc in scenarios
                  if len(have.get((arm, sc), [])) != a.trials]
    if incomplete and not a.allow_incomplete:
        preview = ", ".join(f"{arm}/{sc}: {n} of {a.trials}"
                            for arm, sc, n in incomplete[:6])
        sys.exit(f"{len(incomplete)} (arm, scenario) pair(s) do not have exactly "
                 f"{a.trials} trials ({preview}{'…' if len(incomplete) > 6 else ''}). "
                 f"Re-run the missing trials, pass --trials, or use "
                 f"--allow-incomplete to score the gaps as failures.")

    if judge_requested:
        missing = [(s["arm"], s["trial"], s["scenario"]) for s in slots
                   if not jmap.get((s["arm"], s["trial"], s["scenario"]))]
        if missing and not a.allow_missing_judge:
            preview = ", ".join(f"{m[0]}/t{m[1]}/{m[2]}" for m in missing[:5])
            sys.exit(f"{len(missing)} run(s) have no judge verdict "
                     f"({preview}{'…' if len(missing) > 5 else ''}). Re-run judge.py, "
                     f"or pass --allow-missing-judge to score them as failures.")

    per_run = []
    for s in slots:
        key = (s["arm"], s["trial"], s["scenario"])
        js = jmap.get(key, [])
        grounded_judge = (statistics.mean(strict_num(j["groundedness"], "groundedness", key)
                                          for j in js) if js else None)
        resolution = statistics.mean(num(j["resolution"], 0) for j in js) if js else None
        tone = statistics.mean(num(j["tone"], 0) for j in js) if js else None

        # A scenario with no expected slots has nothing to miss; an unparseable
        # value is not the same thing and must not borrow that pass.
        n_slots = strict_num(s["n_slots"], "n_slots", key)
        slots_all = (strict_num(s["slots_all_heard"], "slots_all_heard", key)
                     if n_slots > 0 else 1.0)

        ok = (
            not s.get("error")                      # a transport failure is never a pass
            and int(num(s["agent_turns"], 0)) > 0   # nor is a call the agent never joined
            and slots_all == 1
            and s["tool_ok"] == "1"
            and s["grounded_ok"] == "1"
            and strict_num(s["forbidden_hit"], "forbidden_hit", key) == 0
            and (grounded_judge is not None and grounded_judge >= 0.5
                 if judge_requested else True)
        )
        per_run.append({**s, "judge_grounded": grounded_judge,
                        "judge_resolution": resolution, "judge_tone": tone,
                        "success": int(ok)})

    by_arm_sc: dict[tuple, list[int]] = defaultdict(list)
    for r in per_run:
        by_arm_sc[(r["arm"], r["scenario"])].append(r["success"])

    rows = []
    for arm in arms:
        runs = [r for r in per_run if r["arm"] == arm]
        # Denominator is every scenario, not just the ones this arm has rows for,
        # and a scenario only passes if it has the full k trials and all passed.
        passed_k = sum(1 for sc in scenarios
                       if len(by_arm_sc.get((arm, sc), [])) == a.trials
                       and all(by_arm_sc[(arm, sc)]))

        # Turn-level, not per-call medians: a p95 over per-call medians discards
        # the one slow reply inside an otherwise normal call, which is exactly
        # the event a p95 exists to capture.
        ttfa = [float(x) for r in runs
                for x in (r.get("ttfa_ms_all") or "").split(";") if x]
        barge = [num(r["bargein_stop_ms"]) for r in runs if num(r["bargein_stop_ms"])]
        slot_accs = [num(r["slot_heard"]) for r in runs if num(r["slot_heard"]) is not None]
        echoed = [num(r["slot_echoed"]) for r in runs if num(r["slot_echoed"]) is not None]
        jg = [r["judge_grounded"] for r in runs if r["judge_grounded"] is not None]
        jr = [r["judge_resolution"] for r in runs if r["judge_resolution"] is not None]
        jt = [r["judge_tone"] for r in runs if r["judge_tone"] is not None]

        def agg(vals, fn, label):
            # An empty cell reads as zero to a spreadsheet and as "fine" to a
            # reader. Say "not measured" instead.
            return round(fn(vals)) if vals else f"no {label}"

        rows.append({
            "arm": arm,
            "runs": len(runs),
            "scenarios": len(scenarios),
            "trials": a.trials,
            "success_mean": round(statistics.mean(r["success"] for r in runs), 3),
            "pass_k": round(passed_k / len(scenarios), 3),
            "slot_heard": round(statistics.mean(slot_accs), 3) if slot_accs else "not measured",
            "slot_echoed": round(statistics.mean(echoed), 3) if echoed else "not measured",
            "tool_ok": round(statistics.mean(int(r["tool_ok"]) for r in runs), 3),
            "grounded_ok": round(statistics.mean(int(r["grounded_ok"]) for r in runs), 3),
            "forbidden_hits": sum(int(num(r["forbidden_hit"], 0)) for r in runs),
            "judge_grounded": round(statistics.mean(jg), 3) if jg else "not measured",
            "judge_resolution": round(statistics.mean(jr), 3) if jr else "not measured",
            "judge_tone": round(statistics.mean(jt), 3) if jt else "not measured",
            "ttfa_turns_n": len(ttfa),
            "ttfa_p50_ms": agg(ttfa, statistics.median, "turns"),
            "ttfa_p95_ms": agg(ttfa, lambda v: pct(v, 0.95), "turns"),
            "bargein_stop_p50_ms": agg(barge, statistics.median, "barge-ins"),
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
