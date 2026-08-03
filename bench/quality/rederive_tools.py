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
import sys
from pathlib import Path

from events import function_call


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


def first_appearance(names: list[str]) -> list[str]:
    """Distinct names in order of first appearance.

    The invariant a rewrite must preserve. Comparing *sets* accepts a
    reordering — ["lookup", "end_call"] against ["end_call", "lookup"] — which
    is not a deduplication, and for multi-tool scenarios the order carries
    scoring meaning.
    """
    out: list[str] = []
    for n in names:
        if n not in out:
            out.append(n)
    return out


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
        # Deduplication may only remove REPEATS of a name already present. Any
        # other difference means the log and the run disagree about what
        # happened, not that duplicates were collapsed:
        #   missing  -> the log is partial (truncated, redacted, overwritten) and
        #               applying it would delete a real tool call
        #   extra    -> the log contains an invocation the run never recorded, and
        #               applying it would invent one
        #   reordered-> the same calls in a different order, which is not a
        #               deduplication at all; order carries scoring meaning in
        #               the multi-tool scenarios
        # All silently change benchmark results, so all are refused. Comparing
        # sets caught the first two and accepted the third — a guard that only
        # checks the differences someone thought of is a partial guard, and
        # membership is a weaker property than the sequence it stands in for.
        if first_appearance(before) != first_appearance(after):
            missing, extra = sorted(set(before) - set(after)), sorted(set(after) - set(before))
            reordered = not missing and not extra
            stats["REFUSED: log and run disagree"] += 1
            print(f"  {r['arm']}/{r['scenario']}/t{r['trial']}: "
                  f"log={after} run={before}"
                  f"{f' missing={missing}' if missing else ''}"
                  f"{f' extra={extra}' if extra else ''}"
                  f"{' reordered (same calls, different order)' if reordered else ''}"
                  f" — left unchanged", file=sys.stderr)
            continue
        stats["unchanged" if before == after else "rewritten"] += 1
        r["tool_calls"] = rebuilt

    for k, v in sorted(stats.items()):
        print(f"{k:28s} {v}")
    if not a.dry_run:
        Path(a.runs).write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in runs))
        print(f"rewrote {len(runs)} runs -> {a.runs}")


if __name__ == "__main__":
    main()
