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

Three rules keep a verdict honest in both directions:

  Holm–Bonferroni over the whole family of paired tests in this run
      (one per comparison per metric). Under the null, roughly one spurious
      rejection is expected at that many tests, so an uncorrected table would
      reliably manufacture a finding.
  A practical floor (PRACTICAL_MS). A 6 ms median shift on a metric whose
      IQR is ~50 ms is noise wearing a significance badge, however small its
      p-value gets with enough pairs.
  Equivalence needs the whole INTERVAL, not the point estimate. A median of
      -19 ms with a CI of [-122, +60] is compatible with a 100 ms effect, so
      it is reported as "no detectable difference; CI admits up to 122 ms" —
      never as "no practical difference", which would assert something the
      data does not support.

A directional claim needs the first two; an equivalence claim needs the third.
Everything else is reported as a null with the bound the data actually gives.

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
from safety import redact, safe_print  # noqa: E402

METRICS = [
    ("ttfa_ms", "time to first agent audio, from end of caller speech"),
    ("ttfa_minus_vad_ms",
     "engine-only: ttfa minus that turn's own measured end-of-turn detection"),
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

# An equivalence claim needs enough observations for the bootstrap interval to
# mean anything. Resampling a single paired difference always returns [d, d],
# so n=1 would "prove" equivalence from one sample — and `--rounds 1` is the
# documented smoke test. Below this the interval is reported but no equivalence
# is asserted.
MIN_EQUIVALENCE_N = 10


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


def mcnemar_exact_p(b: int, c: int) -> float:
    """Exact two-sided McNemar test, from the two discordant counts.

    Fisher's exact would be WRONG here. Treatment and control observations
    are matched by construction — every pair is the same caller audio in the
    same round — and Fisher assumes two independent samples. Discarding the
    pairing overstates significance badly: for ten discordant matched cells
    Fisher reports ~1e-5 where the correct answer is 0.00195.

    Conditional on being discordant, each pair is a coin flip under the null,
    so this reduces to the same exact binomial as `sign_test_p` — which is
    the point: it is the sign test on the discordant pairs.
    """
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def split_cells(turns: list[dict], treat: str, ctrl: str) -> list[tuple[bool, bool]]:
    """(treatment split?, control split?) per complete (round, utterance) cell.

    Only turns that produced a usable measurement count. A turn that died in
    connect or config has ok=False and the default false_starts=0, and
    counting it as a clean non-split would manufacture significance out of
    failures.
    """
    by_cell: dict[tuple, dict[str, bool]] = defaultdict(dict)
    for t in turns:
        if t["arm"] in (treat, ctrl) and t["ok"]:
            by_cell[(t["round"], t["utterance"])][t["arm"]] = bool(t.get("false_starts"))
    return [(c[treat], c[ctrl]) for c in by_cell.values()
            if treat in c and ctrl in c]


def split_rate_table(turns: list[dict]) -> list[str]:
    """Per-pair comparison of how often the detector chopped the utterance.

    A matched-pair rate, so it gets exact McNemar rather than the sign test
    used for the latency metrics — and it stays out of the Holm family above,
    which covers those.
    """
    present = {t["arm"] for t in turns}
    pairs = [p for p in PAIRS if p[0] in present and p[1] in present]
    # Every comparison with data enters the correction, including those that
    # turned out to have no splits at all (p = 1). Dropping them first would
    # make the family size depend on the observed outcomes — choosing which
    # hypotheses to correct over based on their results is the same error as
    # not correcting at all. Zero-zero rows are hidden from the table but they
    # are still counted here.
    computed = []
    for treat, ctrl, question in pairs:
        cells = split_cells(turns, treat, ctrl)
        if not cells:
            continue                      # no data: not a test that was run
        t_split = sum(1 for t, _ in cells if t)
        c_split = sum(1 for _, c in cells if c)
        b = sum(1 for t, c in cells if t and not c)
        c_ = sum(1 for t, c in cells if c and not t)
        computed.append((treat, ctrl, question, cells, t_split, c_split, b, c_,
                         mcnemar_exact_p(b, c_)))
    if not computed or not any(c[4] or c[5] for c in computed):
        return []
    # Corrected within the split-rate family, separately from the latency
    # family: these are rates on the same matched cells, tested with a
    # different statistic, and merging the two families would over-correct the
    # latency metrics while under-correcting nothing.
    adj = holm([c[-1] for c in computed])
    rows = ["| comparison | cells | treatment splits | control splits "
            "| discordant (T only / C only) | McNemar p | p (Holm, split family) |",
            "|---|---:|---:|---:|---:|---:|---:|"]
    any_row = False
    hidden = 0
    for (treat, ctrl, question, cells, t_split, c_split, b, c_, p), pa in zip(computed, adj):
        if t_split == 0 and c_split == 0:
            hidden += 1                   # nothing split either side; still corrected over
            continue
        rows.append(f"| `{treat}` vs `{ctrl}`<br><sub>{question}</sub> | {len(cells)} | "
                    f"{t_split}/{len(cells)} | {c_split}/{len(cells)} | "
                    f"{b} / {c_} | {p:.5f} | {pa:.5f} |")
        any_row = True
    if hidden:
        rows.append("")
        rows.append(f"*Holm family size {len(computed)}: {hidden} comparison(s) with no "
                    f"splits on either arm are corrected over but not shown.*")
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

    @property
    def equivalent(self) -> bool:
        """True only when the WHOLE interval sits inside ±PRACTICAL_MS.

        Equivalence is a claim about what the data rules out, so it cannot be
        made from the point estimate. A median of −19 ms with a CI of
        [−122, +60] is perfectly compatible with a 100 ms effect; calling that
        "no practical difference" asserts something the data does not support.
        This is the interval form of a TOST.
        """
        return (len(self.diffs) >= MIN_EQUIVALENCE_N
                and not math.isnan(self.lo) and not math.isnan(self.hi)
                and self.lo > -PRACTICAL_MS and self.hi < PRACTICAL_MS)

    @property
    def bound_ms(self) -> float:
        """Largest effect the interval still admits, either direction."""
        if math.isnan(self.lo) or math.isnan(self.hi):
            return float("nan")
        return max(abs(self.lo), abs(self.hi))

    def verdict(self) -> str:
        direction = "slower" if self.median > 0 else "faster"
        if self.survives:
            return f"**{direction} by {abs(self.median):.0f} ms**"
        if self.p_adj < ALPHA and not self.practical:
            return (f"significant but below the {PRACTICAL_MS:.0f} ms floor "
                    f"({self.median:+.0f} ms)")
        if self.p_raw < ALPHA and self.practical:
            return f"borderline — {direction} by {abs(self.median):.0f} ms, not robust to Holm"
        if self.equivalent:
            return f"equivalent within ±{PRACTICAL_MS:.0f} ms"
        if len(self.diffs) < MIN_EQUIVALENCE_N:
            return (f"no detectable difference; n={len(self.diffs)} too small to "
                    f"claim equivalence")
        return (f"no detectable difference; CI admits up to "
                f"{self.bound_ms:.0f} ms")


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
    for t in turns:
        # Derived per turn, never from the nominal silence_duration_ms: what a
        # detector actually spends deciding differs from what we asked for, and
        # a semantic detector has no fixed hangover to subtract at all.
        t["ttfa_minus_vad_ms"] = (
            t["ttfa_ms"] - t["speech_stopped_ms"]
            if t.get("ttfa_ms") is not None and t.get("speech_stopped_ms") is not None
            else None)
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

    # Controls are only real if the endpoints honoured them. Surface any field
    # that came back different from what was asked for, before any results.
    fatals: dict[str, int] = defaultdict(int)
    warns: dict[str, int] = defaultdict(int)
    for t in turns:
        for fmsg in t.get("config_fatal") or []:
            fatals[f'{t["arm"]}: {fmsg}'] += 1
        for wmsg in t.get("config_warnings") or []:
            warns[f'{t["arm"]}: {wmsg}'] += 1
    if fatals:
        w("### Aborted: measurement-critical controls could not be confirmed")
        w()
        w("These turns were discarded, not measured. A codec or turn-detector "
          "substitution would corrupt derived figures while looking plausible.")
        w()
        for k, v in sorted(fatals.items()):
            w(f"- {v}x {k}")
        w()
    if warns:
        w("### Control divergences (recorded, not fatal)")
        w()
        for k, v in sorted(warns.items()):
            w(f"- {v}x {k}")
        w()
    # "No warnings" is not verification: a turn that failed before configuring
    # has no warnings either. Require a positively verified echo from every arm
    # that appears in the dataset.
    if any("config_verified" in t for t in turns):
        by_arm: dict[str, int] = defaultdict(int)
        for t in turns:
            if t.get("config_verified"):
                by_arm[t["arm"]] += 1
        unverified = sorted({t["arm"] for t in turns} - set(by_arm))
        if unverified:
            w(f"**Unverified arms** (no turn ever confirmed its controls): "
              f"{', '.join('`' + a + '`' for a in unverified)}. Their numbers "
              f"rest on unchecked settings.")
            w()
        elif not fatals and not warns:
            w(f"Controls verified: every arm confirmed the audio format, sample "
              f"rate, turn detection, voice and STT model it was asked for on "
              f"{min(by_arm.values())}+ turns each.")
            w()
    n_tr_timeout = sum(1 for t in turns if t.get("transcript_timed_out"))
    if n_tr_timeout:
        w(f"{n_tr_timeout} turn(s) never produced a caller transcript within the "
          f"grace window; their `transcript_ms` is missing rather than fast.")
        w()

    w(f"### `ttfa_ms` — headline metric")
    w()
    w(f"Measured from the end of the caller's streamed speech, so it includes the "
      f"detector's end-of-turn delay. We configured `silence_duration_ms = "
      f"{HANGOVER_MS}`, but that nominal value is NOT what any arm actually spends: "
      f"the measured `speech_stopped_ms` runs ~190 ms above it under server VAD, and "
      f"a semantic detector has no fixed hangover at all. The engine-only view below "
      f"therefore subtracts each turn's own measured `speech_stopped_ms`, not a "
      f"constant.")
    w()
    w("\n".join(marginal_table(ok, "ttfa_ms")))
    w()
    w("Engine-only — per turn, `ttfa_ms − speech_stopped_ms` (inference + synthesis, "
      "with that turn's actual end-of-turn detection removed). Turns with no "
      "`speech_stopped` event are excluded rather than guessed at:")
    w()
    eng = [dict(t, ttfa_minus_vad_ms=t["ttfa_ms"] - t["speech_stopped_ms"])
           for t in ok
           if t.get("ttfa_ms") is not None and t.get("speech_stopped_ms") is not None]
    n_drop = len([t for t in ok if t.get("ttfa_ms") is not None]) - len(eng)
    w("\n".join(marginal_table(eng, "ttfa_minus_vad_ms")))
    w()
    if n_drop:
        w(f"({n_drop} turn(s) excluded for a missing `speech_stopped` event.)")
        w()
    if paired_results.get("ttfa_minus_vad_ms"):
        w("\n".join(paired_table(paired_results["ttfa_minus_vad_ms"])))
        w()
    w("Paired differences (identical caller audio, same round):")
    w()
    w("\n".join(paired_table(paired_results.get("ttfa_ms", []))))
    w()

    for metric, blurb in METRICS:
        if metric in ("ttfa_ms", "ttfa_minus_vad_ms"):
            continue        # both rendered in the headline section above
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
    w("`audible` counts fragments that got as far as emitting audio — i.e. the "
      "caller was actually talked over. A split with no audible fragment is a "
      "silent re-segmentation: nothing is heard, but the model then answers a "
      "fragment of the sentence, which is invisible in testing.")
    w()
    w("| arm | turns | turns with >=1 split | total splits | of which audible | audio emitted |")
    w("|---|---:|---:|---:|---:|---:|")
    for arm_id in ARMS_BY_ID:
        xs = [t for t in turns if t["arm"] == arm_id]
        if not xs:
            continue
        n_any = sum(1 for t in xs if t.get("false_starts"))
        tot = sum(t.get("false_starts", 0) for t in xs)
        aud = sum(t.get("false_starts_audible", 0) for t in xs)
        ms = sum(t.get("false_start_audio_ms", 0.0) for t in xs)
        w(f"| `{arm_id}` | {len(xs)} | {n_any} | {tot} | {aud} | "
          f"{ms:.0f} ms |")
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
        w("Split rate per comparison — **exact McNemar**, two-sided, on complete "
          "matched cells. Matched, not independent: every pair is the same caller "
          "audio in the same round, so Fisher's exact would discard the pairing and "
          "overstate significance. **Two correction families, corrected separately:** "
          "these are rates tested with a different statistic from the paired latency "
          "metrics, so merging them would over-correct the latency family without "
          "making the rate claims any safer. Holm is applied within each:")
        w()
        w("\n".join(srt))
        w()

    text = "\n".join(out)
    safe_print(text)
    if args.markdown:
        args.markdown.write_text(redact(text) + "\n")
        safe_print(f"\nwrote {args.markdown}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
