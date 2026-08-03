#!/usr/bin/env python3
"""Verify that every figure a report quotes for an arm matches the analyzer.

Reports are generated, but assembled by hand, and six review rounds found rows
that had drifted — including hand-entered sign counts, which exist to remove an
ambiguity and so are the worst thing to get wrong by typing.

**The rule, borrowed from `bench/quality/COMPLETENESS.md`: compare what you got
against what you expected, by identity rather than by count, and never let
absence read as a pass.** The first two versions of this checker broke that rule
the same way that harness's checker did, and the shape of the breakage is the
reason this file is written the way it is: the parser recognised one row layout
and *silently dropped* the rest. Three separate layouts were found missing, one
per review round — a metric prefix before the pair, a split-rate row separated
by `vs` rather than a dash, and a column-oriented table naming its arms in the
header. Each was invisible, and a report containing only unrecognised rows
exited zero having checked nothing.

So the unit is the **table**, not the row:

- A table is in scope if anything in it names an arm — in a row, in the header,
  or through a declared prose alias.
- In a table in scope, **every body row carrying a figure must be accounted
  for**: verified against the analyzer, or in `UNCHECKABLE_TABLES` with a
  reason. An unrecognised row is a reported problem, never a skip.
- Coverage is asserted by **equality**, so a row that stops being recognised
  turns into a failure rather than a smaller number nobody reads.

And the figures are checked against **declared** data, not against whatever is
lying around in `results/`:

- Each table names its dataset in the document, `<!-- data: v21-ttfa -->`,
  immediately above it. A table in scope without one is a reported problem.
- Datasets live in `published/`, are committed, and are the published study. A
  re-run writes to `results/` and is not evidence until it is promoted.

That binding exists because merging every dataset let a **superseded** run
validate a current section: the pre-marker `vltier-ttfa` block and its
replacement `vltier2-ttfa` both contain the same arms, so re-introducing a
retracted figure still passed. Evidence now has to be named.

    python check_report_tables.py ../../docs/research/realtime-21-2026-08.md

Exit status is non-zero when anything drifted, went unresolved, or was left
unbound. Requires the full declared dataset: with `published/` absent this fails
loudly rather than certifying a document it could not check.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from analyze import (ALPHA, METRICS, PRACTICAL_MS, TAIL_FLOOR_MS,  # noqa: E402
                     compute_paired, describe, holm, load, mcnemar_exact_p, pct,
                     split_cells, usable_for)
from arms import ARMS_BY_ID, PAIRS  # noqa: E402
from safety import safe_print  # noqa: E402

HERE = Path(__file__).resolve().parent
DATA = HERE / "published"

# `<!-- data: tag[,tag] -->` immediately above a table binds it to those runs.
DIRECTIVE = re.compile(r"<!--\s*data:\s*([\w\-,\s]+?)\s*-->")
# Backticks optional: column-oriented tables put the arm in a plain header cell.
ARM_RE = re.compile(r"(?<![\w.-])`?(" + "|".join(
    re.escape(a) for a in sorted(ARMS_BY_ID, key=len, reverse=True)) + r")`?(?![\w-])")
# A signed figure. The sign is part of the token: a report writing `+352` where
# the analyzer says `−352` is a drift, and an unsigned `352` is not.
FIGURE = re.compile(r"(?<![\w.])([−–+-]?)(\d+(?:\.\d+)?)(?![\w.])")

# The reports this checker owns, and the only ones it will accept. Named rather
# than globbed: `docs/research/*.md` also matches the quality study, whose arms
# share these names but whose data lives in `bench/quality/` — checking it here
# would either invent coverage or report drift that is the checker's own. The
# quality reports have their own checker; an unmapped report is an error, never
# a skip.
#
# The count is the number of figure-bearing rows in arm tables the document
# contains, **declared here** rather than read off whatever the parser managed
# to resolve. A count taken from current behaviour certifies current behaviour,
# blind spots included — which is how the previous version reported OK on 19
# rows while 78 more went unseen. Compared by equality, so a table that leaves
# scope fails instead of quietly lowering the number, and a table that arrives
# has to be accounted for in the same commit.
REPORTS = {"realtime-latency-2026-08.md": 47, "realtime-21-2026-08.md": 60}

# Prose labels for a comparison, for tables that name arms in words. Declared,
# not inferred: the headline table is the one readers act on, and a checker that
# covers everything except its motivating case is the bug this file is about.
PROSE_PAIRS = {
    "gpt-realtime-2 via gateway − direct": ("native-gateway", "native-direct"),
    "Voice Live via gateway − direct": ("vl-gateway", "vl-direct"),
}

# Tables that genuinely cannot be checked against the analyzer, keyed by their
# header row, each with the reason. Absence from this list is a problem, not a
# pass — that is the point. No entry may name something the analyzer computes.
UNCHECKABLE_TABLES = {
    "| arm | deflecting |":
        "deflection counts are a manual reading of each reply's transcript, not "
        "an analyzer output; only the denominators are derivable",
    "| arm | deflecting replies |":
        "as above — a hand count of replies that decline to act",
    "| arm | caller transcript the reply answers |":
        "quoted transcript text, no figures of its own",
    "| arm | provider | brain | endpoint |":
        "endpoint configuration, not measurement",
    "| arm | brain | detector |":
        "arm configuration, not measurement",
}

# Individual rows of an otherwise checkable table, keyed by their label. Same
# rule as above: a reason, and nothing the analyzer computes.
UNCHECKABLE_ROWS = {
    "cost/min (Azure retail)":
        "Azure's published price list, not a measurement — and the point of the "
        "row is that the model-to-tier mapping is unverified",
}

# Values that come from the analyzer's own constants rather than from a run.
CONSTANTS = [PRACTICAL_MS, TAIL_FLOOR_MS, ALPHA * 100]


def fmts(v: float) -> set[str]:
    """Every way this value could legitimately be written, signed and bare."""
    out = set()
    for p in (0, 1, 2, 3, 5):
        out.add(f"{v:+.{p}f}")
        out.add(f"{abs(v):.{p}f}")
    return out


def numbers(vals) -> set[str]:
    out: set[str] = set()
    for v in vals:
        if v is None:
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f != f:                              # NaN — not a quotable figure
            continue
        out |= fmts(f)
    return out


@dataclass
class Dataset:
    """The derivable figures of one run, per arm and per comparison."""
    tags: tuple[str, ...]
    arm: dict[str, set[str]] = field(default_factory=dict)
    pair: dict[tuple[str, str], set[str]] = field(default_factory=dict)

    @staticmethod
    def load(tags: tuple[str, ...]) -> "Dataset | str":
        """Each run is derived on its own; a multi-run binding takes the union.

        Not the union of the *turns*: rounds are numbered from 1 in every run,
        so concatenating two would collide in the `(round, utterance)` cell key
        and one turn of each pair would silently disappear.
        """
        merged = Dataset(tags)
        for tag in tags:
            hits = sorted(DATA.glob(f"turns-*-{tag}.jsonl"))
            if not hits:
                return f"no dataset `{tag}` in {DATA.relative_to(HERE.parent.parent)}/"
            if len(hits) > 1:
                return f"dataset `{tag}` is ambiguous: {[h.name for h in hits]}"
            one = Dataset((tag,))._derive(load(hits[0]))
            for a, v in one.arm.items():
                merged.arm.setdefault(a, set()).update(v)
            for p, v in one.pair.items():
                merged.pair.setdefault(p, set()).update(v)
        return merged

    def _derive(self, turns: list[dict]) -> "Dataset":
        for t in turns:
            # Exactly as analyze.main derives them; a checker that computes a
            # figure differently from the generator reports drift that is its own.
            t["session_ready_ms"] = (
                t["connect_ms"] + t["config_ms"]
                if t.get("connect_ms") is not None and t.get("config_ms") is not None
                else None)
            t["ttfa_minus_vad_ms"] = (
                t["ttfa_ms"] - t["speech_stopped_ms"]
                if t.get("ttfa_ms") is not None
                and t.get("speech_stopped_ms") is not None else None)
        ok = [t for t in turns if t["ok"]]

        raw: dict[tuple[str, str], list] = {}
        for results in compute_paired(ok, [m for m, _ in METRICS]).values():
            for r in results:
                if r.not_comparable:
                    continue
                raw.setdefault((r.treat, r.ctrl), []).extend(
                    [r.median, r.lo, r.hi, pct(r.diffs, 10), pct(r.diffs, 90),
                     r.sign_counts[0], r.sign_counts[1], r.p_raw, r.p_adj,
                     len(r.diffs)])

        # Split rates, corrected within their own family — mirroring
        # analyze.split_rate_table, including the comparisons it hides.
        present = {t["arm"] for t in turns}
        computed = []
        for treat, ctrl, _q in PAIRS:
            if treat not in present or ctrl not in present:
                continue
            cells = split_cells(turns, treat, ctrl)
            if not cells:
                continue
            b = sum(1 for a, c in cells if a and not c)
            c_ = sum(1 for a, c in cells if c and not a)
            computed.append(((treat, ctrl), cells, b, c_, mcnemar_exact_p(b, c_)))
        for ((treat, ctrl), cells, b, c_, p), p_adj in zip(
                computed, holm([c[-1] for c in computed]) if computed else []):
            raw.setdefault((treat, ctrl), []).extend(
                [len(cells), sum(1 for a, _ in cells if a),
                 sum(1 for _, c in cells if c), b, c_, p, p_adj])
        self.pair = {k: numbers(v) for k, v in raw.items()}

        for a in present:
            vals: list = []
            for metric, _ in METRICS:
                xs = [t[metric] for t in turns
                      if t["arm"] == a and usable_for(t, metric)]
                if xs:
                    vals += list(describe(xs).values()) + [pct(xs, 95)]
            aok = [t for t in turns if t["arm"] == a and t["ok"]]
            split = [t for t in aok if t.get("false_starts")]
            if aok:
                vals += [len(aok), len(split), 100.0 * len(split) / len(aok),
                         sum(1 for t in split if t.get("false_starts_audible")),
                         sum(t.get("false_start_audio_ms") or 0 for t in split)]
            self.arm[a] = numbers(vals)
        return self


@dataclass
class Table:
    """A contiguous run of `|` lines, with the binding declared above it."""
    start: int
    header: str
    body: list[tuple[int, str]]
    tags: tuple[str, ...] | None


def tables(text: str) -> list[Table]:
    lines = text.split("\n")
    out, i = [], 0
    while i < len(lines):
        if not lines[i].startswith("|"):
            i += 1
            continue
        start = i
        while i < len(lines) and lines[i].startswith("|"):
            i += 1
        block = lines[start:i]
        body = [(start + n + 1, l) for n, l in enumerate(block)
                if n >= 2 and l.strip("| -")]
        tags = None
        j = start - 1
        while j >= 0 and not lines[j].strip():       # blank lines only
            j -= 1
        if j >= 0:
            m = DIRECTIVE.search(lines[j])
            if m:
                tags = tuple(t.strip() for t in m.group(1).split(",") if t.strip())
        out.append(Table(start + 1, block[0], body, tags))
    return out


def figures(row: str) -> set[str]:
    """Signed figures a row quotes, with identifiers removed.

    Arm ids and model names carry digits (`gw-2-server`, `gpt-4.1-mini`) and are
    not measurements; everything inside backticks is a name, not a number.
    """
    body = re.sub(r"<sub>.*?</sub>", "", row)
    body = re.sub(r"`[^`]*`", "", body)
    body = ARM_RE.sub("", body)
    body = re.sub(r"gpt-[\w.\-]+", "", body)
    return {(s.replace("−", "-").replace("–", "-") or "") + n
            for s, n in FIGURE.findall(body)}


def row_arms(row: str) -> list[str]:
    seen: list[str] = []
    for a in ARM_RE.findall(row):
        if a not in seen:
            seen.append(a)
    for label, (treat, ctrl) in PROSE_PAIRS.items():
        if label in row:
            for a in (treat, ctrl):
                if a not in seen:
                    seen.append(a)
    return seen


def available(ds: Dataset, subjects: list[str], *, any_pair: bool = False) -> set[str]:
    out = set(numbers(CONSTANTS))
    for a in subjects:
        out |= ds.arm.get(a, set())
    if len(subjects) >= 2:
        out |= ds.pair.get((subjects[0], subjects[1]), set())
        out |= ds.pair.get((subjects[1], subjects[0]), set())
    elif any_pair and subjects:
        # A column-oriented row can quote a paired Δ without naming the control
        # — the report's convention is that each arm is compared against its own
        # baseline. Admit the comparisons where this arm is the *treatment*,
        # which is the direction every table in these reports uses.
        for (treat, _ctrl), v in ds.pair.items():
            if treat == subjects[0]:
                out |= v
    return out


def check_row(ds: Dataset, line: str, header_arms: list[str]) -> str:
    """Empty string when every figure in the row is derivable, else the problem."""
    figs = figures(line)
    if not figs:
        return ""
    if len(header_arms) >= 2:
        # Column-oriented: the header names the arms, the row names the metric
        # and sometimes the control. Each cell answers to its own column.
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        ctrl = row_arms(cells[0])
        missing = set()
        for arm, cell in zip(header_arms, cells[1:]):
            missing |= figures("| " + cell) - available(
                ds, [arm] + [c for c in ctrl if c != arm], any_pair=True)
        if not missing:
            return ""
        return f"figures not derivable per column: {sorted(missing)}"
    subjects = row_arms(line)
    if subjects:
        missing = figs - available(ds, subjects)
        if not missing:
            return ""
        return (f"figures not derivable for {' − '.join(subjects[:2])}: "
                f"{sorted(missing)}")
    return "row carries figures but names no arm, and no column does either"


# Deriving a run costs a few seconds of bootstrap; both reports and the tests
# that alter them a row at a time re-check the same bindings many times over.
_CACHE: dict[tuple[str, ...], "Dataset | str"] = {}


def allowlisted_row(line: str) -> bool:
    return any(k in line.split("|")[1] for k in UNCHECKABLE_ROWS)


def bound_tags(reports) -> set[str]:
    return {t for r in reports for tbl in tables(Path(r).read_text())
            for t in tbl.tags or ()}


def orphans(reports) -> list[str]:
    """Runs sitting in the evidence directory that no table quotes.

    A superseded run left beside its replacement is how the merge bug arrived in
    the first place; keeping it here would only mean nothing reads it *today*.
    Either a table should bind it or it does not belong in `published/`.
    """
    bound = bound_tags(reports)
    return sorted(p.name for p in DATA.glob("turns-*.jsonl")
                  if not any(p.name.endswith(f"-{t}.jsonl") for t in bound))


def check(report: Path) -> int:
    text = report.read_text()
    checked = allowlisted = 0
    problems: list[str] = []
    considered = 0

    for tbl in tables(text):
        header_arms = row_arms(tbl.header)
        in_scope = bool(header_arms) or any(row_arms(l) for _, l in tbl.body)
        rows = [(n, l) for n, l in tbl.body if figures(l)]
        if not in_scope or not rows:
            continue
        considered += len(rows)
        key = tbl.header.strip()
        if key in UNCHECKABLE_TABLES:
            allowlisted += len(rows)
            continue
        if not tbl.tags:
            problems.append(
                f"  UNBOUND  table at line {tbl.start} ({len(rows)} row(s))\n"
                f"      {key[:120]}\n"
                f"      add `<!-- data: <tag> -->` above it, or list it in "
                f"UNCHECKABLE_TABLES with a reason")
            continue
        if tbl.tags not in _CACHE:
            _CACHE[tbl.tags] = Dataset.load(tbl.tags)
        ds = _CACHE[tbl.tags]
        if isinstance(ds, str):
            problems.append(f"  MISSING DATA  table at line {tbl.start} "
                            f"({len(rows)} row(s)): {ds}")
            continue
        for n, line in rows:
            if allowlisted_row(line):
                allowlisted += 1
                continue
            why = check_row(ds, line, header_arms)
            if why:
                problems.append(f"  DRIFTED  {report.name}:{n} "
                                f"[data: {','.join(tbl.tags)}]\n"
                                f"      {line.strip()[:150]}\n      {why}")
            else:
                checked += 1

    unresolved = considered - checked - allowlisted
    assert unresolved >= 0, "coverage arithmetic"
    # Coverage by EQUALITY against a declared count, in both directions: a
    # deficit means a table stopped being seen, a surplus means one arrived
    # unaccounted for. A floor would pass either way.
    want = REPORTS.get(report.name)
    if want is not None and want != considered:
        problems.append(
            f"  COVERAGE  {report.name}: {considered} figure-bearing rows in arm "
            f"tables, declared {want}\n      if that is intended, change REPORTS "
            f"in {Path(__file__).name} in the same commit")
        unresolved += 1
    for p in problems:
        safe_print(p)
    safe_print(f"{report.name}: {considered} figure-bearing rows in arm tables — "
               f"{checked} verified, {allowlisted} allowlisted, "
               f"{considered - checked - allowlisted} unresolved")
    return unresolved


if __name__ == "__main__":
    docs = HERE.parent.parent / "docs" / "research"
    targets = [Path(a) for a in sys.argv[1:]] or [docs / r for r in REPORTS]
    unknown = [t for t in targets if t.name not in REPORTS]
    if unknown:
        raise SystemExit(f"not this checker's reports: {[t.name for t in unknown]} — "
                         f"this one covers {list(REPORTS)}. Run it with no arguments "
                         f"to check exactly those.")
    if not DATA.is_dir():
        raise SystemExit(f"no {DATA}: the published datasets are required — "
                         f"this checker verifies reports against them, and "
                         f"without them it would certify nothing while exiting 0")
    bad = sum(check(t) for t in targets)
    if len(targets) == len(REPORTS):
        for name in orphans(targets):
            safe_print(f"  ORPHAN  published/{name} is quoted by no table — bind "
                       f"it or remove it; a superseded run must not sit in the "
                       f"evidence directory")
            bad += 1
    safe_print("\nOK" if not bad else f"\n{bad} row(s) need attention")
    raise SystemExit(0 if not bad else 1)
