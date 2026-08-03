#!/usr/bin/env python3
"""Verify that every figure a report quotes for an arm matches the analyzer.

Reports are generated, but assembled by hand, and seven review rounds found rows
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
  for**: verified against the analyzer, or in `UNCHECKABLE_TABLES` /
  `UNCHECKABLE_ROWS` with a reason. An unrecognised row is a reported problem.
- Coverage is asserted by **equality**, so a row that stops being recognised
  turns into a failure rather than a smaller number nobody reads.

And the figures are checked against **declared** data, not against whatever is
lying around in `results/`:

- Each table names its run in the document, `<!-- data: v21-ttfa -->`,
  immediately above it. A table in scope without one is a reported problem.
- Runs live in `published/`, are committed, and are the study. A re-run writes
  to `results/` and is not evidence until it is promoted.
- **A cell, not a table, is what gets bound.** A table quoting two runs has to
  say which column or which row came from which:
  ``<!-- data: full2; column "run 1" = full -->``. Unioning the two and
  accepting a figure from either was the same hole one level down — it let the
  headline table's primary-run delta be replaced by the *other* run's.

That binding exists because merging every dataset let a **superseded** run
validate a current section, and did: the 2.1 report's recommendation table
carried the retracted block's end-of-turn row for a week. Evidence is named now.

    python check_report_tables.py          # the reports it owns, no arguments

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

# `<!-- data: tag[, column "…" = tag][, row "…" = tag] -->` above a table.
DIRECTIVE = re.compile(r"<!--\s*data:\s*(.+?)\s*-->")
CLAUSE = re.compile(r'^(column|row)\s+"([^"]+)"\s*=\s*(.+)$')
# Backticks optional: column-oriented tables put the arm in a plain header cell.
ARM_RE = re.compile(r"(?<![\w.-])`?(" + "|".join(
    re.escape(a) for a in sorted(ARMS_BY_ID, key=len, reverse=True)) + r")`?(?![\w-])")
# A signed figure. The sign is part of the token: a report writing `+352` where
# the analyzer says `−352` is a drift, and an unsigned `352` is not.
FIGURE = re.compile(r"(?<![\w.])([−–+-]?)(\d+(?:\.\d+)?)(?![\w.])")
# `k/n` or `k/n — p%`: a hand count over a denominator the analyzer knows.
MANUAL_COUNT = re.compile(
    r"(\d+)\s*/\s*(\d+)(?:\s*[—–-]\s*(\d+(?:\.\d+)?)\s*%)?")

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
# rows while 88 more went unseen. Compared by equality, so a table that leaves
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

# Tables whose figures are a hand count over a derivable denominator. Only the
# **numerator** is exempt: the denominator must equal the arm's usable turns in
# the bound runs, and the percentage must equal the two. Allowlisting the whole
# table was the bug — it exempted `20` and `10.0%` along with the `2`, so `2/19`
# passed against a run of twenty.
MANUAL_COUNT_TABLES = {
    "| arm | deflecting |":
        "the numerator is a manual reading of each reply's transcript; the "
        "denominator and percentage are checked",
    "| arm | deflecting replies |":
        "as above — a hand count of replies that decline to act",
}

# Tables that genuinely cannot be checked against the analyzer, keyed by their
# header row, each with the reason. Absence from this list is a problem, not a
# pass — that is the point. No entry may name something the analyzer computes,
# and no entry may cover more than the part that is actually unverifiable.
UNCHECKABLE_TABLES: dict[str, str] = {}

# Individual rows of an otherwise checkable table, keyed by their label. Same
# rule, and narrower than a table entry for that reason.
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
class Run:
    """The derivable figures of one run, per arm and per comparison."""
    tag: str
    arm: dict[str, set[str]] = field(default_factory=dict)
    pair: dict[tuple[str, str], set[str]] = field(default_factory=dict)
    n_ok: dict[str, int] = field(default_factory=dict)

    def derive(self, turns: list[dict]) -> "Run":
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

        # Directional statistics are kept apart from the rest so the reverse of
        # a comparison can be derived by negating them. `X − Y` and `Y − X` are
        # not the same claim, and a reader cannot tell a swapped label from a
        # sign error by inspection.
        directional: dict[tuple[str, str], list] = {}
        symmetric: dict[tuple[str, str], list] = {}
        for results in compute_paired(ok, [m for m, _ in METRICS]).values():
            for r in results:
                if r.not_comparable:
                    continue
                directional.setdefault((r.treat, r.ctrl), []).extend(
                    [r.median, r.lo, r.hi, pct(r.diffs, 10), pct(r.diffs, 90)])
                symmetric.setdefault((r.treat, r.ctrl), []).extend(
                    [r.sign_counts[0], r.sign_counts[1], r.p_raw, r.p_adj,
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
            symmetric.setdefault((treat, ctrl), []).extend(
                [len(cells), sum(1 for a, _ in cells if a),
                 sum(1 for _, c in cells if c), b, c_, p, p_adj])

        for k in set(directional) | set(symmetric):
            self.pair[k] = numbers(directional.get(k, []) + symmetric.get(k, []))
        for (treat, ctrl) in list(self.pair):
            if (ctrl, treat) in self.pair:
                continue                      # a real comparison, not a mirror
            self.pair[(ctrl, treat)] = numbers(
                [-v for v in directional.get((treat, ctrl), [])]
                + symmetric.get((treat, ctrl), []))

        for a in present:
            vals: list = []
            for metric, _ in METRICS:
                xs = [t[metric] for t in turns
                      if t["arm"] == a and usable_for(t, metric)]
                if xs:
                    vals += list(describe(xs).values()) + [pct(xs, 95)]
            aok = [t for t in turns if t["arm"] == a and t["ok"]]
            split = [t for t in aok if t.get("false_starts")]
            self.n_ok[a] = len(aok)
            if aok:
                vals += [len(aok), len(split), 100.0 * len(split) / len(aok),
                         sum(1 for t in split if t.get("false_starts_audible")),
                         sum(t.get("false_start_audio_ms") or 0 for t in split)]
            self.arm[a] = numbers(vals)
        return self


# Deriving a run costs a few seconds of bootstrap; both reports and the tests
# that alter them a row at a time re-check the same bindings many times over.
_RUNS: dict[str, "Run | str"] = {}


def get_run(tag: str) -> "Run | str":
    if tag not in _RUNS:
        hits = sorted(DATA.glob(f"turns-*-{tag}.jsonl"))
        if not hits:
            _RUNS[tag] = f"no run `{tag}` in {DATA.relative_to(HERE.parent.parent)}/"
        elif len(hits) > 1:
            _RUNS[tag] = f"run `{tag}` is ambiguous: {[h.name for h in hits]}"
        else:
            _RUNS[tag] = Run(tag).derive(load(hits[0]))
    return _RUNS[tag]


@dataclass
class Evidence:
    """The runs one cell may be checked against — usually exactly one.

    A multi-run set unions each run's *derivations*, never its turns: rounds are
    numbered from 1 in every run, so concatenating two would collide in the
    `(round, utterance)` cell key and lose half the pairs. Counts (`n_ok`) add,
    because counts are additive; distributions do not, so no percentile is ever
    computed across runs.
    """
    tags: tuple[str, ...]
    runs: list[Run]

    def arm(self, a: str) -> set[str]:
        return set().union(*(r.arm.get(a, set()) for r in self.runs)) \
            if self.runs else set()

    def pair(self, t: str, c: str) -> set[str]:
        return set().union(*(r.pair.get((t, c), set()) for r in self.runs)) \
            if self.runs else set()

    def pairs_with_treatment(self, t: str) -> set[str]:
        out: set[str] = set()
        for r in self.runs:
            for (treat, _ctrl), v in r.pair.items():
                if treat == t:
                    out |= v
        return out

    def n_ok(self, a: str) -> int:
        return sum(r.n_ok.get(a, 0) for r in self.runs)


def evidence(tags: tuple[str, ...]) -> "Evidence | str":
    runs = []
    for tag in tags:
        r = get_run(tag)
        if isinstance(r, str):
            return r
        runs.append(r)
    return Evidence(tags, runs)


@dataclass
class Binding:
    """Which run each cell of a table answers to."""
    default: tuple[str, ...]
    columns: list[tuple[str, tuple[str, ...]]] = field(default_factory=list)
    rows: list[tuple[str, tuple[str, ...]]] = field(default_factory=list)

    def tags_for(self, row_label: str, col_header: str) -> tuple[str, ...]:
        """Row scope ∩ column scope, falling back to whichever is declared.

        The intersection is what makes a table that mixes runs by row *and* by
        column resolve to a single run per cell, which is the whole point: a
        figure that could have come from either run has not been checked
        against the one it claims to come from.
        """
        col = next((t for label, t in self.columns if label in col_header), None)
        row = next((t for label, t in self.rows if label in row_label), None)
        if col is not None and row is not None:
            both = tuple(t for t in row if t in col)
            return both or ()
        return col if col is not None else (row if row is not None else self.default)

    @property
    def all_tags(self) -> tuple[str, ...]:
        seen = list(self.default)
        for _l, ts in self.columns + self.rows:
            seen += [t for t in ts if t not in seen]
        return tuple(dict.fromkeys(seen))


def parse_binding(text: str) -> "Binding | None":
    m = DIRECTIVE.search(text)
    if not m:
        return None
    parts = [p.strip() for p in m.group(1).split(";") if p.strip()]
    b = Binding(default=())
    for i, part in enumerate(parts):
        c = CLAUSE.match(part)
        if c:
            scope, label, tags = c.group(1), c.group(2), tuple(
                t.strip() for t in c.group(3).split(",") if t.strip())
            (b.columns if scope == "column" else b.rows).append((label, tags))
        elif i == 0:
            b.default = tuple(t.strip() for t in part.split(",") if t.strip())
    return b


@dataclass
class Table:
    """A contiguous run of `|` lines, with the binding declared above it."""
    start: int
    header: str
    body: list[tuple[int, str]]
    binding: "Binding | None"

    @property
    def head_cells(self) -> list[str]:
        return cells_of(self.header)

    @property
    def column_arms(self) -> list[list[str]]:
        return [row_arms(c) for c in self.head_cells]

    @property
    def is_column_oriented(self) -> bool:
        return sum(1 for a in self.column_arms[1:] if a) >= 2


def cells_of(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


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
        j = start - 1
        while j >= 0 and not lines[j].strip():       # blank lines only
            j -= 1
        binding = parse_binding(lines[j]) if j >= 0 else None
        out.append(Table(start + 1, block[0], body, binding))
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


def available(ev: Evidence, subjects: list[str], *, any_pair: bool = False) -> set[str]:
    out = set(numbers(CONSTANTS))
    for a in subjects:
        out |= ev.arm(a)
    if len(subjects) >= 2:
        # The ordered pair only. The reverse is derived at load time with its
        # directional statistics negated, so relabelling a comparison without
        # flipping its sign is a drift rather than a match.
        out |= ev.pair(subjects[0], subjects[1])
    elif any_pair and subjects:
        # A column-oriented row can quote a paired Δ without naming the control
        # — the report's convention is that each arm is compared against its own
        # baseline. Admit the comparisons where this arm is the *treatment*,
        # which is the direction every table in these reports uses.
        out |= ev.pairs_with_treatment(subjects[0])
    return out


def check_manual_count(ev: Evidence, cell: str, subjects: list[str]) -> str:
    """`k/n` and `k/n — p%`: k is the hand count, n and p are not."""
    m = MANUAL_COUNT.search(cell)
    if not m:
        return f"expected a `k/n` count, got {cell.strip()!r}"
    k, n = int(m.group(1)), int(m.group(2))
    if k > n:
        return f"{k}/{n}: numerator exceeds denominator"
    for a in subjects:
        if ev.n_ok(a) != n:
            return (f"{k}/{n}: denominator is {ev.n_ok(a)} usable turns for "
                    f"`{a}` in {','.join(ev.tags)}")
    if m.group(3) is not None:
        want = f"{100.0 * k / n:.1f}"
        if m.group(3) != want:
            return f"{m.group(3)}% is not {k}/{n} ({want}%)"
    return ""


def check_row(tbl: Table, line: str, resolve) -> str:
    """Empty string when every figure in the row is derivable, else the problem.

    `resolve(row_label, column_header) -> Evidence | str` supplies the run each
    individual cell answers to, so a table quoting two runs cannot satisfy one
    run's column with the other run's figure.
    """
    body = cells_of(line)
    head = tbl.head_cells
    label = body[0] if body else ""
    manual = tbl.header.strip() in MANUAL_COUNT_TABLES
    column_arms = tbl.column_arms
    problems: list[str] = []
    row_subjects = row_arms(line)

    for i, cell in enumerate(body):
        figs = figures("| " + cell)
        if not figs:
            continue
        ev = resolve(label, head[i] if i < len(head) else "")
        if isinstance(ev, str):
            return ev
        if tbl.is_column_oriented and i > 0:
            arms = column_arms[i] if i < len(column_arms) else []
            if not arms:
                problems.append(f"column {i} names no arm, and its cell carries "
                                f"{sorted(figs)}")
                continue
            subjects = arms + [c for c in row_arms(label) if c not in arms]
            missing = figs - available(ev, subjects, any_pair=True)
            if missing:
                problems.append(f"{head[i]}: {sorted(missing)}")
            continue
        if not row_subjects:
            return "row carries figures but names no arm, and no column does either"
        if manual:
            why = check_manual_count(ev, cell, row_subjects)
            if why:
                problems.append(why)
            continue
        missing = figs - available(ev, row_subjects)
        if missing:
            problems.append(f"{sorted(missing)} not derivable for "
                            f"{' − '.join(row_subjects[:2])} in {','.join(ev.tags)}")
    return "; ".join(problems)


def allowlisted_row(line: str) -> bool:
    return any(k in cells_of(line)[0] for k in UNCHECKABLE_ROWS)


def bound_tags(reports) -> set[str]:
    return {t for r in reports for tbl in tables(Path(r).read_text())
            for t in (tbl.binding.all_tags if tbl.binding else ())}


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
        in_scope = (bool(row_arms(tbl.header))
                    or any(row_arms(l) for _, l in tbl.body))
        rows = [(n, l) for n, l in tbl.body if figures(l)]
        if not in_scope or not rows:
            continue
        considered += len(rows)
        key = tbl.header.strip()
        if key in UNCHECKABLE_TABLES:
            allowlisted += len(rows)
            continue
        if not tbl.binding or not tbl.binding.all_tags:
            problems.append(
                f"  UNBOUND  table at line {tbl.start} ({len(rows)} row(s))\n"
                f"      {key[:120]}\n"
                f"      add `<!-- data: <tag> -->` above it, or list it in "
                f"UNCHECKABLE_TABLES with a reason")
            continue

        absent = [t for t in tbl.binding.all_tags
                  if isinstance(get_run(t), str)]
        if absent:
            problems.append(
                f"  MISSING DATA  table at line {tbl.start} ({len(rows)} row(s)): "
                + "; ".join(str(get_run(t)) for t in absent))
            continue

        def resolve(row_label: str, col_header: str, _b=tbl.binding):
            tags = _b.tags_for(row_label, col_header)
            if not tags:
                return (f"no run bound to this cell — the row and column "
                        f"clauses of the directive do not overlap")
            return evidence(tags)

        for n, line in rows:
            if allowlisted_row(line):
                allowlisted += 1
                continue
            why = check_row(tbl, line, resolve)
            if why:
                problems.append(f"  DRIFTED  {report.name}:{n}\n"
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
        raise SystemExit(f"no {DATA}: the published runs are required — "
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
