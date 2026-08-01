#!/usr/bin/env python3
"""Turn the raw turns.jsonl into the tables that go in the report.

Two views:

  Marginal — per-arm distribution of every metric (min, p50, p90, p99, IQR).
  Paired   — for each proxy pair, the per-cell difference on identical
             (round, utterance) input. Paired differences cancel the network
             and time-of-day noise that dominates the marginals, so this is
             the view that actually answers "does the proxy cost anything".

Significance uses a two-sided exact sign test plus a bootstrap CI on the
median difference — both distribution-free, so no scipy dependency and no
normality assumption about latency (which is never normal).

Two guards stop a bare p < 0.05 from minting a directional claim:

  Holm–Bonferroni over the whole family of paired tests in this run
      (3 comparisons x len(METRICS) metrics = 21). Under the null, one
      spurious rejection is expected at that many tests, so an uncorrected
      table would reliably manufacture a finding.
  A practical floor (PRACTICAL_MS). A 6 ms median shift on a metric whose
      IQR is ~50 ms is noise wearing a significance badge, however small its
      p-value gets with enough pairs.

A result is only reported directionally when it clears both.

  python analyze.py results/turns-20260801-2130.jsonl [--markdown out.md]
"""
from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from arms import ARMS_BY_ID, PAIRS, TURN_DETECTION  # noqa: E402

METRICS = [
    ("ttfa_ms", "time to first agent audio, from end of caller speech"),
    ("speech_stopped_ms",
     "the VAD's own end-of-turn decision, isolated from model and TTS time"),
    ("ttft_ms", "time to first agent text/transcript delta"),
    ("transcript_ms", "time to the caller's own transcript"),
    ("response_total_ms", "time to response.done"),
    ("connect_ms", "dial to WebSocket open"),
    ("config_ms", "session.update to our own session.updated echo"),
]
HANGOVER_MS = TURN_DETECTION["silence_duration_ms"]
BOOTSTRAP = 20000
ALPHA = 0.05

# Below this, a difference is reported as "no practical difference" no matter
# what the p-value says. Conversational turn-taking tolerates far more than
# this — gaps only become perceptible to a caller in the 100+ ms range — so
# 50 ms is a conservative floor that still admits anything worth acting on.
PRACTICAL_MS = 50.0


def pct(xs: list[float], p: float) -> float:
    """Nearest-rank percentile — no interpolation games on small n."""
    if not xs:
        return float("nan")
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, math.ceil(p / 100 * len(s)) - 1))]


def describe(xs: list[float]) -> dict:
    if not xs:
        return {}
    q1, q3 = pct(xs, 25), pct(xs, 75)
    return {"n": len(xs), "min": min(xs), "p50": statistics.median(xs),
            "p90": pct(xs, 90), "p99": pct(xs, 99), "max": max(xs),
            "iqr": q3 - q1, "q1": q1, "q3": q3}


def sign_test_p(diffs: list[float]) -> float:
    """Two-sided exact sign test. Ties are dropped (standard practice)."""
    pos = sum(1 for d in diffs if d > 0)
    neg = sum(1 for d in diffs if d < 0)
    n = pos + neg
    if n == 0:
        return 1.0
    k = min(pos, neg)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def bootstrap_median_ci(diffs: list[float], iters: int = BOOTSTRAP,
                        seed: int = 20260801) -> tuple[float, float]:
    if not diffs:
        return (float("nan"), float("nan"))
    rng = random.Random(seed)
    n = len(diffs)
    meds = sorted(statistics.median(rng.choices(diffs, k=n)) for _ in range(iters))
    return meds[int(0.025 * iters)], meds[int(0.975 * iters)]


def load(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def fmt(v) -> str:
    return "—" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v:.0f}"


def marginal_table(turns: list[dict], metric: str) -> list[str]:
    rows = ["| arm | brain | n | min | p50 | p90 | p99 | IQR |",
            "|---|---|---:|---:|---:|---:|---:|---:|"]
    for arm_id in ARMS_BY_ID:
        xs = [t[metric] for t in turns
              if t["arm"] == arm_id and t["ok"] and t.get(metric) is not None]
        if not xs:
            continue
        d = describe(xs)
        rows.append(f"| `{arm_id}` | {ARMS_BY_ID[arm_id].brain} | {d['n']} | "
                    f"{fmt(d['min'])} | **{fmt(d['p50'])}** | {fmt(d['p90'])} | "
                    f"{fmt(d['p99'])} | {fmt(d['iqr'])} |")
    return rows


def paired(turns: list[dict], treat: str, ctrl: str, metric: str) -> list[float]:
    """Difference per (round, utterance) cell — the same caller audio on both
    arms, moments apart."""
    by_cell: dict[tuple, dict[str, float]] = defaultdict(dict)
    for t in turns:
        if t["arm"] in (treat, ctrl) and t["ok"] and t.get(metric) is not None:
            by_cell[(t["round"], t["utterance"])][t["arm"]] = t[metric]
    return [c[treat] - c[ctrl] for c in by_cell.values()
            if treat in c and ctrl in c]


def fisher_exact_p(a: int, b: int, c: int, d: int) -> float:
    """Two-sided Fisher exact test on a 2x2 table.

        [[a, b],
         [c, d]]

    Sums the probability of every table with the same margins that is at least
    as extreme as the observed one. Exact rather than chi-square because the
    split-rate counts are small and often contain a zero cell, where the
    asymptotic approximation is worthless.
    """
    n = a + b + c + d
    if n == 0:
        return 1.0
    row1, col1 = a + b, a + c

    def prob(x: int) -> float:
        return (math.comb(row1, x) * math.comb(n - row1, col1 - x)
                / math.comb(n, col1))

    observed = prob(a)
    lo = max(0, col1 - (n - row1))
    hi = min(row1, col1)
    # 1e-9 slack: equally-extreme tables must count, and float error would
    # otherwise drop them and understate p
    return min(1.0, sum(prob(x) for x in range(lo, hi + 1)
                        if prob(x) <= observed * (1 + 1e-9)))


def split_rate_table(turns: list[dict]) -> list[str]:
    """Per-pair comparison of how often server VAD chopped the utterance.

    This is a rate, not a latency, so it gets a Fisher test rather than the
    sign test — and it is deliberately kept out of the Holm family above,
    which covers the paired latency metrics.
    """
    present = {t["arm"] for t in turns}
    pairs = [p for p in PAIRS if p[0] in present and p[1] in present]
    rows = ["| comparison | treatment splits | control splits | Fisher p |",
            "|---|---:|---:|---:|"]
    any_row = False
    for treat, ctrl, question in pairs:
        tt = [t for t in turns if t["arm"] == treat]
        ct = [t for t in turns if t["arm"] == ctrl]
        if not tt or not ct:
            continue
        a = sum(1 for t in tt if t.get("false_starts"))
        c = sum(1 for t in ct if t.get("false_starts"))
        if a == 0 and c == 0:
            continue                      # nothing split either side
        p = fisher_exact_p(a, len(tt) - a, c, len(ct) - c)
        rows.append(f"| `{treat}` vs `{ctrl}`<br><sub>{question}</sub> | "
                    f"{a}/{len(tt)} | {c}/{len(ct)} | {p:.4f} |")
        any_row = True
    return rows if any_row else []


def holm(pvals: list[float]) -> list[float]:
    """Holm–Bonferroni adjusted p-values, returned in the input order.

    Step-down: sort ascending, scale the k-th smallest by (m - k), then enforce
    monotonicity so an adjusted value never drops below one ranked before it.
    Uniformly more powerful than Bonferroni and needs no independence
    assumption — which matters here, since the metrics are correlated
    (`ttfa` and `ttft` measure overlapping stages of the same turn).
    """
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    adj = [1.0] * m
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, (m - rank) * pvals[i])
        adj[i] = min(1.0, running)
    return adj


@dataclass
class PairedResult:
    metric: str
    treat: str
    ctrl: str
    question: str
    diffs: list[float]
    median: float
    lo: float
    hi: float
    p_raw: float
    p_adj: float = 1.0

    @property
    def practical(self) -> bool:
        return abs(self.median) >= PRACTICAL_MS

    @property
    def survives(self) -> bool:
        """Directional claims require BOTH a corrected p and a real effect."""
        return self.p_adj < ALPHA and self.practical

    def verdict(self) -> str:
        direction = "slower" if self.median > 0 else "faster"
        if self.survives:
            return f"**{direction} by {abs(self.median):.0f} ms**"
        if not self.practical:
            # too small to matter however the p-value lands
            return (f"no practical difference (<{PRACTICAL_MS:.0f} ms)"
                    + (" despite p<0.05" if self.p_raw < ALPHA else ""))
        if self.p_raw < ALPHA:
            return f"borderline — {direction} by {abs(self.median):.0f} ms, not robust to Holm"
        return "no detectable difference"


def compute_paired(turns: list[dict], metrics: list[str]) -> dict[str, list[PairedResult]]:
    """Every paired test in this run, Holm-corrected as one family.

    The correction spans all metrics, not just the three within a table —
    a reader scanning the whole report is implicitly looking at all of them,
    so that is the family the error rate has to be controlled over.
    """
    present = {t["arm"] for t in turns}
    pairs = [p for p in PAIRS if p[0] in present and p[1] in present]
    results: list[PairedResult] = []
    for metric in metrics:
        for treat, ctrl, question in pairs:
            diffs = paired(turns, treat, ctrl, metric)
            if not diffs:
                continue
            lo, hi = bootstrap_median_ci(diffs)
            results.append(PairedResult(
                metric=metric, treat=treat, ctrl=ctrl, question=question,
                diffs=diffs, median=statistics.median(diffs), lo=lo, hi=hi,
                p_raw=sign_test_p(diffs)))
    for r, p_adj in zip(results, holm([r.p_raw for r in results])):
        r.p_adj = p_adj
    by_metric: dict[str, list[PairedResult]] = defaultdict(list)
    for r in results:
        by_metric[r.metric].append(r)
    return by_metric


def paired_table(results: list[PairedResult]) -> list[str]:
    rows = ["| comparison | pairs | median Δ | 95% CI | p90 Δ | p (raw) | p (Holm) | verdict |",
            "|---|---:|---:|---|---:|---:|---:|---|"]
    for r in results:
        rows.append(
            f"| `{r.treat}` − `{r.ctrl}`<br><sub>{r.question}</sub> | {len(r.diffs)} | "
            f"**{r.median:+.0f}** | [{r.lo:+.0f}, {r.hi:+.0f}] | {pct(r.diffs, 90):+.0f} | "
            f"{r.p_raw:.3f} | {r.p_adj:.3f} | {r.verdict()} |")
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results", type=Path)
    ap.add_argument("--markdown", type=Path, default=None)
    args = ap.parse_args()

    turns = load(args.results)
    ok = [t for t in turns if t["ok"]]
    paired_results = compute_paired(ok, [m for m, _ in METRICS])
    n_tests = sum(len(v) for v in paired_results.values())
    out: list[str] = []

    def w(s: str = "") -> None:
        out.append(s)

    w(f"Turns: {len(ok)}/{len(turns)} usable "
      f"({len(turns) - len(ok)} failed or produced no audio).")
    w()
    w(f"**{n_tests} paired hypothesis tests** in this run "
      f"({n_tests // max(1, len(METRICS))} comparisons x {len(METRICS)} metrics "
      f"present in this dataset). At α={ALPHA} that is "
      f"~{n_tests * ALPHA:.1f} spurious rejections expected under the null, so "
      f"p-values are Holm-corrected across the whole family. A directional verdict "
      f"additionally requires a median shift of at least {PRACTICAL_MS:.0f} ms; "
      f"anything smaller reads as no practical difference however its p-value lands.")
    w()
    errs: dict[str, int] = defaultdict(int)
    for t in turns:
        if not t["ok"]:
            errs[f'{t["arm"]}: {t["error"][:80]}'] += 1
    if errs:
        w("Failures:")
        w()
        for k, v in sorted(errs.items(), key=lambda kv: -kv[1]):
            w(f"- {v}x {k}")
        w()

    w(f"### `ttfa_ms` — headline metric")
    w()
    w(f"Measured from the end of the caller's streamed speech. It includes the "
      f"server-VAD hangover we configured (`silence_duration_ms = {HANGOVER_MS}`), "
      f"which is a constant we chose, not engine latency. Subtract {HANGOVER_MS} ms "
      f"from every number below for the engine-only figure.")
    w()
    w("\n".join(marginal_table(ok, "ttfa_ms")))
    w()
    w(f"Engine-only (raw − {HANGOVER_MS} ms hangover):")
    w()
    adj = [dict(t, ttfa_ms=t["ttfa_ms"] - HANGOVER_MS) for t in ok
           if t.get("ttfa_ms") is not None]
    w("\n".join(marginal_table(adj, "ttfa_ms")))
    w()
    w("Paired differences (identical caller audio, same round):")
    w()
    w("\n".join(paired_table(paired_results.get("ttfa_ms", []))))
    w()

    for metric, blurb in METRICS:
        if metric == "ttfa_ms":
            continue
        rows = marginal_table(ok, metric)
        if len(rows) <= 2:
            continue
        w(f"### `{metric}` — {blurb}")
        w()
        w("\n".join(rows))
        w()
        if paired_results.get(metric):
            w("\n".join(paired_table(paired_results[metric])))
            w()

    # reply length, as a sanity check that arms are doing comparable work
    w("### Reply length (sanity check — arms should be answering comparably)")
    w()
    w("| arm | median audio out (ms) | median reply |")
    w("|---|---:|---|")
    for arm_id in ARMS_BY_ID:
        xs = [t for t in ok if t["arm"] == arm_id and t.get("audio_out_ms")]
        if not xs:
            continue
        med = statistics.median(t["audio_out_ms"] for t in xs)
        sample = sorted(xs, key=lambda t: t["audio_out_ms"])[len(xs) // 2]
        w(f"| `{arm_id}` | {med:.0f} | {sample['transcript'][:70]!r} |")
    w()

    # False starts: server VAD splitting an utterance at a clause pause. If one
    # arm splits far more often than another, the arms are not hearing the same
    # turn structure and the ttfa comparison needs a caveat.
    w("### VAD false starts (utterance split at a clause pause, response cancelled)")
    w()
    w("| arm | turns | turns with >=1 false start | total false starts |")
    w("|---|---:|---:|---:|")
    for arm_id in ARMS_BY_ID:
        xs = [t for t in turns if t["arm"] == arm_id]
        if not xs:
            continue
        n_any = sum(1 for t in xs if t.get("false_starts"))
        tot = sum(t.get("false_starts", 0) for t in xs)
        w(f"| `{arm_id}` | {len(xs)} | {n_any} | {tot} |")
    w()
    by_utt: dict[str, int] = defaultdict(int)
    for t in turns:
        if t.get("false_starts"):
            by_utt[t["utterance"]] += t["false_starts"]
    if by_utt:
        w("By utterance: " + ", ".join(f"`{k}` {v}" for k, v in sorted(by_utt.items())))
        w()
    srt = split_rate_table(turns)
    if srt:
        w("Split rate per comparison (Fisher exact, two-sided — a rate, so it is "
          "not part of the Holm family over the paired latency metrics):")
        w()
        w("\n".join(srt))
        w()

    text = "\n".join(out)
    print(text)
    if args.markdown:
        args.markdown.write_text(text + "\n")
        print(f"\nwrote {args.markdown}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
