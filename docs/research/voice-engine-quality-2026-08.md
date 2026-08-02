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
| Time to first audio, p50 | **1393 ms** | 2079–2408 ms |
| Time to first audio, p95 | **1654 ms** | 3468–3812 ms |
| Caller-slot capture, heard | **0.967** | 0.856–0.933 |
| Caller-slot capture, echoed back | 0.719 | **0.812–0.819** |
| Judge groundedness | 0.697 | **1.000** |
| Strict task success | 0.394 | **0.424–0.606** |
| pass^3 | 0.182 | **0.273–0.545** |
| Cost | **$0.03/min** | $0.07/min |

Voice Live answers **~690 ms sooner at p50 and over two seconds sooner at p95**,
at 43 % of the cost, and it *hears* the caller better — 0.967 vs 0.856 slot
capture, and it never lost a phone number. On a phone call the latency gap is
the difference between a receptionist and a bad connection.

What you give up is sharper than the latency gap. gpt-realtime-2 got a **perfect
groundedness score — 0 unsupported claims in 66 runs** — against 24 for the Voice
Live arms, and it completes the whole call correctly **three times out of three
in 54.5 % of scenarios against 18.2 %**. The two engines fail differently: one
mishears a name, the other says something that is not true.

**What gpt-4.1-mini actually gets wrong matters for a booking business.** Six of
its 24 groundedness failures are the agent telling a caller a specific slot *is
available* — "Thursday, August 6th, after 3 PM is available" — when the prompt
says in as many words *"Do not promise a confirmed slot."* gpt-realtime-2 never
did this. A practice would have to either honour those slots or ring the caller
back to apologise.

The remaining ~9 are the judge applying "no unsupported business fact" to
conversational framing such as *"Dr. Weber is not available right now"* while
taking a message. That is defensible behaviour and arguably a judge false
positive, so **the raw 0.697 overstates the problem** — but the over-promising
subset does not, and it is concentrated exactly where money changes hands.

**The most decision-relevant number:** `vl-native-brain` (Voice Live serving
gpt-realtime-2) scores like gpt-realtime-2 on groundedness (1.000) and like
gpt-realtime-2 on latency (2408 ms p50 — the *worst* p50 of any arm). So **the
quality difference is the brain, and the speed difference is also the brain, not
the serving stack.** Switching serving stack buys nothing on its own. There is
no configuration that gets you gpt-realtime-2's judgement at gpt-4.1-mini's
latency.

### Two things to change now

1. **Never enable `input_audio_noise_reduction`.** Azure's
   `azure_deep_noise_suppression` makes recognition **worse under exactly the
   noise it exists to remove** — German WER rises 6.05 → 7.47 at 10 dB cafe
   noise and 9.84 → 16.84 at 5 dB, with zero dropped utterances, so this is
   recognition damage and not a plumbing artefact. On English it additionally
   drops ~24 % of utterances entirely, even on clean audio. Reproduced at n=50;
   see §"Noise suppression" for the full teardown. OpenFon does not set this
   knob today, so the shipped config is already correct — this is a "do not
   'improve' this later" finding and is worth a comment in `call-session.ts`.
2. **`end_call` is unreliable on every arm** — 23–25 of 33 runs, with no
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

## Track B — task success, responsiveness, barge-in

11 Riverside Dental scenarios (7 DE, 4 EN) × 5 arms × 3 trials = **165 live
calls**, 0 errors. Run against the real system prompt: `gen_prompt.ts` calls
`buildSystemPrompt` from `src/prompt.ts`, so the 21-day calendar block every date
question depends on is the genuine one, pinned to Monday 2026-08-03.

| arm | success | pass^3 | slots heard | slots echoed | end_call | grounded (judge) | resolution | tone | TTFA p50 | TTFA p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| `native-gpt-realtime-2` | **0.606** | **0.545** | 0.856 | **0.819** | 24/33 | **1.000** | 1.697 | 1.576 | 2079 | 3812 |
| `vl-gpt41mini-dns` | 0.455 | 0.273 | **0.967** | 0.651 | 23/33 | 0.818 | 1.727 | 1.697 | 1450 | 1803 |
| `vl-native-brain` | 0.424 | 0.273 | 0.933 | 0.812 | 23/33 | **1.000** | 1.727 | 1.576 | 2408 | 3468 |
| `vl-gpt41mini` | 0.394 | 0.182 | **0.967** | 0.719 | 24/33 | 0.697 | 1.727 | **1.788** | 1393 | 1654 |
| `vl-gpt41mini-semvad` | 0.364 | 0.182 | 0.933 | 0.767 | **25/33** | 0.758 | **1.788** | 1.697 | **1364** | **1527** |

`success` is a strict conjunction: every expected slot heard correctly, `end_call`
invoked where expected, every grounded fact stated, no forbidden claim, and the
judge's groundedness verdict positive. `pass^3` requires that on **all three**
trials.

**The two capabilities separate cleanly.** Voice Live *hears* better — 0.967 vs
0.856 slot capture, and it never lost a phone number. gpt-realtime-2 *reasons*
better — a perfect 1.000 groundedness against 0.697, and it completes the whole
call correctly on all three trials in 54.5 % of scenarios against 18.2 %.

**`end_call` is the biggest single drag on strict success and is equally bad
everywhere** (23–25 of 33; `tool_ok` 0.697–0.758). Because no arm is meaningfully
better, it does not separate the engines — but it is a real product bug, and on
`reschedule-en-01` it fired **1 time in 15**: the agent captured every detail
correctly and then would not close the call.

Where the remaining failures come from, now that the fixture and scoring defects
are out of the way (Confounds 9 and 11):

| scenario | success | what fails |
|---|---|---|
| `book-de-01` | 0/15 | the ASR hears **"Katrin"** for "Kathrin" on 15/15 — one letter, but the wrong name in the booking |
| `reschedule-en-01` | 1/15 | every slot captured; `end_call` fires 1/15 |
| `codeswitch-01` | 1/15 | language switch followed 14/15; `end_call` 0/15 |
| `message-de-01` | 2/15 | `end_call`, plus the judge objecting to "Dr. Weber is not available right now" |
| `holiday-de-01` | 15/15 | the special-closure calendar lookup works on every arm and trial |
| `bargein-en-01` | 13/15 | correction adopted 24/30 across arms |

**Heard vs echoed.** `slots heard` is whether the engine's own caller transcript
contains the value — did it *hear* the phone number. `slots echoed` is whether
the agent repeated it back. The confirmation gap is brain/prompt behaviour, not
recognition, and is fixable in the prompt; a recognition gap is not.

**Code-switching:** every Voice Live arm followed the German→English switch on
3/3 trials. Native gpt-realtime-2 failed it once (2/3).

### Barge-in: the finding is that you cannot test it server-side

Of 30 barge-in attempts across all arms, the agent's response was **still in
flight in exactly one**. These engines push a whole response's audio down the
wire far faster than real time — a ~4 s reply is fully delivered with
`response.done` about 600 ms after it starts. By the time a real caller is 500 ms
into *hearing* the reply, the server has finished sending it.

So the reported `bargein_stop_p50_ms` (8–373 ms) is not an engine property and
should not be used to rank engines. **Barge-in is entirely the client's
responsibility**: OpenFon's `CallSession` must discard its own playback buffer.
The existing `greetingGuardUntil` logic is the right shape; nothing in either
engine will do this for you.

What the engines *did* get right: all five adopted the corrected value after
being interrupted, 3/3 trials each. Interruption handling as *content* is solid
everywhere; interruption as *audio* is not the engine's job.

---

## Confounds and limits

Stated rather than smoothed over.

1. **VAD is not held constant between stacks.** Voice Live **rejects**
   `server_vad` on the gpt-realtime-2 brain ("turn_detection must be of type
   AzureSemanticVAD"), so `vl-native-brain` runs Azure semantic VAD while
   `native-gpt-realtime-2` runs server VAD. I added `vl-gpt41mini-semvad` as a
   control: on the same brain, semantic vs server VAD moves TTFA p50 by −69 ms
   and success not at all, so the VAD is **not** driving the brain comparison.
   But the native-vs-voice-live comparison still crosses a VAD boundary.
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
     It now reads the agent's post-interruption reply: 24/30, not 30/30.
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
