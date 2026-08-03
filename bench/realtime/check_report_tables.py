#!/usr/bin/env python3
"""Verify that every figure a report quotes for a comparison matches the analyzer.

Reports are generated, but assembled by hand, and five review rounds found rows
that had drifted — including hand-entered sign counts, which exist to remove an
ambiguity and so are the worst thing to get wrong by typing.

**The rule, borrowed from `bench/quality/COMPLETENESS.md`: compare what you got
against what you expected, by identity rather than by count, and never let
absence read as a pass.** The first version of this checker broke that rule in
the same way the quality harness's checker did — it recognised only rows
*beginning* with a backticked arm, so rows carrying a metric prefix,
``| `connect_ms`, `vl-gateway` − `vl-direct` | …``, were silently skipped. That
hid twelve rows across two reports, including the whole table of results that
survive correction. A parser that drops what it does not recognise reports
success for the rows it never looked at.

So: **any table row mentioning an arm pair is a candidate.** Every candidate is
either verified against the analyzer or listed in `UNCHECKABLE` with a reason.
Anything else is a reported problem, and coverage is asserted by **equality**.

  python check_report_tables.py ../../docs/research/realtime-21-2026-08.md

Exit status is non-zero when anything drifted or went unresolved.
"""
from __future__ import annotations

import glob
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from analyze import METRICS, compute_paired, load, pct  # noqa: E402
from safety import safe_print  # noqa: E402

HERE = Path(__file__).resolve().parent

# An arm pair anywhere in the row makes it a candidate, prefixed or not.
ARM_PAIR = re.compile(r"`([\w.\-]+)`\s*[−–-]\s*`([\w.\-]+)`")
# A metric named just before the pair, backticked or as prose.
METRIC_PREFIX = re.compile(
    r"\|\s*(?:`(?P<code>[\w_]+)`|(?P<prose>[A-Za-z][\w \-]*?))\s*,\s*`")

PROSE_METRIC = {
    "end-of-turn": "speech_stopped_ms",
    "engine-only": "ttfa_minus_vad_ms",
    "ttfa": "ttfa_ms",
}

# Rows that genuinely cannot be checked against a paired result, each with its
# reason. Absence from this list is a problem, not a pass — that is the point.
UNCHECKABLE: dict[str, str] = {}


def derive_all() -> dict:
    """Every paired result across every dataset, keyed (treat, ctrl, metric)."""
    merged: dict = {}
    for f in sorted(glob.glob(str(HERE / "results" / "*.jsonl"))):
        turns = load(Path(f))
        for t in turns:
            t["session_ready_ms"] = (
                t["connect_ms"] + t["config_ms"]
                if t.get("connect_ms") is not None and t.get("config_ms") is not None
                else None)
            t["ttfa_minus_vad_ms"] = (
                t["ttfa_ms"] - t["speech_stopped_ms"]
                if t.get("ttfa_ms") is not None
                and t.get("speech_stopped_ms") is not None else None)
        ok = [t for t in turns if t["ok"]]
        for metric, results in compute_paired(ok, [m for m, _ in METRICS]).items():
            for r in results:
                merged.setdefault((r.treat, r.ctrl, metric), []).append(r)
    return merged


def row_numbers(row: str) -> set:
    body = re.sub(r"<sub>.*?</sub>", "", row)
    body = body.replace("−", "-").replace("–", "-")
    return set(re.findall(r"-?\d+\.?\d*", body))


def reproduces(r, nums: set) -> bool:
    """Does this analyzer result account for the row's figures?

    Requires the median — the one statistic every comparison row quotes — plus
    at least one other derived value, so a row cannot match on a coincidence.
    A report legitimately shows a subset of columns, so the rest are optional.
    """
    if f"{r.median:.0f}" not in nums:
        return False
    optional = {f"{pct(r.diffs, 10):.0f}", f"{pct(r.diffs, 90):.0f}",
                str(r.sign_counts[0]), str(r.sign_counts[1]),
                f"{r.lo:.0f}", f"{r.hi:.0f}", f"{r.p_adj:.3f}", f"{r.p_raw:.3f}"}
    return bool(nums & optional)


def check(report: Path, results: dict) -> int:
    text = report.read_text()
    rows = [l for l in text.split("\n") if l.startswith("|") and ARM_PAIR.search(l)]
    checked = allowlisted = 0
    problems = []
    for line in rows:
        if any(key in line for key in UNCHECKABLE):
            allowlisted += 1
            continue
        m = ARM_PAIR.search(line)
        treat, ctrl = m.group(1), m.group(2)
        pm = METRIC_PREFIX.match(line)
        metric = None
        if pm:
            metric = pm.group("code") or PROSE_METRIC.get(
                (pm.group("prose") or "").strip().lower())
        candidates = [r for (t, c, mm), rs in results.items()
                      if (t, c) == (treat, ctrl)
                      and (metric is None or mm == metric)
                      for r in rs]
        if not candidates:
            problems.append(f"  UNRESOLVED  {treat} − {ctrl}"
                            + (f"  (metric {metric})" if metric else "")
                            + f"\n      {line.strip()[:130]}")
            continue
        if any(reproduces(r, row_numbers(line)) for r in candidates):
            checked += 1
            continue
        best = candidates[0]
        problems.append(
            f"  DRIFTED  {treat} − {ctrl} ({best.metric})\n"
            f"      report:   {line.strip()[:130]}\n"
            f"      analyzer: median {best.median:+.0f}, p10/p90 "
            f"{pct(best.diffs, 10):+.0f}/{pct(best.diffs, 90):+.0f}, "
            f"signs {best.sign_counts[0]}/{best.sign_counts[1]}")
    for p in problems:
        safe_print(p)
    unresolved = len(problems)
    # Coverage by EQUALITY, computed from the candidate list itself so it cannot
    # be calibrated against a blind spot the way a hand-set floor can.
    assert checked + allowlisted + unresolved == len(rows), "coverage arithmetic"
    safe_print(f"{report.name}: {len(rows)} comparison rows — {checked} verified, "
               f"{allowlisted} allowlisted, {unresolved} unresolved")
    return unresolved


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: check_report_tables.py <report.md> [...]")
    res = derive_all()
    bad = sum(check(Path(a), res) for a in sys.argv[1:])
    safe_print("\nOK" if not bad else f"\n{bad} row(s) need attention")
    raise SystemExit(0 if not bad else 1)
