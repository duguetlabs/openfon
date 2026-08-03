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
Hence the per-report cell floors in `RESULTS_FOR`: the run is an error if any
mapped report stopped being compared. Enforcing that in aggregate was not enough
— two documents then mask each other, and one can fall to zero coverage while the
run still reports clean.

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

# label -> the summary.csv field(s) it states. A two-field entry is a compound
# cell ("2087 / 2975"), split on the slash in order.
METRIC_FIELDS: dict[str, tuple[str, ...]] = {
    "slots heard": ("slot_heard",),
    "slot heard": ("slot_heard",),
    "slots echoed back": ("slot_echoed",),
    "slots echoed": ("slot_echoed",),
    "judge groundedness": ("judge_grounded",),
    "groundedness": ("judge_grounded",),
    "groundedness (seed 1)": ("judge_grounded",),
    "grounded (judge)": ("judge_grounded",),
    "grounded strings": ("grounded_ok",),
    "resolution": ("judge_resolution",),
    "tone": ("judge_tone",),
    "end_call": ("tool_ok",),
    "strict success": ("success_mean",),
    "success": ("success_mean",),
    "pass^3": ("pass_k",),
    "ttfa p50": ("ttfa_p50_ms",),
    "ttfa p95": ("ttfa_p95_ms",),
    "ttfa p50 / p95": ("ttfa_p50_ms", "ttfa_p95_ms"),
}

# Rows that carry numbers beside an arm but are NOT summary.csv figures. Every
# one is declared with the reason, because the alternative — skipping anything
# unrecognised — is how six latency figures went unchecked while the coverage
# count certified the document as fully compared. An unlisted numeric row is now
# a problem, so adding a metric to a report forces a decision here.
UNCHECKED_METRICS = {
    # Track A word-error rates: these live in asr_scores_summary.csv, not
    # summary.csv. NOT currently verified by this checker — a real gap, named.
    "clean": "Track A WER (asr_scores_summary.csv) — not yet checked",
    "cafe 20 db": "Track A WER — not yet checked",
    "cafe 10 db": "Track A WER — not yet checked",
    "cafe 5 db": "Track A WER — not yet checked",
    "cafe 0 db": "Track A WER — not yet checked",
    "g.711 telephony": "Track A WER — not yet checked",
    "telephony + cafe 10 db": "Track A WER — not yet checked",
    "telephony + 3 % loss": "Track A WER — not yet checked",
    "en_us": "SNR50, derived in score_asr.py — not yet checked",
    "de_de": "SNR50, derived in score_asr.py — not yet checked",
    # Judge-free recomputations: deliberately different quantities from the
    # summary fields they resemble. `slots all heard` is the per-run conjunction
    # (0.778), not `slot_heard` (0.893); `deterministic success` excludes the
    # judge (0.593), unlike `success_mean` (0.556). Mapping either would compare
    # two different measurements and manufacture a failure.
    "slots all heard": "per-run conjunction, not summary.slot_heard",
    "deterministic success": "judge-free success, not summary.success_mean",
    "(seed 2)": "second judge pass (judge_seed2.csv), not in summary.csv",
    # Costs and configuration.
    "cost": "catalog price, not a measurement",
    "$": "cost table", "$/min": "cost table",
    "track a min": "cost table", "track b min": "cost table",
    "stack": "configuration", "brain": "configuration", "stt": "configuration",
    "arms": "lists arm names, not a measurement",
}

# Each report is checked against the pass it was written from, and carries the
# number of table cells it is *expected* to resolve. The 2.1 run re-judged every
# arm and overwrote results/ in place, so the merged report's figures are NOT
# reproducible from the current CSVs — they are reproducible from
# results/main-report/, restored from the commit that published them. A report
# with no mapping here is an error, not a skip: an unchecked document is exactly
# the state this file exists to prevent.
#
# The cell count is a declared expectation, not a guess, and it is enforced **per
# report**. A single global floor let two documents mask each other: 25 cells
# from one and 40 from the other clear a floor of 30, so either could fall to
# zero — its tables silently unchecked — while the run still reported clean. Same
# rule as everywhere else in this harness: compare what you got against what you
# expected, for each thing you expected it of.
#
# **Where these numbers come from.** They are the count of numeric cells the
# documents *contain* beside an arm, which is now the same as the count resolved
# because an unresolved numeric row is a problem (see UNCHECKED_METRICS). That
# equality is the point. The first version of this count was 25/40, read off
# whatever the parser happened to resolve at the time — and it therefore encoded
# the parser's blind spot: the compound `TTFA p50 / p95` row matched no label, so
# six latency figures were skipped and the count certified the document as fully
# compared anyway. **A coverage number counted from current behaviour certifies
# current behaviour, including its blind spots.** Closing that gap took the
# counts to 50/51.
#
# Removing a table on purpose means lowering the number here in the same commit.
# That is the point: coverage changes should be visible in the diff.
RESULTS_FOR = {
    # report: (results subdirectory, table cells it must resolve)
    "voice-engine-quality-2026-08.md": ("main-report", 50),
    "voice-engine-quality-2026-08-gpt-realtime-2-1.md": (".", 51),
}


def norm_label(s: str) -> str:
    """Strip markdown emphasis, backticks and footnote markers from a table cell."""
    s = s.replace("**", "").replace("`", "").strip()
    return re.sub(r"\s+", " ", s).lower()


def resolve_arm(label: str, arms: set[str]) -> str | None:
    """The arm a table label names, or None if the label names no arm at all.

    Returns names that may be absent from `summary` — an alias pointing at an
    arm the CSV does not have is a *finding* ("the report has a column for an
    arm this pass never ran"), not a lookup to index blindly. Callers must check
    membership; `missing_arm` builds the message.
    """
    lab = norm_label(label)
    if lab in arms:
        return lab
    return ARM_LABELS.get(lab)


def missing_arm(doc: str, arm: str, summary: dict) -> str:
    return (f"{doc}: has a table entry for arm {arm!r}, which is not in this "
            f"report's summary.csv (it has {sorted(summary)}). Either the "
            "report names an arm the pass never ran, or it is being checked "
            "against the wrong results directory.")


def parse_number(cell: str) -> float | None:
    """Pull a single number out of a cell; None if the cell is not a lone number."""
    c = norm_label(cell).replace("$", "").replace("ms", "").replace("/min", "")
    c = c.replace(",", "").strip()
    if not re.fullmatch(r"-?\d+(\.\d+)?", c):
        return None
    return float(c)


def parse_cell(cell: str, n_fields: int) -> tuple[list[float], bool] | None:
    """The value(s) a cell states and whether they are exact, or None.

    `n_fields` comes from the label, which removes the ambiguity of the slash:
    with two fields "1315 / 1719" is a compound (p50, p95); with one, "18/27" is
    a fraction to divide. Guessing from the cell alone cannot tell them apart.

    The second element is False only for a divided fraction, whose quotient
    cannot equal summary.csv's 3-decimal rounding. Everything else compares
    exactly — a decimal cell written 0.668 against a stored 0.667 is a stale
    figure, not a rounding artefact, and must not be absorbed by a tolerance
    that exists for a different reason.
    """
    if n_fields == 2:
        parts = [p for p in norm_label(cell).split("/") if p.strip()]
        if len(parts) != 2:
            return None
        vals = [parse_number(p) for p in parts]
        if any(v is None for v in vals):
            return None
        return [v for v in vals if v is not None], True
    if (v := parse_number(cell)) is not None:
        return [v], True
    if m := re.fullmatch(r"(\d+)\s*/\s*(\d+)", norm_label(cell)):
        den = int(m.group(2))
        return ([int(m.group(1)) / den], False) if den else None
    return None


def looks_numeric(cell: str) -> bool:
    """Does this cell state a figure at all? Used to decide whether an
    unrecognised row is a silent gap or just prose."""
    return parse_cell(cell, 1) is not None or parse_cell(cell, 2) is not None


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

        def compare(label: str, arm: str, cells: list[str]) -> None:
            """One metric label against one arm's summary row."""
            nonlocal checked
            lab = norm_label(label)
            fields = METRIC_FIELDS.get(lab)
            if fields is None:
                # Unrecognised label. If it carries figures beside an arm, it is
                # a silent gap — the shape that left six TTFA values unchecked
                # while the coverage count called the document complete.
                if any(looks_numeric(c) for c in cells) and lab not in UNCHECKED_METRICS:
                    msg = (f"{doc}: table row/column {label!r} states figures "
                           "beside an arm but resolves to no summary.csv field. "
                           "Add it to METRIC_FIELDS, or to UNCHECKED_METRICS with "
                           "the reason it cannot be checked.")
                    if msg not in problems:
                        problems.append(msg)
                return
            for cell in cells:
                parsed = parse_cell(cell, len(fields))
                if parsed is None:
                    continue
                got, exact = parsed
                if arm not in summary:
                    if (msg := missing_arm(doc, arm, summary)) not in problems:
                        problems.append(msg)
                    continue
                for field, g in zip(fields, got):
                    want = parse_number(summary[arm].get(field, ""))
                    checked += 1
                    if want is None:
                        problems.append(
                            f"{doc}: {arm}/{field} — summary.csv holds "
                            f"{summary[arm].get(field)!r}, not a number")
                    # Exact, except for a fraction the document wrote as 18/27
                    # against a value summary.csv rounded to 0.667.
                    elif abs(g - want) > (1e-9 if exact else 0.0006):
                        problems.append(
                            f"{doc}: {arm}/{field} — document says {g:g}, "
                            f"summary.csv says {want:g}")

        if col_arms:  # metrics down the first column
            for row in tbl[1:]:
                if not row:
                    continue
                for i, arm in col_arms.items():
                    if i < len(row):
                        compare(row[0], arm, [row[i]])
        elif row_arms:  # metrics across the header
            for r, arm in row_arms.items():
                for i, c in enumerate(head):
                    if i and i < len(tbl[r]):
                        compare(c, arm, [tbl[r][i]])
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
    with a_path.open() as f:
        a = list(csv.DictReader(f))
    with b_path.open() as f:
        b = list(csv.DictReader(f))
    # Columns are indexed below; a renamed or dropped one must be reported, not
    # raised. Same reason resolve_arm no longer indexes summary blindly.
    need = ("scenario", "arm", "trial", "groundedness", "resolution", "tone")
    for path, rows in ((a_path, a), (b_path, b)):
        if not rows:
            return [f"{doc}: {path.name} has no rows, so the judge-agreement "
                    "claim cannot be verified against it"]
        if absent := [c for c in need if c not in rows[0]]:
            return [f"{doc}: {path.name} is missing column(s) {absent}, so the "
                    "judge-agreement claim cannot be verified against it"]
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
        rate = n / len(shared) * 100
        fm = re.search(field, region, re.I)
        if not fm:
            # Every dimension must state its agreement. Skipping a missing one
            # meant the whole three-row table could be deleted — heading intact —
            # and the run still passed: the reliability evidence disappears and
            # CI certifies the report anyway. Absence of the evidence is the
            # finding, exactly as it is everywhere else in this harness.
            problems.append(
                f"{doc}: the judge-agreement claim does not state {field}. "
                f"Every judge dimension the report scores needs its reliability "
                f"figure; recomputed it is {n}/{len(shared)} ({rate:.1f} %).")
            continue
        window = region[fm.end():fm.end() + 80]
        frac = re.search(r"(\d+)\s*/\s*(\d+)", window)
        pctm = re.search(r"(\d+\.\d+)\s*%", window)
        if not frac and not pctm:
            problems.append(
                f"{doc}: {field} appears in the judge-agreement claim with no "
                f"figure next to it, so nothing was compared; recomputed it is "
                f"{n}/{len(shared)} ({rate:.1f} %).")
            continue
        if frac:
            got = (int(frac.group(1)), int(frac.group(2)))
            if got != (n, len(shared)):
                problems.append(
                    f"{doc}: judge agreement on {field} — document says "
                    f"{got[0]}/{got[1]}, the two judge files agree on "
                    f"{n}/{len(shared)} shared rows")
        if pctm and abs(float(pctm.group(1)) - rate) > 0.05:
            problems.append(
                f"{doc}: judge agreement on {field} — document says "
                f"{pctm.group(1)} %, recomputed {rate:.1f} %")
    # Row counts and arm coverage for these files are checked by
    # check_arm_counts' "`<file>.csv` (…)" form, which covers any named CSV.
    return problems


WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
         "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12}


def as_int(token: str) -> int | None:
    return int(token) if token.isdigit() else WORDS.get(token.lower())


def arm_set(summary_csv: Path) -> set[str] | None:
    if not summary_csv.exists():
        return None
    with summary_csv.open() as f:
        rows = list(csv.DictReader(f))
    if not rows or "arm" not in rows[0]:
        return None
    return {r["arm"] for r in rows}


def arms_in(results: Path) -> int | None:
    s = arm_set(results / "summary.csv")
    return None if s is None else len(s)


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
        rm = re.search(r"(\d+)\s+rows", paren)
        am = re.search(r"(\w+)\s+arms", paren)
        n = as_int(am.group(1)) if am else None
        if not rm and n is None:
            continue  # a parenthetical that makes no count claim
        path = own / fname
        if not path.exists():
            # The document names a file and states its size; if the file is not
            # there, that is the finding. Skipping quietly meant a report could
            # cite a CSV that no longer exists and still pass.
            problems.append(f"{doc}: cites `{fname}` with a row/arm count, but "
                            f"{path} does not exist")
            continue
        with path.open() as f:
            rows = list(csv.DictReader(f))
        if rm and int(rm.group(1)) != len(rows):
            problems.append(f"{doc}: says {fname} has {rm.group(1)} rows; "
                            f"it has {len(rows)}")
        if n is not None:
            if not rows or "arm" not in rows[0]:
                problems.append(f"{doc}: says {fname} covers {am.group(1)} arms, "
                                "but that file has no rows with an 'arm' column")
            else:
                got = len({r["arm"] for r in rows})
                if got != n:
                    problems.append(f"{doc}: says {fname} covers {am.group(1)} "
                                    f"arms; it covers {got}")

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


def check_conditions(md: str, doc: str, results: Path, root: Path) -> list[str]:
    """"Track A was run on six conditions" followed by five names.

    Checked two ways: the stated count against the names listed, and the names
    against the conditions actually present in the committed ASR rows. Anchored
    on the phrase that introduces the matrix, not on any "run on N conditions" —
    the merged report has an unrelated control re-run "on two conditions".

    The data comparison is per expected arm, not `any` arm. Accepting the claim
    because *one* arm matched let the other carry a different matrix while the
    report's coverage statement went unchallenged — the claim is about the arms
    this study added, so every one of them has to satisfy it.
    """
    m = re.search(r"Track A was run on (\w+) conditions", md)
    if not m:
        return []
    stated = as_int(m.group(1))
    if stated is None:
        return [f"{doc}: states Track A conditions as {m.group(1)!r}, which is "
                "not a number this checker can compare"]
    tail = md[m.end(): m.end() + 400]
    kept = re.search(r"Kept:(.*?)(?:Cut:|\n\n)", tail, re.S)
    if not kept:
        return [f"{doc}: states {stated} Track A conditions but does not list "
                "them, so the matrix cannot be reproduced"]
    named = set(re.findall(r"`([a-z0-9_]+)`", kept.group(1)))
    problems = []
    if len(named) != stated:
        problems.append(f"{doc}: states {m.group(1)} Track A conditions but "
                        f"names {len(named)}: {sorted(named)}")

    present: dict[str, set[str]] = {}
    found_any = False
    for name in ("asr.jsonl", "asr_fixed.jsonl", "asr_control.jsonl"):
        p = results / name
        if not p.exists():
            continue
        found_any = True
        for line in p.read_text().splitlines():
            r = json.loads(line)
            present.setdefault(r["arm"], set()).add(r["condition"])
    if not found_any or not present:
        return problems + [
            f"{doc}: states a Track A matrix but there are no ASR rows under "
            f"{results}, so the claim cannot be checked against data"]

    # Which arms the claim is about, decided outside the data being checked:
    # the arms this report added, i.e. present in its own pass and absent from
    # the baseline snapshot. Inferring them from the ASR rows would be checking
    # the data against itself.
    own, base = arm_set(results / "summary.csv"), arm_set(root / "main-report" / "summary.csv")
    if own is None or base is None:
        return problems + [f"{doc}: cannot determine which arms the Track A "
                           "claim covers (a summary.csv is missing)"]
    expected = sorted((own - base) & set(present))
    if not expected:
        return problems + [
            f"{doc}: no arm added by this report has ASR rows, so the "
            f"'{m.group(1)} conditions' claim covers nothing checkable"]
    for arm in expected:
        if present[arm] != named:
            problems.append(
                f"{doc}: names conditions {sorted(named)} but {arm} has "
                f"{sorted(present[arm])} in the committed ASR rows")
    return problems


def check_cost_table(md: str, doc: str) -> list[str]:
    """A cost table whose line items do not sum to its own total is a real error.

    Found once already: the header quoted an estimate written before the table.
    """
    problems = []
    for tbl in tables(md):
        items, total, total_unparsed = [], None, False
        for row in tbl:
            if not row:
                continue
            val = parse_number(row[-1])
            is_total = "total" in norm_label(row[0])
            if val is None:
                # A total row whose figure stopped parsing silently disabled the
                # whole check for that table. Reformatting the cell must not be
                # a way to switch off the arithmetic.
                total_unparsed = total_unparsed or is_total
                continue
            if is_total:
                total = val
            else:
                items.append(val)
        if total_unparsed and total is None:
            problems.append(f"{doc}: a table has a 'total' row whose last cell "
                            "is not a number, so its arithmetic was not checked")
        if total is not None and not items:
            problems.append(f"{doc}: a table states a total ({total:.2f}) with "
                            "no parseable line items to check it against")
        if total is not None and items:
            s = round(sum(items), 2)
            if abs(s - total) > 0.011:
                problems.append(f"{doc}: cost table line items sum to {s:.2f}, "
                                f"stated total {total:.2f}")
    return problems


def check_run_counts(md: str, doc: str, results: Path) -> list[str]:
    """'N of the M new runs …' — both halves move when the study is extended."""
    # Look for the claim first: a missing data file only matters if something
    # depends on it, and when something does, its absence is a problem rather
    # than a reason to return clean.
    m = re.search(r"\*\*(\w+) of the (\d+) new runs\*\*", md)
    if not m:
        return []
    per_run = results / "summary_per_run.csv"
    if not per_run.exists():
        return [f"{doc}: states a new-run count but {per_run} is missing, so it "
                "cannot be checked"]
    with per_run.open() as f:
        rows = list(csv.DictReader(f))
    if not rows or "arm" not in rows[0]:
        return [f"{doc}: states a new-run count but {per_run.name} has no usable "
                "rows, so it cannot be checked"]
    new = {"native-gpt-realtime-21", "native-gpt-realtime-21-mini", "vl-native-brain-21"}
    n_new = sum(1 for r in rows if r["arm"] in new)
    dropped = sum(1 for r in rows if r["arm"] in new and r.get("ttfa_trustworthy") == "0")

    got = as_int(m.group(1))
    if got is None:
        return [f"{doc}: new-run count {m.group(1)!r} is not a number this "
                "checker can compare"]
    if got != dropped or int(m.group(2)) != n_new:
        return [f"{doc}: says {m.group(1)} of {m.group(2)} new runs were dropped "
                f"from the latency percentiles; summary_per_run.csv has "
                f"{dropped} of {n_new}"]
    return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default=str(HERE / "results"))
    ap.add_argument("--docs", default=str(HERE / ".." / ".." / "docs" / "research"))
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    a = ap.parse_args()

    root = Path(a.results)
    docs = Path(a.docs)

    problems: list[str] = []
    per_doc: dict[str, int] = {}
    seen_docs = 0
    for md_path in sorted(docs.glob("voice-engine-quality-*.md")):
        seen_docs += 1
        md = md_path.read_text()
        doc = md_path.name
        entry = RESULTS_FOR.get(doc)
        if entry is None:
            problems.append(
                f"{doc}: no entry in RESULTS_FOR, so nothing checked it. Add the "
                "results directory this report was written from.")
            continue
        sub, want_cells = entry
        results = (root / sub).resolve()
        summary_path = results / "summary.csv"
        if not summary_path.exists():
            problems.append(f"{doc}: {summary_path} is missing; its figures "
                            "cannot be verified")
            continue
        with summary_path.open() as f:
            summary = {r["arm"]: r for r in csv.DictReader(f)}
        p, n = check_tables(md, doc, summary)
        problems += p
        per_doc[doc] = n
        # Per report, not in aggregate: a document whose tables stopped resolving
        # must fail on its own account, not be carried by the other one.
        if n < want_cells:
            problems.append(
                f"{doc}: only {n} table cells resolved, expected {want_cells}. "
                "Its numeric tables are no longer being checked — this is not "
                "evidence the report is correct. If a table was removed on "
                "purpose, lower the count for this report in RESULTS_FOR.")
        problems += check_judge_agreement(md, doc, results)
        problems += check_cost_table(md, doc)
        problems += check_run_counts(md, doc, results)
        problems += check_arm_counts(md, doc, results, root)
        problems += check_conditions(md, doc, results, root)

    if not seen_docs:
        print(f"no reports found under {docs}", file=sys.stderr)
        return 2
    # Every mapped report must have been reached. A report that exists in
    # RESULTS_FOR but produced no entry above was skipped by one of the `continue`
    # paths, each of which records its own problem; this catches any future path
    # that forgets to.
    for doc in RESULTS_FOR:
        if doc not in per_doc and not any(doc in p for p in problems):
            problems.append(f"{doc}: mapped in RESULTS_FOR but never checked")

    checked = sum(per_doc.values())
    if a.json:
        print(json.dumps({"docs": seen_docs, "cells_checked": checked,
                          "cells_per_report": per_doc, "problems": problems},
                         indent=2))
    else:
        print(f"checked {checked} table cells across {seen_docs} report(s)")
        for doc, n in sorted(per_doc.items()):
            print(f"    {n:3d}  {doc}")
        for p in problems:
            print(f"  MISMATCH {p}")
        if not problems:
            print("  all figures agree with results/")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
