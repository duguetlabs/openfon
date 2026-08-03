#!/usr/bin/env python3
"""Verify that every paired-table row in a report matches the analyzer.

The reports are generated, but they are assembled by hand, and four separate
review rounds found rows that had drifted from the analyzer after a schema or
data change — including hand-entered sign counts, which were added precisely
to remove an ambiguity and so are the worst thing to get wrong by typing.

This turns "remember to regenerate" into a check. For every `| comparison |`
table in a report, it re-derives each row from the datasets in `results/` and
reports any cell that does not match.

  python check_report_tables.py ../../docs/research/realtime-21-2026-08.md

Exit status is non-zero when anything has drifted, so it can gate a commit.
"""
from __future__ import annotations

import glob
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from analyze import (METRICS, compute_paired, load,  # noqa: E402
                     pct)
from safety import safe_print  # noqa: E402

HERE = Path(__file__).resolve().parent
CELL = re.compile(r"\s*\|\s*")


def derive(dataset: Path) -> dict:
    """Every paired result in a dataset, keyed by (treat, ctrl, metric)."""
    turns = load(dataset)
    for t in turns:
        t["session_ready_ms"] = (
            t["connect_ms"] + t["config_ms"]
            if t.get("connect_ms") is not None and t.get("config_ms") is not None
            else None)
        t["ttfa_minus_vad_ms"] = (
            t["ttfa_ms"] - t["speech_stopped_ms"]
            if t.get("ttfa_ms") is not None and t.get("speech_stopped_ms") is not None
            else None)
    ok = [t for t in turns if t["ok"]]
    out = {}
    for metric, results in compute_paired(ok, [m for m, _ in METRICS]).items():
        for r in results:
            out[(r.treat, r.ctrl, metric)] = r
    return out


def all_results() -> dict:
    """Union across datasets. A comparison measured in several runs appears
    once per run; a row matching ANY of them is treated as current, since a
    report legitimately quotes different blocks in different sections."""
    merged: dict = {}
    for f in sorted(glob.glob(str(HERE / "results" / "*.jsonl"))):
        for k, v in derive(Path(f)).items():
            merged.setdefault(k, []).append(v)
    return merged


def row_numbers(row: str) -> list:
    """Numbers in a report row, minus the ones inside the <sub> caption."""
    body = re.sub(r"<sub>.*?</sub>", "", row)
    return re.findall(r"-?\d+\.?\d*", body.replace("−", "-").replace("–", "-"))


def check(report: Path) -> int:
    text = report.read_text()
    results = all_results()
    problems = 0
    checked = 0
    for row in text.split("\n"):
        m = re.match(r"\|\s*`([\w.-]+)`\s*−\s*`([\w.-]+)`", row.replace("−", "−"))
        if not m:
            continue
        treat, ctrl = m.group(1), m.group(2)
        candidates = [r for (t, c, _), rs in results.items() if (t, c) == (treat, ctrl)
                      for r in rs]
        if not candidates:
            safe_print(f"  no data for {treat} − {ctrl}")
            problems += 1
            continue
        checked += 1
        nums = row_numbers(row)
        # a row matches if some candidate reproduces its median, p10 and p90
        def matches(r) -> bool:
            want = {f"{r.median:.0f}", f"{pct(r.diffs, 10):.0f}",
                    f"{pct(r.diffs, 90):.0f}", str(r.sign_counts[0]),
                    str(r.sign_counts[1])}
            have = set(nums)
            return want <= have
        if not any(matches(r) for r in candidates):
            best = candidates[0]
            safe_print(f"  DRIFTED  {treat} − {ctrl}")
            safe_print(f"      report: {row.strip()[:130]}")
            safe_print(f"      analyzer (e.g. {best.metric}): median {best.median:+.0f}, "
                       f"p10/p90 {pct(best.diffs,10):+.0f}/{pct(best.diffs,90):+.0f}, "
                       f"signs {best.sign_counts[0]}/{best.sign_counts[1]}")
            problems += 1
    safe_print(f"\n{checked} paired rows checked in {report.name}: "
               + ("all match the analyzer" if not problems else f"{problems} drifted"))
    return 0 if not problems else 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: check_report_tables.py <report.md> [<report.md>...]")
    raise SystemExit(max(check(Path(a)) for a in sys.argv[1:]))
