# Addendum: gpt-realtime-2.1 and 2.1-mini

Run 2026-08-03, extended the same day with a Voice-Live-served 2.1 arm.
Against the same fixtures, scenarios and scorers as
[the main report](./voice-engine-quality-2026-08.md). Spend **$8.85** (cap $12).

Deployments `gpt-realtime-2.1` and `gpt-realtime-2.1-mini`, both dated
2026-07-07 on `duguet-labs-eu`, same Foundry GA surface as `gpt-realtime-2`.

---

## Does a Voice-Live-served gpt-realtime collapse the split? No — it gets 0.920, not 0.960

The hypothesis was that Voice Live's `azure-speech` plus a gpt-realtime brain
would give best-in-class slot capture *and* groundedness at once. **The first
half is confirmed and the second is not, for a reason that is structural.**

**Voice Live serves gpt-realtime-2.1 with `azure-speech`.** Read off the echo,
not assumed:

```
model=gpt-realtime-2.1  ->  session.model = "gpt-realtime-2.1-global-standard"
                            input_audio_transcription = {"model": "azure-speech", …}
```

And the caller transcripts confirm it empirically: `vl-native-brain-21` matches
the other Voice Live arms 10/27 and the Foundry 2.1 arm **1/27**. The recogniser
follows the **surface**, not the brain — the mirror image of the whisper-1
finding.

**But slot capture lands at 0.920, not 0.960, and the missing 0.040 is the VAD.**
Voice Live *rejects* `server_vad` for a gpt-realtime brain — "turn_detection
must be of type AzureSemanticVAD" — so semantic VAD is forced. Holding the
recogniser fixed and varying only the VAD isolates the cost:

| recogniser | VAD | brain | slots heard |
|---|---|---|---|
| azure-speech | server_vad | gpt-4.1-mini | **0.960** |
| azure-speech | semantic | gpt-4.1-mini | 0.920 |
| azure-speech | semantic | gpt-realtime-2 | 0.920 |
| azure-speech | semantic | gpt-realtime-2.1 | 0.920 |
| whisper-1 | server_vad | gpt-realtime-2 / 2.1 | 0.893 |

**Slot capture is a function of (recogniser, VAD) and nothing else.** Three
different brains on azure-speech + semantic VAD give 0.920 to three decimals;
two gpt-realtime versions on whisper-1 give 0.893. The brain does not enter.

So 0.960 is unreachable with a gpt-realtime brain: it requires `server_vad`,
which that combination is not allowed to use.

### What the tier is actually worth

| | VL + gpt-4.1-mini | **VL + 2.1** | Foundry 2.1 |
|---|---|---|---|
| slots heard | **0.960** | 0.920 | 0.893 |
| judge groundedness | 0.778 | **0.926** | **0.963** |
| strict success | 0.407 | **0.481** | 0.407 |
| pass^3 | 0.333 | **0.444** | 0.222 |
| TTFA p50 / p95 | **1315 / 1719** | 2087 / 2975 | 1876 / **2560** |
| cost | **$0.03/min** | $0.07/min | $0.07/min |

**A Voice-Live-served 2.1 tier is worth adding, and it is the best booking tier
tested** — better slot capture than Foundry 2.1 (0.920 vs 0.893, structural) and
the joint-best pass^3 at 0.444. Against Foundry 2.1 it trades ~210 ms of p50 and
415 ms of p95 for those gains; the success and pass^3 differences are two runs
and two scenarios at n=27, so treat the slot-capture gain as the solid part.

**It does not replace the information-only tier.** Voice Live + gpt-4.1-mini
remains 770 ms faster at p50 and less than half the price, and still holds the
only 0.960 slot capture on offer. **The split stands** — it just gets a better
booking tier.

---

## The answer

**The split recommendation stands, with one substitution: booking businesses
should use `gpt-realtime-2.1` rather than `gpt-realtime-2`.** It is the same
model family on quality and materially faster — p95 falls 3325 → 2560 ms, a 23 %
reduction, for no loss of groundedness.

**2.1 does not collapse the split, and 2.1-mini is not the single default.**

| | VL + gpt-4.1-mini | gpt-realtime-2 | **gpt-realtime-2.1** | 2.1-mini |
|---|---|---|---|---|
| TTFA p50 | **1315 ms** | 2077 ms | 1876 ms | **1194 ms** |
| TTFA p95 | **1719 ms** | 3325 ms | 2560 ms | 1839 ms |
| Judge groundedness | 0.778 | 0.926 | **0.963** | 0.667 |
| Slots heard | **0.960** | 0.893 | 0.893 | 0.893 |
| Slots echoed back | 0.697 | 0.816 | **0.924** | 0.898 |
| Strict success | 0.407 | **0.556** | 0.407 | 0.185 |
| pass^3 | 0.333 | **0.444** | 0.222 | 0.111 |
| Cost | **$0.03/min** | $0.07/min | $0.07/min | $0.035/min |

*All figures from `bench/quality/results/summary.csv`, the single judge pass
covering all eight arms. An earlier draft of this table carried the pre-extension
pass and is superseded; the CSV is authoritative — `check_report.py` verifies
every figure in this document against it.*

### The tension in that table, stated rather than smoothed

**2.1 does not beat 2 on strict success — 2 leads 0.556 to 0.407, and on pass^3
0.444 to 0.222.** A recommendation to substitute 2.1 for 2 has to answer that
rather than quote only the columns where 2.1 wins.

The judge-free view says the two are not distinguishable on task success. Every
deterministic component is *identical*:

| | slots all heard | `end_call` | grounded strings | deterministic success |
|---|---|---|---|---|
| `native-gpt-realtime-2` | 0.778 | 0.667 | 1.000 | 0.593 |
| `native-gpt-realtime-21` | 0.778 | 0.667 | 1.000 | 0.444 |

Only the *conjunction* differs, because the two fail on different runs. The gap
is **4 runs of 27**, spread across three scenarios at one or two runs each
(`hours-en-01` 3/3 vs 1/3, `emergency-de-01` 3/3 vs 2/3, `codeswitch-01` 1/3 vs
0/3) — no concentration, no mechanism. And pass^3 at k=3 over nine scenarios
moves in steps of 0.111, so a two-scenario difference is the second-coarsest
value the metric can take.

Strict success is also the metric this study flags as least trustworthy: noisiest
at this n, and inflated in an unmeasured direction by the approximate time
matcher.

**So the supported claim is narrower than "2.1 substitutes cleanly for 2":**

> gpt-realtime-2.1 is **better grounded** (0.963 vs 0.926) and **materially
> faster** (p95 2560 vs 3325 ms, −23 %). On strict task success the data **does
> not separate them** at 27 runs per arm — the deterministic components are
> identical and the point estimate favours 2 by four runs. Prefer 2.1 for the
> groundedness and the latency, not on a claim that it completes more calls.

That is a weaker claim than the earlier draft and it is the one the numbers
carry.

Taking the four questions in turn.

**Does 2.1 keep gpt-realtime-2's groundedness? Yes — and slightly exceeds it.**
0.963 against 2's 0.926 in the same judge pass. Two families separate cleanly in
the current pass, and 2.1-mini belongs to neither:

| family | arms | groundedness (seed 1) | (seed 2) |
|---|---|---|---|
| gpt-realtime brains | `native-2`, `native-21`, `vl-native-brain`, `vl-native-brain-21` | 0.926–0.963 | 0.889–0.963 |
| gpt-4.1-mini | `vl-gpt41mini`, `-dns`, `-semvad` | 0.778–0.815 | 0.704–0.815 |
| gpt-realtime-2.1-mini | `native-21-mini` | **0.667** | 0.778 |

The family separation holds under reseeding — no gpt-realtime arm falls into the
gpt-4.1-mini band on either seed. **2.1-mini's rank does not.** It is below every
gpt-4.1-mini arm on seed 1 and above two of the three on seed 2, so "worse than
the cheap tier" is a seed-1 result, not a stable one. What survives both seeds is
that it sits well below the gpt-realtime band its name suggests it belongs to.

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

**Is 2.1-mini the single-default answer? No, and less so than first written.**
It is genuinely fast — 1194 ms p50, *faster than Voice Live* — and half the cost
of 2.1. But its groundedness is **0.667**, far below the gpt-realtime band on
both seeds: it buys the cheap tier's latency by giving up the property that
justified paying for the expensive one. Its strict success, 0.185, and its
pass^3, 0.111, are the lowest of any arm tested. Whether it is also worse than
the gpt-4.1-mini arms is seed-dependent (above), so the case against it rests on
the gpt-realtime gap and on task success, not on that ordering.

---

## What did not move, and why that is the honest reading

The 2-versus-2.1 strict-success gap is reconciled above under the headline
table; it is four runs of 27 with identical deterministic components.

`native-gpt-realtime-21` did score best of any arm on slots *echoed back*
(0.924) — it confirms details to the caller more often — but that is one metric
at the same n and should not carry a decision on its own.

---

## Method notes

**Incumbent numbers differ slightly from the main report.** All eight arms were
re-judged together in a single pass, so the comparison here is internally
consistent, but the LLM judge is not perfectly reproducible. That moves an
incumbent arm's strict success by a run or two versus the merged report — for
example `native-gpt-realtime-2` reads 0.556 here against 0.593 in the merged
report, on identical call data. **Compare arms within this table, not across documents.**

**Judge reliability, recomputed against the pass the report actually quotes.**
`results/judge.csv` (seed 1, 246 rows, eight arms) against
`results/judge_seed2.csv` (seed 2, 219 rows, seven arms — the second pass predates
`vl-native-brain-21` and does not cover it). Agreement over the **219 rows
present in both**, keyed on `(scenario, arm, trial)`:

| field | agreement |
|---|---|
| groundedness | 209/219 (**95.4 %**) |
| resolution | 204/219 (93.2 %) |
| tone | 170/219 (77.6 %) |

Both files span all 11 scenarios, including the two barge-in ones that are judged
but not scored; the reported rates in `summary.csv` use only the 9 scored ones.
Groundedness — the load-bearing metric here — is the most reproducible of the
three, and tone is the least, which is why no claim in this report rests on tone.

An earlier draft quoted 97.7 / 95.0 / 76.3 % from the *pre-extension* judge file.
Those figures described a smaller pass than the numbers they were vouching for;
the table above is computed from the two files named in it.

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
direction. **Ten of the 81 new runs** contained a cancelled response and are
excluded from the latency percentiles by `ttfa_trustworthy` (4 `native-21`,
3 `native-21-mini`, 3 `vl-native-brain-21`; 17 of 216 across all arms).

## The STT vocabulary prompt: rejected outright, and not the cause of `book-de-01`

PR #7 found `transcription.prompt` echoed back `null` on the 2.1 tiers and on
HD. Probing directly gives the reason, and it is stronger than a silent discard:

```
input_audio_transcription = {"model": "azure-speech", "prompt": "Telefonat bezüglich: …"}
  -> error: "prompt is not yet supported for azure-speech.
             This feature will be supported in a future update."
```

The same error comes back on `gpt-4.1-mini` (the HD tier) and on
`gpt-realtime-2.1`. So **`sttVocab` cannot be applied on any azure-speech tier
at all** — every Voice Live tier, including HD. It works only on the Foundry
surface, where transcription is whisper-1, which is exactly why gpt-realtime-2
echoed it verbatim. That is a real gap worth fixing in the gateway (strip it, or
translate it to `phrase_list`, which the same echo shows the API does expose).

**But it is not the cause of `book-de-01` failing 15/15.** `sttVocab` is built
from the business name, agent name, service names and address — it contains no
caller names by construction. Checked against the frozen fixture: none of
`Kathrin`, `Schröder`, `Ferenc`, `Nagy`, `Jonathan`, `Reeves`, `Amelia`, `Hart`,
`Priya` or `Raman` appears in it. A working vocab prompt could not have biased
the recogniser toward "Kathrin", because "Kathrin" was never going to be in it.

My own logs cannot corroborate PR #7 either way: this harness never sends a
prompt on any arm, so `prompt: null` in every committed log is my omission, not
the service's. The probe above is the evidence, not the logs.

## Cost

| | Track A min | Track B min | $/min | $ |
|---|---|---|---|---|
| `gpt-realtime-2.1` | 52.5 | 13.5 | 0.070 | 4.62 |
| `gpt-realtime-2.1-mini` | 52.5 | 11.6 | 0.035 | 2.24 |
| judge, 2 passes × 219 runs | | | | 0.55 |
| `vl-native-brain-21` Track B | — | 11.8 | 0.070 | 0.82 |
| run lost to a hung handshake (see below) | — | ~4.5 | 0.070 | 0.32 |
| judge re-run over 246 runs | | | | 0.30 |
| **total** | | | | **8.85** |

### One harness fix this run forced

A Voice Live session accepted the TCP connection and then never sent
`session.created`. `websockets.connect` has no default timeout, so the run
stopped dead for 13 minutes on a zero-byte log with no error raised — the
"operational hang" `COMPLETENESS.md` listed as documented-not-fixed, reached by
a route it did not anticipate. `connect_kwargs` now sets `open_timeout=30` and
keepalive pings, so a stalled handshake fails instead of hanging.

Chasing that exposed a limit in the wall-clock bound added alongside it:
`asyncio.wait_for` schedules its cancellation *on the event loop*, so it cannot
fire while the loop itself is blocked — and both `az` (credential lookup) and
`ffmpeg` (audio decode) are synchronous subprocesses on that thread. Those now
carry their own `timeout=`, which is the only thing that can bound them. What is
covered, and what is not, is enumerated in `COMPLETENESS.md`.

### The methodological lesson from extending a finished study

Review of this addendum found the same defect six times, and it is worth naming
because it will recur on the next extension: **extending a study invalidates
prose that quoted the original pass, and prose does not fail CI.**

Every instance had the same shape — a sentence true when written, describing a
pass since re-run. A results table, a groundedness band that excluded its own
member, judge-agreement figures quoted from a smaller earlier pass, an arm count
that said "seven" after an eighth was added, a run count that said "seven of 54"
after a third new arm made it ten of 81, and a cost total in the merged report
that never equalled its own line items. None of them broke a test. All of them
would have been quoted by a reader.

The judge-agreement case is the one that mattered most: those figures are the
evidence that the LLM-judge metric can be trusted at all, and they were vouching
for a pass they had not been computed over.

Two things changed as a result:

1. **`bench/quality/check_report.py`** compares every table cell, agreement
   figure, cost total and run count in these documents against the CSVs they
   quote, and `test_scoring.py` runs it. A stale figure now fails CI. It also
   fails if it resolves *nothing*, since a parser that quietly stopped matching
   would otherwise certify a document of wrong numbers.
2. **A re-run must not overwrite the pass an existing report quotes.** This run
   re-judged all eight arms and rewrote `results/` in place, which left the
   merged report's figures unreproducible from the repository until its pass was
   restored to `results/main-report/`. The next study writes to its own
   directory.
