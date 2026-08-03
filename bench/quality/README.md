# Voice engine quality benchmark

Compares realtime voice engines on the two things a small-business phone agent
is actually judged on: **did it understand the caller**, and **did it handle the
call**. Results and analysis live in
[`docs/research/voice-engine-quality-2026-08.md`](../../docs/research/voice-engine-quality-2026-08.md).

For the datasets and how to fetch them, see
[`docs/research/voice-eval-datasets.md`](../../docs/research/voice-eval-datasets.md).

## No real call data is committed

**Every scenario, name, phone number and audio file here is synthetic.** The
caller scripts are written by hand in `fixtures/scenarios.json` and spoken by a
text-to-speech voice via `render_scenarios.py` — no human was recorded, and no
customer or production call has ever been part of this benchmark. The committed
event logs are transcripts of that synthesised audio.

Phone numbers are drawn only from ranges reserved for fiction, so they cannot
ring a real subscriber: the German numbers use the Bundesnetzagentur's dramatic
ranges (`0152 288173xx` mobile, `030 23125xxx` Berlin landline) and the English
ones use the `555-01xx` convention. `test_scoring.py::TestFixtureHygiene` fails
the build if a fixture number ever falls outside those ranges. Personal names
are invented; a name on its own identifies nobody.

The Track A speech is [FLEURS](https://huggingface.co/datasets/google/fleurs)
(CC-BY-4.0, read Wikipedia-style sentences by paid speakers) mixed with
[DEMAND](https://zenodo.org/records/1227121) noise (CC-BY-4.0).

## Arms

| arm | serving stack | brain | STT | audio front-end |
|---|---|---|---|---|
| `vl-gpt41mini` | Azure Voice Live | gpt-4.1-mini | azure-speech | none — **as OpenFon ships it** |
| `vl-gpt41mini-dns` | Azure Voice Live | gpt-4.1-mini | azure-speech | `azure_deep_noise_suppression` + echo cancellation |
| `vl-native-brain` | Azure Voice Live | gpt-realtime-2 | azure-speech | none |
| `native-gpt-realtime-2` | Foundry `/openai/v1/` | gpt-realtime-2 | whisper-1 | none (not offered) |

All four go **direct to Azure**, not through the Kataleptic gateway. The gateway
adds ~5–8 ms round-trip (measured in the earlier recon), which is immaterial
here, but going direct avoids the gateway's global `DAILY_CAP_USD` breaker,
avoids its injected second `session.updated`, and avoids it swapping the
transcription model out from under us. The path is constant across arms.

Voice Live defaults both audio front-end knobs to null and OpenFon never sets
them, so **the shipped HD tier runs with no noise suppression**. `vl-gpt41mini`
reproduces that; `vl-gpt41mini-dns` is the same arm with it switched on. The gap
between them is the headline noise-robustness result.

## Two tracks

**Track A — understanding and noise robustness.** Conditioned FLEURS clips are
streamed in and scored against the reference transcript. This measures **the STT
front-end each stack ships** (whisper-1 vs azure-speech) as experienced through
a live session — not a free-standing ASR comparison, and it should not be
reported as one.

Transcription-only: turn detection is disabled and each clip is committed by
hand, so there is exactly one transcript per clip, no VAD segmentation to
confound WER, and no output audio to pay for.

**Track B — task success, responsiveness, barge-in.** Eleven Riverside Dental
scenarios (7 DE, 4 EN) run as live multi-turn calls against the **real** system
prompt — `gen_prompt.ts` calls `buildSystemPrompt` from `src/prompt.ts`, so the
21-day calendar block that every date question depends on is the genuine one.

## Running it

```bash
python3 -m venv .venv && .venv/bin/pip install websockets jiwer num2words soundfile numpy scipy

# 1. Freeze the system prompt from the real product code.
npx vite-node bench/quality/gen_prompt.ts

# 2. Fetch and condition the audio (see docs/research/voice-eval-datasets.md).
DATA=/path/to/data

# 3. Validate every arm's session payload before spending anything.
.venv/bin/python bench/quality/probe_session.py --wav $DATA/conditions/clean/en_us/en_us-000.wav

# 4. Run — ALWAYS to a new directory. run_all.sh truncates $OUT/results/*.jsonl,
#    and OUT defaults to bench/quality, so omitting it would destroy the
#    committed data both reports quote. The script now refuses rather than
#    letting that happen; set OUT and it proceeds.
cd bench/quality
OUT=/tmp/mybench DATA=$DATA PY=../../.venv/bin/python ./run_all.sh

#    Its defaults reproduce the MERGED report only: three ASR arms, five
#    scenario arms, all eight conditions. The addendum's three arms are an
#    extension, with a deliberately smaller condition set:
OUT=/tmp/mybench DATA=$DATA PY=../../.venv/bin/python TRACK=a \
  ASR_ARMS="native-gpt-realtime-21 native-gpt-realtime-21-mini" \
  CONDITIONS="clean,cafe_snr10,cafe_snr5,cafe_snr0,tel,tel_cafe_snr10" ./run_all.sh
OUT=/tmp/mybench DATA=$DATA PY=../../.venv/bin/python TRACK=b \
  SC_ARMS="native-gpt-realtime-21 native-gpt-realtime-21-mini vl-native-brain-21" ./run_all.sh

#    Those two blocks append, so the full committed matrix is the merged-report
#    run followed by both. Together they give 1800 ASR rows and 246 scenario
#    runs — the numbers in results/ today.

# 5. Score.
# The matrix is asymmetric by design: the two 2.1 ASR arms skip cafe_snr20 and
# tel_loss3, so eight (arm, condition) cells are absent. --allow-incomplete
# accepts that; without it the run aborts and writes nothing. Absent cells are
# emitted with n=0 and complete=0 rather than omitted, so the gaps are visible
# in the CSV instead of showing up as a complete matrix with fewer rows.
python score_asr.py   --hyp results/asr.jsonl --expect-clips 25 --allow-incomplete \
                      --out results/asr_scores.csv
python score_slots.py --runs results/scenarios.jsonl --out results/slots.csv
KATALEPTIC_KEY=... python judge.py --runs results/scenarios.jsonl --out results/judge.csv --seed 1
KATALEPTIC_KEY=... python judge.py --runs results/scenarios.jsonl --out results/judge_seed2.csv --seed 2
python summarize.py --slots results/slots.csv --judge results/judge.csv \
  --scenarios fixtures/scenarios.json --trials 3 --out results/summary.csv

# What every completeness check compares, and how it can be fooled:
#   bench/quality/COMPLETENESS.md
```

Azure keys come from `az cognitiveservices account keys list` (or `AZURE_AI_KEY`).
The judge needs a Kataleptic key in `KATALEPTIC_KEY`.

## Scoring

Split by whether the question has an objectively right answer.

**Programmatic** (`score_slots.py`) — slot capture (phone numbers compared as
digit strings, names through the per-language normaliser so `Schröder` matches
`Schroeder`), tool calls, forbidden claims, language adherence.

**LLM judge** (`judge.py`, gpt-5.5, temperature 0) — only groundedness against
the KB, resolution, and tone. It never sees arm identity; candidates for a
scenario are judged together in a per-scenario shuffled order, seeded so reruns
reproduce. Run it twice with different `--seed` values and compare: that
disagreement rate is the reliability number, and it belongs in the report.

`summarize.py` reports **pass^k** — scenarios an arm got right on *every* trial —
next to the mean. A single-run pass rate rewards luck.

### Checking the reports against the results

```sh
python3 check_report.py        # exits non-zero and lists every disagreement
```

Every figure in `docs/research/voice-engine-quality-*.md` is compared against the
CSVs it was written from — Track B metrics against `summary.csv`, Track A WER and
empty-transcript counts against `asr_scores.csv`, SNR₅₀ against
`asr_scores_summary.csv`, judge agreement recomputed from both judge passes, and
the headline spend against the cost table. Three review rounds found the same defect — a sentence
correct when written and stale after the study was extended — and prose does not
fail CI on its own. This makes it fail: `test_scoring.py` runs it.

`RESULTS_FOR` maps each report to its own pass *and* to the number of table cells
it must resolve. The 2.1 run re-judged every arm and overwrote `results/` in
place, so the merged report is checked against `results/main-report/`, the pass
that produced it. **A re-run that changes existing arms' numbers should write to
a new directory and add a mapping**, not overwrite; a report whose data has been
overwritten cannot be verified by anyone, including you. A report with no mapping
is a failure, not a skip.

The cell count is enforced **per report**, not across the run — otherwise two
documents mask each other and one can silently stop being checked while the
totals still look healthy. If you remove a table on purpose, lower that report's
number in the same commit.

## Things that will bite you

These all cost real debugging time here; they are encoded in the harness.

* **Keep sending audio.** Server VAD emits `speech_stopped` only after it
  *observes* `silence_duration_ms` of silence. Stop streaming at the end of an
  utterance and the turn never ends — you get exactly one `speech_started` per
  session and no response, ever. `run_scenarios.py` runs a mic task that sends
  silence frames continuously, like a real phone line.
* **Do not wrap `ws.recv()` in `wait_for`.** Cancelling a websockets read on
  every poll timeout kills the reader. Use a bare `async for` and cancel the task.
* **Bind transcripts by `item_id`.** Voice Live emits `conversation.item.created`
  for clip *N* *after* clip *N*'s transcript, so "take the first
  transcript-shaped event" hands clip *N+1* the previous clip's text and then
  cascades. `run_asr.py` waits for `input_audio_buffer.committed` first.
* **Voice Live rejects manual-commit transcription on the `gpt-realtime-2`
  brain** (`turn_detection must be of type AzureSemanticVAD`) but allows it on
  `gpt-4.1-mini`. That is why `vl-native-brain` is Track B only.
* **Echo cancellation is rejected when modalities are text-only**
  (`ec_not_supported`), so it is duplex-only.
* Voice Live wants `session.update` before any other event, treats `session` as
  replace-not-merge, and forbids changing `turn_detection.type` mid-session.
* Voice Live defaults `silence_duration_ms` to 200, the GA surface to 500. Both
  are pinned to OpenFon's production 550 here — unpinned, you are benchmarking
  two different end-of-turn policies.

## Layout

```
engines.py        arm definitions, both wire dialects, session payloads
probe_session.py  pre-flight validation of every arm
run_asr.py        Track A runner
run_scenarios.py  Track B runner (continuous mic, barge-in timing)
score_asr.py      WER/CER, dWER, SNR50
score_slots.py    programmatic Track B scoring
judge.py          blind LLM judge, soft dimensions only
summarize.py      per-arm aggregation incl. pass^k
check_report.py   verifies the reports against the CSVs they quote
gen_prompt.ts     freezes the real buildSystemPrompt output
fixtures/         business fixture, scenarios, frozen prompt
prepare/          dataset download + conditioning recipes
results/          CSV/JSONL outputs (current pass)
results/main-report/  the merged report's pass, which the 2.1 run overwrote
logs/             raw event logs — results can be re-scored without re-spending
```
