# Realtime voice latency: Kataleptic gateway vs. direct Azure

*Three independent runs: two 125-turn runs of the same five-arm design on 2026-08-01 and
2026-08-02, and a 100-turn four-arm replication of the two proxy pairs on 2026-08-03,
collected after the per-cell marker fix. **The proxy comparison — the question this report
exists to answer — is anchored on the third**, which is the only one free of that confound;
the five-arm sections are from the second, and all three are reported side by side. Harness
and full method in [`bench/realtime/`](../../bench/realtime/README.md); regenerable with
`bench.py --rounds 25`.*

---

> **Follow-up (2026-08-03):** `gpt-realtime-2.1` and `2.1-mini` are now on the gateway and
> are measured in [realtime-21-2026-08.md](realtime-21-2026-08.md). Both are faster than
> gpt-realtime-2 — the mini tier by a full second — and both still split utterances under
> server VAD exactly as gpt-realtime-2 does.

> **Provenance (2026-08-03): the marker confound is settled by replication rather than by
> argument.** Until `d5f3b2a` the harness drew a random `MK<8 hex>` marker **per turn**
> rather than per `(round, utterance)` cell, so the two arms of a pair were answering
> system prompts that differed in one ten-character token. `full` (08-01) and `full2`
> (08-02) both predate that change; the 2.1 report's blocks are marked for the same reason.
>
> An earlier version of this note argued the confound could not have manufactured a null:
> the marker is drawn **independently of the arm**, so it adds within-cell *variance* and
> nothing directional, and noise makes a null easier to reach rather than harder. That
> argument still holds, and it no longer has to be taken on its own. The post-fix
> replication it called for — the two proxy pairs, 4 arms × 25 rounds, 100 turns, 99
> usable — was run on 2026-08-03 as `full3`. It is free of the confound, it agrees with
> both earlier runs, and **it is the run the proxy tables below are anchored on.**

## Answer

**No. Routing through the Kataleptic gateway costs no detectable latency in either
direction, for either engine.**

<!-- data: full3; column "run 1" = full; column "run 2" = full2; metric: ttfa_ms -->
| comparison | run 1<br><sub>08-01</sub> | run 2<br><sub>08-02</sub> | run 3<br><sub>08-03, post-fix</sub> | 95% CI | **p10 / p90 Δ** | **min / max Δ** | slower / faster | p raw / Holm |
|---|---:|---:|---:|---|---:|---:|---:|---:|
| gpt-realtime-2 via gateway − direct | −18 ms | +12 ms | **−31 ms** | [−118, +306] | **−464 / +455** | **−1365 / +472** | **10 / 15** | 0.42 / 1.00 |
| Voice Live via gateway − direct | −19 ms | −100 ms | **+31 ms** | [−103, +126] | **−218 / +205** | **−418 / +719** | **14 / 10** | 0.54 / 1.00 |

*Three medians, one per run, each bound to its own run. Every column to their right is
**run 3's** — the post-fix replication, described in
[its own section](#run-3-the-post-fix-replication) below.*

**Three runs, six point estimates, and no stable sign.** The native pair reads −18, +12,
−31 ms; the Voice Live pair −19, −100, +31 ms. Neither sequence keeps its sign, and
nothing survives Holm correction in any run.

**These three medians must not be averaged.** An average of −18, +12 and −31 is a number
with a sign, and it would be the one thing the data is clear does not exist. The
disagreement *is* the result: an effect that changes direction between runs of the same
design against the same endpoints is smaller than the run-to-run variation, which is
exactly what "no detectable difference" means and is stronger evidence for it than any
single run's p-value.

**Stronger still, and easy to miss: within every run the gateway is slower on only about
half the turns.** By sign, the native pair splits 10/25, 12/23 and 10/25 slower across the
three runs — 40%, 52%, 40% — and Voice Live 12/25, 7/25 and 14/24, or 48%, 28% and 58%.
Five of those six are a coin flip and the sixth leans *toward* the gateway. That is a
per-turn statement, measured on identical caller audio in the same round, where the sign
instability above is only a per-run one — 147 matched pairs rather than six point
estimates. **A cost cannot be negative as often as it is positive.**

**Read the p10/p90 pair, not just the median.** Individual turns scatter by roughly
±450 ms on the native pair and ±210 ms on Voice Live — but *in both directions*. That is
per-turn variance: network jitter and model non-determinism. The confidence intervals are
the right summary of it, and they are what bounds the claim.

The distinction that matters is **magnitude, not frequency**. Compare OpenAI's semantic
VAD, measured in the [2.1 report](realtime-21-2026-08.md): it was slower on 13 of 20 turns
and *faster on 7*, so it is not "almost never faster" — but its slow turns cost up to
**+3864 ms** where its fast ones saved at most **457 ms**. That asymmetry in size is what
makes it a cost a caller feels. The proxy comparisons are symmetric in both size and count:
on the native pair the worst slow turn is +472 ms against a best fast turn of −496 ms once
the single −1365 ms cell is set aside, and on Voice Live +719 against −418. That −1365 is
one cell and is [dissected below](#the-1365-ms-outlier) — it is the *direct* arm having a
single slow turn, not the gateway a fast one, and the median does not depend on it.

**Stated precisely: no detectable difference, with the loosest of the three intervals
ruling out anything larger than ~310 ms on the native pair and ~130 ms on Voice Live.**
The loosest is quoted deliberately. Run 3's native interval reaches +306 ms where run 2's
reached only +141, and picking the tightest of three would be choosing the run that
flatters the claim after seeing all three. That is not exact equivalence — 25 pairs against
this per-turn variance cannot deliver one — but ~310 ms is 14% of the native pair's 2.2 s
time-to-first-audio and ~130 ms is under 8% of Voice Live's 1.8 s, which is decisive for
the decision at hand.

The measurements also flatter the gateway. From the machine that ran this, the Cloudflare
edge fronting `api.kataleptic.com` is 30 ms of TCP RTT away while Azure swedencentral is
61 ms, so the gateway arms get a ~31 ms shorter round trip before any proxying happens.
Adding that constant back moves every median above 31 ms toward "gateway slower": the
native pair becomes +13, +43 and 0 ms across the three runs, Voice Live +12, −69 and
+62 ms. **No point estimate is defensible from this either.** The adjusted values span −69
to +62 ms and still do not agree on sign, so quoting any one of them as "the proxy cost"
would claim precision the data does not contain. What the benchmark supports is the
**bound** above, not an estimate. (Those six adjusted figures are arithmetic on the table's
medians plus a traceroute constant, not statistics any run derives, so they are stated in
prose rather than in a table — an unverifiable table sitting beside verified ones is
exactly where a stale number hides.)

A separate and much more precise measurement does exist. During recon the gateway's own
protocol path was timed directly — round-tripping a free `input_audio_buffer.clear`
through it — at **5–8 ms**. That figure is not derived from this benchmark, is far better
powered for that specific quantity, and is consistent with everything here. It is the
number to quote for the gateway's own overhead; this benchmark's job is to confirm nothing
much larger is hiding behind it.

Either way the conclusion is the same and it is a null result: **the proxy is not where
your latency is.** At a p50 time-to-first-audio of 1.8–2.2 s, even the loosest bound the
data allows — ~310 ms on the native pair — is 14% of it, and the directly measured 5–8 ms
is under half a percent.
If OpenFon wants faster turn-taking, the levers are the turn detector (~0.7 s of the
budget as measured, and largely ours to set) and the choice of engine (Voice Live's
gpt-4.1-mini cascade reaches first audio a few hundred milliseconds sooner than
gpt-realtime-2, consistently in direction across all three runs) — not disintermediating
Kataleptic.

**A separate finding, from the [VAD follow-up](#follow-up-is-the-splitting-the-brain-or-the-turn-detector)
and arguably more actionable than the latency result:** OpenFon's `gpt-realtime-2` tier
**silently splits a caller's sentence at a clause pause, 10 times out of 10**, because
`src/call-session.ts` sends `server_vad` to every tier. The caller hears nothing — 20 splits
produced 0 ms of audio — so the model answers a sentence fragment as if it were a complete
turn, and a response is generated and discarded on every pause. Being inaudible makes it
harder to catch, not less real. The fix costs nothing in latency, but the combination that
delivers it (Voice Live serving gpt-realtime-2 with Azure semantic VAD) is not currently
exposed by Kataleptic on any tier.

---

## Setup

Five arms, a 2×2 plus a control:

| id | stack | brain | endpoint |
|---|---|---|---|
| `native-direct` | Azure AI Foundry | gpt-realtime-2 | `duguet-labs-eu.cognitiveservices.azure.com/openai/v1/realtime` |
| `native-gateway` | Kataleptic → Foundry | gpt-realtime-2 | `api.kataleptic.com/v1/realtime?model=gpt-realtime-2` |
| `vl-direct` | Azure Voice Live | gpt-4.1-mini | `.../voice-live/realtime?model=gpt-4.1-mini` |
| `vl-gateway` | Kataleptic → Voice Live | gpt-4.1-mini | `api.kataleptic.com/v1/realtime?model=kataleptic-realtime-hd` |
| `vl-native-brain` | Azure Voice Live | gpt-realtime-2 | `.../voice-live/realtime?model=gpt-realtime-2` |

The fifth arm exists because Voice Live will serve `gpt-realtime-2` as a managed model
with no Foundry deployment involved. That lets the *same brain* and the *same voice*
(`marin`) be reached through two different Azure serving stacks, so `vl-native-brain` −
`native-direct` isolates Voice Live's own overhead rather than a model difference.

Every direct arm points at `duguet-labs-eu` in **swedencentral** — the same resource and
region the gateway proxies to. The westeurope Speech resource was deliberately not used:
it would have confounded region with stack.

**Held constant**: caller audio (synthesized once with Azure Speech TTS, cached, replayed
byte-identically), real-time 20 ms frame pacing, the receptionist prompt, turn detection
(`server_vad / 0.7 / 300 / 550`), PCM16 @ 24 kHz both directions, one fresh session per
turn, and voice + STT within each comparison (`marin` + `whisper-1` on all three
gpt-realtime-2 arms, `en-US-AvaMultilingualNeural` + `azure-speech` on both gpt-4.1-mini
arms). Turns ran strictly serially, interleaved round-robin with the arm order rotated
each round, 4 utterances (EN/DE × short/long) cycling across 25 rounds.

123/125 turns produced a usable measurement; the 2 rejections are described under
Caveats and are not failures of the endpoint but of a control we require.

**Run 3 (`full3`, 2026-08-03) drops the fifth arm and keeps the first four** — the two
proxy pairs and nothing else, since its purpose is to re-measure exactly the comparison
this report leads with, under a harness that draws the prompt marker per
`(round, utterance)` cell rather than per turn. Same arms, same endpoints, same held-constant
list, same 4 utterances × 25 rounds; 100 turns, 99 usable. It cannot speak to
`vl-native-brain`, which is why the five-arm sections below remain sourced from run 2.

---

## Time to first agent audio

Measured from the instant the last frame of caller speech finishes playing out, so it
**includes the detector's end-of-turn delay**. We configured `silence_duration_ms = 550`,
but that nominal figure is not what any arm actually spends — the measured
`speech_stopped_ms` is ~740 ms under server VAD — so the engine-only view subtracts each
turn's own measurement rather than the constant.

Raw (what a caller on OpenFon's current settings experiences):

<!-- data: full2; metric: ttfa_ms -->
| arm | brain | n | min | **p50** | p90 | p99 | IQR |
|---|---|---:|---:|---:|---:|---:|---:|
| `native-direct` | gpt-realtime-2 | 25 | 1305 | **2205** | 2620 | 3404 | 376 |
| `native-gateway` | gpt-realtime-2 | 23 | 1712 | **2227** | 2531 | 2616 | 374 |
| `vl-direct` | gpt-4.1-mini | 25 | 1668 | **2002** | 2384 | 2400 | 391 |
| `vl-gateway` | gpt-4.1-mini | 25 | 1528 | **1915** | 2191 | 2540 | 375 |
| `vl-native-brain` | gpt-realtime-2 | 25 | 1653 | **2129** | 2479 | 2553 | 355 |

Engine-only — **per turn, `ttfa_ms − speech_stopped_ms`**: inference plus synthesis, with
that turn's *own measured* end-of-turn detection removed. Subtracting the nominal 550 ms
would be wrong: under server VAD the detector actually spends ~740 ms, and a semantic
detector has no fixed hangover at all.

<!-- data: full2; metric: ttfa_minus_vad_ms -->
| arm | brain | min | **p50** | p90 | p99 |
|---|---|---:|---:|---:|---:|
| `native-direct` | gpt-realtime-2 | 611 | **1512** | 1857 | 2664 |
| `native-gateway` | gpt-realtime-2 | 1019 | **1543** | 1801 | 1880 |
| `vl-direct` | gpt-4.1-mini | 933 | **1284** | 1650 | 1662 |
| `vl-gateway` | gpt-4.1-mini | 826 | **1179** | 1453 | 1813 |
| `vl-native-brain` | gpt-realtime-2 | 957 | **1384** | 1751 | 1857 |

Paired on the engine-only figure, neither proxy comparison survives correction
(`native-gateway` − `native-direct` +33 ms, p = 1.00; `vl-gateway` − `vl-direct` −95 ms,
p raw 0.043 / Holm 0.87).

Paired, on identical caller audio in the same round:

<!-- data: full2; metric: ttfa_ms -->
| comparison | pairs | median Δ | 95% CI | **p10 / p90 Δ** | slower / faster | p raw | p Holm | verdict |
|---|---:|---:|---|---:|---:|---:|---:|---|
| `native-gateway` − `native-direct` | 23 | **+12** | [−90, +141] | **−494 / +502** | **12 / 11** | 1.000 | 1.000 | wide both ways, not a cost |
| `vl-gateway` − `vl-direct` | 25 | **−100** | [−280, −15] | **−374 / +171** | **7 / 18** | 0.043 | 0.866 | borderline — faster by 100 ms, not robust to Holm |
| `vl-native-brain` − `native-direct` | 25 | **−46** | [−152, −1] | **−536 / +508** | **7 / 18** | 0.043 | 0.866 | wide both ways, not a cost |

> Regenerated with the current analyzer. Three changes since first publication: the Holm
> values are 0.866, not the 0.779 published earlier — that figure predated
> `session_ready_ms` joining the metric family; the paired **p10** is now shown beside the
> p90, because a large p90 alone cannot distinguish a cost from variance; and with both
> visible, two rows that a p90-only view flagged as tails turn out to be **symmetric
> spread** — the gateway is ~500 ms faster about as often as it is ~500 ms slower.
> Neither changes a conclusion; both were published as cleaner than the data supports.

p-values are Holm-corrected across all 27 paired tests in the run (see
[Statistical discipline](#statistical-discipline)); a directional verdict additionally
requires a median shift of at least 50 ms.

Note the **p90 columns**: the gateway's tail is *tighter*, not looser
(`native-gateway` p90 2531 ms vs `native-direct` 2620 ms, and 2531 vs 3129 in run 1).
Whatever jitter the extra hop adds is smaller than the jitter already in the direct path.

`native-gateway` shows 23 turns rather than 25 because two were **rejected**, not lost —
see the session-race caveat below.

### Run 3: the post-fix replication

*2026-08-03, four arms × 25 rounds, 100 turns, 99 usable (one `vl-direct` connect was reset
by the peer). The two proxy pairs only, collected after `d5f3b2a` moved the prompt marker
to the `(round, utterance)` cell — so this is the one run in which the two arms of every
pair answered a byte-identical system prompt.*

<!-- data: full3; metric: ttfa_ms -->
| arm | brain | n | min | **p50** | p90 | max | IQR |
|---|---|---:|---:|---:|---:|---:|---:|
| `native-direct` | gpt-realtime-2 | 25 | 1687 | **2187** | 2570 | 3538 | 409 |
| `native-gateway` | gpt-realtime-2 | 25 | 1713 | **2204** | 2487 | 2497 | 255 |
| `vl-direct` | gpt-4.1-mini | 24 | 1542 | **1790** | 2266 | 2483 | 496 |
| `vl-gateway` | gpt-4.1-mini | 25 | 1479 | **1813** | 2348 | 2824 | 388 |

Paired, on identical caller audio in the same round:

<!-- data: full3; metric: ttfa_ms -->
| comparison | pairs | median Δ | 95% CI | **p10 / p90 Δ** | **min / max Δ** | slower / faster | p raw | p Holm | verdict |
|---|---:|---:|---|---:|---:|---:|---:|---:|---|
| `native-gateway` − `native-direct` | 25 | **−31** | [−118, +306] | **−464 / +455** | **−1365 / +472** | **10 / 15** | 0.424 | 1.000 | wide both ways, not a cost |
| `vl-gateway` − `vl-direct` | 24 | **+31** | [−103, +126] | **−218 / +205** | **−418 / +719** | **14 / 10** | 0.541 | 1.000 | symmetric spread, not a cost |

Two things are worth reading off this beyond the medians. **The gateway's spread is not
wider**, which is what an extra hop would be expected to cost: on the native pair it is
tighter on both measures (p90 2487 vs 2570, IQR 255 vs 409), and on Voice Live it is
tighter by IQR (388 vs 496) while its p90 sits 82 ms above the direct arm's. That
replicates run 2's reading — whatever jitter the hop adds is of the same order as the
jitter already in the direct path — without overstating it as a tail improvement in
both pairs.

And the run's own null is *tighter than run 2's on Voice Live* (CI [−103, +126] against
[−280, −15]) while being **looser on the native pair** ([−118, +306] against [−90, +141]).
That is why the bound this report quotes is the loosest of the three rather than run 3's:
being the best-controlled run does not make it the most precise one, and conflating the
two would let the cleanest run set a bound the noisier ones contradict.

#### The −1365 ms outlier

The native pair's most extreme difference is nearly three times the next one, so it is worth
saying exactly what it is rather than leaving it in a `min` column. It is **one cell —
round 2, `de-short` — and it is the *direct* arm having a single slow turn, not the gateway
having a fast one.**

- That turn is `native-direct`'s slowest of the run: it *is* the 3538 ms `max` in the table
  above, against that arm's own p50 of 2187 and p90 of 2570. The gateway's turn in the same
  cell was unremarkable, within 30 ms of its arm's median.
- **It is not a slow dial.** Connect, config and `speech_stopped` on that turn all sit at
  their arm's medians, and the two arms' end-of-turn decisions are 1.4 ms apart. All but
  those 1.4 ms sit downstream of the turn ending, in inference and synthesis: the same
  cell's engine-only difference is −1363 ms, so subtracting each turn's own detection time
  does not touch it.
- **It is not the utterance splitting either.** Both arms split on that cell — splits in
  this run are exactly symmetric, 6/25 on each native arm, all of them `de-short`, zero
  discordant cells, McNemar p = 1.00 — so segmentation is not what distinguishes the two
  turns.

**The median does not depend on it.** Dropping the cell entirely moves the pair median from
−31 ms to −23 ms over the remaining 24 pairs, and leaves the count of turns on which the
gateway was *slower* at 10 — the cell is one of the 15 faster ones, so removing it takes
that side to 14 and changes nothing about the balance. Neither median approaches the 50 ms
practical floor from either side. Since the excursion is on the *direct*
arm it flatters the gateway, so removing it moves the estimate toward the gateway being
slower — the conservative direction for the claim being made. Read as what it is: one slow
inference on a 25-pair sample, which is also why the median rather than the mean is the
statistic this report quotes throughout.

### Engine choice dominates

The interesting number is not the proxy delta, it is the gap between engines: Voice Live's
gpt-4.1-mini cascade reaches first audio at a p50 of **2002 ms** raw (1284 ms engine-only)
where gpt-realtime-2 takes **2205 ms** (1512 ms) — a raw gap of **203 ms** and an
engine-only gap of **228 ms** in run 2. Run 1 put the same gap at 549 ms raw / 443 ms
engine-only and run 3 at 397 ms raw / 441 ms engine-only, so the magnitude is not stable
across runs; the ordering is (Voice Live first in all three), and the gap is an order of
magnitude larger than anything the proxy contributes.
Treat "a few hundred milliseconds, direction consistent" as the finding rather than either
point estimate. Whether that
trade is worth it depends on what OpenFon values — gpt-realtime-2 hears tone rather than
words and its replies are noticeably more natural. But if the goal is a snappier phone
agent, switching tiers buys far more than removing the gateway would.

### That gap is the model, not turn detection

A reasonable worry about the number above: if the two engines detected end-of-turn
differently, the "engine gap" could really be a VAD gap. It is not, and the run measures
this directly.

All five arms were configured with **identical turn detection** — `server_vad`,
threshold `0.7`, prefix padding `300 ms`, silence `550 ms` — and every endpoint echoed
that back verbatim in its `session.updated` (re-verified live after the run; no arm
silently substituted Azure semantic VAD or anything else). `speech_stopped_ms` then
measures each server's *own* end-of-turn decision, from the end of caller speech to its
`input_audio_buffer.speech_stopped`:

<!-- data: full2; metric: speech_stopped_ms -->
| arm | brain | min | **p50** | p90 | IQR |
|---|---|---:|---:|---:|---:|
| `native-direct` | gpt-realtime-2 | 686 | **724** | 747 | 40 |
| `native-gateway` | gpt-realtime-2 | 683 | **707** | 740 | 35 |
| `vl-direct` | gpt-4.1-mini | 686 | **733** | 739 | 11 |
| `vl-gateway` | gpt-4.1-mini | 687 | **731** | 736 | 33 |
| `vl-native-brain` | gpt-realtime-2 | 692 | **727** | 751 | 31 |

**Every arm decides end-of-turn within 26 ms of every other** (p50 707–733 ms in run 2,
737–765 ms in run 1, 704–710 ms in run 3; all paired deltas null or below the 50 ms
practical floor) — the 550 ms hangover plus ~170 ms of
detection and network, the same everywhere. Turn detection is therefore *not* where the engines
diverge. The ~550 ms difference in time-to-first-audio accrues entirely **downstream of
the turn ending**, in model inference plus speech synthesis.

So the honest attribution is: gpt-4.1-mini-behind-Voice-Live **produces its first audio
byte sooner**, not "ends turns better" and not "reasons faster" — with a cascade, first
audio only needs the first TTS chunk, whereas a native speech-to-speech model must begin
generating audio tokens itself. Two different mechanisms, one observable.

One thing genuinely *does* differ by engine, but it is turn **segmentation**, not
end-of-turn speed — see the VAD-splits caveat below.

---

## Supporting metrics

<!-- data: full2 -->
| metric | native-direct | native-gateway | vl-direct | vl-gateway | vl-native-brain |
|---|---:|---:|---:|---:|---:|
| `speech_stopped_ms` p50 (VAD end-of-turn) | 724 | 707 | 733 | 731 | 727 |
| `transcript_ms` p50 (caller's transcript) | 1332 | *(excluded)* | 1271 | 1193 | 1292 |
| `connect_ms` paired Δ | — | **−91 ms** | — | **−121 ms** | — |
| `config_ms` paired Δ vs `native-direct` | — | +37 ms | — | — | **+65 ms** |

*`native-gateway` is excluded from the transcript row: the gateway substituted its own
STT deployment on all but three turns, so the three that survive are not a distribution.*

Every paired `ttft`, `transcript` and `response_total` comparison for the two proxy pairs
is null (p ≥ 0.11). The reply lengths confirm the arms were doing comparable work.

**`connect_ms` is the vantage point made visible.** The gateway is 91–121 ms faster to
open a socket (p < 0.001 on both pairs, in both runs) purely because the Cloudflare edge
is nearer than Sweden — p50 317 ms vs 414 ms on the native pair, 310 ms vs 433 ms on Voice
Live. It gives some of that back on `config_ms` (133 ms vs 79 ms, +37 ms paired) because
the gateway dials its upstream lazily *after* accepting the client socket, so the upstream
handshake is hidden inside session configuration rather than inside connect.

Time to a *configured* session is therefore its own metric, `session_ready_ms`, computed
per turn rather than by adding the two medians — the median of a sum is not the sum of the
medians. On that measure the gateway is still ahead from here: **465 ms vs 491 ms** native
(paired −52 ms, not significant) and **402 ms vs 540 ms** Voice Live (paired −101 ms,
p_adj < 0.001). None of this transfers to a Cloudflare Worker, which has a different
geometry again.

**Run 3 replicates the shape and sharpens the `config_ms` half of it:**

<!-- data: full3 -->
| comparison | `connect_ms` paired Δ | `config_ms` paired Δ | `session_ready_ms` paired Δ |
|---|---:|---:|---:|
| `native-gateway` − `native-direct` | **−60 ms** | **+100 ms** | +13 ms |
| `vl-gateway` − `vl-direct` | −24 ms | +21 ms | −6 ms |

Same trade in the same direction — faster to open a socket, slower to configure one, and
the two very nearly cancelling on `session_ready_ms`. The one figure that moved materially
is the native pair's `config_ms`, **+37 ms in run 2 and +100 ms here**, slower on 25 of 25
turns and surviving Holm in this run where it was demoted in the last. It is a larger lazy
upstream dial than run 2 saw, it is still paid once before the call rather than per turn,
and it still does not reach `ttfa_ms`. Two runs a day apart disagreeing by a factor of
nearly three is the same lesson as the headline: **a session-setup point estimate from one
run is not a constant of the gateway.**

The one non-connection result that survives correction lives here too:
**`vl-native-brain` − `native-direct` on `config_ms` is +65 ms** (CI [+40, +78],
p_adj < 0.001) — Voice Live is measurably slower than the Foundry endpoint at applying a
session configuration. It is paid once at session setup, not per turn, so it does not
reach `ttfa_ms`; but it is a real difference between the two stacks and the only one this
benchmark establishes.

---

## Statistical discipline

This run performs **27 paired hypothesis tests** (3 comparisons × 9 metrics); run 3, with
two comparisons instead of three, performs **17** — 2 × 9 less the native `transcript_ms`
comparison, which the gateway's STT substitution leaves with no usable pair — and is
corrected within its own family.
At α = 0.05 that is ~1.4 spurious rejections expected under the null — so an uncorrected
table would reliably manufacture a finding. Two guards are applied, and both are in the
code rather than only in this prose:

1. **Holm–Bonferroni across the whole family**, not per-table. A reader scanning the
   report is implicitly looking at all 27 tests, so that is the family the error rate has
   to be controlled over. Holm is used rather than Bonferroni because it is uniformly more
   powerful and assumes nothing about independence — which matters here, since `ttfa` and
   `ttft` measure overlapping stages of the same turn.
2. **A 50 ms practical floor.** A difference smaller than this is not reported
   directionally whatever its p-value. Conversational turn-taking gaps only become
   perceptible to a caller well into the 100 ms range, so 50 ms is conservative and still
   admits anything worth acting on.
3. **Equivalence requires the whole interval, not the point estimate.** "No practical
   difference" is a claim about what the data *rules out*, so it is only made when the
   entire CI sits inside ±50 ms — the interval form of a TOST. A median of −19 ms with a
   CI of [−122, +60] is compatible with a 100 ms effect, so it is reported as *"no
   detectable difference; CI admits up to 122 ms"* instead. That is why the two proxy rows
   above carry a bound rather than an equivalence claim.

Split rates are corrected as their **own** Holm family, separately from the paired latency
metrics: they are rates on the same matched cells tested with a different statistic
(exact McNemar), and merging the families would over-correct the latency metrics without
making the rate claims any safer. Both VAD split results survive their family correction
(p = 0.00195 raw, 0.00781 adjusted over a family of four — including the comparison that showed no splits on either arm, which is corrected over even though its row is hidden, so the family size does not depend on the outcomes).

What survives both gates:

Everything in the primary run with an uncorrected p below 0.05 (27 tests in the family):

<!-- data: full2 -->
| result | median | p raw | p Holm | status |
|---|---:|---:|---:|---|
| `connect_ms`, `vl-gateway` − `vl-direct` | −121 ms | 0.000 | 0.000 | **survives both gates** |
| `session_ready_ms`, `vl-gateway` − `vl-direct` | −101 ms | 0.000 | 0.000 | **survives both gates** |
| `config_ms`, `vl-native-brain` − `native-direct` | +65 ms | 0.000 | 0.000 | **survives both gates** |
| `connect_ms`, `native-gateway` − `native-direct` | −91 ms | 0.000 | 0.002 | **survives both gates** |
| `config_ms`, `native-gateway` − `native-direct` | +37 ms | 0.003 | 0.060 | demoted — not robust to correction |
| `ttfa_minus_vad_ms`, `vl-native-brain` − `native-direct` | −64 ms | 0.015 | 0.322 | demoted — not robust |
| `response_total_ms`, `native-gateway` − `native-direct` | −588 ms | 0.035 | 0.728 | demoted — not robust |
| `ttfa_ms`, `vl-gateway` − `vl-direct` | −100 ms | 0.043 | 0.866 | demoted — not robust |
| `ttfa_ms`, `vl-native-brain` − `native-direct` | −46 ms | 0.043 | 0.866 | demoted — not robust |
| `ttfa_minus_vad_ms`, `vl-gateway` − `vl-direct` | −95 ms | 0.043 | 0.866 | demoted — not robust |
| `response_total_ms`, `vl-gateway` − `vl-direct` | −1272 ms | 0.043 | 0.866 | demoted — not robust |

Split rates are a *rate*, not a paired latency, so they are tested separately with
**exact McNemar** and are not part of this family. McNemar rather than Fisher's exact
because the observations are matched by construction — same caller audio, same round —
and Fisher discards the pairing, overstating the evidence by two orders of magnitude.
Only complete cells where both turns produced a usable measurement are counted; a turn
that failed has no split recorded by default, and counting it as a clean non-split would
manufacture significance out of failures.

**Four results survive both gates, and every one of them is about session setup, not
speech.** Three are the vantage point (the two `connect_ms` rows and the combined
`session_ready_ms`, all explained by the Cloudflare edge being nearer than Sweden). The
fourth is not: **`config_ms`, `vl-native-brain` − `native-direct`, +65 ms** says Voice Live
takes ~65 ms longer than the Foundry endpoint to apply a session configuration. It is real,
reproducible, paid once before the call starts rather than per turn, and it never reaches
time-to-first-audio — but it is a genuine difference between the two stacks, and it is the
only one this benchmark establishes.

**Nothing on any speech metric survives.** In particular:

> **"Voice Live's serving stack is faster with the brain held constant" is not an
> established result.** In the primary run it is −46 ms with a CI upper bound touching zero
> (−152, −1) and a corrected p of 0.87; run 1 put it at −93 ms, also demoted. Its
> paired differences are wide in *both* directions (p10/p90 −536 / +508), so "if anything
> faster" describes the median of a scatter, not a reliable advantage. The honest
> statement is: *no robust difference either way.*
> Confirming it would need a dedicated, better-powered run.

Note also how many rows sit at exactly p = 0.043 — that is the smallest two-sided p an
exact sign test can produce at n = 25 with one discordant pair short of unanimity. Several
metrics landing there together is what a family of correlated near-null tests looks like,
and is precisely why the correction exists.

**This discipline strengthens the headline rather than weakening it.** The proxy null is
not "we failed to find an effect" — it is a bounded null, replicated twice: three
independent runs, none surviving correction in either pair, disagreeing on sign in both
pairs, with the true effect confined by the loosest of the three intervals to roughly
±310 ms (native) and ±130 ms (Voice Live) at 95%. Alongside it sits an
independent and far more precise direct measurement of the gateway's own protocol overhead
at 5–8 ms. That is a much stronger position than a bare "p > 0.05", and it deserves not to
be surrounded by over-claimed marginal findings — including one of my own, since an earlier
draft quoted a single "+10 ms true proxy cost" that the replications do not support.

**The three medians are reported side by side and are deliberately not pooled.** Averaging
−18, +12 and −31 would produce a single signed number, and combining three intervals would
produce one narrower than any of them — both of which would describe the run-to-run
variation as if it were measurement precision. The variation is the finding, so it is left
visible. Pooling would also require the runs to be exchangeable, and they are not: run 3
uses four arms and a fixed harness where runs 1 and 2 used five arms and the per-turn
marker.

## Caveats

**Vantage point — the main threat to external validity.** All measurements are from a
laptop in Austria. TCP RTT: Cloudflare edge **30 ms**, Azure swedencentral **61 ms**. The
gateway arms therefore get a systematically shorter client leg. Pairing cancels drift and
time-of-day load but cannot cancel path length. Production OpenFon is a Cloudflare Worker,
where the client→edge leg is very short and the edge→origin leg may differ substantially.
**A Worker-side run would settle this and has not been done.** The directly measured
protocol overhead (5–8 ms round-trip) is an order of magnitude below the measurement noise
here, so a change of vantage point is unlikely to change the verdict — but it would change
the confidence, and it is the one adjustment that pairing cannot make for us.

**Multiple comparisons** are handled in [Statistical discipline](#statistical-discipline)
above rather than as an afterthought here: 27 tests, Holm-corrected as one family, with a
50 ms practical floor on top. Each run is its own family — run 3 is corrected across
**17** tests, not 27 — because a family is the set of
tests a reader scans together, and pooling three runs into one family would correct each
run for tests it did not perform. The short version is that **the four surviving results in
run 2 are all about session setup, none about speech** — and "Voice Live serves
gpt-realtime-2 faster than the Foundry deployment" is **not** among the findings.

**Correction is not a substitute for power.** Holm makes the reported claims trustworthy;
it does not make the borderline ones false. The −46 ms `ttfa` effect for
`vl-native-brain` − `native-direct` may well be real — 25 pairs simply cannot resolve it
against this per-turn variance (IQR ~360–400 ms). Resolving it would need several hundred
pairs, or a lower-variance measurement, and it should be pre-registered as a single
hypothesis rather than harvested from a table of 27.

**VAD splits are the detector, not the brain** — see the dedicated follow-up experiment
below, which settles this. The main run left it confounded; the follow-up removes the
confound and reverses the tentative reading.

Within the main run: splits occur symmetrically inside every pair, so all three paired
comparisons are unaffected, and `speech_stopped_ms` shows end-of-turn *timing* is identical
across arms regardless. The native-vs-Voice-Live *cross* comparison on `de-short` is not
strictly apples-to-apples.

**The gateway's session race also hits turn detection — and it was biasing the numbers.**
The gateway dials its upstream lazily and injects its own `session.update`, which races
with the client's. On 2 of 25 `native-gateway` turns it won on `turn_detection` too,
leaving Azure's defaults (`threshold 0.5`, `silence_duration_ms 500`) in place of the
`0.7 / 550` every other arm ran.

Those turns are now **rejected**, because turn detection is a measurement-critical control.
Before the check existed they were silently measured — with a hangover **50 ms shorter than
every arm they were being compared against**, which biases the gateway toward looking
faster. That is a systematic bias in the direction of the result, and it is a plausible
part of why run 1's gateway point estimates were negative (−18, −19 ms) where run 2's are
+12 and −100. No run's comparison survives correction either way, so the conclusion is
unchanged; but the earlier point estimates should be read as slightly flattering to the
gateway, and this is exactly the class of error that only shows up once you check the echo
rather than the request.

**The race did not recur on turn detection in run 3**: all 25 `native-gateway` turns passed
the detector check and none was rejected. That is not evidence the race is fixed — it is a
race, and run 2 lost it twice in 25 — but it does mean run 3's native pair carries none of
the bias described above, which is one more reason it is the run the headline is anchored
on.

**A second control diverges the same way.** Every arm's
`session.updated` echo is now checked field by field against what was asked for, and
anything that could corrupt a measurement — audio codec, sample rate, turn detector —
aborts the turn instead of being recorded and ignored. That check found the
`native-gateway` arm reporting `transcription.model = "whisper"` where the client sent
`whisper-1`: the gateway dials its upstream lazily and injects its own transcription
deployment (`AZURE_REALTIME_TRANSCRIPTION_MODEL`), which races with the client's value.

In run 2 the gateway's `whisper` deployment won on **22 of 25 turns**; over 10 consecutive
sessions in a separate probe it won 8 times; in run 3 it won on **all 25**, which leaves
that run with no usable `transcript_ms` pair on the native comparison at all. So the STT
model on that arm is not merely different from the direct arm — it varies session to
session, and how often it wins varies run to run.

Rather than note this and carry on, those turns are now **excluded from
`transcript_ms`**: a confirmed-different control is worse than an unconfirmable one, and an
eliminated confound beats a disclosed one. That leaves 3 usable pairs, so the table reports
*"no detectable difference; n=3 too small to claim equivalence"* rather than a number that
would invite comparing two different STT deployments. The exclusion is per-metric, not
per-turn — STT runs in parallel with generation and cannot gate first audio, so `ttfa_ms`,
the metric the conclusion rests on, is untouched.

Every other field on every other arm echoes back exactly as asked — verified against live
payloads by `verify_live.py`, which also mutates each real echo to confirm the checker
catches codec, rate, detector and missing-field substitutions rather than passing them.

**Unremovable dialect asymmetry.** Voice Live speaks the flat/beta wire format while the
native endpoint and the gateway speak GA nested. Each arm is sent its own native dialect.
The gateway's translation work is part of what we are measuring, so this is correct — but
`vl-direct` and `vl-gateway` are not byte-identical on the wire.

**TTS engine across the VL/native split.** `vl-direct` and `vl-gateway` synthesize with
Azure neural voices; the gpt-realtime-2 arms emit native model audio. Within-pair
comparisons are clean; the engine-choice gap in the section above mixes two speech stacks
and should be read as "these two products differ by ~550 ms", not "cascading costs 550 ms".

**Single session per turn.** Every turn opens a fresh session, so none of this measures
latency drift over a long call, nor barge-in behaviour. Both are separate questions.

---

## Follow-up: is the splitting the brain or the turn detector?

*Separate run, 2026-08-02, 120 turns, $1.61. Two blocks of 6 arms × 10 rounds: `de-short`
(the only utterance that ever splits) for split rate, `en-short` (which never splits on any
arm) for a clean latency comparison — because on a split arm the model answers only the
second fragment, so `ttfa` measured on `de-short` is not comparing like with like.*

The main run left a confound: gpt-realtime-2 chopped the caller's utterance at a clause
pause and gpt-4.1-mini did not, so "the better engine" could have meant the better *brain*
or the better *turn detector* — different product decisions. This run pins the brain and
varies only the detector.

### Which combinations exist

Not every pairing is offered, and the refusals are informative:

| surface | brain | detector | |
|---|---|---|---|
| Foundry | gpt-realtime-2 | `semantic_vad` | accepted |
| Foundry | gpt-realtime-2 | `azure_semantic_vad_multilingual` | **rejected** — *"Supported values are: none, server_vad, semantic_vad"* |
| Voice Live | gpt-realtime-2 | `semantic_vad` | accepted |
| Voice Live | gpt-realtime-2 | `azure_semantic_vad_multilingual` | accepted |
| Voice Live | gpt-4.1-mini | `azure_semantic_vad_multilingual` | accepted |
| Voice Live | gpt-4.1-mini | `semantic_vad` | **rejected** — *"OpenAI Semantic VAD is not supported in cascaded pipeline"* |

OpenAI's semantic VAD needs a native-audio model; Azure's needs Azure's own pipeline.
Neither detector can be moved onto the other brain on the Foundry surface.

### Split rate — the detector, decisively

<!-- data: vad-split2 -->
| arm | brain | detector | turns split |
|---|---|---|---:|
| `native-direct` | gpt-realtime-2 | `server_vad` | **10/10** |
| `vl-native-brain` | gpt-realtime-2 | `server_vad` | **10/10** |
| `nat-semantic` | gpt-realtime-2 | OpenAI `semantic_vad` | **0/10** |
| `vlnat-azsemantic` | gpt-realtime-2 | Azure semantic | **0/10** |
| `vl-direct` | gpt-4.1-mini | `server_vad` | 0/10 |
| `vlmini-azsemantic` | gpt-4.1-mini | Azure semantic | 0/10 |

**Exact McNemar**, two-sided, on complete matched cells: `nat-semantic` vs
`native-direct` and `vlnat-azsemantic` vs `vl-native-brain` are both **p = 0.00195**
(10 discordant cells, all in the same direction), **0.00781 after Holm correction within
the split-rate family** — which is a separate family from the paired latency metrics,
since these are rates tested with a different statistic. McNemar rather than Fisher because
these observations are matched by construction — the same caller audio in the same round —
and Fisher would discard the pairing and report ~1e-5, overstating the evidence by two
orders of magnitude. Holding the brain *and* the serving stack constant and changing only
the detector takes splitting from 100% to 0%.

**This reverses the tentative reading in the main run.** Splitting is not a property of the
brain — it is `server_vad` firing on a clause pause, and gpt-realtime-2's `server_vad`
implementation is simply more trigger-happy than the cascade's. Give the same brain a
semantic detector and the behaviour disappears entirely.

### The caller is not talked over — which makes this subtler, not milder

The obvious reading of a "false start" is that the agent begins answering half a sentence
out loud. **It does not.** Tracking whether each cancelled fragment emitted any audio:

| | splits | of which audible | audio emitted |
|---|---:|---:|---:|
| all splitting arms, `de-short` × 10 rounds | **20** | **0** | **0 ms** |

Every split was cancelled before a single audio delta went out — in a traced session, 8 ms
after the fragment response was created. So the caller hears nothing. What actually happens
is that the service commits the utterance as **two input items** and answers the second:

| arm | caller transcript the reply answers |
|---|---|
| `native-direct` (split) | `'Haben Sie am Donnerstagnachmittag noch einen Termin frei?'` |
| `nat-semantic` (no split) | `'Guten Tag, haben Sie am Donnerstagnachmittag noch einen Termin frei?'` |

Both fragments remain in the conversation, so no content is destroyed — the model still has
"Guten Tag" as a prior item. The defect is that **turn boundaries land in the wrong place**:
the model treats a sentence fragment as a complete turn, and a response is generated and
thrown away on every such pause (which is billed).

This is a **lower severity than "the agent interrupts callers", and a higher detection
cost**. Nothing is audible, so it will never show up in manual testing or a call recording;
it surfaces only as occasional oddly-scoped answers. Two things remain untested: whether a
longer clause pause crosses into audible interruption (these fragments died in single-digit
milliseconds, but that is a race, not a guarantee), and whether the re-segmentation measurably
degrades reply quality. The first is a barge-in study; the second is task #6.

### What the fix costs — and here the two detectors differ enormously

Paired on `en-short`, where nothing splits on any arm:

<!-- data: vad-ttfa; metric: ttfa_ms -->
| comparison | median Δ ttfa | 95% CI | **p10 / p90 Δ** | slower / faster | p raw / Holm |
|---|---:|---|---:|---:|---:|
| `vlnat-azsemantic` − `vl-native-brain`<br><sub>Azure semantic vs server VAD, brain and stack held constant</sub> | **−72 ms** | [−600, +255] | −1025 / +489 | **5 / 5** | 1.000 / 1.000 |
| `nat-semantic` − `native-direct`<br><sub>OpenAI semantic vs server VAD, brain held constant</sub> | **+662 ms** | [+248, +3425] | **−78 / +3651** | **9 / 1** | 0.021 / 0.730 |
| `vlmini-azsemantic` − `vl-direct`<br><sub>Azure semantic vs server VAD, brain gpt-4.1-mini</sub> | +177 ms | [−69, +260] | −244 / +318 | 7 / 3 | 0.344 / 1.000 |

> Corrected within this run's family of **36** tests (4 comparisons × 9 metrics). The Holm
> value on the middle row was published as 0.645, from a family of 31 — the same staleness
> the main table above was corrected for when `session_ready_ms` joined the metric family,
> missed here because this block is analysed separately. It changes nothing: 0.021 raw is
> not significant at either family size, and the finding rests on the p90 either way. Found
> by `check_report_tables.py` once it stopped skipping rows it did not recognise.

Note the sign counts: Azure's detector on the same brain and stack is 5 slower / 5 faster —
a coin flip. OpenAI's is 9 slower / 1 faster **and** its losses reach +3651 ms against a
best case of −78 ms. Asymmetric in both, which is why it is the one that hurts.

`speech_stopped_ms` shows the mechanism directly — this is the detector's own decision time:

<!-- data: vad-ttfa; metric: speech_stopped_ms -->
| arm | detector | p50 | p90 | IQR |
|---|---|---:|---:|---:|
| `native-direct` | `server_vad` | 736 | 760 | 59 |
| `vlnat-azsemantic` | Azure semantic | **707** | **742** | **22** |
| `nat-semantic` | OpenAI `semantic_vad` | **1189** | **4512** | **3331** |

**Azure's semantic detector is free** — same end-of-turn timing as server VAD, and the
tightest spread of any arm measured. **OpenAI's is not**: it roughly doubles the median
end-of-turn decision and its tail is catastrophic for a phone call, with a p90 of 4.5 s
spent deciding the caller has stopped talking. (The +662 ms `ttfa` figure is flagged
borderline by the correction, and with an IQR of 3.3 s that caution is right — but the
direction is unambiguous and the mechanism is visible in `speech_stopped_ms`.)

The engine-only view isolates it cleanly. With each turn's own detection time subtracted,
`nat-semantic` − `native-direct` is **−87 ms (p = 0.34, null)**: inference and synthesis
are unchanged. **The entire penalty of OpenAI's semantic VAD is the detector deciding, not
the model thinking.**

### What this means for OpenFon

1. **You do not have to choose between the better brain and the better turn-taking.**
   gpt-realtime-2 with Azure semantic VAD splits 0/10 at no measurable latency cost.
2. **OpenFon is currently exposed to this.** `realtimeSessionPayload` in
   `src/call-session.ts` sends `server_vad / 0.7 / 300 / 550` to *every* tier, including
   `gpt-realtime-2`. On that tier a caller who pauses mid-sentence — "Guten Tag, …" — has
   the turn split, reproducibly, 10 times out of 10. Inaudibly: the model answers the
   fragment and a discarded response is billed each time.
3. **The good combination is not currently purchasable through Kataleptic.** Its
   `gpt-realtime-2` tier proxies to the Foundry surface, where `semantic_vad` means
   OpenAI's slow one; its HD tier maps `semantic_vad` to Azure's, but that tier's brain is
   gpt-4.1-mini. Nothing exposes *Voice Live + gpt-realtime-2*, which is the combination
   that wins here. That is a concrete tier worth asking for.

Until then the honest short-term options are: use the HD tier (fast detector, weaker
brain), or use `gpt-realtime-2` with `server_vad` and accept silent clause-pause splitting.
Switching that tier to OpenAI `semantic_vad` fixes the splitting but trades it for a
multi-second end-of-turn tail, which is worse on a phone call.

## Cost

Both five-arm runs cost about **$2** each (125 turns, ~25 minutes wall clock), the VAD
follow-up **$1.61** (120 turns), the split re-run **$0.9**, and the post-fix replication
about **$1.60** (100 turns) — roughly **$8** across everything. Caller-audio synthesis was
a one-off four requests to Azure Speech.

Worth noting for its own sake: **gpt-realtime-2 costs ~4× what the Voice Live gpt-4.1-mini
tier costs** for the same conversation, on top of being ~550 ms slower to first audio.

---

## Reproducing

```bash
cd bench/realtime
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
export AZURE_REALTIME_KEY=$(az cognitiveservices account keys list \
  -n duguet-labs-eu -g qptr-projects --query key1 -o tsv)
export AZURE_SPEECH_KEY=$(az cognitiveservices account keys list \
  -n openfon-speech -g openfon-rg --query key1 -o tsv)
./venv/bin/python bench.py --rounds 25 --tag full
./venv/bin/python analyze.py results/turns-<stamp>-full.jsonl
```

The post-fix replication is the same command with two arms dropped:

```bash
./venv/bin/python bench.py --rounds 25 --tag full3 \
  --arms native-direct,native-gateway,vl-direct,vl-gateway
```

**Without spending anything**: the five runs behind this report — `full` (run 1), `full2`
(run 2), `full3` (run 3, the post-fix replication the proxy tables are anchored on),
`vad-ttfa` and `vad-split2` — are committed under `bench/realtime/published/`,
and each table names the one it quotes in an HTML comment above it. Re-derive every figure
with no credentials, no network and no venv:

```bash
python3 bench/realtime/check_report_tables.py
```
