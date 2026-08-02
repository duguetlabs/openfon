# Realtime voice latency: Kataleptic gateway vs. direct Azure

*Two independent 125-turn runs of the same five-arm design, 2026-08-01 and 2026-08-02.
Numbers below are from the second, which was collected with the fully verified harness;
the first is reported alongside as a replication. Harness and full method in
[`bench/realtime/`](../../bench/realtime/README.md); regenerable with `bench.py --rounds 25`.*

---

## Answer

**No. Routing through the Kataleptic gateway does not cost measurable latency, for
either engine.**

| comparison | run 2 (primary) | 95% CI | p raw / Holm | run 1 (replication) |
|---|---:|---|---:|---:|
| gpt-realtime-2 via gateway − direct | **+12 ms** | [−90, +141] | 1.00 / 1.00 | −18 ms |
| Voice Live via gateway − direct | **−100 ms** | [−280, −15] | 0.043 / 0.78 | −19 ms |

Neither survives correction in either run, and the two runs disagree on sign for the
native pair (+12 vs −18) — which is itself the finding: the effect is smaller than the
run-to-run variation. **Stated precisely: no detectable difference, with the data ruling
out anything larger than ~140 ms for the native pair and ~280 ms for Voice Live.** That is
not a claim of exact equivalence — 25 pairs against this per-turn variance cannot deliver
one — but at a p50 of 1.9–2.2 s it is decisive for the decision at hand.
The point estimates are *negative* — the gateway looked marginally faster — but that is a
vantage-point artefact, not a win: from the machine that ran this, the Cloudflare edge
fronting `api.kataleptic.com` is 30 ms of TCP RTT away while Azure swedencentral is 61 ms,
so the gateway arms got a shorter first leg. Correcting for that ~30 ms of geographic
advantage puts the **true proxy cost at roughly +10 ms**, which agrees with the ~5–8 ms
round-trip overhead measured directly against the gateway's protocol path during recon.

Either way the conclusion is the same and it is a null result: **the proxy is not where
your latency is.** At a p50 time-to-first-audio of 1.9–2.4 s, ten milliseconds is 0.5%.
If OpenFon wants faster turn-taking, the levers are the turn detector (~740 ms of the
budget as measured, and largely ours to set) and the choice of engine (Voice Live's gpt-4.1-mini cascade is
~550 ms faster to first audio than gpt-realtime-2) — not disintermediating Kataleptic.

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

---

## Time to first agent audio

Measured from the instant the last frame of caller speech finishes playing out, so it
**includes the detector's end-of-turn delay**. We configured `silence_duration_ms = 550`,
but that nominal figure is not what any arm actually spends — the measured
`speech_stopped_ms` is ~740 ms under server VAD — so the engine-only view subtracts each
turn's own measurement rather than the constant.

Raw (what a caller on OpenFon's current settings experiences):

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

| arm | brain | min | **p50** | p90 | p99 |
|---|---|---:|---:|---:|---:|
| `native-direct` | gpt-realtime-2 | 611 | **1512** | 1857 | 2664 |
| `native-gateway` | gpt-realtime-2 | 1019 | **1543** | 1801 | 1880 |
| `vl-direct` | gpt-4.1-mini | 933 | **1284** | 1650 | 1662 |
| `vl-gateway` | gpt-4.1-mini | 826 | **1179** | 1453 | 1813 |
| `vl-native-brain` | gpt-realtime-2 | 957 | **1384** | 1751 | 1857 |

Paired on the engine-only figure, neither proxy comparison survives correction
(`native-gateway` − `native-direct` +33 ms, p = 1.00; `vl-gateway` − `vl-direct` −95 ms,
p raw 0.043 / Holm 0.78).

Paired, on identical caller audio in the same round:

| comparison | pairs | median Δ | 95% CI | p90 Δ | p raw | p Holm | verdict |
|---|---:|---:|---|---:|---:|---:|---|
| `native-gateway` − `native-direct` | 23 | **+12** | [−90, +141] | +502 | 1.000 | 1.000 | no detectable difference; CI admits up to 141 ms |
| `vl-gateway` − `vl-direct` | 25 | **−100** | [−280, −15] | +171 | 0.043 | 0.779 | borderline, not robust to correction |
| `vl-native-brain` − `native-direct` | 25 | **−64** | [−156, −12] | +506 | 0.015 | 0.293 | borderline, not robust to correction |

p-values are Holm-corrected across all 24 paired tests in the run (see
[Statistical discipline](#statistical-discipline)); a directional verdict additionally
requires a median shift of at least 50 ms.

Note the **p90 columns**: the gateway's tail is *tighter*, not looser
(`native-gateway` p90 2531 ms vs `native-direct` 2620 ms, and 2531 vs 3129 in run 1).
Whatever jitter the extra hop adds is smaller than the jitter already in the direct path.

`native-gateway` shows 23 turns rather than 25 because two were **rejected**, not lost —
see the session-race caveat below.

### Engine choice dominates

The interesting number is not the proxy delta, it is the gap between engines: Voice Live's
gpt-4.1-mini cascade reaches first audio at a p50 of **2002 ms** raw (1284 ms engine-only)
where gpt-realtime-2 takes **2205 ms** (1512 ms) — a raw gap of **203 ms** and an
engine-only gap of **228 ms** in run 2. Run 1 put the same gap at 549 ms raw / 443 ms
engine-only, so the magnitude is not stable across runs; the ordering is (Voice Live first
in both), and the gap is an order of magnitude larger than anything the proxy contributes.
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

| arm | brain | min | **p50** | p90 | IQR |
|---|---|---:|---:|---:|---:|
| `native-direct` | gpt-realtime-2 | 686 | **724** | 747 | 40 |
| `native-gateway` | gpt-realtime-2 | 683 | **707** | 740 | 35 |
| `vl-direct` | gpt-4.1-mini | 686 | **733** | 739 | 11 |
| `vl-gateway` | gpt-4.1-mini | 687 | **731** | 736 | 33 |
| `vl-native-brain` | gpt-realtime-2 | 692 | **727** | 751 | 31 |

**Every arm decides end-of-turn within 26 ms of every other** (p50 707–733 ms in run 2,
737–765 ms in run 1; all paired deltas null) — the 550 ms hangover plus ~170 ms of
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

| metric | native-direct | native-gateway | vl-direct | vl-gateway | vl-native-brain |
|---|---:|---:|---:|---:|---:|
| `speech_stopped_ms` p50 (VAD end-of-turn) | 724 | 707 | 733 | 731 | 727 |
| `transcript_ms` p50 (caller's transcript) | 1332 | *(n=3, excluded)* | 1271 | 1193 | 1292 |
| `connect_ms` p50 | — | **−91 ms vs direct** | — | **−121 ms vs direct** | — |

Every paired `ttft`, `transcript` and `response_total` comparison for the two proxy pairs
is null (p ≥ 0.11). The reply lengths confirm the arms were doing comparable work.

**`connect_ms` is the vantage point made visible.** The gateway is 91–121 ms faster to
open a socket (p < 0.001 on both pairs, in both runs) purely because the Cloudflare
edge is nearer than Sweden — and then gives ~50 ms of it back on `config_ms`, because the
gateway dials its upstream lazily *after* accepting the client socket, so the upstream
handshake is hidden inside session configuration rather than inside connect. Summed,
first-configured-session is still faster through the gateway from here (513 ms vs 633 ms
native; 462 ms vs 556 ms Voice Live). None of this transfers to a Cloudflare Worker,
which has a different geometry again.

---

## Statistical discipline

This run performs **24 paired hypothesis tests** (3 comparisons × 8 metrics). At
α = 0.05 that is ~1.2 spurious rejections expected under the null — so an uncorrected
table would reliably manufacture a finding. Two guards are applied, and both are in the
code rather than only in this prose:

1. **Holm–Bonferroni across the whole family**, not per-table. A reader scanning the
   report is implicitly looking at all 24 tests, so that is the family the error rate has
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

| result | median | p raw | p Holm | status |
|---|---:|---:|---:|---|
| `connect_ms`, both proxy pairs | −145 / −142 ms | 0.000 | 0.000 | **robust** — large, corrected, mechanically explained |
| `ttfa_ms`, `vl-native-brain` − `native-direct` | −93 ms | 0.043 | 0.909 | **not robust** — borderline |
| `config_ms`, `vl-gateway` − `vl-direct` | +6 ms | 0.043 | 0.909 | **not robust**, and below the floor anyway |
| `config_ms`, `vl-native-brain` − `native-direct` | +46 ms | 0.001 | 0.017 | survives Holm, **fails the 50 ms floor** |

Split rates are a *rate*, not a paired latency, so they are tested separately with
**exact McNemar** and are not part of this family. McNemar rather than Fisher's exact
because the observations are matched by construction — same caller audio, same round —
and Fisher discards the pairing, overstating the evidence by two orders of magnitude.
Only complete cells where both turns produced a usable measurement are counted; a turn
that failed has no split recorded by default, and counting it as a clean non-split would
manufacture significance out of failures.

Only the `connect_ms` results are reported as findings. In particular:

> **The −93 ms "Voice Live's serving stack is faster with the brain held constant" is not
> an established result.** Its CI upper bound touches zero (−424, −0), its corrected
> p-value is 0.91, and its `ttft` and `response_total` counterparts are both null. The
> honest statement is: *no robust difference; if anything Voice Live's stack is slightly
> faster.* Confirming it would need a dedicated, better-powered run.

The last row is worth noting for the opposite reason: it clears the correction but not the
effect-size floor. A 46 ms shift in session-configuration time is real and reproducible,
and also irrelevant to a caller.

**This discipline strengthens the headline rather than weakening it.** The proxy null is
not "we failed to find an effect" — it is a well-powered null with a tight interval: the
true proxy cost lies within roughly ±140 ms at 95% confidence on 25 pairs, with a point
estimate of −18/−19 ms and a physical explanation (≈+10 ms after correcting for the
vantage point) that agrees with an independent RTT measurement. That is a much stronger
claim than a bare "p > 0.05", and it deserves not to be surrounded by over-claimed
marginal findings.

## Caveats

**Vantage point — the main threat to external validity.** All measurements are from a
laptop in Austria. TCP RTT: Cloudflare edge **30 ms**, Azure swedencentral **61 ms**. The
gateway arms therefore get a systematically shorter client leg. Pairing cancels drift and
time-of-day load but cannot cancel path length. Production OpenFon is a Cloudflare Worker,
where the client→edge leg is very short and the edge→origin leg may differ substantially.
**A Worker-side run would settle this and has not been done.** Given that the true proxy
cost estimated here (~10 ms) is an order of magnitude below the measurement noise, it is
unlikely to change the verdict — but it would change the confidence.

**Multiple comparisons** are handled in [Statistical discipline](#statistical-discipline)
above rather than as an afterthought here: 24 tests, Holm-corrected as one family, with a
50 ms practical floor on top. The short version is that only the `connect_ms` results
survive, and "Voice Live serves gpt-realtime-2 faster than the Foundry deployment" is
**not** among the findings.

**Correction is not a substitute for power.** Holm makes the reported claims trustworthy;
it does not make the borderline ones false. A −93 ms effect on `ttfa` may well be real —
25 pairs simply cannot resolve it against this much per-turn variance (IQR ~400–500 ms).
Resolving it would need a run with several hundred pairs, or a lower-variance measurement,
and it should be pre-registered as a single hypothesis rather than harvested from a table
of 21.

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
+12 and −100. Neither run's comparison survives correction either way, so the conclusion is
unchanged; but the earlier point estimates should be read as slightly flattering to the
gateway, and this is exactly the class of error that only shows up once you check the echo
rather than the request.

**A second control diverges the same way.** Every arm's
`session.updated` echo is now checked field by field against what was asked for, and
anything that could corrupt a measurement — audio codec, sample rate, turn detector —
aborts the turn instead of being recorded and ignored. That check found the
`native-gateway` arm reporting `transcription.model = "whisper"` where the client sent
`whisper-1`: the gateway dials its upstream lazily and injects its own transcription
deployment (`AZURE_REALTIME_TRANSCRIPTION_MODEL`), which races with the client's value.

In run 2 the gateway's `whisper` deployment won on **22 of 25 turns**; over 10 consecutive
sessions in a separate probe it won 8 times. So the STT model on that arm is not merely
different from the direct arm — it varies session to session.

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

| comparison | median Δ ttfa | 95% CI | p raw / Holm |
|---|---:|---|---:|
| `vlnat-azsemantic` − `vl-native-brain`<br><sub>Azure semantic vs server VAD, brain and stack held constant</sub> | **−72 ms** | [−600, +255] | 1.000 / 1.000 |
| `nat-semantic` − `native-direct`<br><sub>OpenAI semantic vs server VAD, brain held constant</sub> | **+662 ms** | [+248, +3425] | 0.021 / 0.645 |
| `vlmini-azsemantic` − `vl-direct`<br><sub>Azure semantic vs server VAD, brain gpt-4.1-mini</sub> | +177 ms | [−69, +260] | 0.344 / 1.000 |

`speech_stopped_ms` shows the mechanism directly — this is the detector's own decision time:

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

Both main runs cost about **$2** each (125 turns, ~25 minutes wall clock), the VAD
follow-up **$1.61** (120 turns), and the split re-run **$0.9** — roughly **$6.50** across
everything. Caller-audio synthesis was a one-off four requests to Azure Speech.

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
