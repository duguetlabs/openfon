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
import math
import statistics
import sys
from pathlib import Path
from collections import defaultdict


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
    """Nearest-rank percentile: the smallest value at or above rank ceil(q*n).

    `round()` is not this. Python rounds half to even, so `round(q*n + 0.5)`
    picks rank 20 of 20 and rank 96 of 100 where nearest-rank picks 19 and 95 —
    and the Track B arms have 96–106 turns each, squarely in that range.
    """
    s = sorted(values)
    return s[max(0, min(len(s) - 1, math.ceil(q * len(s)) - 1))]


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

    # Every arm must have run every scenario once per trial id 1..k.
    #
    # By IDENTITY, not by count. Counting rows lets three copies of trial 1
    # satisfy `--trials 3` while trials 2 and 3 are missing entirely, and
    # `pass_k` then reports a pass over duplicates. That is not hypothetical
    # here: the runners append to JSONL, so a re-run of one trial adds rows
    # rather than replacing them.
    expected_trials = {str(t) for t in range(1, a.trials + 1)}
    have: dict[tuple, list[str]] = defaultdict(list)
    for s in slots:
        have[(s["arm"], s["scenario"])].append(str(s["trial"]))

    incomplete = []
    for arm in arms:
        for sc in scenarios:
            got = have.get((arm, sc), [])
            dupes = sorted({t for t in got if got.count(t) > 1})
            missing = sorted(expected_trials - set(got))
            unexpected = sorted(set(got) - expected_trials)
            if dupes or missing or unexpected:
                why = []
                if missing:
                    why.append(f"missing trial {','.join(missing)}")
                if dupes:
                    why.append(f"duplicate trial {','.join(dupes)}")
                if unexpected:
                    why.append(f"unexpected trial {','.join(unexpected)}")
                incomplete.append((arm, sc, "; ".join(why)))
    if incomplete and not a.allow_incomplete:
        preview = "; ".join(f"{arm}/{sc}: {why}" for arm, sc, why in incomplete[:6])
        sys.exit(f"{len(incomplete)} (arm, scenario) pair(s) do not have exactly one "
                 f"row per trial 1..{a.trials} ({preview}"
                 f"{'…' if len(incomplete) > 6 else ''}). Re-run the gaps, pass "
                 f"--trials, or use --allow-incomplete to score them as failures.")

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
    expected_runs = len(scenarios) * a.trials
    for arm in arms:
        runs = [r for r in per_run if r["arm"] == arm]
        # THE RULE: every aggregate compares what it observed against what was
        # expected. A rate whose denominator is "the rows that happened to be
        # there" reports 1.0 for two successes out of three — which is exactly
        # what --allow-incomplete promises not to do.
        missing_runs = expected_runs - len(runs)

        def rate(pred) -> float:
            """Fraction over *expected* runs; anything absent counts as a miss."""
            return (sum(1 for r in runs if pred(r))) / expected_runs

        # Denominator is every scenario, not just the ones this arm has rows for,
        # and a scenario only passes if it has the full k trials and all passed.
        # Keyed on trial identity: a scenario passes only if trials 1..k each
        # have exactly one row and all of them succeeded.
        passed_k = 0
        for sc in scenarios:
            got = {r["trial"]: r["success"] for r in per_run
                   if r["arm"] == arm and r["scenario"] == sc}
            n_rows = sum(1 for r in per_run
                         if r["arm"] == arm and r["scenario"] == sc)
            if (len(got) == a.trials == n_rows
                    and {str(t) for t in got} == {str(t) for t in range(1, a.trials + 1)}
                    and all(got.values())):
                passed_k += 1

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

        # Descriptive statistics cannot impute a missing observation the way a
        # rate can, so they carry their own n and are flagged when short of a
        # denominator that is actually known.
        #
        # TTFA has no such denominator: a caller turn only yields a latency if
        # the agent replied, and the last turn of a call (the caller's goodbye)
        # usually gets no reply by design. Comparing against the caller-turn
        # count would flag every complete run as short. Run-level completeness
        # is carried by `missing_runs`, which is the denominator that exists.
        def descr(vals, fn, label, expected=None, ndigits=0):
            if not vals:
                return f"no {label}"
            out = round(fn(vals), ndigits) if ndigits else round(fn(vals))
            short = expected is not None and len(vals) < expected
            return f"{out} (of {len(vals)}/{expected} {label})" if short else out

        rows.append({
            "arm": arm,
            "runs": len(runs),
            "runs_expected": expected_runs,
            "missing_runs": missing_runs,
            "scenarios": len(scenarios),
            "trials": a.trials,
            # Rates: denominated on expected, so a missing run is a failure.
            "success_mean": round(rate(lambda r: r["success"]), 3),
            "pass_k": round(passed_k / len(scenarios), 3),
            "tool_ok": round(rate(lambda r: r["tool_ok"] == "1"), 3),
            "grounded_ok": round(rate(lambda r: r["grounded_ok"] == "1"), 3),
            # Descriptive: cannot be imputed, so report n and flag shortfalls.
            "slot_heard": descr(slot_accs, statistics.mean, "runs", ndigits=3) if slot_accs
            else "not measured",
            "slot_echoed": descr(echoed, statistics.mean, "runs", ndigits=3) if echoed
            else "not measured",
            "forbidden_hits": sum(int(num(r["forbidden_hit"], 0)) for r in runs),
            "judge_grounded": descr(jg, statistics.mean, "verdicts", expected_runs, ndigits=3)
            if jg else "not measured",
            "judge_resolution": descr(jr, statistics.mean, "verdicts", expected_runs, ndigits=3)
            if jr else "not measured",
            "judge_tone": descr(jt, statistics.mean, "verdicts", expected_runs, ndigits=3)
            if jt else "not measured",
            "ttfa_turns_n": len(ttfa),
            "ttfa_p50_ms": descr(ttfa, statistics.median, "turns"),
            "ttfa_p95_ms": descr(ttfa, lambda v: pct(v, 0.95), "turns"),
            "bargein_stop_p50_ms": descr(barge, statistics.median, "barge-ins"),
            "errors": sum(1 for r in runs if r["error"]),
            "session_min": round(sum(num(r["session_s"], 0) for r in runs) / 60, 1),
        })

    with open(a.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows -> {a.out}")

    detail = sibling(a.out, "_per_run")
    with open(detail, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(per_run[0].keys()))
        w.writeheader()
        w.writerows(per_run)
    print(f"wrote {len(per_run)} rows -> {detail}")


if __name__ == "__main__":
    main()
