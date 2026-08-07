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
import math
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# A report table cell is checked only if both its arm and its metric resolve.
# An arm label that resolves to an arm absent from summary.csv is reported; a
# metric label that resolves to nothing is reported if the row carries figures,
# unless it is declared in UNCHECKED_METRICS below.
#
# That wording is deliberately specific, because the earlier version of this
# comment — "anything unresolved is counted and reported, never silently
# dropped" — was true of the arm path and false of the metric path, and the gap
# it papered over was six unchecked latency figures. A comment describing an
# invariant the code half-implements is more convincing than the code, since it
# states the intent rather than the behaviour.
ARM_LABELS = {
    "vl + gpt-4.1-mini": "vl-gpt41mini",
    "vl + 2.1": "vl-native-brain-21",
    "foundry 2.1": "native-gpt-realtime-21",
    "gpt-realtime-2": "native-gpt-realtime-2",
    "gpt-realtime-2.1": "native-gpt-realtime-21",
    "2.1-mini": "native-gpt-realtime-21-mini",
    "gpt-realtime-2.1-mini": "native-gpt-realtime-21-mini",
    "voice live + gpt-4.1-mini": "vl-gpt41mini",
}

# Columns that stand for SEVERAL arms and state a range ("2077–2408 ms"), or a
# single value where the two coincide. The merged report's headline table — the
# one a reader looks at first — is built this way, and neither label resolved to
# an arm, so the whole table was skipped: its p95 range could be set to
# 9999–9999 and the run stayed green with unchanged coverage.
ARM_GROUPS = {
    "gpt-realtime-2 (either stack)": ("native-gpt-realtime-2", "vl-native-brain"),
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
    # Headline-table spellings.
    "time to first audio, p50": ("ttfa_p50_ms",),
    "time to first audio, p95": ("ttfa_p95_ms",),
    "caller-slot capture, heard": ("slot_heard",),
    "caller-slot capture, echoed back": ("slot_echoed",),
    "strict task success": ("success_mean",),
}

# Rows that carry numbers beside an arm but are NOT summary.csv figures. Every
# one is declared with the reason, because the alternative — skipping anything
# unrecognised — is how six latency figures went unchecked while the coverage
# count certified the document as fully compared. An unlisted numeric row is now
# a problem, so adding a metric to a report forces a decision here.
UNCHECKED_METRICS = {
    # Track A: not summary.csv fields, but NOT unchecked — check_wer_tables and
    # check_snr50_table compare them against asr_scores.csv and
    # asr_scores_summary.csv. Listed here only so check_tables leaves them alone.
    "clean": "Track A WER — checked against asr_scores.csv",
    "cafe 20 db": "Track A WER — checked against asr_scores.csv",
    "cafe 10 db": "Track A WER — checked against asr_scores.csv",
    "cafe 5 db": "Track A WER — checked against asr_scores.csv",
    "cafe 0 db": "Track A WER — checked against asr_scores.csv",
    "g.711 telephony": "Track A WER — checked against asr_scores.csv",
    "telephony + cafe 10 db": "Track A WER — checked against asr_scores.csv",
    "telephony + 3 % loss": "Track A WER — checked against asr_scores.csv",
    "en_us": "SNR50 — checked against asr_scores_summary.csv",
    "de_de": "SNR50 — checked against asr_scores_summary.csv",
    # Costs and configuration.
    "cost": "catalog price, not a measurement",
    "$": "cost table", "$/min": "cost table",
    "track a min": "cost table", "track b min": "cost table",
    "stack": "configuration", "brain": "configuration", "stt": "configuration",
    "arms": "lists arm names, not a measurement",
}

# Labels on the ARM axis that are not arms. Same contract as UNCHECKED_METRICS:
# declared with a reason, so the alternative to checking is a decision rather
# than silence.
#
# Cost tables are handled structurally instead of listed here — their rows are
# spend lines ("pilots and probes", "judge re-run over 246 runs") that vary per
# study, and check_cost_table already verifies every one of them against its own
# arithmetic and the column total. Enumerating them would be a list of brittle
# strings standing in for a rule.
NON_ARM_LABELS: dict[str, str] = {}


def is_cost_table(head: list[str]) -> bool:
    return "$" in [norm_label(c) for c in head]

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
    # 192 -> 217: +20 for the two before/after tables, whose headers name an
    # arm *pair* so neither axis resolved and both were skipped whole; +5 for
    # the English DNS empty-transcript column, written `24 %`, which the unit
    # pattern could not read.
    # 217 -> 227: +10 for the change stated in each delta cell's parenthetical,
    # which was dropped rather than checked — the checker verifying a
    # subtraction's inputs but not its result.
    "voice-engine-quality-2026-08.md": ("main-report", 227),
    # 61 -> 62: the `gpt-realtime-2 / 2.1` recogniser row states one figure for
    # two arms and was compared against one of them. Both arms are a claim, so
    # both are counted.
    # 62 -> 70: +8 for the family table's two multi-arm rows, whose cells are
    # ranges across a family — neither axis resolved and a range is not
    # `looks_numeric`, so they were neither compared nor reported.
    "voice-engine-quality-2026-08-gpt-realtime-2-1.md": (".", 70),
}


# Figures recomputed per run rather than read from summary.csv. They are not
# summary fields, but "lives in a different CSV" is an argument for checking
# against that CSV — the same reasoning that moved Track A WER out of the
# allowlist. Allowlisting these let the decision-supporting judge-free table be
# edited freely: 0.593 -> 0.999 passed.
#
# A scenario with no slots satisfies "all slots heard" vacuously — `n_slots` is
# 0 for the twelve information-only runs and `slots_all_heard` is empty, not 0.
# Counting only "1" gives 0.333 against the report's 0.778; this is the same
# convention summarize.py applies when it builds `success`.
def _all_heard(r: dict) -> bool:
    return r["slots_all_heard"] in ("1", "")


PER_RUN_METRICS = {
    "slots all heard": _all_heard,
    "deterministic success": lambda r: (
        _all_heard(r) and r["tool_ok"] == "1" and r["grounded_ok"] == "1"
        and r["forbidden_hit"] in ("0", "") and not r["error"]
        and int(r["agent_turns"] or 0) > 0),
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


# Units and markers a figure may wear. Stripping these is not cosmetic: a cell
# the parser cannot read is a cell it silently skips, so every unit it does not
# know is a blind spot. `~15` made a whole cost line uncheckable *and* silent,
# and `1.0 dB` hid an unresolved arm row — the same non-match invisibility as the
# compound row and the grouped column, in one more dimension.
#
# `%` was inside the word-boundary group, and `%` is not a word character — so
# `\b%\b` never matches after a space and `parse_number("24 %")` returned None.
# The English DNS empty-transcript column is written that way, so its five
# figures were skipped in silence and the 24 % rate backing "never enable Azure
# noise suppression" could be edited to 99 % with the run staying green. Same
# non-match invisibility as `~15` and `1.0 dB`, in one more dimension: a unit
# the parser does not know is a cell it does not check.
UNITS = re.compile(r"\b(ms|db|s|min)\b|%|[$,]|/min")


def parse_number(cell: str) -> float | None:
    """Pull a single number out of a cell; None if the cell is not a lone number.

    A leading `~` marks an estimate. It is stripped rather than rejected: "this
    figure is approximate" is not the same as "this figure is unverifiable", and
    treating it as the latter meant the row was never compared at all.
    """
    c = UNITS.sub("", norm_label(cell)).strip()
    c = c[1:].strip() if c.startswith("~") else c
    if not re.fullmatch(r"-?\d+(\.\d+)?", c):
        return None
    return float(c)


def is_estimate(cell: str) -> bool:
    return "~" in cell


# A cell that states no value. Blank, or the dash these tables use for a leg a
# cost line did not use. Distinguished from a cell that states something
# unreadable, which is a finding rather than an absence.
ABSENT_CELL = re.compile(r"|[—–-]+|n/?a")


def is_absent(cell: str) -> bool:
    return ABSENT_CELL.fullmatch(norm_label(cell)) is not None


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


def parse_range(cell: str) -> tuple[float, float] | None:
    """"2077–2408 ms" -> (2077, 2408); "**1.000**" -> (1.0, 1.0).

    A group column collapses to a single value when its arms agree, so a lone
    number is a degenerate range rather than an unparseable cell.
    """
    c = norm_label(cell).replace("ms", "").replace("$", "").strip()
    if m := re.fullmatch(r"(-?\d+(?:\.\d+)?)\s*[–—-]\s*(-?\d+(?:\.\d+)?)", c):
        return float(m.group(1)), float(m.group(2))
    if (v := parse_number(cell)) is not None:
        return v, v
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


def seed2_grounded(rows: list[dict], arm: str, scored: set[str]) -> float | None:
    """Groundedness from the SECOND judge pass, over the scored scenarios.

    The family table states seed 1 and seed 2 side by side, and only seed 1 was
    checked — "not in summary.csv" was true and beside the point, since
    judge_seed2.csv is committed. Same argument as Track A and the judge-free
    figures, third time.
    """
    rs = [r for r in rows if r["arm"] == arm and r["scenario"] in scored]
    if not rs:
        return None
    return sum(1 for r in rs if r["groundedness"].strip() == "1") / len(rs)


def check_tables(md: str, doc: str, summary: dict[str, dict[str, str]],
                 per_run: list[dict] | None = None,
                 seed2: list[dict] | None = None,
                 scored: set[str] | None = None) -> tuple[list[str], int]:
    """Compare every resolvable (arm, metric) cell against the generated data."""
    problems: list[str] = []
    checked = 0
    arms = set(summary)

    runs_by_arm: dict[str, list[dict]] = {}
    for r in per_run or []:
        if r.get("scored") == "1":
            runs_by_arm.setdefault(r["arm"], []).append(r)

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
        col_groups = {i: g for i, c in enumerate(head)
                      if i > 0 and (g := ARM_GROUPS.get(norm_label(c)))}

        def report_unresolved(label: str, cells: list[str], axis: str) -> None:
            """An arm label that resolves to nothing, beside figures.

            Rows were made loud first, then number formats; the arm axis had the
            same hole, and this one also defeats the coverage count — omitting a
            whole column leaves the resolved total unchanged, so `RESULTS_FOR`
            still matches exactly while arbitrary numbers sit unverified.
            """
            lab = norm_label(label)
            if not lab or lab in NON_ARM_LABELS or lab in METRIC_FIELDS:
                return
            if not any(looks_numeric(c) for c in cells):
                return
            msg = (f"{doc}: table {axis} {label!r} carries figures but names no "
                   "arm. Add it to ARM_LABELS or ARM_GROUPS if it is one, or to "
                   "NON_ARM_LABELS with the reason it is not.")
            if msg not in problems:
                problems.append(msg)

        if col_arms or col_groups:
            for i, c in enumerate(head):
                if i and i not in col_arms and i not in col_groups:
                    report_unresolved(c, [r[i] for r in tbl[1:] if i < len(r)],
                                      "column")
        elif row_arms and not is_cost_table(head):
            # check_cost_table owns every line of a cost table, including the
            # ones that are not arms, so those rows are covered elsewhere
            # rather than unchecked.
            for r, row in enumerate(tbl[1:], 1):
                if row and r not in row_arms:
                    report_unresolved(row[0], row[1:], "row")

        def compare_group(label: str, group: tuple[str, ...], cell: str) -> None:
            """A range cell against the min and max across the group's arms."""
            nonlocal checked
            fields = METRIC_FIELDS.get(norm_label(label))
            if fields is None:
                return          # `compare` reports unrecognised labels
            if len(fields) != 1:
                # A compound row ("TTFA p50 / p95") under a group column states
                # two ranges, which this path cannot compare — and falling
                # through means the cell is neither compared nor reported, the
                # shape that hid six latency figures on the single-arm path.
                # No document does this today; the point is that one cannot
                # start to in silence.
                problems.append(
                    f"{doc}: grouped column states {label!r}, a compound metric "
                    f"({'/'.join(fields)}) this checker cannot compare as a "
                    "range. Split the row, or give the group its own check.")
                return
            got = parse_range(cell)
            if got is None:
                return
            missing = [a for a in group if a not in summary]
            if missing:
                for a in missing:
                    if (msg := missing_arm(doc, a, summary)) not in problems:
                        problems.append(msg)
                return
            vals = [parse_number(summary[a].get(fields[0], "")) for a in group]
            if any(v is None for v in vals):
                problems.append(f"{doc}: {label} for {group} — summary.csv holds "
                                "a non-numeric value")
                return
            checked += 2  # both ends of the range are claims
            want = (min(vals), max(vals))  # type: ignore[type-var]
            if abs(got[0] - want[0]) > 1e-9 or abs(got[1] - want[1]) > 1e-9:
                problems.append(
                    f"{doc}: {norm_label(label)} across {'/'.join(group)} — "
                    f"document says {got[0]:g}–{got[1]:g}, summary.csv gives "
                    f"{want[0]:g}–{want[1]:g}")

        def compare(label: str, arm: str, cells: list[str]) -> None:
            """One metric label against one arm's summary row."""
            nonlocal checked
            lab = norm_label(label)
            if lab == "(seed 2)":
                for cell in cells:
                    parsed = parse_cell(cell, 1)
                    if parsed is None:
                        continue
                    if arm not in summary:
                        if (msg := missing_arm(doc, arm, summary)) not in problems:
                            problems.append(msg)
                        continue
                    want = (seed2_grounded(seed2 or [], arm, scored or set())
                            if seed2 else None)
                    if want is None:
                        problems.append(
                            f"{doc}: states a seed-2 groundedness for {arm}, but "
                            "judge_seed2.csv has no scored rows for it")
                        continue
                    checked += 1
                    if abs(parsed[0][0] - round(want, 3)) > 0.0006:
                        problems.append(
                            f"{doc}: {arm}/seed-2 groundedness — document says "
                            f"{parsed[0][0]:g}, judge_seed2.csv gives {want:.3f}")
                return
            if (pred := PER_RUN_METRICS.get(lab)) is not None:
                for cell in cells:
                    parsed = parse_cell(cell, 1)
                    if parsed is None:
                        continue
                    got = parsed[0][0]
                    if arm not in summary:
                        if (msg := missing_arm(doc, arm, summary)) not in problems:
                            problems.append(msg)
                        continue
                    rs = runs_by_arm.get(arm)
                    # Denominated on expected runs, like every other rate here:
                    # the per-run file is the numerator's source, never the
                    # denominator's.
                    n = parse_number(summary[arm].get("runs_expected", ""))
                    if not rs or not n:
                        problems.append(
                            f"{doc}: states {lab} for {arm}, but "
                            "summary_per_run.csv has no scored rows for it")
                        continue
                    checked += 1
                    want = round(sum(1 for r in rs if pred(r)) / n, 3)
                    if abs(got - want) > 0.0006:
                        problems.append(
                            f"{doc}: {arm}/{lab} — document says {got:g}, "
                            f"recomputed from summary_per_run.csv {want:g}")
                return
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

        if col_arms or col_groups:  # metrics down the first column
            for row in tbl[1:]:
                if not row:
                    continue
                for i, arm in col_arms.items():
                    if i < len(row):
                        compare(row[0], arm, [row[i]])
                for i, group in col_groups.items():
                    if i < len(row):
                        compare_group(row[0], group, row[i])
        elif row_arms:  # metrics across the header
            for r, arm in row_arms.items():
                for i, c in enumerate(head):
                    if i and i < len(tbl[r]):
                        compare(c, arm, [tbl[r][i]])
    return problems, checked


CONDITION_LABELS = {
    "clean": "clean", "cafe 20 db": "cafe_snr20", "cafe 10 db": "cafe_snr10",
    "cafe 5 db": "cafe_snr5", "cafe 0 db": "cafe_snr0",
    "g.711 telephony": "tel", "telephony + cafe 10 db": "tel_cafe_snr10",
    "telephony + 3 % loss": "tel_loss3",
}
LANGS = ("en_us", "de_de")

# The arms each report's "Track A was run on N conditions" sentence covers.
# Declared here rather than derived from the ASR rows, so an arm that produced
# no rows at all is a failure instead of quietly leaving the expectation.
#
# `vl-native-brain-21` is deliberately absent: Voice Live rejects manual-commit
# transcription on a gpt-realtime brain ("turn_detection must be of type
# AzureSemanticVAD"), so that arm is Track B only and has no ASR rows by design.
# An arm that is intentionally unrun and one that is missing look identical in
# the data; only a declaration can tell them apart.
TRACK_A_ARMS = {
    "voice-engine-quality-2026-08-gpt-realtime-2-1.md": (
        "native-gpt-realtime-21", "native-gpt-realtime-21-mini"),
}
# "47.76 (8e)" -> WER 47.76 with 8 empty transcripts.
WER_CELL = re.compile(r"^(\d+(?:\.\d+)?)(?:\s*\((\d+)e\))?$")


def load_asr(results: Path, name: str) -> list[dict] | None:
    p = results / name
    if not p.exists():
        return None
    with p.open() as f:
        return list(csv.DictReader(f))


def check_wer_tables(md: str, doc: str, results: Path,
                     summary: dict) -> tuple[list[str], int]:
    """Track A WER, against asr_scores.csv.

    These carry the DNS recommendation — "never enable Azure noise suppression"
    rests on 4.83 -> 47.76 and the empty-transcript counts — so they are exactly
    the figures that must not be taken on trust. They were declared unchecked
    while the checker verified everything around them; a declared allowlist is a
    hiding place if things go into it for convenience rather than because they
    genuinely cannot be checked. asr_scores.csv existing is a second source to
    check against, not a reason to skip.

    The table has language section rows (`| **en_US** | | | |`) rather than a
    language column, so the current section is tracked while walking down.
    """
    rows = load_asr(results, "asr_scores.csv")
    problems: list[str] = []
    checked = 0
    arms = set(summary)

    for tbl in tables(md):
        head = tbl[0]
        if not head or norm_label(head[0]) != "condition":
            continue
        cols = {i: a for i, c in enumerate(head)
                if i and (a := resolve_arm(c, arms))}
        if len(cols) < 2:
            continue
        if rows is None:
            problems.append(f"{doc}: has a Track A WER table but {results}/"
                            "asr_scores.csv is missing, so it cannot be checked")
            continue
        idx = {(r["arm"], r["lang"], r["condition"]): r for r in rows}
        lang = None
        for row in tbl[1:]:
            if not row:
                continue
            lab = norm_label(row[0])
            if lab in LANGS and not any(c.strip() for c in row[1:]):
                lang = lab
                continue
            cond = CONDITION_LABELS.get(lab)
            if cond is None:
                continue
            if lang is None:
                problems.append(f"{doc}: WER row {row[0]!r} appears before any "
                                "language section header, so its language is "
                                "undetermined")
                continue
            for i, arm in cols.items():
                if i >= len(row) or not row[i].strip():
                    continue
                m = WER_CELL.match(norm_label(row[i]))
                if not m:
                    problems.append(f"{doc}: WER cell {row[i]!r} "
                                    f"({arm}/{lang}/{cond}) is not a figure this "
                                    "checker can compare")
                    continue
                src = idx.get((arm, lang, cond))
                if src is None:
                    problems.append(f"{doc}: states a WER for {arm}/{lang}/{cond}, "
                                    "which has no row in asr_scores.csv")
                    continue
                checked += 1
                want = parse_number(src["wer"])
                got = float(m.group(1))
                if want is None or abs(got - want) > 1e-9:
                    problems.append(f"{doc}: {arm}/{lang}/{cond} WER — document "
                                    f"says {got:g}, asr_scores.csv says "
                                    f"{src['wer']!r}")
                # The "(8e)" annotation is empty_hyp; absent means zero.
                checked += 1
                shown = int(m.group(2)) if m.group(2) else 0
                if str(shown) != (src["empty_hyp"] or "0"):
                    problems.append(f"{doc}: {arm}/{lang}/{cond} empty "
                                    f"transcripts — document shows {shown}, "
                                    f"asr_scores.csv says {src['empty_hyp']!r}")
    return problems, checked


def check_snr50_table(md: str, doc: str, results: Path,
                      summary: dict) -> tuple[list[str], int]:
    """SNR50 per (arm, language), against asr_scores_summary.csv."""
    rows = load_asr(results, "asr_scores_summary.csv")
    problems: list[str] = []
    checked = 0
    arms = set(summary)

    for tbl in tables(md):
        head = tbl[0]
        if not head or norm_label(head[0]) != "arm":
            continue
        cols = {i: norm_label(c) for i, c in enumerate(head)
                if i and norm_label(c) in LANGS}
        if not cols:
            continue
        if rows is None:
            problems.append(f"{doc}: has an SNR50 table but {results}/"
                            "asr_scores_summary.csv is missing")
            continue
        idx = {(r["arm"], r["lang"]): r for r in rows}
        for row in tbl[1:]:
            arm = resolve_arm(row[0], arms) if row else None
            if arm is None:
                continue
            for i, lang in cols.items():
                if i >= len(row) or not row[i].strip():
                    continue
                src = idx.get((arm, lang))
                if src is None:
                    problems.append(f"{doc}: states SNR50 for {arm}/{lang}, which "
                                    "has no row in asr_scores_summary.csv")
                    continue
                checked += 1
                # "<0 (degenerate)" and ">20" are stored literally; a plain
                # number is stored as a number.
                cell = norm_label(row[i]).replace("db", "").strip()
                want = (src["snr50_db"] or "").strip()
                got = parse_number(cell)
                ok = (abs(got - w) <= 1e-9
                      if got is not None and (w := parse_number(want)) is not None
                      else cell.split("(")[0].strip() == want)
                if not ok:
                    problems.append(f"{doc}: {arm}/{lang} SNR50 — document says "
                                    f"{row[i]!r}, asr_scores_summary.csv says "
                                    f"{want!r}")
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

    # Which arms the claim is about — declared, not observed. An earlier version
    # intersected the report's new arms with `set(present)`, so an arm with *no*
    # ASR rows at all dropped out of the expectation and the remaining one
    # satisfied the claim: an entirely absent arm passed. That is the
    # declared-expectation rule broken inside the fix for the `any()` finding —
    # "every expected arm" is only as strong as where `expected` comes from, and
    # it came from the data being checked.
    expected = sorted(TRACK_A_ARMS.get(doc, ()))
    if not expected:
        return problems + [
            f"{doc}: states a Track A matrix but TRACK_A_ARMS declares no arms "
            "for it, so nothing checked the claim. Add the arm list."]
    for arm in expected:
        if arm not in present:
            problems.append(
                f"{doc}: names a {m.group(1)}-condition Track A matrix covering "
                f"{arm}, which has no ASR rows at all under {results}")
        elif present[arm] != named:
            problems.append(
                f"{doc}: names conditions {sorted(named)} but {arm} has "
                f"{sorted(present[arm])} in the committed ASR rows")
    return problems


# "Actual spend **$22.82**" / "Spend **$8.85** (cap $12)" — the figure a reader
# quotes, which lives nowhere near the table that justifies it.
SPEND_HEADLINE = re.compile(r"spend \*\*\$(\d+(?:\.\d+)?)\*\*", re.I)


def check_cost_table(md: str, doc: str) -> list[str]:
    """The cost table's arithmetic **and** the headline that summarises it.

    Checking only the table's internal consistency missed the very defect this
    guard was written for: both reports' headline `Actual spend` had been an
    estimate written before the table was itemised and never reconciled against
    it ($23.19 vs $22.82; $9.03 vs $8.85). Reverting either headline left the
    table untouched and the run green.

    The general shape, worth watching for elsewhere: **a guard that validates an
    artifact's internal consistency while the claim people actually quote lives
    somewhere else in the document.** This was the only instance in this file —
    every other check compares a document claim against generated data — but it
    is the easiest kind to write by accident.
    """
    problems = []
    totals: list[float] = []

    # Each line's own arithmetic, not just the column sum. The header row names
    # the inputs, so `(Track A min + Track B min) x $/min` can be checked against
    # the stated `$`. Summing only the last column let 70.0 minutes become 700.0
    # with the $6.33 unchanged — the same "internal consistency of a subset" gap
    # that let the headline spend drift away from the table it summarises.
    for tbl in tables(md):
        head = [norm_label(c) for c in tbl[0]] if tbl else []
        if "$" not in head or "$/min" not in head:
            continue
        mins = [i for i, c in enumerate(head) if c.endswith("min") and c != "$/min"]
        rate_i, dollar_i = head.index("$/min"), head.index("$")
        for row in tbl[1:]:
            if len(row) <= dollar_i or "total" in norm_label(row[0]):
                continue
            cells = {"$/min": row[rate_i] if rate_i < len(row) else "",
                     "$": row[dollar_i],
                     **{norm_label(head[i]): row[i] for i in mins if i < len(row)}}
            rate = parse_number(row[rate_i]) if rate_i < len(row) else None
            paid = parse_number(row[dollar_i])
            parts = [v for i in mins if i < len(row)
                     and (v := parse_number(row[i])) is not None]
            # A line that states no inputs claims no arithmetic — but a line
            # that states an input this parser cannot read is a different
            # thing, and skipping it silently switched the check off: changing
            # a rate to `bogus` left the run green while the column total still
            # summed the unchanged dollar figure.
            #
            # "Absent" has to include the em-dash these tables write for a leg
            # a line did not use ("| vl-native-brain | — | 16.5 |"). A
            # placeholder is a stated absence; anything else non-blank is a
            # figure that failed to parse.
            if unreadable := sorted(k for k, c in cells.items()
                                    if not is_absent(c) and parse_number(c) is None):
                problems.append(
                    f"{doc}: cost line {norm_label(row[0])!r} states "
                    f"{unreadable} in a form this checker cannot read, so its "
                    "arithmetic was not verified")
                continue
            if rate is None or paid is None or not parts:
                continue
            want = round(sum(parts) * rate, 2)
            # Line items are rounded to the cent, and "~" marks an estimate.
            tol = 0.02 if "~" in "".join(row) else 0.011
            if abs(want - paid) > tol:
                problems.append(
                    f"{doc}: cost line {norm_label(row[0])!r} — "
                    f"{' + '.join(f'{p:g}' for p in parts)} min x {rate:g} = "
                    f"{want:.2f}, but the line states {paid:.2f}")
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
            totals.append(total)
            s = round(sum(items), 2)
            if abs(s - total) > 0.011:
                problems.append(f"{doc}: cost table line items sum to {s:.2f}, "
                                f"stated total {total:.2f}")

    # The headline against the table it summarises.
    heads = [float(m.group(1)) for m in SPEND_HEADLINE.finditer(md)]
    if totals and not heads:
        problems.append(
            f"{doc}: has a cost table totalling {totals[0]:.2f} but states no "
            "headline spend, so the figure a reader quotes is unchecked")
    elif heads and not totals:
        problems.append(
            f"{doc}: states a headline spend of ${heads[0]:.2f} with no cost "
            "table to check it against")
    else:
        for head in heads:
            if not any(abs(head - t) <= 0.011 for t in totals):
                problems.append(
                    f"{doc}: headline spend ${head:.2f} does not match the cost "
                    f"table total ({', '.join(f'{t:.2f}' for t in totals)})")
    return problems


# A result-shaped figure written outside any table: `2560 ms`, `24 %`, `0.963`,
# `9.6 dB`, `$8.85`. Three decimals for a bare rate, so model versions ("2.1")
# and counts are not mistaken for one.
PROSE_FIG = re.compile(
    r"(?<![\w.])(\d+(?:\.\d+)?)\s*(ms|%|dB)(?![\w])"
    r"|\$(\d+\.\d{2})(?![\w])"
    r"|(?<![\w.])(\d\.\d{3})(?![\w])")

# Prose figures that cannot be reconstructed from this repository's generated
# data, each with the reason. A named exemption is fine; an invisible one is
# not — which is the whole point of the check below, so the list is exact and a
# stale entry is an error.
PROSE_EXEMPT = {
    "voice-engine-quality-2026-08-gpt-realtime-2-1.md": {
        "76.3 %": "quoted as a SUPERSEDED figure — the sentence is about an "
                  "earlier draft that read the pre-extension judge file, so it "
                  "must NOT match the current data",
        "$3.06": "the cost of this study's own extension, stated in prose; the "
                 "per-line costs are checked by check_cost_table",
    },
    "voice-engine-quality-2026-08.md": {
        "69 ms": "quoted as a SUPERSEDED figure — the sentence describes what "
                 "an earlier draft claimed, so it must NOT match the data",
        "98.8 %": "judge presentation-order agreement, verified against "
                  "judge.csv by check_judge_agreement rather than summary.csv",
        "99.4 %": "judge presentation-order agreement, verified against "
                  "judge.csv by check_judge_agreement rather than summary.csv",
        "$23.19": "cumulative spend across both studies, including the latency "
                  "benchmark whose results are not in this repository",
        "$22.82": "this report's own total, checked by check_cost_table",
        "1654 ms": "bench/realtime latency benchmark (task #13), not Track B",
        "3812 ms": "bench/realtime latency benchmark (task #13), not Track B",
        "1748 ms": "bench/realtime latency benchmark (task #13), not Track B",
        "3048 ms": "bench/realtime latency benchmark (task #13), not Track B",
        "4.01 %": "a DNS-probe WER, checked by check_dns_tables against "
                  "dns_probe_en.jsonl rather than against summary.csv",
        "1.4 dB": "an SNR50 delta between two arms, both of whose SNR50 values "
                  "check_snr50_table verifies",
    },
}


def check_prose_figures(md: str, doc: str, results: Path,
                        summary: dict[str, dict[str, str]]) -> list[str]:
    """Result figures written outside a table, against the generated data.

    The tables are checked to three decimals; every figure repeated in prose was
    not checked at all. Changing `p95 falls 3325 -> 2560 ms` to `-> 9999 ms`
    left every table untouched and the run green at full declared coverage —
    and that sentence is the headline of the report's recommendation. We
    hardened the tables and the claims walked into the prose. A checker's
    coverage is a claim like any other: "297 cells checked" reads as
    thoroughness while the sentence a reader acts on is exempt.

    What binds: a figure must be *reconstructible* from the generated data —
    equal to a value the data takes, to the absolute difference of two such
    values (the reports quote deltas constantly), or to one as a percentage of
    another. Anything else must be named in `PROSE_EXEMPT` with its reason.

    **What this does not do, stated rather than implied:** it is a membership
    test, not an identity one. It proves a figure is *some* value the study
    produced; it cannot prove it is the value for the arm the sentence names,
    because free prose gives nothing reliable to resolve an arm against — the
    same limitation `check_run_counts` documents for counts. It catches an
    invented number, a stale number, and a number that moved when the data was
    re-run. It would not catch a figure swapped between two arms. That gap is
    real and is why the table checks, which do resolve an arm, remain the
    primary defence.
    """
    problems: list[str] = []
    rate_fields = ("success_mean", "pass_k", "tool_ok", "grounded_ok",
                   "slot_heard", "slot_echoed", "judge_grounded",
                   "judge_resolution", "judge_tone")
    ms_fields = ("ttfa_p50_ms", "ttfa_p95_ms", "bargein_stop_p50_ms")
    rates = {round(v, 3) for r in summary.values() for f in rate_fields
             if (v := parse_number(r.get(f, ""))) is not None}
    mss = {v for r in summary.values() for f in ms_fields
           if (v := parse_number(r.get(f, ""))) is not None}
    wers: set[float] = set()
    for name in ("asr_scores.csv", "asr_scores_summary.csv"):
        p = results / name
        if p.exists():
            with p.open() as f:
                for r in csv.DictReader(f):
                    for k, c in r.items():
                        if ("wer" in k or "snr50" in k) and \
                                (v := parse_number(c)) is not None:
                            wers.add(round(v, 2))
    # Dollar figures live in the cost tables, whose arithmetic is checked
    # separately; prose may restate any of them.
    money = {round(v, 2) for line in md.splitlines()
             if line.lstrip().startswith("|")
             for c in re.findall(r"\d+\.\d{2}", line)
             if (v := parse_number(c)) is not None}

    def near(x: float, pool, tol: float) -> bool:
        return any(abs(x - p) <= tol for p in pool)

    def derived(x: float, pool, tol: float) -> bool:
        """A difference between two figures, or one as a percent of another."""
        vals = sorted(pool)
        return (any(abs(x - abs(a - b)) <= tol for a in vals for b in vals)
                or any(a and abs(x - 100 * abs(a - b) / max(a, b)) <= tol
                       for a in vals for b in vals))

    exempt = PROSE_EXEMPT.get(doc, {})
    used: set[str] = set()
    prose = "\n".join(l for l in re.sub(r"```.*?```", "", md, flags=re.S).splitlines()
                      if not l.lstrip().startswith("|"))
    for m in PROSE_FIG.finditer(prose):
        literal = " ".join(m.group(0).split())
        if m.group(2):
            value, unit = float(m.group(1)), m.group(2)
        elif m.group(3):
            value, unit = float(m.group(3)), "$"
        else:
            value, unit = float(m.group(4)), "rate"
        if literal in exempt:
            used.add(literal)
            continue
        # "~210 ms" is a stated approximation; the reports round these to the
        # nearest ten, so the tolerance has to admit that and nothing looser.
        approx = "~" in prose[max(0, m.start() - 2):m.start() + 1]
        if unit == "ms":
            # The reports round a stated delta to the nearest ten ("770 ms" for
            # 2087 - 1315 = 772), and mark a looser estimate with "~".
            ok = near(value, mss, 0.5) or derived(value, mss, 5.5 if approx else 2.5)
        elif unit == "rate":
            ok = near(value, rates, 0.0005) or derived(value, rates, 0.0015)
        elif unit == "%":
            ok = (near(value / 100, rates, 0.0005) or near(value, wers, 0.011)
                  or derived(value, mss, 0.55) or derived(value, rates, 0.55)
                  or near(value, {100 * r for r in rates}, 0.55))
        elif unit == "dB":
            ok = near(value, wers, 0.011) or value in (0, 5, 10, 20)
        else:
            ok = near(value, money, 0.011)
        if not ok:
            line = prose[:m.start()].count("\n") + 1
            problems.append(
                f"{doc}: prose figure {literal!r} (prose line {line}) cannot be "
                f"reconstructed from {results}. If it is a real result, it "
                f"moved or was mistyped; if it is not, add it to PROSE_EXEMPT "
                f"with the reason.")
    if stale := sorted(set(exempt) - used):
        problems.append(
            f"{doc}: PROSE_EXEMPT lists {', '.join(stale)}, which no longer "
            "appear in the document. Remove them — an allowlist nobody prunes "
            "is a place for figures to hide.")
    return problems


def check_cost_inputs(md: str, doc: str, results: Path) -> list[str]:
    """The minutes a cost line multiplies, against the run that produced them.

    `check_cost_table` verifies the arithmetic — minutes x rate = dollars, line
    items sum to the total, total equals the headline. Every one of those inputs
    comes out of the same Markdown row, so the whole check is internally
    consistent and externally unmoored: a *coherent* edit passes. Take Track A
    from 52.5 to 62.5, the line from 4.62 to 5.32, and the total and headline
    from 8.85 to 9.55, and the arithmetic still closes while `asr_scores.csv`
    says 52.5. An arithmetic check over numbers that all came from the document
    verifies only that the author can add up.

    So the Track A minutes are bound to the generated data: `audio_min` in
    `asr_scores.csv` is exactly the audio this arm streamed and was billed for.
    That is the column the demonstration moved, and it now moves nothing.

    **Track B minutes are deliberately NOT bound, and the reason is the point.**
    The obvious candidate, `session_min` in `summary.csv`, is computed over the
    *scored* runs only — `summarize.py` drops the two unscored barge-in
    scenarios from every aggregate — so it is 15.8 where the merged report bills
    20.4, and binding to it would have been a confident comparison against the
    wrong quantity. The billed figure includes unscored scenarios, retries and
    discarded runs, and is not reproducible from either snapshot: the
    `main-report/` tree holds no `scenarios.jsonl`. An exemption named here is
    worth more than a check against a number that means something else.
    """
    problems: list[str] = []
    audio: dict[str, float] = {}
    p = results / "asr_scores.csv"
    if p.exists():
        with p.open() as f:
            for r in csv.DictReader(f):
                if (v := parse_number(r.get("audio_min", ""))) is not None:
                    audio[r["arm"]] = audio.get(r["arm"], 0.0) + v
    if not audio:
        return problems

    for tbl in tables(md):
        head = [norm_label(c) for c in tbl[0]] if tbl else []
        col = next((i for i, lab in enumerate(head) if lab == "track a min"), None)
        if col is None:
            continue
        for row in tbl[1:]:
            arm = resolve_arm(row[0], set(audio))
            if arm is None or col >= len(row) or is_absent(row[col]):
                continue          # judge passes and the lost run name no arm
            stated = parse_number(row[col])
            if stated is None or "~" in row[col]:
                # Unreadable cells are check_cost_table's job; a stated estimate
                # approximates runs that were never scored.
                continue
            got = audio[arm]
            if abs(stated - got) > 0.051:
                problems.append(
                    f"{doc}: cost line {norm_label(row[0])!r} bills Track A "
                    f"{stated:g} min, but {arm} streamed {got:g} audio-min in "
                    f"{results}/asr_scores.csv")
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
        per_run_path = results / "summary_per_run.csv"
        per_run: list[dict] = []
        if per_run_path.exists():
            with per_run_path.open() as f:
                per_run = list(csv.DictReader(f))
        seed2_path = results / "judge_seed2.csv"
        seed2: list[dict] = []
        if seed2_path.exists():
            with seed2_path.open() as f:
                seed2 = list(csv.DictReader(f))
        fixture = HERE / "fixtures" / "scenarios.json"
        scored = {sc["id"] for sc in json.loads(fixture.read_text())["scenarios"]
                  if sc.get("scored", True)} if fixture.exists() else set()
        p, n = check_tables(md, doc, summary, per_run, seed2, scored)
        problems += p
        for fn in (check_wer_tables, check_snr50_table,
                   check_recogniser_table, check_delta_tables,
                   check_family_table, check_dns_tables_wrapper):
            p2, n2 = fn(md, doc, results, summary)
            problems += p2
            n += n2
        per_doc[doc] = n
        # Per report, not in aggregate: a document whose tables stopped resolving
        # must fail on its own account, not be carried by the other one.
        #
        # Exact, not a floor. A floor certifies "at least this much was checked";
        # equality certifies "exactly what we declared was checked, and nothing
        # moved". The surplus direction is the more interesting of the two — it
        # means the document grew figures and nobody updated the declaration —
        # and a floor cannot see it. This ran as `<` here while the test asserted
        # equality, so the invariant held on one path and was documented as
        # holding generally: the same half-implemented-invariant shape as the
        # header comment above.
        if n != want_cells:
            direction = ("only %d" % n) if n < want_cells else ("%d" % n)
            why = ("Its numeric tables are no longer being checked — this is not "
                   "evidence the report is correct. If a table was removed on "
                   "purpose, lower the count"
                   if n < want_cells else
                   "The document has grown figures the declaration does not "
                   "account for. Confirm the new cells check what you think, "
                   "then raise the count")
            problems.append(
                f"{doc}: {direction} table cells resolved, expected exactly "
                f"{want_cells}. {why} for this report in RESULTS_FOR.")
        problems += check_judge_agreement(md, doc, results)
        problems += check_cost_table(md, doc)
        problems += check_cost_inputs(md, doc, results)
        problems += check_prose_figures(md, doc, results, summary)
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


# --- Sources beyond summary.csv -------------------------------------------
# Everything below exists because the mutation sweep in test_scoring.py found
# these figures could be changed with nothing noticing. Each is derived from a
# committed artifact, so each is checkable; "it lives in a different file" has
# twice been the wrong reason to skip.

# The (recogniser, VAD, brain) -> slots-heard table. Its rows are keyed by
# configuration rather than arm name, so the arms are declared.
#
# Every row maps to a **tuple** of arms, because one of them stands for two: the
# `gpt-realtime-2 / 2.1` row states a single figure for both Foundry arms, and
# that grouping *is* the claim the table exists to make — "slot capture is a
# function of (recogniser, VAD) and not of the brain". Checking it against
# `native-gpt-realtime-2` alone meant the row could not fail when the two arms
# diverged: move 2.1's slot capture and the stale shared figure still passes on
# the incumbent, which is the assertion inverted. A row asserting two arms are
# identical must break when they stop being identical.
RECOGNISER_ROWS = {
    ("azure-speech", "server_vad", "gpt-4.1-mini"): ("vl-gpt41mini",),
    ("azure-speech", "semantic", "gpt-4.1-mini"): ("vl-gpt41mini-semvad",),
    ("azure-speech", "semantic", "gpt-realtime-2"): ("vl-native-brain",),
    ("azure-speech", "semantic", "gpt-realtime-2.1"): ("vl-native-brain-21",),
    ("whisper-1", "server_vad", "gpt-realtime-2 / 2.1"): (
        "native-gpt-realtime-2", "native-gpt-realtime-21"),
}

# probe_dns.py legs, by the display name the reports use.
DNS_LEGS = {
    "no noise reduction": "off", "near_field": "near_field",
    "far_field": "far_field", "azure_deep_noise_suppression": "deep",
    "azure_deep_noise_suppression @ 16 khz": "deep@16k",
}
DNS_GERMAN_ROWS = {"clean": "dns_probe_de_clean.jsonl",
                   "cafe 10 db": "dns_probe_de_cafe_snr10.jsonl",
                   "cafe 5 db": "dns_probe_de_cafe_snr5.jsonl"}
# Clips per noise-suppression leg, DECLARED here rather than counted from the
# probe files, because "how many clips is this measured over" is a published
# figure — both reports write `n=50` beside these tables — and counting it from
# the file it describes is the defect this harness is named after.
# `test_the_reports_declare_the_dns_clip_count` holds this against that prose.
DNS_CLIPS = 50


# Before/after tables, keyed by the transition their header names. The header
# describes a *pair* of arms rather than naming either, so neither axis resolved
# and `check_tables` skipped the whole table — six rows in the merged report,
# including the strict-success figure the VAD-control argument rests on, which
# could be set to 0.999 with the run staying green and its coverage unchanged.
# The arm order is (before, after), matching the arrow.
DELTA_TABLES = {
    "server → semantic vad, gpt-4.1-mini on voice live":
        ("vl-gpt41mini", "vl-gpt41mini-semvad"),
    "gpt-4.1-mini → gpt-realtime-2, voice live, semantic vad":
        ("vl-gpt41mini-semvad", "vl-native-brain"),
}


def numerator(half: str) -> float:
    """The count a fraction cell states, so `18/27 → 19/27 (+1)` checks out."""
    m = re.fullmatch(r"(\d+)\s*/\s*(\d+)", norm_label(half))
    return float(m.group(1)) if m else (parse_number(half) or 0.0)


def delta_tokens(cell: str, n: int) -> list[float | None] | None:
    """The change(s) stated in the parenthetical, or None if there is none.

    `(**−0.074**)`, `(+1)`, `(no change)` and the compound `(**+5 / +133**)`.
    The minus is U+2212 in these documents, not a hyphen.
    """
    if "(" not in cell or ")" not in cell:
        return None
    inner = cell[cell.find("(") + 1:cell.rfind(")")].replace("**", "")
    inner = inner.replace("−", "-").replace("–", "-").replace("—", "-")
    parts = [p.strip() for p in inner.split("/")]
    if len(parts) != n:
        return None
    out: list[float | None] = []
    for p in parts:
        if "no change" in p.lower():
            out.append(0.0)
            continue
        p = p[1:].strip() if p.startswith("+") else p
        out.append(float(p) if re.fullmatch(r"-?\d+(\.\d+)?", p) else None)
    return out


def check_delta_tables(md: str, doc: str, results: Path,
                       summary: dict) -> tuple[list[str], int]:
    """`0.333 → 0.259 (−0.074)` against both arms of the declared pair.

    Both endpoints are checked, not the difference: the delta is arithmetic on
    two claims, so verifying it would only prove the subtraction. And an
    unmapped delta table is reported rather than skipped — being unable to name
    the arms is exactly the state in which a table goes unchecked.
    """
    problems: list[str] = []
    checked = 0
    for tbl in tables(md):
        head = [norm_label(c) for c in tbl[0]] if tbl else []
        if len(head) < 2 or "→" not in head[0] or head[1] != "change":
            continue
        pair = DELTA_TABLES.get(head[0])
        if pair is None:
            problems.append(f"{doc}: delta table {tbl[0][0]!r} names no arm "
                            "pair; add it to DELTA_TABLES")
            continue
        if absent := [a for a in pair if a not in summary]:
            for a in absent:
                if (msg := missing_arm(doc, a, summary)) not in problems:
                    problems.append(msg)
            continue
        for row in tbl[1:]:
            if len(row) < 2:
                continue
            lab = norm_label(row[0])
            fields = METRIC_FIELDS.get(lab)
            if fields is None:
                if "→" in row[1] or looks_numeric(row[1]):
                    problems.append(
                        f"{doc}: delta table row {row[0]!r} states figures but "
                        "resolves to no summary.csv field. Add it to "
                        "METRIC_FIELDS.")
                continue
            body = row[1].split("(")[0]
            segs = body.split("/") if len(fields) == 2 else [body]
            stated = delta_tokens(row[1], len(fields))
            endpoints: list[tuple[float, float] | None] = []
            if len(segs) != len(fields):
                problems.append(f"{doc}: delta cell {row[1]!r} does not state "
                                f"{len(fields)} value pair(s) for {lab!r}")
                continue
            for field, seg in zip(fields, segs):
                halves = seg.split("→")
                if len(halves) != 2:
                    problems.append(f"{doc}: delta cell {seg.strip()!r} "
                                    f"({lab}) is not an 'a → b' pair")
                    endpoints.append(None)
                    continue
                shown: list[float] = []
                for arm, half in zip(pair, halves):
                    parsed = parse_cell(half.strip(), 1)
                    if parsed is None:
                        problems.append(
                            f"{doc}: delta cell {half.strip()!r} ({arm}/{field}) "
                            "is not a figure this checker can read")
                        continue
                    got, exact = parsed
                    want = parse_number(summary[arm].get(field, ""))
                    checked += 1
                    if want is None:
                        problems.append(
                            f"{doc}: {arm}/{field} — summary.csv holds "
                            f"{summary[arm].get(field)!r}, not a number")
                    elif abs(got[0] - want) > (1e-9 if exact else 0.0006):
                        problems.append(
                            f"{doc}: delta table {lab} for {arm} — document "
                            f"says {got[0]:g}, summary.csv says {want:g}")
                    # The stated change is arithmetic on the endpoints as the
                    # document writes them, so it is checked against those —
                    # a fraction row states its change in numerator counts
                    # (`18/27 → 19/27 (+1)`), not in the rate.
                    shown.append(numerator(half) if not exact else got[0])
                endpoints.append((shown[0], shown[1]) if len(shown) == 2 else None)

            # The parenthetical is a published figure too. Dropping it meant
            # `−0.074` could become `−9.999` with the endpoints still right and
            # the run still green — the checker verifying the inputs of a
            # subtraction and not its result.
            if stated is not None and len(stated) == len(endpoints):
                for tok, ends in zip(stated, endpoints):
                    if tok is None or ends is None:
                        continue
                    checked += 1
                    if abs(tok - (ends[1] - ends[0])) > 0.0011:
                        problems.append(
                            f"{doc}: delta table {lab} states a change of "
                            f"{tok:g}, but {ends[0]:g} → {ends[1]:g} is "
                            f"{ends[1] - ends[0]:g}")
    return problems, checked


# The addendum's family table: rows are *families* of arms, cells are ranges
# across the family, and both judge seeds are stated side by side. The
# single-arm row resolves through ARM_LABELS and is checked by check_tables;
# the two multi-arm rows resolved to nothing, and a range is not `looks_numeric`
# either, so they were neither compared nor reported — the seed-comparison
# evidence for "the families separate cleanly" could be set to any two ranges.
FAMILY_ROWS = {
    "gpt-realtime brains": ("native-gpt-realtime-2", "native-gpt-realtime-21",
                            "vl-native-brain", "vl-native-brain-21"),
    "gpt-4.1-mini": ("vl-gpt41mini", "vl-gpt41mini-dns", "vl-gpt41mini-semvad"),
}

# Arms the second judge pass does not cover, declared with the reason. The
# seed-2 column's range is therefore over seven arms where seed 1 has eight,
# and that is a property of the study, not of the data: an arm intentionally
# unjudged and an arm whose rows went missing look identical in judge_seed2.csv,
# and only a declaration tells them apart. Any *other* absence is reported.
SEED2_ABSENT = {
    "vl-native-brain-21": "the seed-2 pass predates this arm; it covers the "
                          "seven arms judge_seed2.csv holds, not all eight",
}


def check_family_table(md: str, doc: str, results: Path,
                       summary: dict) -> tuple[list[str], int]:
    """Groundedness ranges per arm family, for both judge seeds."""
    problems: list[str] = []
    checked = 0
    arms = set(summary)
    seed2_path = results / "judge_seed2.csv"
    seed2: list[dict] = []
    if seed2_path.exists():
        with seed2_path.open() as f:
            seed2 = list(csv.DictReader(f))
    fixture = HERE / "fixtures" / "scenarios.json"
    scored = {sc["id"] for sc in json.loads(fixture.read_text())["scenarios"]
              if sc.get("scored", True)} if fixture.exists() else set()

    for tbl in tables(md):
        head = [norm_label(c) for c in tbl[0]] if tbl else []
        if head[:2] != ["family", "arms"]:
            continue
        # Which column states which seed, from the header rather than position.
        cols = {i: ("seed2" if "seed 2" in c else "seed1")
                for i, c in enumerate(head) if i > 1}
        for row in tbl[1:]:
            if len(row) < 3 or resolve_arm(row[0], arms):
                continue          # a single-arm row; check_tables owns it
            family = FAMILY_ROWS.get(norm_label(row[0]))
            if family is None:
                problems.append(f"{doc}: family row {row[0]!r} names no arm "
                                "set; add it to FAMILY_ROWS")
                continue
            if absent := [a for a in family if a not in summary]:
                for a in absent:
                    if (msg := missing_arm(doc, a, summary)) not in problems:
                        problems.append(msg)
                continue
            for i, seed in cols.items():
                if i >= len(row):
                    continue
                got = parse_range(row[i])
                if got is None:
                    problems.append(f"{doc}: family {norm_label(row[0])!r} "
                                    f"{seed} cell {row[i]!r} is not a range "
                                    "this checker can read")
                    continue
                if seed == "seed1":
                    covers = family
                    vals = [parse_number(summary[a].get("judge_grounded", ""))
                            for a in covers]
                else:
                    covers = tuple(a for a in family if a not in SEED2_ABSENT)
                    vals = [None if (v := seed2_grounded(seed2, a, scored)) is None
                            else round(v, 3) for a in covers]
                if not covers or any(v is None for v in vals):
                    missing = [a for a, v in zip(covers, vals) if v is None]
                    problems.append(
                        f"{doc}: family {norm_label(row[0])!r} {seed} — no "
                        f"groundedness for {missing or list(family)}. An arm "
                        "that is intentionally unjudged belongs in "
                        "SEED2_ABSENT with the reason; otherwise its rows are "
                        "missing.")
                    continue
                checked += 2      # both ends of the range are claims
                want = (min(vals), max(vals))   # type: ignore[type-var]
                if abs(got[0] - want[0]) > 0.0006 or abs(got[1] - want[1]) > 0.0006:
                    problems.append(
                        f"{doc}: family {norm_label(row[0])!r} {seed} "
                        f"groundedness — document says {got[0]:g}–{got[1]:g}, "
                        f"the data gives {want[0]:g}–{want[1]:g}")
    return problems, checked


def check_dns_tables_wrapper(md: str, doc: str, results: Path,
                             summary: dict) -> tuple[list[str], int]:
    return check_dns_tables(md, doc, results)


def check_recogniser_table(md: str, doc: str, results: Path,
                           summary: dict) -> tuple[list[str], int]:
    """Slots heard by (recogniser, VAD, brain) — the addendum's structural claim.

    "Slot capture is a function of (recogniser, VAD) and nothing else" rests
    entirely on these five numbers, and none of them was compared: the rows are
    keyed by configuration, so no cell resolved to an arm.

    A row covering several arms is compared against **every** one of them. The
    `gpt-realtime-2 / 2.1` row claims one figure for two arms; validating it
    against the first alone made the row's own claim — that they agree —
    unfalsifiable, and each arm it covers is a separate claim for the coverage
    count.
    """
    problems: list[str] = []
    checked = 0
    for tbl in tables(md):
        head = [norm_label(c) for c in tbl[0]] if tbl else []
        if head[:3] != ["recogniser", "vad", "brain"]:
            continue
        for row in tbl[1:]:
            if len(row) < 4:
                continue
            key = tuple(norm_label(c) for c in row[:3])
            group = RECOGNISER_ROWS.get(key)
            got = parse_number(row[3])
            if got is None:
                continue
            if group is None:
                problems.append(f"{doc}: recogniser table row {key} names no "
                                "arm; add it to RECOGNISER_ROWS")
                continue
            for arm in group:
                if arm not in summary:
                    problems.append(missing_arm(doc, arm, summary))
                    continue
                checked += 1
                want = parse_number(summary[arm].get("slot_heard", ""))
                if want is None or abs(got - want) > 1e-9:
                    problems.append(
                        f"{doc}: {key} -> {arm} slots heard — document says "
                        f"{got:g}, summary.csv says "
                        f"{summary[arm].get('slot_heard')!r}")
    return problems, checked


def check_dns_tables(md: str, doc: str, results: Path) -> tuple[list[str], int]:
    """The noise-suppression probe tables, recomputed from dns_probe_*.jsonl.

    These carry the "never enable Azure noise suppression" recommendation just
    as Track A does — 4.01 -> 38.34 and the 24 % empty rate — and they were the
    last unchecked figures in either report.
    """
    import importlib.util
    problems: list[str] = []
    checked = 0
    has_en = any(norm_label(t[0][0]) == "leg" for t in tables(md) if t and t[0])
    has_de = any(norm_label(t[0][0]) == "condition"
                 and "no nr" in [norm_label(c) for c in t[0]]
                 for t in tables(md) if t and t[0])
    if not (has_en or has_de):
        return problems, checked
    if importlib.util.find_spec("jiwer") is None:      # pragma: no cover
        return [f"{doc}: has noise-suppression tables but jiwer is not "
                "installed, so they cannot be recomputed"], 0
    sys.path.insert(0, str(HERE))
    sys.path.insert(0, str(HERE / "prepare"))
    from score_asr import wer_cer

    def legs(path: Path) -> dict[str, list[dict]]:
        """Load a probe file, refusing one whose shape makes it unscoreable.

        The verifier used to accept whatever rows it found. That leaves `n` as
        the one figure nothing checks, and n is a figure like any other: the
        documents state `n=50` beside these tables. Duplicating every row in
        `dns_probe_en.jsonl` doubles n to 100 while leaving every WER and every
        percentage identical — ratios are invariant under duplication — so the
        checker certified that all figures agreed with a file describing twice
        the study. The declared-matrix lesson on a different input: a verifier
        that trusts the shape of the data it is checking is checking the data
        against itself.

        Four properties, all of them about identity rather than count:
        error-free rows only, one row per clip id, the same clip ids in every
        leg (the legs are compared *to each other*, so a differing id set means
        they are not the same experiment), and that id count equal to the
        declared `DNS_CLIPS`.
        """
        out: dict[str, list[dict]] = {}
        if not path.exists():
            return out
        for line in path.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                out.setdefault(r["leg"], []).append(r)

        for leg, rows in sorted(out.items()):
            ids = [r["id"] for r in rows]
            # `probe_dns.py` records an error when a clip produced no
            # transcription event at all. Such a row is empty because the
            # session failed, not because the engine dropped the utterance —
            # and this table's whole subject is how often it drops utterances.
            if bad := [r["id"] for r in rows if r.get("error")]:
                problems.append(
                    f"{doc}: {path.name} leg {leg!r} has {len(bad)} errored "
                    f"row(s) ({', '.join(bad[:3])}); those are outages, not "
                    "measurements, and must not enter an empty-transcript rate")
            if dupes := sorted({i for i in ids if ids.count(i) > 1}):
                problems.append(
                    f"{doc}: {path.name} leg {leg!r} repeats clip "
                    f"{', '.join(dupes[:3])}; duplicates leave every rate "
                    f"unchanged while inflating n to {len(ids)}")
            if len(set(ids)) != DNS_CLIPS:
                problems.append(
                    f"{doc}: {path.name} leg {leg!r} covers {len(set(ids))} "
                    f"distinct clip(s), not the declared {DNS_CLIPS}")
        sets = {leg: frozenset(r["id"] for r in rows) for leg, rows in out.items()}
        if len({s for s in sets.values() if s}) > 1:
            ref = max(sets.values(), key=len)
            for leg, s in sorted(sets.items()):
                if s and s != ref:
                    problems.append(
                        f"{doc}: {path.name} leg {leg!r} is scored on different "
                        f"clips from the other legs (missing "
                        f"{sorted(ref - s)[:3]}, extra {sorted(s - ref)[:3]}), "
                        "so the legs are not comparable")
        return out

    for tbl in tables(md):
        head = [norm_label(c) for c in tbl[0]] if tbl else []
        if head[:1] == ["leg"]:
            src = legs(results / "dns_probe_en.jsonl")
            if not src:
                problems.append(f"{doc}: has an English DNS table but "
                                f"{results}/dns_probe_en.jsonl is missing")
                continue
            for row in tbl[1:]:
                leg = DNS_LEGS.get(norm_label(row[0]))
                if leg is None or leg not in src or len(row) < 4:
                    if leg is None and any(looks_numeric(c) for c in row[1:]):
                        problems.append(f"{doc}: DNS leg {row[0]!r} is not in "
                                        "DNS_LEGS")
                    continue
                rs = src[leg]
                ne = [r for r in rs if r["hypothesis"].strip()]
                want = [round(100 * (len(rs) - len(ne)) / len(rs)),
                        round(wer_cer(rs, "en_us")[0], 2),
                        round(wer_cer(ne, "en_us")[0], 2) if ne else None]
                for k, w in enumerate(want, start=1):
                    got = parse_number(row[k])
                    if got is None or w is None:
                        continue
                    checked += 1
                    # Same NaN trap as the German path: a leg whose references
                    # are all empty recomputes to NaN, and every comparison
                    # against NaN is False.
                    if not math.isfinite(w):
                        problems.append(
                            f"{doc}: DNS {leg} column {norm_label(tbl[0][k])!r} "
                            f"recomputed to {w}, so the document's {got:g} was "
                            "not verified")
                    elif abs(got - w) > 0.011:
                        problems.append(
                            f"{doc}: DNS {leg} column {norm_label(tbl[0][k])!r} "
                            f"— document says {got:g}, recomputed {w:g}")
        elif head[:1] == ["condition"] and "no nr" in head:
            for row in tbl[1:]:
                fname = DNS_GERMAN_ROWS.get(norm_label(row[0]))
                if fname is None:
                    # Was a bare `continue`, so a new condition row carried
                    # arbitrary figures past the checker — and because nothing
                    # incremented `checked`, the exact coverage count agreed
                    # that the document was fully compared. The English path
                    # already reports this; both do now.
                    if any(looks_numeric(c) for c in row[1:]):
                        problems.append(f"{doc}: German DNS condition {row[0]!r} "
                                        "is not in DNS_GERMAN_ROWS, so its "
                                        "figures were not compared")
                    continue
                if len(row) < 4:
                    continue
                src = legs(results / fname)
                if not src:
                    problems.append(f"{doc}: has a German DNS row for "
                                    f"{row[0]!r} but {fname} is missing")
                    continue
                # `wer_cer([])` is NaN, every NaN comparison below is False, and
                # the cell still counts as checked — so a file missing a leg
                # certified any WER at full coverage. A recomputation that
                # produced no number is a failure to check, not a match.
                if absent := [leg for leg in ("off", "deep") if not src.get(leg)]:
                    problems.append(
                        f"{doc}: {fname} has no {'/'.join(absent)} leg(s), so "
                        f"the German DNS row for {row[0]!r} cannot be recomputed")
                    continue
                deep = src["deep"]
                want = [round(wer_cer(src["off"], "de_de")[0], 2),
                        round(wer_cer(deep, "de_de")[0], 2),
                        sum(1 for r in deep if not r["hypothesis"].strip())]
                for k, w in enumerate(want, start=1):
                    got = parse_number(row[k])
                    if got is None:
                        continue
                    checked += 1
                    if not math.isfinite(w):
                        problems.append(
                            f"{doc}: German DNS {norm_label(row[0])!r} column "
                            f"{norm_label(tbl[0][k])!r} recomputed to {w}, so "
                            f"the document's {got:g} was not verified")
                    elif abs(got - w) > 0.011:
                        problems.append(
                            f"{doc}: German DNS {norm_label(row[0])!r} column "
                            f"{norm_label(tbl[0][k])!r} — document says {got:g}, "
                            f"recomputed {w:g}")
    return problems, checked

if __name__ == "__main__":
    sys.exit(main())
