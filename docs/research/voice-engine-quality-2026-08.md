# Voice engine quality: Azure Voice Live vs gpt-realtime-2

Run 2026-08-02. Harness, raw logs and CSVs: [`bench/quality/`](../../bench/quality/).
Datasets: [`voice-eval-datasets.md`](./voice-eval-datasets.md).
Actual spend **$23.19** at catalog sell rates (direct Azure retail is lower).

---

## The answer

**Keep `kataleptic-realtime-hd` (Voice Live + gpt-4.1-mini) as the default for
information-only businesses, route booking businesses to gpt-realtime-2, and
never turn on Azure's noise suppression.**

That split is sharper than the earlier draft of this report, because fixing the
scoring bugs in §Confounds 11 widened the quality gap rather than closing it.
Voice Live is faster and cheaper and hears better; gpt-realtime-2 is
substantially more reliable at completing a whole call without saying something
untrue. OpenFon already stores `realtime_model` per business, so this is a
settings default, not a rebuild.

| | Voice Live + gpt-4.1-mini | gpt-realtime-2 (either stack) |
|---|---|---|
| Time to first audio, p50 | **1315 ms** | 2077–2408 ms |
| Time to first audio, p95 | **1719 ms** | 3325–3722 ms |
| Caller-slot capture, heard | **0.960** | 0.893–0.920 |
| Caller-slot capture, echoed back | 0.697 | **0.816–0.908** |
| Judge groundedness | 0.704 | **1.000** |
| Strict task success | 0.333 | **0.407–0.593** |
| pass^3 | 0.222 | **0.222–0.556** |
| Cost | **$0.03/min** | $0.07/min |

Voice Live answers **~690 ms sooner at p50 and ~1.3 s sooner at p95**, at 43 %
of the cost, and it *hears* the caller better — 0.960 vs 0.893 slot
capture, and it never lost a phone number. On a phone call the latency gap is
the difference between a receptionist and a bad connection.

What you give up is sharper than the latency gap. gpt-realtime-2 got a **perfect
groundedness score — 0 unsupported claims in 54 scored runs** — against 21 for
the Voice Live arms,
and it completes the whole call correctly **three times out of three in 55.6 % of
scenarios against 22.2 %**. The two engines fail differently: one
mishears a name, the other says something that is not true.

**What gpt-4.1-mini actually gets wrong matters for a booking business.** Six of
its 21 groundedness failures are the agent telling a caller a specific slot *is
available* — "Thursday, August 6th, after 3 PM is available" — when the prompt
says in as many words *"Do not promise a confirmed slot."* gpt-realtime-2 never
did this. A practice would have to either honour those slots or ring the caller
back to apologise.

The remaining 9 are the judge applying "no unsupported business fact" to
conversational framing such as *"Dr. Weber is not available right now"* while
taking a message. That is defensible behaviour and arguably a judge false
positive, so **the raw 0.704 overstates the problem** — but the over-promising
subset does not, and it is concentrated exactly where money changes hands.

**The most decision-relevant number:** `vl-native-brain` (Voice Live serving
gpt-realtime-2) scores like gpt-realtime-2 on groundedness (1.000) and like
gpt-realtime-2 on latency (2408 ms p50 — the *worst* p50 of any arm). So **the
quality difference is the brain, and the speed difference is also the brain, not
the serving stack.** Switching serving stack buys nothing on its own. There is
no configuration that gets you gpt-realtime-2's judgement at gpt-4.1-mini's
latency.

### Three things to change now

1. **Never enable `input_audio_noise_reduction`.** Azure's
   `azure_deep_noise_suppression` makes recognition **worse under exactly the
   noise it exists to remove** — German WER rises 6.05 → 7.47 at 10 dB cafe
   noise and 9.84 → 16.84 at 5 dB, with zero dropped utterances, so this is
   recognition damage and not a plumbing artefact. On English it additionally
   drops ~24 % of utterances entirely, even on clean audio. Reproduced at n=50;
   see §"Noise suppression" for the full teardown. OpenFon does not set this
   knob today, so the shipped config is already correct — this is a "do not
   'improve' this later" finding and is worth a comment in `call-session.ts`.
2. **`end_call` is unreliable on every arm** — 17–19 of 27 scored runs, with no
   meaningful spread between engines. It is the single biggest drag on strict
   task success, and on `reschedule-en-01` it fired **1 time in 15**: the agent
   captured every detail correctly and then would not close the call. The
   existing `isFarewell` heuristic and 15 s DO safety net are load-bearing, not
   belt-and-braces. Do not remove them.
3. **Route booking businesses to gpt-realtime-2.** The one thing gpt-4.1-mini
   gets wrong that costs real money is promising appointment slots the business
   has not confirmed, against an explicit prompt rule. `realtime_model` is
   already per-business in `agent_settings`, so this is a default, not a build.

---

## Arms

| arm | stack | brain | STT | VAD | front-end |
|---|---|---|---|---|---|
| `vl-gpt41mini` | Voice Live | gpt-4.1-mini | azure-speech | server_vad | none — **as shipped** |
| `vl-gpt41mini-dns` | Voice Live | gpt-4.1-mini | azure-speech | server_vad | `azure_deep_noise_suppression` |
| `vl-gpt41mini-semvad` | Voice Live | gpt-4.1-mini | azure-speech | azure semantic | none — VAD control |
| `vl-native-brain` | Voice Live | gpt-realtime-2 | azure-speech | azure semantic | none |
| `native-gpt-realtime-2` | Foundry `/openai/v1/` | gpt-realtime-2 | whisper-1 | server_vad | not offered |

All arms went **direct to Azure**, not through the Kataleptic gateway: the
gateway adds ~5–8 ms round-trip (immaterial), but going direct avoids its global
`DAILY_CAP_USD` breaker, its injected second `session.updated`, and its
substitution of the transcription model. Constant across arms.

---

## Track A — understanding and noise robustness

25 FLEURS utterances per condition, en_US and de_DE, 8 conditions, 1200
transcripts. Transcription-only sessions (VAD off, manual commit) so each
transcript covers exactly the clip sent.

**This measures the STT front-end each stack ships** — whisper-1 on the Foundry
GA surface, azure-speech on Voice Live — as experienced through a live session.
It is not a free-standing ASR comparison.

WER %, `(Ne)` = utterances returning an empty transcript:

| condition | vl-gpt41mini | vl-gpt41mini-dns | native-gpt-realtime-2 |
|---|---|---|---|
| **en_US** | | | |
| clean | 4.83 | 47.76 (8e) | **4.47** |
| cafe 20 dB | 5.01 | 55.99 (10e) | **4.47** |
| cafe 10 dB | **5.55** | 52.06 (7e) | **5.55** |
| cafe 5 dB | **5.72** | 56.35 (8e) | 6.44 |
| cafe 0 dB | **12.34** | 64.40 (6e) | 14.31 (1e) |
| G.711 telephony | **5.72** | 50.27 (8e) | 6.08 |
| telephony + cafe 10 dB | 8.59 | 61.90 (10e) | **7.69** |
| telephony + 3 % loss | 8.77 | 46.69 (7e) | **8.23** |
| **de_DE** | | | |
| clean | 3.70 | 3.90 | **3.31** |
| cafe 20 dB | 4.29 | 5.85 (1e) | **3.12** |
| cafe 10 dB | 4.68 | 7.21 | **4.29** |
| cafe 5 dB | **7.99** | 15.40 (1e) | 8.58 |
| cafe 0 dB | **20.47** | 40.35 (2e) | 34.50 |
| G.711 telephony | 4.29 | **3.70** | **3.70** |
| telephony + cafe 10 dB | **5.07** | 9.16 | 6.63 |
| telephony + 3 % loss | **5.26** | 4.68 | 5.07 |

**The two engines are much closer on recognition than the latency gap
suggests.** In **12 of the 16** language×condition cells they are within one WER
point of each other. whisper-1 wins more cells (10 of 16) but wins them small —
its largest margin anywhere is 1.17 points. azure-speech wins 6, and wins them
big: −1.97 (en 0 dB), −1.56 (de telephony+noise), and −14.03 (de 0 dB).

So the honest summary is: **on clean and moderately degraded audio there is no
meaningful difference, and the choice should not be made on WER.** Where the gap
opens it is under heavy noise and it favours azure-speech — at 0 dB cafe noise in
German, 20.5 % vs 34.5 %, a 41 % relative advantage in the condition that most
resembles a caller standing outside a café. That is the one recognition result
that should carry weight in the decision.

All latency percentiles here are over **individual caller turns** (96–106 turns
per arm), not over per-call medians. A p95 of per-call medians discards the one
slow reply inside an otherwise normal call, which is the event a p95 exists to
capture; it read 1654 ms for Voice Live and up to 3812 ms for gpt-realtime-2,
both wrong in opposite directions.

**SNR₅₀** is the signal-to-noise ratio, in dB, at which an arm's WER reaches
**twice its own clean-audio WER**, linearly interpolated between the measured
20 / 10 / 5 / 0 dB points. It compresses a whole degradation curve into one
number and is self-normalising — an arm with a poor clean WER is not rewarded
for having less far to fall. **Lower is better**: it means the engine tolerates
more noise before its error rate doubles. `<0` means the curve never reached 2×
even at 0 dB; `>20` means it was already past 2× at the mildest noise tested.

| arm | en_US | de_DE |
|---|---|---|
| vl-gpt41mini | **2.0 dB** | **5.9 dB** |
| native-gpt-realtime-2 | 3.4 dB | 7.3 dB |
| vl-gpt41mini-dns | <0 (degenerate) | 9.6 dB |

Voice Live tolerates ~1.4 dB more noise in both languages before its error rate
doubles.

**Telephony is a non-event.** The G.711 μ-law 8 kHz chain — the exact Twilio
path — costs 0.4–1.6 pp of WER on every working arm. Neither engine is hurt by
the phone network itself; they are hurt by what is behind the caller.

### Noise suppression

The DNS column above is extreme enough that it was treated as a suspected
artefact and chased down separately before being reported. `probe_dns.py`
re-runs clean English at **n=50** across five legs; the German legs re-run at
n=50 across three noise levels.

**English, clean audio, n=50:**

| leg | empty transcripts | WER (all) | WER (non-empty only) |
|---|---|---|---|
| no noise reduction | 0 % | **4.01** | 4.01 |
| `near_field` | 0 % | **4.01** | 4.01 |
| `far_field` | 0 % | **4.01** | 4.01 |
| `azure_deep_noise_suppression` | **24 %** | 38.34 | 16.83 |
| `azure_deep_noise_suppression` @ 16 kHz | **30 %** | 47.72 | 25.74 |

**German, n=50 per cell:**

| condition | no NR | deep NR | empties (deep) |
|---|---|---|---|
| clean | 4.26 | 4.35 | 0 |
| cafe 10 dB | 6.05 | **7.47** | 0 |
| cafe 5 dB | 9.84 | **16.84** | 1 |

Four things follow, and the alternative explanations are ruled out rather than
waved away:

1. **It reproduces.** 4.01 → 38.34 on 50 clean English clips, matching the main
   run's 4.83 → 47.76 on 25.
2. **The primary harm is recognition, not plumbing.** German has *zero* dropped
   utterances yet still degrades 23 % relative at 10 dB and 71 % at 5 dB.
   Azure's deep noise suppression **makes recognition worse under exactly the
   noise it exists to remove.** On matched clip IDs (same utterances, DNS's
   non-empty subset only) the English clean figure is 5.00 → 18.89, so the
   returned transcripts are worse too — they are not merely fewer.
3. **It is specific to the deep model.** `near_field` and `far_field` produce
   WER identical to off to two decimal places with zero empties, which also
   means those two values are effectively **no-ops** on this path. Only
   `azure_deep_noise_suppression` does anything, and what it does is harmful.
4. **It is not a sample-rate interaction.** Re-running the deep model on a
   16 kHz input contract made it *worse* (30 % empties, 47.72 WER), not better.

Ruled out along the way: **locale mismatch** — `session.updated` echoes
`en-US` for both English arms and `de-DE` for German, with identical
`input_audio_sampling_rate` and format, the NR knob being the only difference;
**truncation** — median hypothesis/reference word ratio is 1.00 on the returned
DNS transcripts, with 1 of 17 short; **pairing drift** — the `off` leg of this
probe shares the harness path exactly and lands at the expected 4.01 %.

The empty transcripts are a genuine service behaviour, not a collector bug: for
the affected items the service emitted *two*
`input_audio_transcription.completed` events and **both were empty**
(`logs/asr-vl-gpt41mini-dns-en_us-clean.jsonl`).

The language asymmetry — catastrophic in English, merely harmful in German —
remains unexplained. It is characterised rather than understood, and it is why
the recommendation is "leave the knob alone" rather than "enable it for German".

---

## Track B — task success and responsiveness

11 Riverside Dental scenarios (7 DE, 4 EN) × 5 arms × 3 trials = **165 live
calls**, 0 errors — of which **135 are scored**: the two barge-in scenarios are
run and logged but excluded from every aggregate (see below). Run against the real system prompt: `gen_prompt.ts` calls
`buildSystemPrompt` from `src/prompt.ts`, so the 21-day calendar block every date
question depends on is the genuine one, pinned to Monday 2026-08-03.

| arm | success | pass^3 | slots heard | slots echoed | end_call | grounded (judge) | resolution | tone | TTFA p50 | TTFA p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| `native-gpt-realtime-2` | **0.593** | **0.556** | 0.893 | 0.816 | 18/27 | **1.000** | 1.741 | 1.519 | 2077 | 3325 |
| `vl-native-brain` | 0.407 | 0.222 | 0.920 | **0.908** | 17/27 | **1.000** | 1.778 | 1.556 | 2408 | 3722 |
| `vl-gpt41mini-dns` | 0.370 | 0.222 | **0.960** | 0.681 | 17/27 | 0.815 | 1.778 | 1.667 | 1408 | 1891 |
| `vl-gpt41mini` | 0.333 | 0.222 | **0.960** | 0.697 | 18/27 | 0.704 | 1.778 | **1.778** | **1315** | **1719** |
| `vl-gpt41mini-semvad` | 0.259 | 0.111 | 0.920 | 0.740 | **19/27** | 0.704 | **1.852** | 1.667 | 1320 | 1852 |

**Nine scenarios, not eleven.** The two barge-in scenarios are run and logged but
excluded from every aggregate — see below. 27 scored runs per arm.

`success` is a strict conjunction: every expected slot heard correctly, `end_call`
invoked where expected, every grounded fact stated, no forbidden claim, the
judge's groundedness verdict positive, and the run free of transport errors.
`pass^3` requires that on **all three** trials.

**The two capabilities separate cleanly.** Voice Live *hears* better — 0.960 vs
0.893 slot capture, and it never lost a phone number. gpt-realtime-2 *reasons*
better — a perfect 1.000 groundedness against 0.704, and it completes the whole
call correctly on all three trials in 55.6 % of scenarios against 22.2 %.

**`end_call` is the biggest single drag on strict success and is equally bad
everywhere** (17–19 of 27). Because no arm is meaningfully better, it does not
separate the engines — but it is a real product bug, and on `reschedule-en-01`
it fired **1 time in 15**: the agent captured every detail correctly and then
would not close the call.

Where the remaining failures come from, now that the fixture and scoring defects
are out of the way (Confounds 9 and 11):

| scenario | success | what fails |
|---|---|---|
| `book-de-01` | 0/15 | the ASR hears **"Katrin"** for "Kathrin" on 15/15 — one letter, but the wrong name in the booking |
| `reschedule-en-01` | 1/15 | every slot captured; `end_call` fires 1/15 |
| `message-de-01` | 2/15 | `end_call`, plus the judge objecting to "Dr. Weber is not available right now" |
| `codeswitch-01` | 2/15 | language switch followed **15/15**; `end_call` 0/15 |
| `hours-en-01` | 12/15 | mostly passes once time-valued facts are matchable |
| `holiday-de-01` | 15/15 | the special-closure calendar lookup works on every arm and trial |

**Heard vs echoed.** `slots heard` is whether the engine's own caller transcript
contains the value — did it *hear* the phone number. `slots echoed` is whether
the agent repeated it back. The confirmation gap is brain/prompt behaviour, not
recognition, and is fixable in the prompt; a recognition gap is not.

**Code-switching: every arm followed the German→English switch on 3/3 trials,
15 of 15 runs.** An earlier draft reported native gpt-realtime-2 failing once;
that came from scoring language adherence off the *caller's* transcript rather
than the agent's final turn, which is the only place the answer lives.

### Barge-in — measured, and withdrawn

**No barge-in numbers are reported.** Interruption handling was measured four
times across four rounds of review, and each round found the previous
measurement wrong:

1. *Stop latency* timed when agent audio stopped arriving on the wire — which is
   not when the agent stopped speaking, because these services deliver a whole
   response far faster than real time.
2. *Adoption of the correction* read the **caller's** transcript, so a perfectly
   transcribed correction counted as adopted even when the agent ignored it.
3. *Cancellation* watched for a top-level `response.cancelled` event that neither
   service emits, so it read false for every real cancellation.
4. *In-flight state* was recorded **after** the quiescence wait, so a response
   that finished during the wait read as "nothing in flight"; and when the
   previous response was silent or tool-only, the barge-in turn's audio was
   **skipped entirely** — the scripted correction was never spoken and the rest
   of that scenario was silently invalid.

The fourth is not a mismeasurement but an invalidated run, with no error raised.
Four independent defects in one metric is not a metric, so the numbers are gone
rather than caveated. **Barge-in is not measurable server-side with this design.**

The two barge-in scenarios still run — they exercise interruption end to end and
their transcripts are useful to read — but nothing is scored from them.

For the product, the qualitative finding stands and does not depend on any of
the withdrawn numbers: **interruption is the client's responsibility.**
OpenFon's `CallSession` must discard its own playback buffer. Nothing in either
engine will do it, and on Voice Live there is often no server-side generation
left to cancel by the time a caller interrupts, because the reply has already
been delivered in full.

## How much to trust these numbers

Written down because a reader deciding on the strength of this study deserves the
same summary the reviewers had.

**Thirteen instances of one bug class** were found across nine rounds of review, in
which missing or unverified data read as a passing result — a missing judge row,
an empty judge file, a missing trial, duplicate trials counted as distinct ones,
a scenario an arm never ran, an unparseable numeric, an errored run, a call the
agent never joined, a runner that swallowed its own errors, a shell that reported
success anyway, a duplicated ASR clip double-weighted in a WER, and an ASR batch that exhausted its retries and was published as 100 % WER rather than as the outage it was. Three
successive sweeps each missed instances of the class they were sweeping for,
which is why the checks are now enumerated in
[`bench/quality/COMPLETENESS.md`](../../bench/quality/COMPLETENESS.md) rather
than held in anyone's head.

**One metric was withdrawn.** Barge-in had four independent defects in four
rounds and is not reported at all — see above.

**The recommendation never moved.** Across every correction, the ordering of the
arms and the shape of the trade-off stayed the same: Voice Live is faster,
cheaper and hears better; gpt-realtime-2 is markedly more reliable at completing
a call without asserting something untrue. Corrections changed magnitudes — the
p95 latency gap narrowed substantially, strict success rose on every arm once
time-valued facts became matchable — but never the direction.

So: **treat the ordering as solid and the absolute values as approximate.** The
figures that survived scrutiny unchanged are the WER table, the slot-capture
rates and the judge groundedness verdicts. The figures that moved under
correction, and could move again, are the latency percentiles and the strict
task-success rates. The figure that did not survive is barge-in.

## Confounds and limits

Stated rather than smoothed over. The first two change what the numbers *mean*,
not merely what they are, and belong ahead of everything else.

### The absolute rates are optimistic: the recogniser was told the language

Both tracks pass the scenario's language to the speech recogniser — `language`
to Azure Speech on the Voice Live arms, and to `whisper-1` on the Foundry arm.
**Production does not.** `src/call-session.ts` leaves it unset so that language
is detected per utterance, which is what a real caller gets.

Every slot-capture and success figure in this report therefore benefits from an
oracle prior the product does not have. A reader who sees "0.960 slots heard"
should not read it as what a caller experiences: it is what a caller would
experience if the system already knew which language they were about to speak.
The gap is likely largest exactly where it matters most — German names and
digit strings, and the code-switching scenario, whose 15/15 result is the most
optimistic number in the document for this reason.

Both arms received the same prior, so the *comparison* is unaffected. Only the
levels are.

### Time-slot matching is approximate, in both directions

Expected appointment times are matched by parsing clock mentions out of the
text. Three rounds of review improved it and it is still loose, so rather than
attempt a fourth regex the limits are stated:

- **Numeric strings are parsed as times.** The digit pattern does not know a
  phone number from a clock, so *"Meine Nummer ist 152 288 17386"* yields a
  15:00 mention and can satisfy `time_after=15:00` with no time recognised at
  all. This inflates.
- **Spoken composite times record only the hour.** *"at two thirty"* is read as
  hour 2 with no minute, so it satisfies an expected 14:00 — reintroducing
  precisely the wrong-minute false positive the numeric parser was rewritten to
  reject. This also inflates.

Both push the same way, so **strict success on the booking scenarios
(`book-en-01`, `book-de-01`, `reschedule-en-01`) is optimistic by an unmeasured
amount.** At 27 runs per arm that metric is already noisy — a single run is
0.037 — so a reader should treat booking-scenario success as directional and
weight the WER table, slot capture and groundedness verdicts more heavily. Both
failure modes affect every arm identically, so the comparison is not skewed.

### The strict-success comparison may favour engines that hang up earlier

Production begins tearing the call down when `end_call` fires. The harness
records the tool and keeps streaming the remaining scripted turns, so a later
transcript — and any slot it satisfies — can be credited to a call that would
already have ended. Since `end_call` fires in 17–19 of 27 scored runs, the
mechanism is live rather than theoretical, and it biases *toward* engines that
end calls sooner, which is a comparison-level effect rather than a level-only one.

**Measured exposure in this run: two turns, on one arm.** Across all 135 scored
runs, `end_call` fired before the final turn only twice, both on `vl-gpt41mini`;
every other arm streamed nothing after it. That is because the scripted
`end_call` almost always lands on the closing turn, where there is nothing left
to stream.

**Could it flip the ordering? No, on this dataset.** The gap between
`vl-gpt41mini` (0.333) and `native-gpt-realtime-2` (0.593) is seven runs out of
27. The exposure is two turns, and it runs against `vl-gpt41mini` — the arm that
would *lose* credit — so removing it would widen the gap rather than close it.
The mechanism could matter in a scenario set with more post-goodbye content;
it does not matter here, and the harness cannot quantify it beyond this because
it never modelled the hang-up.

1. **VAD is not held constant between stacks, and semantic VAD is not free.**
   Voice Live **rejects** `server_vad` on the gpt-realtime-2 brain
   ("turn_detection must be of type AzureSemanticVAD"), so `vl-native-brain`
   runs Azure semantic VAD while `native-gpt-realtime-2` runs server VAD.
   `vl-gpt41mini-semvad` is the control. On the final scored dataset, holding
   brain and stack constant:

   | server → semantic VAD, gpt-4.1-mini on Voice Live | change |
   |---|---|
   | strict success | 0.333 → 0.259 (**−0.074**) |
   | pass^3 | 0.222 → 0.111 (**−0.111**) |
   | slots heard | 0.960 → 0.920 (−0.040) |
   | judge groundedness | 0.704 → 0.704 (no change) |
   | `end_call` | 18/27 → 19/27 (+1) |
   | TTFA p50 / p95 | 1315 → 1320 ms / 1719 → 1852 ms (**+5 / +133**) |

   An earlier draft of this report claimed −69 ms and no effect on success. That
   was wrong in both directions and is withdrawn: semantic VAD is **marginally
   slower and scores slightly worse** on this brain. At 27 runs per arm the
   success delta is two runs and the pass^3 delta is one scenario, so treat the
   magnitude as noise — but the *direction* is against semantic VAD, not for it.
   Anyone adopting it for false-start suppression should verify that benefit
   separately; this study does not show it paying for itself.

   **The attribution survives, via a cleaner cell than the control.** Holding
   *both* stack and VAD constant — Voice Live, semantic VAD, brain varied —
   `vl-gpt41mini-semvad` vs `vl-native-brain` is the one fully-controlled
   comparison in the design:

   | gpt-4.1-mini → gpt-realtime-2, Voice Live, semantic VAD | change |
   |---|---|
   | strict success | 0.259 → 0.407 (**+0.148**) |
   | judge groundedness | 0.704 → 1.000 (**+0.296**) |
   | TTFA p50 | 1320 → 2408 ms (**+1088**) |

   The brain effect is twice the VAD effect on success and unambiguous on
   groundedness. It also runs the *opposite* way to the confound: semantic VAD
   costs success, and `vl-native-brain` is itself on semantic VAD, so its
   advantage over `vl-gpt41mini` is if anything understated. The
   native-vs-Voice-Live comparison still crosses a VAD boundary and should be
   read as directional; the within-Voice-Live brain comparison does not.
2. **Track A could not include `vl-native-brain`** for the same reason —
   manual-commit transcription is rejected on that brain. Voice Live's STT is
   azure-speech regardless of brain, and Track B's caller transcripts are
   consistent with that, but it is not directly verified.
3. **Caller audio is TTS** (Azure neural voices), so it is more fluent and
   cleaner than real callers — no disfluency, no accent range. Track B numbers
   are therefore optimistic in absolute terms. They are comparable *between*
   arms, which is what the decision needs. Track A uses real human speech.
4. **Track A is the STT front-end, not the engine's understanding.** A caller
   transcript is not the same signal the model reasons over on a native
   speech-to-speech stack, where audio tokens reach the model directly.
   gpt-realtime-2 may understand better than its whisper-1 transcript suggests.
5. **No greeting turn.** The caller speaks first, unlike production. Removes a
   source of variance and cost; means greeting latency is not measured here (the
   separate latency benchmark covers it).
6. **n is small**: 25 utterances per Track A cell, 3 trials per Track B cell.
   Differences under ~1 pp of WER, or one scenario of success, are noise.
7. **The judge was validated, not assumed.** Two seeds with different
   presentation orders agreed on groundedness 163/165 (**98.8 %**), resolution
   99.4 %, tone 83.6 %. Groundedness — the only judge output feeding the
   pass/fail conjunction — is among the most reliable. Tone is too noisy to rank
   arms on and is not used for anything load-bearing. The parser now *raises* on
   a malformed reply rather than defaulting, and the runner exits non-zero: a
   silent judge outage would otherwise have read as "no groundedness objection",
   which the success conjunction treats as a pass. It caught a real failure on
   one scenario during this run.
9. **Two scoring/fixture defects were found in review and corrected by
   re-running, not by footnoting.** Both had been depressing Track B for every
   arm equally, so the comparison held, but the absolute numbers were wrong.
   * The time matcher looked only for the literal "14" when the expected value
     was `14:00`. A caller saying "at two" and an agent confirming "2 PM" were
     both scored as misses — `new_time` was marked wrong on **all 15**
     `reschedule-en-01` runs where every arm had in fact got it right.
   * The German caller scripts used ASCII transliteration (`fuenfzehn`), and
     Azure TTS reads that as "fuer-enf-zehn". Every engine faithfully
     transcribed the garbage, so a **fixture** defect looked like a uniform
     engine failure on `time_after`. Verified by A/B: the same sentence written
     `fünfzehn` transcribes as "nach 15 Uhr" cleanly, the ASCII version as
     "nach fuer enf 10 Uhr".

   All 11 German scenarios and the 3 phone-number scenarios were re-rendered and
   re-run across all 5 arms and 3 trials (150 calls) rather than reported with a
   caveat. Both are now pinned by tests in `bench/quality/test_scoring.py`.
10. **Phone numbers are drawn from ranges reserved for fiction** (BNetzA
   `0152 288173xx` / `030 23125xxx`, and `555-01xx`), so nothing here can ring a
   real subscriber. A test fails the build if a fixture number leaves those
   ranges.

12. **The harness had a systemic bias: absent data read as a pass.** Fourteen
   separate places, found across five review rounds, turned missing or
   unparseable data into a passing result — a missing judge row, a judge file
   that was empty rather than absent, a missing trial, a scenario an arm never
   ran, an unparseable numeric in the conjunction, a run that errored on the
   wire, and a call the agent never joined. Each individually looks like a small
   oversight; together they are a default the harness was written with, and they
   all pushed the same way. `summarize.py` now **fails closed everywhere**: it
   validates that every arm ran every scenario exactly `k` times, treats an
   empty `--judge` file as an error rather than as "no judge requested", aborts
   on any value it cannot parse rather than guessing, scores errored and
   agent-absent runs as failures, and prints "not measured" instead of an empty
   cell that a reader would take for zero. `TestAbsentDataNeverPasses` pins all
   of it; each case is a separate process invocation, because the point is that
   the run refuses, not that a helper returns False.

   Three successive sweeps each missed instances of the class they were
   sweeping for — six found and two missed, then two more missed after that. The
   rule, in its final form, is: *every check must compare what it got against
   what it expected, by identity rather than by count.* Counting rows is not
   verifying trials; writing an error row is not reporting failure. The last two
   were exactly those: `summarize.py` accepted three copies of trial 1 as
   "3 trials" (the runners append to JSONL, so re-runs duplicate rather than
   replace), and `run_scenarios.py` turned any exception into an error row and
   then exited 0, so the shell that had just been taught to propagate child
   failures faithfully reported success.

   Because the shapes evidently are not memorable, the checks are now enumerated
   in [`bench/quality/COMPLETENESS.md`](../../bench/quality/COMPLETENESS.md):
   every place the harness decides "this is complete", what it compares, and how
   it can be fooled — including the three places that still cannot be verified.
   The earlier formulation, kept because it is the useful half: Re-run against that statement, it also caught
   `success_mean` averaging only the rows present under `--allow-incomplete`
   (reporting 1.0 for two successes out of three, precisely what that flag
   promises not to do), and `run_all.sh` exiting 0 after a runner failed, so a
   half-finished matrix scored as a whole one. Every rate is now denominated on
   expected runs; every descriptive statistic carries its own n and is flagged
   when short; `score_asr.py`, which had no completeness check at all, now
   validates every (arm, language, condition) cell and emits `complete`.

   None of these were firing on the final dataset — all 165 Track B runs and all
   48 Track A cells are complete, judged and error-free, so the corrected guards
   leave every reported number unchanged. They exist so that the next run cannot
   quietly report a partial one as a good one.

11. **Six scoring bugs were found in code review and fixed; three moved
   reported numbers.** All were scoring-side, so they were corrected by
   re-deriving from the existing raw logs rather than re-running calls.
   * *Clock times were compared as text.* `normalize("14:00")` is
     "vierzehn null", which cannot match "vierzehn uhr" or "2 PM", so **every
     time-valued grounded fact was unsatisfiable** and correct answers scored as
     ungrounded. Times are now canonicalised temporally. `grounded_ok` rose from
     147/165 to 159/165 and strict success rose on every arm.
   * *Forbidden claims were matched across turn boundaries.* Joining all agent
     turns let "…Monday until 17:00" plus "On Fridays we close at 14:00"
     synthesise the forbidden claim "17:00 on Friday" out of two correct
     answers. Facts are now matched within a single utterance; the one
     `forbidden_hit` in the whole study was this false positive and is now zero.
   * *`bargein_correct` inspected the caller transcript*, so an accurately
     transcribed correction counted as adopted even when the agent ignored it.
     One of the four barge-in defects that led to dropping the metric entirely.
   * *A missing judge verdict counted as a pass.* `summarize.py` treated an
     absent groundedness row as "no objection", so a judge outage would have
     *raised* success rates. It now aborts, or scores such runs as failures under
     `--allow-missing-judge`.
   * *`end_call` was double-counted.* One invocation surfaces on several events
     sharing a `call_id`; all were appended, producing `['end_call','end_call']`.
     This never affected `tool_ok`, which compares sets — **the 23–25/33
     reliability figures are unchanged** — but the duplicate was shown to the
     blind judge. Deduplicated on `call_id` and the judge re-run.
   * *`run_all.sh` omitted `vl-gpt41mini-semvad`*, so the documented default
     produced 132 calls where this report describes 165, dropping the control
     that keeps the brain comparison VAD-neutral. Now included by default.
   * *`ttfa_p95_ms` was a percentile of per-call medians.* Each multi-turn call
     was collapsed to its median before aggregation, so a single slow reply
     inside an otherwise normal call never reached the tail statistic. Now
     computed over all 96–106 individual turns per arm. This moved the numbers
     in **both** directions: Voice Live's p95 rose 1654 → 1748 ms (the old
     figure was too flattering) while native gpt-realtime-2's fell 3812 →
     3048 ms (too harsh). The gap is real but smaller than first reported.
   * *Percentiles used `round()`, which is not nearest-rank.* Python rounds
     half to even, so `round(q*n + 0.5)` selects rank 20 of 20 and rank 96 of
     100 where nearest-rank selects 19 and 95. Now `ceil(q*n) - 1`. The Track B
     arms have 96–106 turns, where `q*n` is non-integral, so both agree and no
     published latency figure moved — but at n=100 it would have.
   * *A late `input_audio_buffer.committed` could bind a clip to the previous
     transcript.* On timeout the runner recorded the clip without an item id and
     kept the socket, so a late commit was consumed as the *next* clip's and
     every subsequent clip inherited its predecessor's hypothesis — silent WER
     corruption with no error on any affected row. The batch now aborts and
     reconnects.
   * *The time matcher accepted semantically wrong times.* The bare-hour
     pattern dropped the minutes and made the meridiem optional, so an expected
     `14:00` was satisfied by `2:30`, `2 AM` or a bare `2`. Times are now parsed
     into (hour, minute) and compared, with spoken hours scanned only after the
     digits are stripped — normalising "2:30" yields "two thirty", and a word
     scan over that re-admitted the very times the digit pass had rejected.
     This removed seven false grounding credits, all on gpt-4.1-mini arms
     (`grounded_ok` 1.000 → 0.963, 0.963 → 0.852, 1.000 → 0.889); the
     gpt-realtime-2 arms were unaffected, and no success or pass^3 figure moved.
   * *Negated claims matched the claim being denied.* "We are not open on
     Saturday" matched the forbidden `open on Saturday`, and "not 10:00 — I
     meant 14:00" matched `10:00`. Since any forbidden hit is a hard failure,
     correct denials and self-corrections scored as failures. A negation-window
     check now applies to both the phrase and the time paths. It changed
     nothing on this dataset — the study's only `forbidden_hit` had already
     been removed as a cross-turn artefact — so it is a guard for future runs.
   * *A withdrawn metric's scenarios were still being scored.* The barge-in
     metric was dropped, but its two scenarios kept feeding `success`, `pass^k`
     and the slot aggregates — and when the preceding response produces no audio
     the runner never speaks the interrupting turn, so a row can exist for a call
     in which the scripted correction was never delivered, with an earlier agent
     message satisfying the completeness check. They are now marked
     `"scored": false` in the fixture and excluded from every aggregate: 9
     scored scenarios, 135 of the 165 runs. This moved every Track B figure and
     swapped `vl-gpt41mini-dns` and `vl-native-brain` in the success ordering —
     a within-family pair that was never a decision point. **The recommendation
     is unchanged**: both gpt-realtime-2 arms still lead both gpt-4.1-mini arms
     on strict success (0.593 / 0.407 against 0.370 / 0.333 / 0.259).
   * *An exhausted ASR batch became a data point.* After both attempts failed,
     the runner wrote a full cell of error rows and exited zero, so the shell
     reported completion and the scorer saw a complete set of clip ids — a
     transport or configuration outage published as 100 % WER. The worst version
     of the class: the others let a gap pass as success, this one converted
     infrastructure failure into a measurement. The runner now exits non-zero and
     `score_asr.py` refuses any cell whose rows are all errors.
   * *`final_language` was scored from the caller's transcript*, so strict
     success tested what the *caller* said rather than whether the agent
     switched languages; the companion echoed score joined all agent turns, where
     earlier German drowns out a correct English reply. Both wrong, in opposite
     directions. Scored from the agent's final turn, every arm followed the
     switch 15/15, and native gpt-realtime-2's strict success rose.
   * *Cancellation was never detected.* An interrupted generation is
     `response.done` with `response.status == "cancelled"`; the runner watched
     for a top-level `response.cancelled` that neither service emits, so
     `agent_cancelled` was false for all 7 real cancellations. Re-derived from
     the committed logs.
   * *A closing turn burned 25 s of billed silence.* A response consisting only
     of an `end_call` tool call sets `done` without ever producing audio, and the
     wait loop required audio, so it sat out the full timeout while the mic kept
     streaming — on every call that ended properly.
   * *A JSON `true` passed as a judge score.* `bool` is a subclass of `int` in
     Python, so `true` satisfied a `value in (0, 1)` membership test, landed
     `True` in the CSV, and was then coerced to `0.0` — turning a *positive*
     groundedness verdict into a failure with no error raised anywhere.

   All six are pinned by tests in `bench/quality/test_scoring.py` (39 tests,
   run in CI as a separate `bench-scoring` job).

8. **A harness bug was found and fixed mid-run.** The first Track A pass scored
   `vl-gpt41mini-dns` with a collector that took the first transcript-shaped
   event per item; with the service double-emitting, this dropped 64 of 200
   English transcripts. The collector now keeps the longest text per `item_id`.
   As a control, `vl-gpt41mini` was re-run on two conditions after the fix:
   **100/100 transcripts byte-identical**, confirming the fix is
   behaviour-preserving and that the remaining 68 empties on the DNS arm are the
   service's.

## Cost

| arm | Track A min | Track B min | $/min | $ |
|---|---|---|---|---|
| native-gpt-realtime-2 | 70.0 | 20.4 | 0.07 | 6.33 |
| vl-gpt41mini | 70.0 | 18.9 | 0.03 | 2.67 |
| vl-gpt41mini-dns | 70.0 | 19.1 | 0.03 | 2.67 |
| vl-gpt41mini-semvad | — | 19.3 | 0.03 | 0.58 |
| vl-native-brain | — | 16.5 | 0.07 | 1.15 |
| discarded DNS pass + control | 87.5 | — | 0.03 | 2.63 |
| pilots and probes | ~15 | — | ~0.05 | 0.75 |
| DNS teardown (`probe_dns.py`, 8 legs x 50) | 62.0 | — | 0.03 | 1.86 |
| re-runs after the review fixes (150 calls) | — | 63.0 | ~0.045 | 2.83 |
| judge (gpt-5.5, 6 full passes + 1 partial) | | | | 1.35 |
| **total** | | | | **23.19** |

Catalog sell rates; billed direct to the Azure sponsorship subscription, so the
true cost is lower. The gateway's `DAILY_CAP_USD` breaker was never approached.

## Reproducing

See [`bench/quality/README.md`](../../bench/quality/README.md). Raw event logs
are committed (audio payloads redacted), so every number here can be re-scored
without spending anything.
