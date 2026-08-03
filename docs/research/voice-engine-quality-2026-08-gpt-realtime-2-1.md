# Addendum: gpt-realtime-2.1 and 2.1-mini

Run 2026-08-03, against the same fixtures, scenarios and scorers as
[the main report](./voice-engine-quality-2026-08.md). Spend **$7.41** (cap $12).

Deployments `gpt-realtime-2.1` and `gpt-realtime-2.1-mini`, both dated
2026-07-07 on `duguet-labs-eu`, same Foundry GA surface as `gpt-realtime-2`.

---

## The answer

**The split recommendation stands, with one substitution: booking businesses
should use `gpt-realtime-2.1` rather than `gpt-realtime-2`.** It is the same
model family on quality and materially faster — p95 falls 3325 → 2560 ms, a 23 %
reduction, for no loss of groundedness.

**2.1 does not collapse the split, and 2.1-mini is not the single default.**

| | Voice Live + gpt-4.1-mini | gpt-realtime-2 | **gpt-realtime-2.1** | gpt-realtime-2.1-mini |
|---|---|---|---|---|
| TTFA p50 | **1315 ms** | 2077 ms | 1876 ms | **1194 ms** |
| TTFA p95 | **1719 ms** | 3325 ms | 2560 ms | 1839 ms |
| Judge groundedness | 0.741 | **0.926** | **0.926** | 0.741 |
| Slots heard | **0.960** | 0.893 | 0.893 | 0.893 |
| Slots echoed back | 0.697 | 0.816 | **0.924** | 0.898 |
| Strict success | 0.370 | **0.519** | 0.370 | 0.148 |
| Cost | **$0.03/min** | $0.07/min | $0.07/min | $0.035/min |

Taking the four questions in turn.

**Does 2.1 keep gpt-realtime-2's groundedness? Yes.** 0.926 against 2's 0.926 in
the same judge pass, and stable across two seeds (2.1: 0.926 / 0.926; 2: 0.939 /
0.909). The groundedness families are unambiguous and hold under reseeding:
gpt-realtime-2, 2.1 and Voice-Live-served gpt-realtime-2 sit at 0.91–0.97; every
gpt-4.1-mini arm **and 2.1-mini** sit at 0.73–0.82.

**Does it close the slot-capture gap? No — and it structurally cannot.** 0.893,
identical to gpt-realtime-2 to three decimals. Track A makes the reason
unambiguous: across 300 conditioned clips per arm, `gpt-realtime-2`,
`gpt-realtime-2.1` and `gpt-realtime-2.1-mini` returned **byte-identical
transcripts, 300/300 for both new arms**. Caller transcription on the Foundry GA
surface is `whisper-1`, requested explicitly in
`session.audio.input.transcription.model`; the realtime brain never touches it.
The 0.893-vs-0.960 gap is whisper-1 versus azure-speech, so **no gpt-realtime
version can close it.** Only changing the recogniser can.

**Is it fast enough to matter? It is much better, and still not Voice Live.**
p50 2077 → 1876 ms (−201), p95 3325 → 2560 ms (−765). That is the largest
single improvement in this addendum. But Voice Live remains ~560 ms ahead at p50
and ~840 ms at p95. (These are Track B by-products; task #13 measured latency
directly and its numbers should be preferred where they differ.)

**Is 2.1-mini the single-default answer? No.** It is genuinely fast — 1194 ms
p50, *faster than Voice Live* — and half the cost of 2.1. But its groundedness
is 0.741, squarely in the gpt-4.1-mini band, not the gpt-realtime band. It buys
the latency of the cheap tier by giving up exactly the property that justified
the expensive one. Its strict success, 0.148, is the lowest of any arm tested.

---

## What did not move, and why that is the honest reading

**2.1's strict success is *lower* than 2's — 0.370 against 0.519 — and I do not
believe the difference.** Stripping the judge clause entirely gives a fully
deterministic score, and there the three headline components are *identical*:

| | slots all heard | `end_call` | grounded strings | deterministic success |
|---|---|---|---|---|
| `native-gpt-realtime-2` | 0.778 | 0.667 | 1.000 | 0.593 |
| `native-gpt-realtime-21` | 0.778 | 0.667 | 1.000 | 0.444 |

Every component is equal; only the *conjunction* differs, because the two arms
fail on different runs. At 27 runs per arm that is a four-run gap on a metric
where one run is 0.037, and the main report already flags strict success as the
figure most exposed to noise and to the approximate time matcher. **Read 2 and
2.1 as equivalent on task success**, and take the latency improvement as the
real difference.

`native-gpt-realtime-21` did score best of any arm on slots *echoed back*
(0.924) — it confirms details to the caller more often — but that is one metric
at the same n and should not carry a decision on its own.

---

## Method notes

**Incumbent numbers differ slightly from the main report.** All seven arms were
re-judged together in a single pass, so the comparison here is internally
consistent, but the LLM judge is not perfectly reproducible: two seeds agreed on
groundedness 214/219 (**97.7 %**), resolution 95.0 %, tone 76.3 %. That moves an
incumbent arm's strict success by a run or two versus the merged report — for
example `native-gpt-realtime-2` reads 0.519 here against 0.593 there, on
identical call data. **Compare arms within this table, not across documents.**

**Track A was run on six conditions, not eight.** Kept: `clean` (needed as the
dWER/SNR₅₀ baseline), `cafe_snr10`, `cafe_snr5`, `cafe_snr0` and
`tel_cafe_snr10`. Cut: `cafe_snr20` and `tel_loss3`, the two conditions where
the incumbent arms differed least (max between-arm spread 1.17 and 0.54 WER
points respectively, against 14.03 for `cafe_snr0`). `cafe_snr5` was kept beyond
the minimum so the SNR curve still has three points and SNR₅₀ remains
computable.

In hindsight the whole of Track A was structurally redundant for this question —
shared `whisper-1` guaranteed identical transcripts — but that was an assumption
until measured, and $3.06 to turn it into a fact that rules out an entire class
of future change ("try a newer realtime model to fix slot capture") is worth it.

**Everything the main report carries forward applies here**, and is not repeated:
the recogniser is given the caller's language while production is not, so the
absolute rates are optimistic; scripted turns continue past `end_call`; barge-in
is not measured; and time-slot matching is approximate in the inflating
direction. Seven of the 54 new runs contained a cancelled response and are
excluded from the latency percentiles by `ttfa_trustworthy`.

## Cost

| | Track A min | Track B min | $/min | $ |
|---|---|---|---|---|
| `gpt-realtime-2.1` | 52.5 | 13.5 | 0.070 | 4.62 |
| `gpt-realtime-2.1-mini` | 52.5 | 11.6 | 0.035 | 2.24 |
| judge, 2 passes × 219 runs | | | | 0.55 |
| **total** | | | | **7.41** |
