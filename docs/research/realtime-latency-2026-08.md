# Realtime voice latency: Kataleptic gateway vs. direct Azure

*Run 2026-08-01, 125 turns across five arms. Harness and full method in
[`bench/realtime/`](../../bench/realtime/README.md); raw data regenerable with
`bench.py --rounds 25`.*

---

## Answer

**No. Routing through the Kataleptic gateway does not cost measurable latency, for
either engine.**

| comparison | median Δ time-to-first-audio | 95% CI | sign-test p |
|---|---:|---|---:|
| gpt-realtime-2 via gateway − direct | **−18 ms** | [−138, +22] | 0.42 |
| Voice Live via gateway − direct | **−19 ms** | [−122, +60] | 1.00 |

Both intervals straddle zero, on 25 paired turns each with byte-identical caller audio.
The point estimates are *negative* — the gateway looked marginally faster — but that is a
vantage-point artefact, not a win: from the machine that ran this, the Cloudflare edge
fronting `api.kataleptic.com` is 30 ms of TCP RTT away while Azure swedencentral is 61 ms,
so the gateway arms got a shorter first leg. Correcting for that ~30 ms of geographic
advantage puts the **true proxy cost at roughly +10 ms**, which agrees with the ~5–8 ms
round-trip overhead measured directly against the gateway's protocol path during recon.

Either way the conclusion is the same and it is a null result: **the proxy is not where
your latency is.** At a p50 time-to-first-audio of 1.9–2.4 s, ten milliseconds is 0.5%.
If OpenFon wants faster turn-taking, the levers are the VAD hangover (550 ms of the
budget, ours to set) and the choice of engine (Voice Live's gpt-4.1-mini cascade is
~550 ms faster to first audio than gpt-realtime-2) — not disintermediating Kataleptic.

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

125/125 turns produced a usable measurement.

---

## Time to first agent audio

Measured from the instant the last frame of caller speech finishes playing out. It
**includes the 550 ms server-VAD hangover we configured** — a knob we chose, not engine
latency — so both views are given.

Raw (what a caller on OpenFon's current settings experiences):

| arm | brain | n | min | **p50** | p90 | p99 | IQR |
|---|---|---:|---:|---:|---:|---:|---:|
| `native-direct` | gpt-realtime-2 | 25 | 1639 | **2413** | 3129 | 3289 | 399 |
| `native-gateway` | gpt-realtime-2 | 25 | 1810 | **2307** | 2487 | 2599 | 228 |
| `vl-direct` | gpt-4.1-mini | 25 | 1586 | **1864** | 2315 | 2362 | 461 |
| `vl-gateway` | gpt-4.1-mini | 25 | 1591 | **1870** | 2428 | 2963 | 387 |
| `vl-native-brain` | gpt-realtime-2 | 25 | 1733 | **2357** | 2579 | 3795 | 496 |

Engine-only (raw − 550 ms hangover):

| arm | brain | min | **p50** | p90 | p99 |
|---|---|---:|---:|---:|---:|
| `native-direct` | gpt-realtime-2 | 1089 | **1863** | 2579 | 2739 |
| `native-gateway` | gpt-realtime-2 | 1260 | **1757** | 1937 | 2049 |
| `vl-direct` | gpt-4.1-mini | 1036 | **1314** | 1765 | 1812 |
| `vl-gateway` | gpt-4.1-mini | 1041 | **1320** | 1878 | 2413 |
| `vl-native-brain` | gpt-realtime-2 | 1183 | **1807** | 2029 | 3245 |

Paired, on identical caller audio in the same round:

| comparison | pairs | median Δ | 95% CI | p90 Δ | p | verdict |
|---|---:|---:|---|---:|---:|---|
| `native-gateway` − `native-direct` | 25 | **−18** | [−138, +22] | +171 | 0.424 | no detectable difference |
| `vl-gateway` − `vl-direct` | 25 | **−19** | [−122, +60] | +404 | 1.000 | no detectable difference |
| `vl-native-brain` − `native-direct` | 25 | **−93** | [−424, −0] | +537 | 0.043 | marginal — see caveat |

Note the **p90 columns**: the gateway's tail is *tighter*, not looser
(`native-gateway` p90 2487 ms vs `native-direct` 3129 ms; IQR 228 vs 399). Whatever
jitter the extra hop adds is smaller than the jitter already present in the direct path.

### Engine choice dominates

The interesting number is not the proxy delta, it is the ~550 ms gap between engines:
Voice Live's gpt-4.1-mini cascade reaches first audio at a p50 of **1864 ms** raw
(1314 ms engine-only) where gpt-realtime-2 takes **2413 ms** (1863 ms). Whether that
trade is worth it depends on what OpenFon values — gpt-realtime-2 hears tone rather than
words and its replies are noticeably more natural. But if the goal is a snappier phone
agent, switching tiers buys 30× more than removing the gateway would.

---

## Supporting metrics

| metric | native-direct | native-gateway | vl-direct | vl-gateway | vl-native-brain |
|---|---:|---:|---:|---:|---:|
| `ttft_ms` p50 (first text) | 2055 | 2072 | 1479 | 1509 | 2053 |
| `transcript_ms` p50 (caller's transcript) | 1367 | 1413 | 1242 | 1288 | 1405 |
| `response_total_ms` p50 | 5018 | 4803 | 2942 | 2796 | 5259 |
| `connect_ms` p50 | 549 | 359 | 481 | 355 | 427 |
| `config_ms` p50 | 84 | 154 | 75 | 107 | 142 |
| median reply audio | 11.4 s | 11.2 s | 9.9 s | 10.1 s | 12.3 s |

Every paired `ttft`, `transcript` and `response_total` comparison for the two proxy pairs
is null (p ≥ 0.11). The reply lengths confirm the arms were doing comparable work.

**`connect_ms` and `config_ms` are the vantage point made visible.** The gateway is
150 ms faster to open a socket (p < 0.001 on both pairs) purely because the Cloudflare
edge is nearer than Sweden — and then gives ~50 ms of it back on `config_ms`, because the
gateway dials its upstream lazily *after* accepting the client socket, so the upstream
handshake is hidden inside session configuration rather than inside connect. Summed,
first-configured-session is still faster through the gateway from here (513 ms vs 633 ms
native; 462 ms vs 556 ms Voice Live). None of this transfers to a Cloudflare Worker,
which has a different geometry again.

---

## Caveats

**Vantage point — the main threat to external validity.** All measurements are from a
laptop in Austria. TCP RTT: Cloudflare edge **30 ms**, Azure swedencentral **61 ms**. The
gateway arms therefore get a systematically shorter client leg. Pairing cancels drift and
time-of-day load but cannot cancel path length. Production OpenFon is a Cloudflare Worker,
where the client→edge leg is very short and the edge→origin leg may differ substantially.
**A Worker-side run would settle this and has not been done.** Given that the true proxy
cost estimated here (~10 ms) is an order of magnitude below the measurement noise, it is
unlikely to change the verdict — but it would change the confidence.

**Multiple comparisons.** Six metrics × three pairs = 18 significance tests; at α = 0.05
roughly one false positive is expected. The `vl-native-brain` − `native-direct` ttfa
result (−93 ms, p = 0.043, CI upper bound −0 ms) is exactly the kind of marginal finding
that produces. Its `ttft` and `response_total` counterparts are both null. **Treat
"Voice Live serves gpt-realtime-2 faster than the Foundry deployment" as an untested
hypothesis worth a dedicated run, not as a result.** The `connect_ms` results, by
contrast, are large, consistent across all three pairs, and have a mechanical explanation,
so those are real.

**VAD splits differ by brain, not by stack.** The German short utterance contains a clause
pause after "Guten Tag," longer than `silence_duration_ms = 550`. Server VAD commits
early, starts a response, and cancels it (`reason: turn_detected`) when the caller
resumes. This happened on **all three gpt-realtime-2 arms (6/25 turns each) and never on
the two gpt-4.1-mini Voice Live arms** — turn detection follows the brain, not the serving
stack. The harness discards those fragment responses and measures the reply to the
complete utterance. Because splits occur symmetrically within every pair, the paired
analysis is unaffected; but the native-vs-Voice-Live *cross* comparison on `de-short` is
not strictly apples-to-apples.

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

## Cost

The run cost **$1.99** in model usage (125 turns, ~25 minutes wall clock): $0.50
`native-direct`, $0.63 `native-gateway`, $0.13 `vl-direct`, $0.19 `vl-gateway`, $0.53
`vl-native-brain`. Caller-audio synthesis was a one-off four requests to Azure Speech.

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
