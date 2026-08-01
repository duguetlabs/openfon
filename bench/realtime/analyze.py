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


def paired_table(turns: list[dict], metric: str) -> list[str]:
    rows = ["| comparison | pairs | median Δ | 95% CI | p90 Δ | sign-test p | verdict |",
            "|---|---:|---:|---|---:|---:|---|"]
    for treat, ctrl, question in PAIRS:
        diffs = paired(turns, treat, ctrl, metric)
        if not diffs:
            continue
        med = statistics.median(diffs)
        lo, hi = bootstrap_median_ci(diffs)
        p = sign_test_p(diffs)
        sig = p < 0.05
        verdict = ("no detectable difference" if not sig
                   else f"{'slower' if med > 0 else 'faster'} by {abs(med):.0f} ms")
        rows.append(f"| `{treat}` − `{ctrl}`<br><sub>{question}</sub> | {len(diffs)} | "
                    f"**{med:+.0f}** | [{lo:+.0f}, {hi:+.0f}] | {pct(diffs, 90):+.0f} | "
                    f"{p:.3f} | {verdict} |")
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results", type=Path)
    ap.add_argument("--markdown", type=Path, default=None)
    args = ap.parse_args()

    turns = load(args.results)
    ok = [t for t in turns if t["ok"]]
    out: list[str] = []

    def w(s: str = "") -> None:
        out.append(s)

    w(f"Turns: {len(ok)}/{len(turns)} usable "
      f"({len(turns) - len(ok)} failed or produced no audio).")
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
    w("\n".join(paired_table(ok, "ttfa_ms")))
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
        prows = paired_table(ok, metric)
        if len(prows) > 2:
            w("\n".join(prows))
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

    text = "\n".join(out)
    print(text)
    if args.markdown:
        args.markdown.write_text(text + "\n")
        print(f"\nwrote {args.markdown}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
