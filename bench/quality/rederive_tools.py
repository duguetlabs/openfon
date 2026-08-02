"""Rebuild `tool_calls` in a results file from the committed raw event logs.

The first version of the runner appended a tool name on every event that
mentioned it, so one `end_call` invocation was recorded two or three times. The
duplicate never affected `tool_ok` (which compares sets) but it was shown to the
blind judge as `[tools invoked: end_call, end_call]`, and it made the logs
misleading to read.

Deduplicating on call_id is a pure re-read of data we already paid for, so this
corrects the record without re-running a single call.

  python rederive_tools.py --runs results/scenarios.jsonl --logdir logs
"""
from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path

from run_scenarios import function_call


def calls_from_log(path: Path) -> list[str]:
    seen: set[str] = set()
    names: list[str] = []
    if not path.exists():
        return []
    with open(path) as f:
        for line in f:
            try:
                ev = json.loads(line).get("ev") or {}
            except json.JSONDecodeError:
                continue
            if (call := function_call(ev)):
                cid, name = call
                if cid not in seen:
                    seen.add(cid)
                    names.append(name)
    return names


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", required=True)
    ap.add_argument("--logdir", default="logs")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    runs = [json.loads(l) for l in Path(a.runs).read_text().splitlines() if l.strip()]
    stats = collections.Counter()
    for r in runs:
        log = Path(a.logdir) / f"sc-{r['arm']}-{r['scenario']}-t{r['trial']}.jsonl"
        rebuilt = calls_from_log(log)
        if not log.exists():
            stats["log missing"] += 1
            continue
        before, after = list(r.get("tool_calls") or []), rebuilt
        stats["unchanged" if before == after else "rewritten"] += 1
        # A set-level change would mean the dedupe lost a distinct call, which
        # would be a bug in this script rather than a correction.
        if set(before) != set(after):
            stats["SET CHANGED (investigate)"] += 1
            print(f"  {r['arm']}/{r['scenario']}/t{r['trial']}: {before} -> {after}")
        r["tool_calls"] = rebuilt

    for k, v in sorted(stats.items()):
        print(f"{k:28s} {v}")
    if not a.dry_run:
        Path(a.runs).write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in runs))
        print(f"rewrote {len(runs)} runs -> {a.runs}")


if __name__ == "__main__":
    main()
