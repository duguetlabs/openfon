"""Rebuild `tool_calls` in a results file from the committed raw event logs.

The first version of the runner appended a tool name on every event that
mentioned it, so one `end_call` invocation was recorded two or three times. The
duplicate never affected `tool_ok` (which compares sets) but it was shown to the
blind judge as `[tools invoked: end_call, end_call]`, and it made the logs
misleading to read.

Deduplicating on call_id is a pure re-read of data we already paid for, so this
corrects the record without re-running a single call.

Exits non-zero if any row was left unrepaired — see the end of `main`. A repair
tool that declines part of its job and reports success is indistinguishable from
one that had nothing to do.

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

    Comparing *sets* accepts a reordering — ["lookup", "end_call"] against
    ["end_call", "lookup"] — which is not a deduplication, and for multi-tool
    scenarios the order carries scoring meaning. Distinctness in order is
    stronger, and still not strong enough on its own: see `is_deduplication`.
    """
    out: list[str] = []
    for n in names:
        if n not in out:
            out.append(n)
    return out


def is_subsequence(sub: list[str], whole: list[str]) -> bool:
    """Can `sub` be obtained from `whole` by deleting elements?"""
    it = iter(whole)
    return all(any(x == y for y in it) for x in sub)


def is_deduplication(before: list[str], after: list[str]) -> bool:
    """May `before` be replaced by `after`? Only if `after` removes repeats.

    Three properties, and each one is load-bearing:

    * **`after` is a subsequence of `before`.** Deletion is the only edit a
      deduplication performs, so every call in the rewrite must be one the run
      already recorded, in the position it recorded it. This is the property
      that carries multiplicity, and its absence was the bug: two distinct call
      ids sharing a function name give `after == ["end_call", "end_call"]`,
      whose *distinct names in order* are identical to `["end_call"]`'s — so the
      guard permitted a rewrite that **adds** an invocation. `end_call`
      reliability is one of this study's published findings; a re-derivation
      able to invent an `end_call` writes into the evidence for it.
    * **the set is preserved.** Deleting every copy of a name is not a
      deduplication, it deletes a tool call — the log being partial (truncated,
      redacted, overwritten) rather than merely repetitive.
    * **first appearance is preserved.** A subsequence can keep every name and
      still reorder them by deleting the *first* occurrence: ["a", "b", "a"] ->
      ["b", "a"] is a set-preserving subsequence that changes which tool the
      record says was called first.

    Counting distinct names in order was itself the fix for a set comparison
    that missed reordering. Each tightening stopped one step short of the
    property it was reaching for; the property is stated here in full so the
    next one does not have to be inferred from the check.
    """
    return (is_subsequence(after, before)
            and set(after) == set(before)
            and first_appearance(after) == first_appearance(before))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", required=True)
    ap.add_argument("--logdir", default="logs")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    runs = [json.loads(l) for l in Path(a.runs).read_text().splitlines() if l.strip()]
    stats = collections.Counter()
    # Every row this run declined to repair, by identity. A count in stdout is
    # not a report: see the exit below.
    declined: list[str] = []
    for r in runs:
        unit = f"{r['arm']}/{r['scenario']}/t{r['trial']}"
        log = Path(a.logdir) / f"sc-{r['arm']}-{r['scenario']}-t{r['trial']}.jsonl"
        rebuilt = calls_from_log(log)
        if not log.exists():
            # Also a declined repair, not a no-op: this row's `tool_calls` were
            # never checked against anything, so "I verified every row" and "I
            # could not find the evidence for this one" would otherwise be the
            # same exit code.
            stats["log missing"] += 1
            declined.append(f"{unit}: no log at {log}")
            continue
        before, after = list(r.get("tool_calls") or []), rebuilt
        # Deduplication may only remove REPEATS of a name already present. Any
        # other difference means the log and the run disagree about what
        # happened, not that duplicates were collapsed:
        #   missing  -> the log is partial (truncated, redacted, overwritten) and
        #               applying it would delete a real tool call
        #   extra    -> the log contains an invocation the run never recorded, and
        #               applying it would invent one
        #   inflated -> the log has MORE calls of a name the run also recorded —
        #               two distinct call ids, one name — so applying it invents
        #               an invocation without introducing a new name, which is
        #               invisible to any check that compares names
        #   reordered-> the same calls in a different order, which is not a
        #               deduplication at all; order carries scoring meaning in
        #               the multi-tool scenarios
        # All silently change benchmark results, so all are refused. See
        # `is_deduplication` for why each of the three properties it checks is
        # needed; the short version is that every weaker guard tried here so far
        # was a comparison of *names*, and `inflated` differs in the count.
        if not is_deduplication(before, after):
            cb, ca = collections.Counter(before), collections.Counter(after)
            missing, extra = sorted(cb.keys() - ca.keys()), sorted(ca.keys() - cb.keys())
            inflated = sorted(f"{n} {cb[n]}->{ca[n]}" for n in ca
                              if n in cb and ca[n] > cb[n])
            reordered = not missing and not extra and not inflated
            why = (f"log={after} run={before}"
                   f"{f' missing={missing}' if missing else ''}"
                   f"{f' extra={extra}' if extra else ''}"
                   f"{f' inflated={inflated}' if inflated else ''}"
                   f"{' reordered (same calls, different order)' if reordered else ''}")
            stats["REFUSED: log and run disagree"] += 1
            declined.append(f"{unit}: {why}")
            print(f"  {unit}: {why} — left unchanged", file=sys.stderr)
            continue
        stats["unchanged" if before == after else "rewritten"] += 1
        r["tool_calls"] = rebuilt

    for k, v in sorted(stats.items()):
        print(f"{k:28s} {v}")
    if not a.dry_run:
        Path(a.runs).write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in runs))
        # Not `len(runs)`: the refused rows were written back unchanged, and
        # saying they were rewritten is the same overclaim as the exit code.
        print(f"rewrote {stats['rewritten']} of {len(runs)} runs -> {a.runs}")

    # A refusal has to reach the exit status. This tool repairs benchmark data
    # that backs published findings, so "I declined to repair these rows" and
    # "I repaired everything" must not be the same exit code: a caller chaining
    # `rederive_tools.py && summarize.py` would score a partial repair as a
    # complete one, and nothing downstream can tell the difference — the refused
    # rows look exactly like rows that needed no repair.
    #
    # This is the guard's own shadow. Refusing the rewrite was the fix; the
    # refusal being invisible to automation is the same class one step further
    # out, which is the shape this harness keeps producing (COMPLETENESS.md).
    # The file is still written, because the accepted rows are correctly
    # deduplicated and the refused ones are byte-identical to their input —
    # partial repair is safe, silent partial repair is not.
    if declined:
        sys.exit(f"{len(declined)} run(s) were NOT re-derived:\n  "
                 + "\n  ".join(declined[:10])
                 + ("\n  ..." if len(declined) > 10 else "")
                 + f"\n{a.runs} holds a PARTIAL re-derivation: the rows above "
                 "are unchanged from their input, the rest are deduplicated. "
                 "Investigate the logs before treating this file as repaired.")


if __name__ == "__main__":
    main()
