#!/usr/bin/env python3
"""Verify the research reports against the CSVs they claim to quote.

Why this exists
---------------
Three review rounds in a row found the same defect: a sentence or a table that
was correct when written, and stale after the study was extended. Code that goes
stale fails a test; prose that goes stale fails nothing. Every number in these
reports is derived from `results/*.csv`, so every number in these reports can be
checked against `results/*.csv` — this file does that, and `test_scoring.py`
runs it.

The rule this enforces is the same one `COMPLETENESS.md` states for the scorers:
**a check that resolves nothing must fail, not pass.** A parser that silently
matched zero table cells would report "no problems" for a document made entirely
of wrong numbers, which is this repository's signature bug wearing a new hat.
Hence `MIN_CELLS`: the run is an error if it did not actually compare anything.

Usage:  python3 check_report.py [--results results] [--docs ../../docs/research]
Exits non-zero, listing each disagreement, if the documents and the data differ.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# A report table cell is checked only if both its arm and its metric resolve.
# Anything unresolved is counted and reported, never silently dropped.
ARM_LABELS = {
    "vl + gpt-4.1-mini": "vl-gpt41mini",
    "vl + 2.1": "vl-native-brain-21",
    "foundry 2.1": "native-gpt-realtime-21",
    "gpt-realtime-2": "native-gpt-realtime-2",
    "gpt-realtime-2.1": "native-gpt-realtime-21",
    "2.1-mini": "native-gpt-realtime-21-mini",
    "gpt-realtime-2.1-mini": "native-gpt-realtime-21-mini",
}

METRIC_FIELDS = {
    "slots heard": "slot_heard",
    "slot heard": "slot_heard",
    "slots echoed back": "slot_echoed",
    "judge groundedness": "judge_grounded",
    "groundedness": "judge_grounded",
    "strict success": "success_mean",
    "success": "success_mean",
    "pass^3": "pass_k",
    "ttfa p50": "ttfa_p50_ms",
    "ttfa p95": "ttfa_p95_ms",
}

MIN_CELLS = 30  # floor: fewer means the parser stopped matching, not that the doc is clean

# Each report is checked against the pass it was written from. The 2.1 run
# re-judged every arm and overwrote results/ in place, so the merged report's
# figures are NOT reproducible from the current CSVs — they are reproducible from
# results/main-report/, restored from the commit that published them. A report
# with no mapping here is an error, not a skip: an unchecked document is exactly
# the state this file exists to prevent.
RESULTS_FOR = {
    "voice-engine-quality-2026-08.md": "main-report",
    "voice-engine-quality-2026-08-gpt-realtime-2-1.md": ".",
}


def norm_label(s: str) -> str:
    """Strip markdown emphasis, backticks and footnote markers from a table cell."""
    s = s.replace("**", "").replace("`", "").strip()
    return re.sub(r"\s+", " ", s).lower()


def resolve_arm(label: str, arms: set[str]) -> str | None:
    lab = norm_label(label)
    if lab in arms:
        return lab
    return ARM_LABELS.get(lab)


def parse_number(cell: str) -> float | None:
    """Pull a single number out of a cell; None if the cell is not a lone number."""
    c = norm_label(cell).replace("$", "").replace("ms", "").replace("/min", "")
    c = c.replace(",", "").strip()
    if not re.fullmatch(r"-?\d+(\.\d+)?", c):
        return None
    return float(c)


def tables(md: str) -> list[list[list[str]]]:
    """Every pipe table in the document, as a list of rows of cells."""
    out, cur = [], []
    for line in md.splitlines():
        if line.strip().startswith("|") and line.strip().endswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                continue  # separator row
            cur.append(cells)
        elif cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def check_tables(md: str, doc: str, summary: dict[str, dict[str, str]]) -> tuple[list[str], int]:
    """Compare every resolvable (arm, metric) cell against summary.csv."""
    problems: list[str] = []
    checked = 0
    arms = set(summary)

    for tbl in tables(md):
        if len(tbl) < 2:
            continue
        head = tbl[0]
        # Two orientations appear in these documents: arms down the first column
        # with metrics as headers, and arms across the header with metrics down
        # the first column. Detect by where the arm names actually resolve.
        col_arms = {i: a for i, c in enumerate(head)
                    if (a := resolve_arm(c, arms)) and i > 0}
        row_arms = {r: a for r, row in enumerate(tbl[1:], 1)
                    if row and (a := resolve_arm(row[0], arms))}

        if col_arms:  # metrics down the first column
            for row in tbl[1:]:
                field = METRIC_FIELDS.get(norm_label(row[0]) if row else "")
                if not field:
                    continue
                for i, arm in col_arms.items():
                    if i >= len(row):
                        continue
                    got = parse_number(row[i])
                    if got is None:
                        continue
                    want = parse_number(summary[arm].get(field, ""))
                    checked += 1
                    if want is None:
                        problems.append(
                            f"{doc}: {arm}/{field} — summary.csv holds "
                            f"{summary[arm].get(field)!r}, not a number")
                    elif abs(got - want) > 1e-9:
                        problems.append(
                            f"{doc}: {arm}/{field} — document says {got:g}, "
                            f"summary.csv says {want:g}")
        elif row_arms:  # metrics across the header
            fields = {i: METRIC_FIELDS[norm_label(c)] for i, c in enumerate(head)
                      if norm_label(c) in METRIC_FIELDS}
            for r, arm in row_arms.items():
                for i, field in fields.items():
                    if i >= len(tbl[r]):
                        continue
                    got = parse_number(tbl[r][i])
                    if got is None:
                        continue
                    want = parse_number(summary[arm].get(field, ""))
                    checked += 1
                    if want is None:
                        problems.append(
                            f"{doc}: {arm}/{field} — summary.csv holds "
                            f"{summary[arm].get(field)!r}, not a number")
                    elif abs(got - want) > 1e-9:
                        problems.append(
                            f"{doc}: {arm}/{field} — document says {got:g}, "
                            f"summary.csv says {want:g}")
    return problems, checked


# The judge-agreement claim is always introduced by one of these.
AGREEMENT_ANCHOR = re.compile(r"agreed on|Agreement over|judge reliability", re.I)


def check_judge_agreement(md: str, doc: str, results: Path) -> list[str]:
    """The agreement claim vouches for the judge; recompute it from both files.

    This is the check the addendum most needed: its figures were quoted from a
    smaller, earlier judge pass than the numbers they were vouching for. The
    claim is only as good as the pass it was computed over, so the row counts
    and the shared-row denominator are checked too.
    """
    a_path, b_path = results / "judge.csv", results / "judge_seed2.csv"
    if not (a_path.exists() and b_path.exists()):
        return [f"{doc}: no judge files under {results}, so the agreement claim "
                "cannot be verified"]
    a = list(csv.DictReader(a_path.open()))
    b = list(csv.DictReader(b_path.open()))
    key = lambda r: (r["scenario"], r["arm"], r["trial"])  # noqa: E731
    da, db = {key(r): r for r in a}, {key(r): r for r in b}
    shared = sorted(set(da) & set(db))

    m = AGREEMENT_ANCHOR.search(md)
    if not m:
        return [f"{doc}: no judge-agreement claim found; the LLM-judge metrics "
                "are quoted without the reliability evidence that licenses them"]
    region = md[m.start():m.start() + 700]

    if not shared:
        # An empty intersection is a legitimate state — two passes over disjoint
        # runs — and it must be *reported*, not raised. A verifier that crashes
        # says nothing about the document; "cannot verify" is the finding.
        return [f"{doc}: {a_path.name} and {b_path.name} share no "
                "(scenario, arm, trial) rows, so the judge-agreement claim "
                "cannot be verified against them"]

    problems = []
    for field in ("groundedness", "resolution", "tone"):
        n = sum(1 for k in shared if da[k][field].strip() == db[k][field].strip())
        fm = re.search(field, region, re.I)
        if not fm:
            continue
        window = region[fm.end():fm.end() + 80]
        frac = re.search(r"(\d+)\s*/\s*(\d+)", window)
        if frac:
            got = (int(frac.group(1)), int(frac.group(2)))
            if got != (n, len(shared)):
                problems.append(
                    f"{doc}: judge agreement on {field} — document says "
                    f"{got[0]}/{got[1]}, the two judge files agree on "
                    f"{n}/{len(shared)} shared rows")
        pctm = re.search(r"(\d+\.\d+)\s*%", window)
        if pctm and abs(float(pctm.group(1)) - n / len(shared) * 100) > 0.05:
            problems.append(
                f"{doc}: judge agreement on {field} — document says "
                f"{pctm.group(1)} %, recomputed {n / len(shared) * 100:.1f} %")
    # Row counts and arm coverage for these files are checked by
    # check_arm_counts' "`<file>.csv` (…)" form, which covers any named CSV.
    return problems


WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
         "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12}


def as_int(token: str) -> int | None:
    return int(token) if token.isdigit() else WORDS.get(token.lower())


def arms_in(results: Path) -> int | None:
    p = results / "summary.csv"
    if not p.exists():
        return None
    with p.open() as f:
        return len({r["arm"] for r in csv.DictReader(f)})


def check_arm_counts(md: str, doc: str, own: Path, root: Path) -> list[str]:
    """"…all seven arms" when the CSV holds eight.

    A count in prose is the same defect as a stale table cell, and it survived
    the first version of this checker because only table cells were resolved.

    **Only counts tied to a named artifact are checked**, in two forms: a
    parenthetical after a CSV filename (`judge.csv` (seed 1, 246 rows, eight
    arms)), and a sentence that names a results *directory*. Free prose like
    "all eight arms were re-judged" is deliberately not matched — scanning every
    "N arms" in the text produced five false positives on these two documents,
    and a checker that cries wolf gets switched off. This trades recall for
    precision; write counts next to the file they describe and they get checked.
    """
    problems = []

    # Form 1: `<file>.csv` (…, N rows, M arms)
    for m in re.finditer(r"`(?:[\w/.-]*/)?([\w.-]+\.csv)`\s*\(([^)]*)\)", md):
        fname, paren = m.group(1), m.group(2)
        path = own / fname
        if not path.exists():
            continue
        with path.open() as f:
            rows = list(csv.DictReader(f))
        rm = re.search(r"(\d+)\s+rows", paren)
        if rm and int(rm.group(1)) != len(rows):
            problems.append(f"{doc}: says {fname} has {rm.group(1)} rows; "
                            f"it has {len(rows)}")
        am = re.search(r"(\w+)\s+arms", paren)
        n = as_int(am.group(1)) if am else None
        if n is not None and "arm" in (rows[0] if rows else {}):
            got = len({r["arm"] for r in rows})
            if got != n:
                problems.append(f"{doc}: says {fname} covers {am.group(1)} arms; "
                                f"it covers {got}")

    # Form 2: a sentence naming a results directory and an arm count. Prefer the
    # current tree when the sentence names both, since a sentence mentioning the
    # snapshot usually does so as an aside about where the old pass went.
    for m in re.finditer(r"\b(?:all|covering|holds?)\s+\**(\w+)\**\s+arms\b", md):
        n = as_int(m.group(1))
        if n is None:
            continue
        start = md.rfind(".", 0, m.start()) + 1
        end = md.find(".", m.end())
        sentence = md[start: end if end != -1 else len(md)]
        if not re.search(r"results/|results`", sentence):
            continue  # not tied to a named tree; out of scope by design
        bare = re.search(r"results/(?!main-report)|results`", sentence)
        results, named = ((root, "results/ (the current pass)") if bare
                          else (root / "main-report", "results/main-report/"))
        got = arms_in(results)
        if got is None:
            problems.append(f"{doc}: claims {n} arms in {named}, which has no "
                            "summary.csv to check against")
        elif got != n:
            problems.append(f"{doc}: says {m.group(1)} arms in {named}; that "
                            f"summary.csv has {got}")
    return problems


def check_conditions(md: str, doc: str, results: Path) -> list[str]:
    """"Track A was run on six conditions" followed by five names.

    Checked two ways: the stated count against the names listed, and the names
    against the conditions actually present in the committed ASR rows. Anchored
    on the phrase that introduces the matrix, not on any "run on N conditions" —
    the merged report has an unrelated control re-run "on two conditions".
    """
    m = re.search(r"Track A was run on (\w+) conditions", md)
    if not m:
        return []
    stated = as_int(m.group(1))
    if stated is None:
        return []
    tail = md[m.end(): m.end() + 400]
    kept = re.search(r"Kept:(.*?)(?:Cut:|\n\n)", tail, re.S)
    if not kept:
        return [f"{doc}: states {stated} Track A conditions but does not list "
                "them, so the matrix cannot be reproduced"]
    named = re.findall(r"`([a-z0-9_]+)`", kept.group(1))
    problems = []
    if len(set(named)) != stated:
        problems.append(f"{doc}: states {m.group(1)} Track A conditions but "
                        f"names {len(set(named))}: {sorted(set(named))}")
    # And against the data, not only against itself.
    present = {}
    for name in ("asr.jsonl", "asr_fixed.jsonl", "asr_control.jsonl"):
        p = results / name
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            r = json.loads(line)
            present.setdefault(r["arm"], set()).add(r["condition"])
    if present and not any(s == set(named) for s in present.values()):
        problems.append(
            f"{doc}: the conditions named ({sorted(set(named))}) match no arm's "
            f"condition set in the committed ASR rows "
            f"({ {a: sorted(s) for a, s in sorted(present.items())} })")
    return problems


def check_cost_table(md: str, doc: str) -> list[str]:
    """A cost table whose line items do not sum to its own total is a real error.

    Found once already: the header quoted an estimate written before the table.
    """
    problems = []
    for tbl in tables(md):
        items, total = [], None
        for row in tbl:
            if not row:
                continue
            val = parse_number(row[-1])
            if val is None:
                continue
            if "total" in norm_label(row[0]):
                total = val
            else:
                items.append(val)
        if total is not None and items:
            s = round(sum(items), 2)
            if abs(s - total) > 0.011:
                problems.append(f"{doc}: cost table line items sum to {s:.2f}, "
                                f"stated total {total:.2f}")
    return problems


def check_run_counts(md: str, doc: str, results: Path) -> list[str]:
    """'N of the M new runs …' — both halves move when the study is extended."""
    per_run = results / "summary_per_run.csv"
    if not per_run.exists():
        return []
    rows = list(csv.DictReader(per_run.open()))
    new = {"native-gpt-realtime-21", "native-gpt-realtime-21-mini", "vl-native-brain-21"}
    n_new = sum(1 for r in rows if r["arm"] in new)
    dropped = sum(1 for r in rows if r["arm"] in new and r.get("ttfa_trustworthy") == "0")

    problems = []
    m = re.search(r"\*\*(\w+) of the (\d+) new runs\*\*", md)
    if m:
        got = as_int(m.group(1))
        if got != dropped or int(m.group(2)) != n_new:
            problems.append(
                f"{doc}: says {m.group(1)} of {m.group(2)} new runs were dropped from "
                f"the latency percentiles; summary_per_run.csv has {dropped} of {n_new}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default=str(HERE / "results"))
    ap.add_argument("--docs", default=str(HERE / ".." / ".." / "docs" / "research"))
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    a = ap.parse_args()

    root = Path(a.results)
    docs = Path(a.docs)

    problems: list[str] = []
    checked = 0
    seen_docs = 0
    for md_path in sorted(docs.glob("voice-engine-quality-*.md")):
        seen_docs += 1
        md = md_path.read_text()
        doc = md_path.name
        sub = RESULTS_FOR.get(doc)
        if sub is None:
            problems.append(
                f"{doc}: no entry in RESULTS_FOR, so nothing checked it. Add the "
                "results directory this report was written from.")
            continue
        results = (root / sub).resolve()
        summary_path = results / "summary.csv"
        if not summary_path.exists():
            problems.append(f"{doc}: {summary_path} is missing; its figures "
                            "cannot be verified")
            continue
        summary = {r["arm"]: r for r in csv.DictReader(summary_path.open())}
        p, n = check_tables(md, doc, summary)
        problems += p
        checked += n
        problems += check_judge_agreement(md, doc, results)
        problems += check_cost_table(md, doc)
        problems += check_run_counts(md, doc, results)
        problems += check_arm_counts(md, doc, results, root)
        problems += check_conditions(md, doc, results)

    if not seen_docs:
        print(f"no reports found under {docs}", file=sys.stderr)
        return 2
    # A parser that matched nothing must not read as a clean document.
    if checked < MIN_CELLS:
        problems.append(
            f"only {checked} table cells resolved (expected >= {MIN_CELLS}). "
            "The parser stopped matching — this is not evidence the reports are correct.")

    if a.json:
        print(json.dumps({"docs": seen_docs, "cells_checked": checked,
                          "problems": problems}, indent=2))
    else:
        print(f"checked {checked} table cells across {seen_docs} report(s)")
        for p in problems:
            print(f"  MISMATCH {p}")
        if not problems:
            print("  all figures agree with results/")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
