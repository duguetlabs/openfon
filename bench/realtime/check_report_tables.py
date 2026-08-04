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
REPORTS = {"realtime-latency-2026-08.md": 55, "realtime-21-2026-08.md": 66}

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

# Split rates are not a metric of the paired family; they get their own key.
SPLIT = "split_rate"

# What a column (or, in a column-oriented table, a row label) says its figures
# ARE. Membership in the comparison was not enough: a median satisfied by its
# own CI bound is a false sentence the checker called verified, and 2704 such
# swaps were accepted before this list existed. Each entry is a pattern over
# the normalised label, the statistics that cell may quote, and the metric
# those statistics belong to when the label names one.
#
# **A label that carries figures and matches nothing here is a reported
# problem.** That is the whole discipline: the previous three versions of this
# checker each failed by treating what they did not recognise as nothing to do.
LABEL_SPECS: list[tuple[str, tuple[str, ...], "str | None"]] = [
    # — paired comparisons —
    (r"^pairs$", ("n",), None),
    (r"^cells$", ("cells",), SPLIT),
    (r"^median( δ)?( ttfa)?$", ("median",), None),
    (r"^95% ci$", ("lo", "hi"), None),
    (r"^p10 / p90 δ$", ("p10", "p90"), None),
    (r"^p90 δ$", ("p90",), None),
    # The extremes of the paired differences, deliberately named apart from an
    # arm's own `min`/`max`: a single outlying *pair* is a claim about one cell
    # of one run, and letting it be satisfied by an arm's slowest turn would be
    # the same membership hole the `(metric, statistic)` keying closed.
    (r"^min / max δ$", ("diff_min", "diff_max"), None),
    (r"^slower / faster$", ("slower", "faster"), None),
    (r"^p raw / holm$", ("p_raw", "p_adj"), None),
    (r"^p raw$", ("p_raw",), None),
    # `p Holm` labels both families; which one is decided by the table it sits
    # in — a split-rate table is the one with a McNemar column.
    (r"^p holm$", ("p_adj", "mcnemar_p_adj"), None),
    (r"^p \(holm, split family\)$", ("mcnemar_p_adj",), SPLIT),
    (r"^mcnemar p$", ("mcnemar_p",), SPLIT),
    (r"^discordant", ("discordant_t", "discordant_c"), SPLIT),
    (r"^treatment splits$", ("t_split", "cells"), SPLIT),
    (r"^control splits$", ("c_split", "cells"), SPLIT),
    # The verdict is generated prose. It quotes the median's magnitude
    # ("faster by 352 ms") and the analyzer's own constants ("within ±50 ms"),
    # and nothing else — admitting the CI bounds here let "faster by 100 ms"
    # be rewritten as "faster by 280 ms" from the interval and pass.
    (r"^(verdict|status)$", ("verdict_median",), None),
    # One column per run, each bound to its own run by a `column` clause. The
    # headline table quotes three medians of the same comparison side by side,
    # because the disagreement between them is the finding.
    (r"^run [123]$", ("median",), None),
    # — per-arm distributions —
    (r"^n$", ("n",), None),
    (r"^min$", ("min",), None),
    (r"^max$", ("max",), None),
    (r"^p50$", ("p50",), None),
    (r"^p90$", ("p90",), None),
    (r"^p95$", ("p95",), None),
    (r"^p99$", ("p99",), None),
    (r"^iqr$", ("iqr",), None),
    (r"^(turns )?splits?( at a clause pause)?$", ("splits", "n"), SPLIT),
    # — labels that name their own metric —
    (r"^ttfa p50", ("p50",), "ttfa_ms"),
    (r"^ttfa p95", ("p95",), "ttfa_ms"),
    (r"^end-of-turn p50$", ("p50",), "speech_stopped_ms"),
    (r"^end-of-turn p90$", ("p90",), "speech_stopped_ms"),
    (r"^end-of-turn$", ("p50",), "speech_stopped_ms"),
    (r"^engine-only p50$", ("p50",), "ttfa_minus_vad_ms"),
    (r"^engine-only p90$", ("p90",), "ttfa_minus_vad_ms"),
    (r"^speech_stopped_ms p50", ("p50",), "speech_stopped_ms"),
    (r"^transcript_ms p50", ("p50", "n"), "transcript_ms"),
    (r"^connect_ms paired δ", ("median",), "connect_ms"),
    (r"^config_ms paired δ", ("median",), "config_ms"),
    (r"^session_ready_ms paired δ", ("median",), "session_ready_ms"),
]
LABEL_SPECS_C = [(re.compile(p), stats, metric) for p, stats, metric in LABEL_SPECS]


def normalise_label(cell: str) -> str:
    """Header text as the specs match it: no markup, no arm ids, lowercase."""
    out = re.sub(r"<br>.*", "", cell)
    out = out.replace("**", "").replace("`", "").replace("Δ", "δ")
    out = re.sub(r"\s+", " ", out).strip().lower()
    return out


def spec_for(cell: str) -> "tuple[tuple[str, ...], str | None] | None":
    label = normalise_label(cell)
    for pat, stats, metric in LABEL_SPECS_C:
        if pat.search(label):
            return stats, metric
    return None


def fmts(v: float, *, magnitude: bool = True,
         probability: bool = False) -> set[str]:
    """Every way this value could legitimately be written.

    `magnitude=False` drops the unsigned spelling of a *negative* value, so a
    median of −100 ms cannot be written `100`. Verdict prose is the one place
    that legitimately says "faster by 100 ms" about a negative median, and it
    is the only place that asks for the magnitude.

    `probability=True` drops the whole-number spelling, which is meaningless
    for a p-value and was an accepted disguise: Holm 0.730 passed written as
    `1`, because rounding it to no decimals says so. Two decimals stay — the
    merged report's headline table quotes `0.87` for 0.866.
    """
    out = set()
    for p in (1, 2, 3, 5) if probability else (0, 1, 2, 3, 5):
        out.add(f"{v:+.{p}f}")
        if magnitude or v >= 0:
            out.add(f"{abs(v):.{p}f}")
    return out


PROBABILITY_STATS = {"p_raw", "p_adj", "mcnemar_p", "mcnemar_p_adj"}


def numbers(vals, *, magnitude: bool = True, probability: bool = False) -> set[str]:
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
        out |= fmts(f, magnitude=magnitude, probability=probability)
    return out


@dataclass
class Run:
    """The derivable figures of one run, per arm and per comparison."""
    tag: str
    # (arm, metric) -> statistic -> the ways that value could be written
    arm: dict[tuple[str, str], dict[str, set[str]]] = field(default_factory=dict)
    # (treat, ctrl, metric) -> statistic -> ditto
    pair: dict[tuple[str, str, str], dict[str, set[str]]] = field(default_factory=dict)
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

        # Keyed by (metric, statistic). A flat set per comparison was the third
        # turn of the same screw: binding by table left holes across runs,
        # binding by run left holes across cells, and binding by cell left holes
        # across statistics *within* a cell — a median could be satisfied by its
        # own CI bound. 2704 such swaps were accepted before this.
        def put(d, key, stat, value, negate=False):
            d.setdefault(key, {}).setdefault(stat, set()).update(
                numbers([-value if negate and value is not None else value],
                        probability=stat in PROBABILITY_STATS))

        for metric, results in compute_paired(ok, [m for m, _ in METRICS]).items():
            for r in results:
                if r.not_comparable:
                    continue
                fwd = {"median": r.median, "lo": r.lo, "hi": r.hi,
                       "p10": pct(r.diffs, 10), "p90": pct(r.diffs, 90),
                       "diff_min": min(r.diffs) if r.diffs else None,
                       "diff_max": max(r.diffs) if r.diffs else None}
                sym = {"slower": r.sign_counts[0], "faster": r.sign_counts[1],
                       "p_raw": r.p_raw, "p_adj": r.p_adj, "n": len(r.diffs)}
                for stat, v in fwd.items():
                    put(self.pair, (r.treat, r.ctrl, metric), stat, v)
                for stat, v in sym.items():
                    put(self.pair, (r.treat, r.ctrl, metric), stat, v)
                # The reverse comparison, with the directional statistics
                # negated. `X − Y` and `Y − X` are different claims.
                rev = {"median": -r.median, "lo": -r.hi, "hi": -r.lo,
                       "p10": -pct(r.diffs, 90), "p90": -pct(r.diffs, 10),
                       "diff_min": -max(r.diffs) if r.diffs else None,
                       "diff_max": -min(r.diffs) if r.diffs else None}
                for stat, v in rev.items():
                    put(self.pair, (r.ctrl, r.treat, metric), stat, v)
                for stat, v in {**sym, "slower": r.sign_counts[1],
                                "faster": r.sign_counts[0]}.items():
                    put(self.pair, (r.ctrl, r.treat, metric), stat, v)

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
                computed, holm([x[-1] for x in computed]) if computed else []):
            t_split = sum(1 for a, _ in cells if a)
            c_split = sum(1 for _, x in cells if x)
            for key, stats in (((treat, ctrl, SPLIT), {
                    "cells": len(cells), "t_split": t_split, "c_split": c_split,
                    "discordant_t": b, "discordant_c": c_,
                    "mcnemar_p": p, "mcnemar_p_adj": p_adj}),
                    ((ctrl, treat, SPLIT), {
                        "cells": len(cells), "t_split": c_split, "c_split": t_split,
                        "discordant_t": c_, "discordant_c": b,
                        "mcnemar_p": p, "mcnemar_p_adj": p_adj})):
                for stat, v in stats.items():
                    put(self.pair, key, stat, v)

        for a in present:
            for metric, _ in METRICS:
                xs = [t[metric] for t in turns
                      if t["arm"] == a and usable_for(t, metric)]
                if not xs:
                    continue
                d = dict(describe(xs))
                d["p95"] = pct(xs, 95)
                for stat, v in d.items():
                    put(self.arm, (a, metric), stat, v)
            aok = [t for t in turns if t["arm"] == a and t["ok"]]
            split = [t for t in aok if t.get("false_starts")]
            self.n_ok[a] = len(aok)
            if aok:
                for stat, v in {
                        "n": len(aok), "splits": len(split),
                        "split_pct": 100.0 * len(split) / len(aok),
                        "audible": sum(1 for t in split
                                       if t.get("false_starts_audible")),
                        "audible_ms": sum(t.get("false_start_audio_ms") or 0
                                          for t in split)}.items():
                    put(self.arm, (a, SPLIT), stat, v)
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

    def arm(self, a: str, metric: str) -> dict[str, set[str]]:
        out: dict[str, set[str]] = {}
        for r in self.runs:
            for stat, v in r.arm.get((a, metric), {}).items():
                out.setdefault(stat, set()).update(v)
        return out

    def pair(self, t: str, c: str, metric: str) -> dict[str, set[str]]:
        out: dict[str, set[str]] = {}
        for r in self.runs:
            for stat, v in r.pair.get((t, c, metric), {}).items():
                out.setdefault(stat, set()).update(v)
        return out

    def pairs_with_treatment(self, t: str, metric: str) -> dict[str, set[str]]:
        """A column-oriented row can quote a paired Δ without naming the
        control — the report's convention is that each arm is compared against
        its own baseline, and the row gives no way to know which. Naming the
        control in the row label narrows it to the one pair."""
        out: dict[str, set[str]] = {}
        for r in self.runs:
            for (treat, _ctrl, m), stats in r.pair.items():
                if treat != t or m != metric:
                    continue
                for stat, v in stats.items():
                    out.setdefault(stat, set()).update(v)
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
    """Which run each cell of a table answers to, and which metric it quotes."""
    default: tuple[str, ...]
    columns: list[tuple[str, tuple[str, ...]]] = field(default_factory=list)
    rows: list[tuple[str, tuple[str, ...]]] = field(default_factory=list)
    metric: "str | None" = None

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
        if part.startswith("metric:"):
            b.metric = part.split(":", 1)[1].strip()
            continue
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


def strip_identifiers(row: str) -> str:
    """Arm ids and model names carry digits (`gw-2-server`, `gpt-4.1-mini`) and
    are not measurements; everything inside backticks is a name, not a number.
    Blanked rather than deleted, so figure positions survive."""
    out = row
    for pat in (r"<sub>.*?</sub>", r"`[^`]*`", ARM_RE, r"gpt-[\w.\-]+"):
        out = re.sub(pat, lambda m: " " * len(m.group(0)), out)
    return out


def figures(row: str) -> set[str]:
    """Signed figures a row quotes, with identifiers removed."""
    return {(s.replace("−", "-").replace("–", "-") or "") + n
            for s, n in FIGURE.findall(strip_identifiers(row))}


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


def check_manual_count(ev: Evidence, cell: str, subjects: list[str]) -> str:
    """`k/n` and `k/n — p%`: k is the hand count, n and p are not.

    Every figure in the cell has to belong to one of those forms. A number
    beside the count would otherwise ride along unchecked, which is the same
    "wider than the claim" mistake that put the whole table on the allowlist.
    """
    matches = list(MANUAL_COUNT.finditer(cell))
    if not matches:
        return f"expected a `k/n` count, got {cell.strip()!r}"
    accounted: set[str] = set()
    for m in matches:
        k, n = int(m.group(1)), int(m.group(2))
        accounted |= {m.group(1), m.group(2)}
        if k > n:
            return f"{k}/{n}: numerator exceeds denominator"
        for a in subjects:
            if ev.n_ok(a) != n:
                return (f"{k}/{n}: denominator is {ev.n_ok(a)} usable turns for "
                        f"`{a}` in {','.join(ev.tags)}")
        if m.group(3) is not None:
            accounted.add(m.group(3))
            want = f"{100.0 * k / n:.1f}"
            if m.group(3) != want:
                return f"{m.group(3)}% is not {k}/{n} ({want}%)"
    extra = {f.lstrip("+") for f in figures("| " + cell)} - accounted
    if extra:
        return f"figures beside the hand count, unchecked: {sorted(extra)}"
    return ""


# Only prose cells may quote a magnitude for a negative value, or one of the
# analyzer's own constants. Admitting either everywhere let `−72` be written
# `5` — α×100 — and a −100 ms median be written `100`.
PROSE_STATS = ("verdict_median",)


def stat_values(ev: Evidence, subjects: list[str], stat: str,
                metric: "str | None", table_metric: "str | None",
                prose: bool) -> set[str]:
    """Every way ONE statistic of this subject could legitimately be written."""
    return cell_values(ev, subjects, (stat,), metric, table_metric, prose)


def cell_values(ev: Evidence, subjects: list[str], stats: tuple[str, ...],
                metric: "str | None", table_metric: "str | None",
                prose: bool) -> set[str]:
    """What this cell is allowed to say, given what its column claims it is."""
    out: set[str] = set()
    wanted = metric or table_metric
    metrics = [wanted] if wanted else [m for m, _ in METRICS] + [SPLIT]
    stats = tuple("median" if st == "verdict_median" else st for st in stats)
    for m in metrics:
        for stat in stats:
            raw: set[str] = set()
            if len(subjects) >= 2:
                raw |= ev.pair(subjects[0], subjects[1], m).get(stat, set())
            elif subjects:
                raw |= ev.pairs_with_treatment(subjects[0], m).get(stat, set())
            for a in subjects:
                raw |= ev.arm(a, m).get(stat, set())
            out |= raw if prose else {v for v in raw if not v.startswith("-") or
                                      f"+{v[1:]}" not in raw}
    return out


def check_cell(ev: Evidence, cell: str, subjects: list[str],
               spec: "tuple[tuple[str, ...], str | None]",
               table_metric: "str | None") -> set[str]:
    """Figures in this cell that are not what its column says they are.

    A cell holding several statistics holds them **in order** — `[lo, hi]`,
    `p10 / p90`, `slower / faster`. Accepting either figure in either position
    let a confidence interval be written `[−15, −15]` and pass, which is the
    same membership-not-position hole one level further down.
    """
    stats, metric = spec
    prose = any(st in PROSE_STATS for st in stats)
    if prose:
        # `±N` is the analyzer's practical-difference threshold, quoted in a
        # fixed phrase; every other figure is the median's magnitude. Admitting
        # the constant anywhere let `within ±50 ms` be rewritten `within ±0 ms`
        # — a false equivalence claim built from the row's own median.
        text = strip_identifiers("| " + cell)
        bad = {t for t in re.findall(r"±\s*([+-]?\d+(?:\.\d+)?)", text)
               if abs(float(t)) != PRACTICAL_MS}
        text = re.sub(r"±\s*[+-]?\d+(?:\.\d+)?", "", text)
        rest = [(m.group(1).replace("−", "-").replace("–", "-") or "") + m.group(2)
                for m in FIGURE.finditer(text)]
        allowed = cell_values(ev, subjects, stats, metric, table_metric, True)
        return bad | {v for v in rest if v not in allowed}
    figs = list(FIGURE.finditer(strip_identifiers("| " + cell)))
    values = [(m.group(1).replace("−", "-").replace("–", "-") or "") + m.group(2)
              for m in figs]
    if len(stats) > 1 and len(values) == len(stats):
        return {v for v, stat in zip(values, stats)
                if v not in stat_values(ev, subjects, stat, metric, table_metric,
                                        prose)}
    allowed = cell_values(ev, subjects, stats, metric, table_metric, prose)
    return {v for v in values if v not in allowed}


def check_row(tbl: Table, line: str, resolve) -> str:
    """Empty string when every figure sits where its column says it should.

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
    # A metric named in the row label (``| `connect_ms`, `a` − `b` | …``) or in
    # the binding governs every cell that does not name one itself.
    row_spec = spec_for(label)
    table_metric = (tbl.binding.metric if tbl.binding else None) or (
        row_spec[1] if row_spec else None)

    for i, cell in enumerate(body):
        figs = figures("| " + cell)
        if not figs:
            continue
        ev = resolve(label, head[i] if i < len(head) else "")
        if isinstance(ev, str):
            return ev
        if manual and i > 0:
            why = check_manual_count(ev, cell, row_subjects)
            if why:
                problems.append(why)
            continue
        if tbl.is_column_oriented and i > 0:
            arms = column_arms[i] if i < len(column_arms) else []
            if not arms:
                problems.append(f"column {i} names no arm, and its cell carries "
                                f"{sorted(figs)}")
                continue
            if not row_spec:
                problems.append(f"row label {label!r} carries figures but says "
                                f"no statistic — add it to LABEL_SPECS")
                continue
            subjects = arms + [c for c in row_arms(label) if c not in arms]
            missing = check_cell(ev, cell, subjects, row_spec, table_metric)
            if missing:
                problems.append(f"{normalise_label(head[i])}: {sorted(missing)} "
                                f"is not {'/'.join(row_spec[0])}")
            continue
        if not row_subjects:
            return "row carries figures but names no arm, and no column does either"
        spec = spec_for(head[i]) if i < len(head) else None
        if not spec:
            problems.append(
                f"column {normalise_label(head[i]) if i < len(head) else i!r} "
                f"carries {sorted(figs)} but says no statistic — add it to "
                f"LABEL_SPECS or the figure is unchecked")
            continue
        missing = check_cell(ev, cell, row_subjects, spec, table_metric)
        if missing:
            problems.append(
                f"{normalise_label(head[i])}: {sorted(missing)} is not "
                f"{'/'.join(spec[0])} of {' − '.join(row_subjects[:2])} "
                f"in {','.join(ev.tags)}")
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
