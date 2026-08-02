# Eval datasets for Azure Voice Live vs gpt-realtime-2 (OpenFon)

Scouted 2026-08-01. Recipes live in `bench/quality/prepare/`. Everything marked **downloaded** below is on disk under
`$DATA/` (outside the repo — the audio is gitignored) and was verified by
measurement, not just linked.

---

## 1. Candidate comparison

| Dataset | Size (full) | Languages | License | Download | Measures | Gated |
|---|---|---|---|---|---|---|
| **FLEURS** (`google/fleurs`) | ~570 MB/lang test tar; parquet 0.2–0.8 GB/lang | **102, incl. all 10 OpenFon langs** | CC-BY-4.0 (commercial OK w/ attribution) | HF `datasets` streaming, **no auth** | ASR WER, multilingual parity | **No** |
| **DEMAND** noise | 78–130 MB/scene @16 kHz, 18 scenes | n/a (noise) | CC-BY-4.0 | Zenodo record 1227121, direct HTTP | Noise robustness (mixing source) | **No** |
| LibriSpeech (`openslr/librispeech_asr`) | 346 MB test-clean | EN only | CC-BY-4.0 | HF streaming | ASR WER, English-only | No |
| Multilingual LibriSpeech | 100+ GB | 8 (no SV/DA/FI) | CC-BY-4.0 | HF streaming | ASR WER | No |
| Common Voice 17 | 1–80 GB/lang | 100+ | CC0 | `mozilla-foundation` repo now a 307 stub; `fsicoli/common_voice_17_0` mirror is ungated | Accented/spontaneous ASR | Mirror: no |
| VoxPopuli | 10–100 GB | 16 EU | CC0 / other | HF | Parliamentary speech, non-native | No |
| MUSAN | **11.1 GB single tar** | n/a | CC-BY-4.0 | openslr.org/17 | Noise + babble + music | No |
| RIRS_NOISES | 1.3 GB | n/a | Apache-2.0 | openslr.org/28 | Real + simulated reverb | No |
| VoiceBank+DEMAND | ~2.5 GB | **EN only** | CC-BY-4.0 | Edinburgh DataShare (landing page, not a direct file URL) | Pre-mixed noisy/clean at fixed SNR | No |
| CHiME-6/7 | 100+ GB | EN | requires registration form | — | Far-field, overlap | **Yes** |
| AMI / Fisher | large | EN | AMI open; **Fisher = LDC signed agreement** | — | Conversational overlap | Fisher: **yes** |
| Full-Duplex-Bench v1.5/v3 | unknown | EN | repo LICENSE | **Google Drive** (interstitial; needs `gdown`) | Turn-taking, backchannel, barge-in | Soft |
| τ-voice / τ³-bench (Sierra) | n/a | EN | vendor benchmark | not a downloadable audio corpus | Task success on CS domains | n/a |
| EVA-Bench | n/a | EN | paper/framework | framework, not data | End-to-end voice-agent eval | n/a |
| SLURP / Spoken-SQuAD | 2–10 GB | EN | CC-BY | HF/GitHub | Spoken intent + QA | No |

**Nothing in the recommended suite is gated.** `hf`/`huggingface-cli` are **not
installed** on this machine and no `HF_TOKEN` is set — everything below runs
fully unauthenticated (HF rate-limits unauthenticated parallel pulls; see
Blocked).

---

## 2. Recommended suite

Two tracks, because no single corpus can measure both ASR robustness and task
success, and pretending otherwise is how you get a benchmark that answers
neither question.

### Track A — Understanding + noise robustness (real human speech)

**FLEURS test**, 60 utterances each for **en_US** and **de_DE** (the two
production languages), plus 20 each for fr/es/nl/it/ru/sv/da/fi as a
multilingual smoke set. Real speakers, human transcripts, and — decisive —
**all 10 OpenFon languages in one corpus with one license**.

Nine conditions per language, generated on the fly from clean audio:

| Condition | What it isolates |
|---|---|
| `clean` | ceiling / control |
| `cafe_snr20`, `cafe_snr10`, `cafe_snr5`, `cafe_snr0` | SNR sweep, one noise type |
| `rev400` | RT60 400 ms room (speakerphone) |
| `tel` | **G.711 μ-law 8 kHz + 300–3400 Hz band** — the Twilio PSTN leg |
| `tel_cafe_snr10` | the realistic production worst case |
| `tel_loss3` | 3 % bursty 20 ms RTP frame loss |

Add `babble_snr10 / street_snr10 / car_snr10 / office_snr10` for a noise-type
sweep at fixed SNR once the SNR curve is in.

### Track B — Task success + responsiveness + barge-in (synthesised callers)

**10 scripted Riverside Dental scenarios** (6 DE, 4 EN) covering booking,
grounded hours/insurance Q&A, message-taking, reschedule-with-correction,
emergency handoff, code-switching, and two explicit barge-in scenarios.
Rendered to WAV with known per-turn durations.

### Why synthesis beats an off-the-shelf noisy corpus

1. **Ground truth is exact.** Mixing at a chosen SNR means the reference
   transcript is the clean one — no re-annotation, no alignment guessing.
2. **Controlled SNR sweep.** VoiceBank+DEMAND ships fixed 0/5/10/15 dB and is
   **English-only**. We need a curve, and we need German.
3. **The telephony chain is the point.** OpenFon's production path is a Twilio
   G.711 μ-law 8 kHz leg. No public corpus is recorded through that chain; we
   have to apply it ourselves regardless.
4. **Utterance boundaries are known to the millisecond**, which is the only way
   to measure time-to-first-audio and barge-in latency without forced alignment.
5. **Scenario-relevant content.** FLEURS sentences are read Wikipedia prose;
   they cannot tell you whether the agent captured a spelled surname or a phone
   number. Track B can.

**The tradeoff, stated plainly:** TTS callers are acoustically too clean and too
fluent — no disfluency, no accent range. So Track B numbers are *not* evidence
about ASR robustness; that is exactly what Track A (real human speech) is for.
Do not report a Track B task-success number as a noise-robustness result.

---

## 3. Download recipes (all executed and verified)

Data lives under `$DATA/`. **Total on disk: 1.3 GB after deleting the
DEMAND zips post-extract — well under the 5 GB cap.** Setup:

```bash
DATA=/path/to/scratch/data   # NOT in the repo - the audio is gitignored
python3 -m venv .venv
.venv/bin/pip install datasets soundfile numpy scipy jiwer huggingface_hub pyroomacoustics num2words
export HF_HOME=$DATA/../hf-cache
```

### 3.1 FLEURS slices — `prepare_fleurs.py`

Streaming mode pulls only the parquet row groups it needs: a 60-utterance slice
costs ~60–90 MB instead of the 400–800 MB full test shard.

```bash
for L in en_us de_de; do
  .venv/bin/python bench/quality/prepare/prepare_fleurs.py --lang $L --n 60 --out $DATA/fleurs/$L
done
for L in fr_fr es_419 nl_nl it_it ru_ru sv_se da_dk fi_fi; do
  .venv/bin/python bench/quality/prepare/prepare_fleurs.py --lang $L --n 20 --out $DATA/fleurs/$L
  sleep 3   # unauthenticated HF rate limit
done
```

Emits `<id>.wav` (16 kHz mono PCM16) + `<id>.txt` + `manifest.jsonl` — the same
on-disk contract as `kataleptic-backend/benchmarks/prepare_librispeech.py`, so
`listen_bench.py` consumes it unchanged.

**Verified on disk — 8 of 10 languages:**

| lang | utts | minutes | | lang | utts | minutes |
|---|---|---|---|---|---|---|
| en_us | 60 | 9.5 | | it_it | 20 | 4.4 |
| de_de | 60 | 11.7 | | sv_se | 20 | 3.5 |
| fr_fr | 20 | 3.4 | | da_dk | 20 | 3.6 |
| nl_nl | 20 | 3.0 | | fi_fi | 20 | 4.8 |

`ru_ru` and `es_419` completed subsequently, each 20 utts. **All 10 OpenFon
languages are on disk.** The two production languages (en_us, de_de) carry 60
utterances each and are the only ones conditioned across the full matrix.

### 3.2 DEMAND noise — Zenodo

```bash
mkdir -p $DATA/noise-demand && cd $DATA/noise-demand
for s in PCAFETER SPSQUARE STRAFFIC TCAR OMEETING; do
  curl -sL -C - --retry 5 --retry-delay 3 -o ${s}_16k.zip \
    "https://zenodo.org/records/1227121/files/${s}_16k.zip?download=1"
  unzip -tq ${s}_16k.zip || echo "TRUNCATED $s — rerun, curl resumes"
  unzip -o -q ${s}_16k.zip -d .
done
```

**Verified:** 5 scenes, 16 channels × 300 s @ 16 kHz each, 560 MB.
Zenodo silently truncates under sustained pulls — the `-C -` + `unzip -tq`
retry loop is required, not optional. Two of five scenes truncated on the first
pass and needed it.

*(MUSAN was rejected: 11.1 GB single tar with no per-category download, for
noise we already get from DEMAND at 1/20th the size.)*

### 3.3 Conditions — `make_conditions.py`

```bash
.venv/bin/python bench/quality/prepare/make_conditions.py \
  --clean $DATA/fleurs/de_de --noise $DATA/noise-demand \
  --out $DATA/conditions \
  --conditions clean,cafe_snr20,cafe_snr10,cafe_snr5,cafe_snr0,rev400,tel,tel_cafe_snr10,tel_loss3
```

Every condition is a deterministic function of `(utterance_id, condition)` via a
SHA-256-seeded RNG, so reruns are byte-identical and both engines always see the
same signal. ~54 s for 9 conditions × 60 files.

**Verified by measurement, not assumption:**

| Condition | Measured SNR | Energy >3.8 kHz | Silence frac |
|---|---|---|---|
| clean | — | 0.171 | 0.169 |
| cafe_snr20 | **20.1 dB** | 0.172 | 0.082 |
| cafe_snr10 | **10.3 dB** | 0.173 | 0.045 |
| cafe_snr5 | **5.2 dB** | 0.166 | 0.033 |
| cafe_snr0 | **0.2 dB** | 0.175 | 0.021 |
| tel | — | **0.019** | 0.334 |
| tel_loss3 | — | 0.020 | **0.368** |

SNR targets land within 0.3 dB (mixing uses a P.56-style active-speech RMS, so
leading silence doesn't deflate the level). `tel` drops >3.8 kHz energy 9× —
the band-limit is real. `tel_loss3` adds 3.4 % silence over `tel` — the loss
model fires at the requested rate.

The noise-type sweep was generated and verified the same way — `babble_snr10`,
`street_snr10`, `car_snr10`, `office_snr10` each measured **10.0 dB** on de_de.

Total generated: **13 conditions × 60 utts × 2 languages = 1560 clips, 518 MB.**

### 3.4 Scenario audio — `render_scenarios.py`

```bash
.venv/bin/python bench/quality/prepare/render_scenarios.py \
  --scenarios $SP/scenarios_riverside.json --out $DATA/scenarios --tts say
```

**Verified:** 10 scenarios, 35 turns, 111 s, with per-turn durations in
`turns.json`. `--tts say` uses macOS voices — offline, deterministic, no
credentials, and **all 10 OpenFon languages are covered** (en_US Samantha,
de_DE Anna, fr_FR Thomas, es_ES Mónica, nl_NL Xander, it_IT Alice, sv_SE Alva,
da_DK Sara, fi_FI Satu, ru_RU Milena).

**For the real run use `--tts azure`** (Azure Speech neural voices, needs
`AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION`) — the `say` voices are recognisably
robotic and will flatter any ASR. The `say` path exists to prove the harness
works without waiting on credentials. Track B scenario audio should also be
pushed through `tel` before playback, since production callers arrive over G.711.

---

## 4. Metric definitions

### 4.1 WER / CER — `score_wer.py`

Identical normalisation applied to hypothesis and reference: NFKC → casefold →
**digits spelled out in the utterance language** (`num2words`, all 10 covered)
→ punctuation stripped → whitespace collapsed. Then per language:

- **de** — `ß`→`ss`; `ä/ö/ü` → `ae/oe/ue` so a transliterating engine isn't
  penalised (verified: `Schröder` and `Schroeder` both → `schroeder`).
- **sv/da/fi/nl/it/fr/es** — diacritics **kept**. They are phonemic; folding
  them would hide real errors.
- **ru** — `ё`→`е` (verified: `приём`/`прием` unify).

Reference is the FLEURS `transcription` field (already lowercased,
punctuation-free). `raw_transcription` is retained in the manifest for the LLM
judge, which should see natural text.

Report **WER and CER**. CER matters for DE/FI/SV — a single wrong morpheme in a
compound costs a whole word in WER and overstates the gap.

**Known limitation, measured:** German ordinals expand as cardinals — `15.` →
`fünfzehn`, not `fünfzehnten` — so date-heavy utterances carry a residual ~1
substitution. Do **not** measure date/phone capture with WER; use slot accuracy
(§4.3).

### 4.2 Noise robustness

Per (engine, language, condition): WER, plus

- **ΔWER = WER(condition) − WER(clean)** — the degradation attributable to the condition.
- **WER-vs-SNR curve** over {20, 10, 5, 0} dB.
- **SNR₅₀** — interpolated SNR at which WER reaches 2× the clean WER. One
  number, in dB, directly comparable between engines. Higher SNR₅₀ = more fragile.
- **Telephony penalty** = ΔWER(`tel`) — isolates the codec from the noise.
- **Production worst case** = WER(`tel_cafe_snr10`) — the headline robustness number.

### 4.3 Task success

Split deliberately, because an LLM judge is the wrong instrument for half of it:

**Programmatic (no judge)** — the parts with an objectively right answer:
- **Slot accuracy**: exact match after normalisation, per slot. Phone numbers
  compared as digit strings; names case-folded with the DE umlaut rule; times as
  24 h `HH:MM`. Report per-slot and per-scenario-all-slots-correct.
- **Tool-call correctness**: was the expected tool called, with correct args, and
  were `forbidden` tools *not* called (e.g. `emergency-de-01` must escalate, not book).
- **Language adherence**: detected reply language matches expectation
  (`codeswitch-01` requires following the caller's switch).

**LLM judge (Claude, rubric, temperature 0)** — only the soft dimensions:
- **Groundedness**: every business fact asserted is supported by `business.kb`;
  each `grounded_facts` string present, each `forbidden` string absent. Score
  0/1 with a required one-sentence citation of the supporting KB entry.
- **Appropriate handoff** and **tone**: 0–2 each.

Judge sees the transcript, the tool-call trace, and the KB — never the audio,
and never which engine produced it (blind, and randomise A/B order per item).

**Report pass^k over 3 trials**, not a single run. Realtime speech-to-speech
agents are noticeably nondeterministic; a single pass rewards luck. This follows
current practice in τ³-bench and EVA-Bench.

### 4.4 Responsiveness

All from the client-side wire clock, which is what the caller experiences:

- **TTFA** — last caller audio byte sent → first agent audio byte received.
  The headline number. Report p50 / p95, never the mean alone (the prior
  kataleptic run has a case where mean > p95 from one straggler).
- **EOU-detection latency** — true end of caller speech (known exactly, since we
  generated the audio) → first agent audio byte. Separates the VAD/turn-detection
  decision from generation latency; a fair chunk of perceived slowness is the
  endpointer waiting, not the model thinking.
- **Barge-in stop latency** — caller barge-in onset → last agent audio byte.
  This is the one users complain about. Scenarios `bargein-en-01`
  (700 ms in) and `bargein-de-01` (500 ms in).
- **Barge-in correctness** — did the agent adopt the corrected slot?
  `bargein-en-01` expects day 16, and 9 counts as a failure even if the stop was fast.
- **False barge-in rate** — how often the agent stops for background babble
  rather than the caller. Measure by replaying `cafe_snr5` / `babble_snr10`
  conditions during agent speech. A tempting failure mode for aggressive VADs,
  and cafe noise is exactly what a small-business caller has behind them.

Stream at **1× real time** (the prior harness already does; do not blast audio,
or TTFA is meaningless).

---

## 5. Blocked / rejected

| Item | Status |
|---|---|
| `huggingface-cli` / `hf` | **Not installed**; no `HF_TOKEN`. Not needed — everything used is ungated and unauthenticated HTTP to HF is fast (range GET on the nl_NL shard: HTTP 206 in 1.4 s). One parallel en+de run did silently produce zero German files and succeeded on serial retry, so the recipes serialise with `sleep 3`, but this is not a hard rate limit. |
| `timeout(1)` | **Not on macOS** — it is `gtimeout` (coreutils). A retry loop wrapping the prep script in `timeout` failed instantly for every language and looked exactly like a network stall. Worth knowing before debugging the wrong layer. |
| FLEURS streaming throughput | 3–10 min per language. FLEURS ships **one parquet shard per split**, so streaming reads row groups sequentially and a 20-utterance slice still walks a large prefix of a 0.4–0.8 GB file. Budget wall-clock accordingly, or pre-download the shard once if you want many languages. |
| Zenodo truncation | Silently returns partial zips under sustained pulls. Mitigated with `-C -` resume + `unzip -tq` verify loop; 2 of 5 scenes needed it. |
| Full-Duplex-Bench v1.5/v3 | Google Drive returns the virus-scan interstitial to `curl`. Needs `gdown`. **Not downloaded** — English-only, and Track B's scripted barge-in covers our case with German included. Worth revisiting if we want comparability with published turn-taking numbers. |
| VoiceBank+DEMAND | DataShare URL returns an HTML landing page, not the file. Rejected anyway: English-only, fixed SNR grid. |
| MUSAN | 11.1 GB monolithic tar, no per-category download. Rejected for DEMAND. |
| CHiME-6/7, Fisher | Registration form / LDC signed agreement. Out of scope per constraints. |
| `mozilla-foundation/common_voice_17_0` | Now a 307 stub with an empty card. Ungated mirror `fsicoli/common_voice_17_0` exists if we later want accented/spontaneous speech; not needed since FLEURS covers all 10 languages. |
| RIRS_NOISES | 1.3 GB. Skipped in favour of `pyroomacoustics` shoebox simulation, which gives a *controllable* RT60 sweep at zero download. Add it only if a reviewer wants measured rather than simulated rooms. |

## 6. Files

```
bench/quality/prepare/
  prepare_fleurs.py     FLEURS -> wav/txt/manifest (kataleptic listen_bench contract)
  make_conditions.py    noise / reverb / G.711 / packet-loss generator
  render_scenarios.py   scenario scripts -> WAV turns (say | azure)
  score_wer.py          per-language normalised WER/CER (used by score_asr.py)
bench/quality/fixtures/
  scenarios.json        11 Riverside Dental scenarios, DE + EN

$DATA/                  gitignored; regenerate with the recipes above
  fleurs/<lang>/                  clean slices
  conditions/<cond>/<lang>/       13 conditions x en_us, de_de
  noise-demand/<SCENE>/           5 DEMAND scenes
  scenarios/<id>/                 caller turns + turns.json
```
