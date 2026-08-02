# Realtime-voice latency benchmark

Measures how long a caller waits before the agent starts speaking, across five
ways of reaching a realtime voice model — so we can answer one question:

> **Does routing through the Kataleptic gateway cost measurable latency versus
> talking to Azure directly?**

The write-up of a run lives in [`docs/research/realtime-latency-2026-08.md`](../../docs/research/realtime-latency-2026-08.md).

## The arms

| id | what it is | endpoint |
|---|---|---|
| `native-direct` | gpt-realtime-2 on Azure AI Foundry | `wss://duguet-labs-eu.cognitiveservices.azure.com/openai/v1/realtime?model=gpt-realtime-2` |
| `native-gateway` | the same deployment, via Kataleptic | `wss://api.kataleptic.com/v1/realtime?model=gpt-realtime-2` |
| `vl-direct` | Azure Voice Live, brain gpt-4.1-mini | `.../voice-live/realtime?api-version=2025-10-01&model=gpt-4.1-mini` |
| `vl-gateway` | the same, via Kataleptic's HD tier | `wss://api.kataleptic.com/v1/realtime?model=kataleptic-realtime-hd` |
| `vl-native-brain` | Voice Live serving gpt-realtime-2 | `.../voice-live/realtime?api-version=2025-10-01&model=gpt-realtime-2` |

The design is a 2×2 plus a control:

* `native-gateway` − `native-direct` and `vl-gateway` − `vl-direct` isolate **the proxy**.
* `vl-native-brain` − `native-direct` isolates **Voice Live's own serving stack**, with the
  brain (`gpt-realtime-2`) and the voice (`marin`) held constant. Voice Live will serve
  `gpt-realtime-2` as a managed model with no Foundry deployment involved, which is what
  makes this control possible.

Every direct arm points at `duguet-labs-eu` in **swedencentral** — the same resource and
region the gateway proxies to. The westeurope Speech resource (`openfon-speech`) is
deliberately not used as an arm: it would confound region with stack.

### The VAD follow-up arms (`VAD_ARMS`)

Three further arms vary the *turn detector* with the brain pinned, to separate "better
brain" from "better turn detector":

| id | brain | detector |
|---|---|---|
| `nat-semantic` | gpt-realtime-2, Foundry | OpenAI `semantic_vad` |
| `vlnat-azsemantic` | gpt-realtime-2, Voice Live | `azure_semantic_vad_multilingual` |
| `vlmini-azsemantic` | gpt-4.1-mini, Voice Live | `azure_semantic_vad_multilingual` |

Not every brain/detector pairing exists — Foundry rejects Azure's detector, and Voice Live
rejects OpenAI's on a cascaded brain. The accepted and rejected combinations are recorded
in `arms.py` next to the arm definitions.

Run them with `--arms` and, for the split-rate question, `--utterances de-short` (the only
utterance that ever splits). `analyze.py` reports only the comparisons whose two arms are
both present in the dataset, so the main run and the follow-up each get exactly their own —
and the Holm family is sized to the tests actually performed.

## Metrics

All times in milliseconds. Reply metrics are measured from **the instant the last frame of
caller speech finishes playing out**, not from the send call.

| field | meaning |
|---|---|
| `connect_ms` | dial → WebSocket open |
| `config_ms` | `session.update` sent → the `session.updated` **that echoes our own marker** |
| **`ttfa_ms`** | **end of caller speech → first agent audio delta. The headline number.** |
| `speech_stopped_ms` | end of caller speech → the server's own `speech_stopped`. Isolates the VAD's end-of-turn decision from model and TTS time, so an engine difference can be attributed to the right stage. |
| `ttft_ms` | end of caller speech → first agent text/transcript delta |
| `transcript_ms` | end of caller speech → `conversation.item.input_audio_transcription.completed` |
| `response_total_ms` | end of caller speech → `response.done` |
| `audio_out_ms` | duration of the decoded reply audio |
| `false_starts` | responses server VAD began and cancelled mid-utterance, at a clause pause longer than `silence_duration_ms`. Their timings are discarded, not measured. |
| `false_starts_audible` | how many of those got as far as emitting audio. This is the difference between "the caller was talked over" and "the service silently re-segmented the turn" — two very different severities, so it is measured rather than assumed. |
| `transcript_item_id` | which committed input item the accepted caller transcript belongs to. A split turn commits several, and a late transcript for an earlier fragment must not become the turn's `transcript_ms`. |

`ttfa_ms` **includes the detector's end-of-turn delay**, so `analyze.py` reports it twice:
raw, and engine-only. The engine-only figure subtracts **each turn's own measured
`speech_stopped_ms`**, never the nominal `silence_duration_ms` — the configured 550 ms is
not what any arm actually spends (server VAD measures ~740 ms), and a semantic detector
has no fixed hangover to subtract at all. Turns with no `speech_stopped` event are
excluded rather than guessed at. Quote the engine-only figure when comparing model speed;
quote the raw figure when reasoning about what a caller experiences.

### Why `config_ms` matches on a marker

On the proxied arms the gateway injects **its own** `session.update` upstream before it
forwards ours — a multilingual voice on the HD tier, a transcription default on
gpt-realtime-2. The first `session.updated` you receive is therefore not a reply to your
config. The harness embeds a random marker in `instructions` and waits for the echo that
contains it. A harness that keys off "the" `session.updated` would start streaming against
a half-configured session.

## What is held constant

* **Caller audio** — synthesized once with Azure Speech TTS, cached as raw PCM16 @ 24 kHz,
  and replayed byte-identically to every arm. Leading/trailing silence is trimmed so
  `ttfa_ms` is not inflated by TTS tail padding.
* **Real-time pacing** — 20 ms frames on a wall clock. Blasting the buffer would make VAD
  timing meaningless. Silence frames keep flowing after the utterance so server VAD has
  something to time its hangover against.
* **Instructions** — the same Riverside Dental receptionist prompt on every arm.
* **Turn detection** — `server_vad`, threshold `0.7`, prefix padding `300`, silence `550`
  on every arm of the main design. Voice Live defaults `silence_duration_ms` to 200 where
  the native endpoint defaults to 500; unpinned, that alone would be a 300 ms artefact.
  `speech_stopped_ms` confirms the pin held: in the shipped run all five arms decided
  end-of-turn within 28 ms of each other.
* **Audio format** — PCM16 @ 24 kHz in and out on every arm.
* **Voice and STT within each comparison** — `marin` + `whisper-1` on all three
  gpt-realtime-2 arms; `en-US-AvaMultilingualNeural` + `azure-speech` on both
  gpt-4.1-mini arms.
* **Conversation context** — one fresh session per turn, so no arm accumulates a longer
  prompt than another.
* **Verified, not assumed** — every arm's `session.updated` echo is checked field by field
  (`Arm.verify_echo`) against what was asked for. Matching the marker only proves the
  update was *processed*; it does not prove the endpoint *honoured* it.

  The governing rule is **absent must not read as valid**: a missing field is a mismatch,
  not a skip, because a control you cannot confirm is not a control. Divergences split two
  ways. **Fatal** ones abort the turn — audio codec and sample rate in both directions,
  and the turn detector's type and numeric parameters. Those are the settings whose
  violation makes a measurement *wrong* rather than merely different: `audio_out_ms` is
  derived from a byte count assuming PCM16 @ 24 kHz, so a silent codec substitution would
  corrupt every reply-length figure while looking entirely plausible. **Advisory** ones
  (STT model, voice) are recorded and reported but do not abort, since they cannot corrupt
  a timing. Both are summarised at the top of the analysis.

  `verify_live.py` checks the checker against the real endpoints: it captures each arm's
  actual echo, asserts it verifies clean (no false aborts), then mutates it — codec
  substituted, field removed, rate changed, detector swapped — and asserts every mutation
  is caught. Run it after touching `verify_echo`.
* **Ordering** — turns are strictly serial (parallel handshakes inflate `connect_ms` to
  several seconds) and interleaved round-robin, with the arm order rotated each round.

### Known confounds that could not be removed

* **Dialect.** Voice Live speaks the flat/beta wire format; the native endpoint and the
  gateway speak GA nested. The harness sends each arm its native dialect. The gateway's
  translation work is part of what we are measuring, so this is correct — but it does mean
  `vl-direct` and `vl-gateway` are not byte-identical on the wire.
* **TTS engine across the VL/native split.** `vl-direct` synthesizes with Azure neural
  voices, the gpt-realtime-2 arms emit native model audio. Comparisons *within* a pair are
  clean; `vl-direct` vs `native-direct` mixes two different speech stacks and is reported
  only as context.
* **Vantage point.** See below — this is the big one.

## Vantage point (read this before trusting the numbers)

The run in `docs/research/` was taken from a laptop in Austria. From there the Cloudflare
edge that fronts `api.kataleptic.com` is ~29 ms away while Azure swedencentral is ~72 ms —
so the gateway arms get a *shorter* first leg than the direct arms, which flatters the
proxy. Production OpenFon is a Cloudflare Worker, where the geometry is different again
(Worker → CF edge is very short, and the Worker may already be running near the origin).

The paired analysis cancels a lot of this, because both arms of a pair are measured
seconds apart over the same access network — but it cannot cancel the systematic
difference in path length. **Treat the proxy delta as an estimate from one vantage point,
not a universal constant.** A Worker-side measurement would settle it and is not built here.

## Running it

```bash
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt

export AZURE_REALTIME_KEY=$(az cognitiveservices account keys list \
  -n duguet-labs-eu -g qptr-projects --query key1 -o tsv)
export AZURE_SPEECH_KEY=$(az cognitiveservices account keys list \
  -n openfon-speech -g openfon-rg --query key1 -o tsv)   # first run only
# KATALEPTIC_KEY falls back to DEFAULT_LLM_API_KEY in .dev.vars

./venv/bin/python bench.py --rounds 25 --tag full
./venv/bin/python analyze.py results/turns-<stamp>-full.jsonl --markdown tables.md
```

Useful flags: `--arms native-direct,vl-direct` to narrow, `--rounds 1` to smoke-test,
`--gap` to change the pause between turns, `--reply-timeout` for slow arms.

`requirements.txt` floors `websockets` at **14**, and that floor is load-bearing rather
than cosmetic: in 13.x the top-level `websockets.connect` still resolved to the legacy
client, whose keyword is `extra_headers`, so every turn would fail at connect.

### How `analyze.py` decides something is real

Two views. **Marginal** is the per-arm distribution of each metric. **Paired** is the
per-cell difference on identical `(round, utterance)` input — the view that answers "does
the proxy cost anything", because pairing cancels the network and time-of-day noise that
dominates the marginals.

Significance is a two-sided exact sign test plus a seeded percentile bootstrap CI on the
median — both distribution-free, so no scipy and no normality assumption about latency
(which is never normal). On top of that, two guards stop a bare p < 0.05 from minting a
directional claim:

* **Holm–Bonferroni across the whole family** of paired tests in the run (3 comparisons ×
  7 metrics = 21). At α = 0.05 that many tests yield ~1 spurious rejection under the null,
  so an uncorrected table would reliably manufacture a finding. Correction spans all
  metrics rather than each table separately, because a reader scanning the report is
  implicitly looking at all of them. Holm rather than Bonferroni: uniformly more powerful,
  and assumes nothing about independence — `ttfa` and `ttft` measure overlapping stages of
  the same turn.
* **A 50 ms practical floor** (`PRACTICAL_MS`). Below it the verdict reads "no practical
  difference" whatever the p-value. Turn-taking gaps only become perceptible to a caller
  well into the 100 ms range. In the shipped run this correctly demotes a +6 ms result
  that was nominally significant, and a +46 ms one that even survived Holm.

Split rates get **exact McNemar** instead, not the sign test and emphatically not Fisher's
exact: the observations are matched by construction — same caller audio, same round — and
Fisher would discard the pairing and overstate the evidence by two orders of magnitude
(~1e-5 where the correct answer is 0.00195). Rates are kept out of the Holm family over
the latency metrics. Only complete cells where **both** turns produced a usable
measurement are counted; a turn that died in connect has `false_starts = 0` by default,
and counting it as a clean non-split would manufacture significance out of failures.

Tables show raw and adjusted p side by side, so a demoted result stays visible instead of
disappearing.

### Tests

```bash
python3 -m unittest discover -s bench/realtime -v
```

86 tests, split across `test_analyze.py` (the statistics behind every published table —
percentiles, paired differences, the exact sign test, the bootstrap CI, the Holm
step-down, exact McNemar, matched-cell construction, and the verdict gating) and
`test_harness.py` (the controls that make a run trustworthy — echo verification, cache
keying, framing, silence trimming), plus credential redaction. The network path is not
unit-tested; a wrong percentile, a mis-scaled correction or an unmatched significance test
would corrupt every number in the report while looking entirely plausible.

### Secrets

The gateway takes its key in the query string (`?token=`), which is what its
protocol requires, and websocket libraries put the request URI into exception messages.
Every string persisted to `results/` therefore passes through `redact()` first, on all
error paths. `cache/` and `results/` are gitignored regardless — the caller WAVs
regenerate from `utterances.json` on first run.

## Cost and caps

A 25-round run is ~125 turns and costs roughly **$4** (measured: ~$0.068 per round of five
turns on the shortest utterance, scaling with utterance length). Before a bigger run, check:

* the deployment's **200 requests/min** ceiling — the serial design plus `--gap 0.75` stays
  far under it, but do not parallelise without recalculating;
* **100 000 tokens/min** on the `gpt-realtime-2` deployment;
* the gateway's global `DAILY_CAP_USD` breaker, which closes new sessions with code `4503`;
* session TTLs (3600 s native, 7200 s Voice Live) — irrelevant here since every turn opens
  a fresh session, but they bite any soak test.

## Files

| file | role |
|---|---|
| `arms.py` | arm definitions, per-dialect `session.update` construction, event-name normalization |
| `audio.py` | Azure Speech synthesis, silence trimming, 20 ms framing, disk cache |
| `bench.py` | the harness: one turn = one session, round-robin driver, JSONL + CSV output |
| `analyze.py` | marginal and paired statistics, markdown tables |
| `utterances.json` | the fixed caller utterances (EN + DE, short + long) |
| `verify_live.py` | checks `verify_echo` against the live endpoints, both directions |
