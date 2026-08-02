# Completeness inventory

Every place this harness decides **"this run is complete / this arm is verified /
this result counts"** — what each check compares, and how it can be fooled.

This file exists because **the same bug class was found thirteen times across eight
review rounds**, and three separate sweeps each missed instances of the class
they were sweeping for. That is not a run of bad luck — it is the failure mode
this code attracts, and anyone extending the harness should expect to introduce
it again rather than assume it has been designed out. The shapes are not
memorable. The inventory is.

**The rule.** *Every check must compare what it got against what it expected, by
identity rather than by count.* Counting rows is not verifying trials. Writing an
error row is not reporting failure. A non-empty collection is not a complete one.

Corollary: **absence is never a pass.** If a benchmark's failure modes all
inflate its own results, the numbers it produces are indistinguishable from
correct ones, which is worse than no numbers.

---

## The checks

| # | Where | Decides | Compares | Fooled by |
|---|---|---|---|---|
| 1 | `run_scenarios.py` `main()` | did this arm/trial complete | every scenario ran without raising **and** produced at least one agent turn; **exits non-zero** if any failed | nothing known. A silently-empty scenario used to reach the scorer as a valid row. |
| 2a | `run_asr.py` `main()` | did every condition produce results | retries not exhausted for any condition; **exits non-zero** if any were | nothing known. Exiting zero was the bug: a full cell of error rows has every expected clip id, so the scorer scored an outage as 100% WER. Paired with #11's all-error guard. |
| 2 | `run_asr.py` `transcribe_batch()` | is this session still coherent | each clip gets `input_audio_buffer.committed`; a timeout **raises** `CommitDesync` rather than continuing | nothing known. Continuing was the bug: a late commit was consumed as the next clip's, cascading wrong hypotheses. |
| 3 | `run_all.sh` | did the matrix complete | every runner invocation's exit code; collects failures and **exits non-zero** | a runner that exits 0 having swallowed its errors — which is why #1 exists. Also `OUT` must point somewhere disposable in tests: the `: >` truncation writes to `$HERE` by default and once destroyed a finished run. |
| 4 | `summarize.py` trial check | did every arm run everything | **set of trial ids** per `(arm, scenario)` equals `{1..k}`, no duplicates, no extras | nothing known. Counting rows was the bug: three copies of trial 1 satisfied `--trials 3`. Runners append to JSONL, so re-runs duplicate rather than replace. |
| 5 | `summarize.py` judge check | was every run judged | a verdict row exists for every `(arm, trial, scenario)`; empty `--judge` file is an **error**, not "no judge" | a judge that returns verdicts for the wrong candidates — blocked in `parse_verdicts` by id membership. |
| 5b | `summarize.py` scenario universe | which scenarios should exist | the **fixture's** scored scenario ids, against the ids present; rejects both gaps and rogues | nothing known. Inferring the set from the results was the bug, and the only one the per-scenario trial checks could not see: they verify trials *within* a scenario, this loses the scenario. |
| 6 | `summarize.py` conjunction | did this run succeed | `error` empty **and** `agent_turns > 0` **and** slots/tools/grounded/forbidden **and** a judge verdict | an unparseable numeric — blocked by `strict_num`, which aborts rather than defaulting. |
| 7 | `summarize.py` rates | `success_mean`, `tool_ok`, `grounded_ok` | numerator over **expected** runs (`scenarios × trials`), not rows present | nothing known. Averaging present rows was the bug: 2 of an expected 3 reported 1.0. |
| 8 | `summarize.py` `pass_k` | did it pass every trial | trial ids `{1..k}` each present exactly once **and** all succeeded; denominator is every scenario | nothing known. |
| 9 | `summarize.py` descriptives | `slot_heard`, `judge_*` | carries its own n, flagged `(of n/expected)` when short | these cannot be imputed, only reported. A short n is visible, not corrected. |
| 10 | `summarize.py` TTFA | latency percentiles | **nothing** — deliberately | a turn only yields a latency if the agent replied, and the closing turn usually gets none by design, so there is no a-priori denominator. Run-level completeness (#4, #7) carries it. This is the one check that cannot be tightened. |
| 11 | `score_asr.py` cell check | is every ASR cell whole | **set of clip ids** per `(arm, lang, condition)`: no duplicates, size equals `--expect-clips`, and identical across arms for the same `(lang, condition)` | clips present but with empty references — surfaced separately as `unscorable_refs`. Counting rows was the bug: a duplicated id beside a missing one totals correctly and double-weights the duplicate in the WER. |
| 13 | `score_asr.py` robustness rows | can dWER/SNR50 be computed | a `clean` baseline exists per `(arm, lang)`; **emits nothing and says so** if not | nothing known. `summary[0]` used to raise `IndexError` after the detailed CSV had been written. |
| 12 | `judge.py` `parse_verdicts` | is this verdict usable | one verdict per expected candidate id, scores literally `int` in range | nothing known. `bool` passing as `int` was the bug: `true` became `0.0` downstream. |

## Known limitations, documented rather than fixed

The line: **anything that can silently contaminate a reported number gets fixed;
anything that fails visibly, or only under a debug flag, gets written down.**

- **`--allow-incomplete` counts rows, not identities.** The default path
  validates by trial identity (check #4), but the escape hatch does not: four
  rows against three expected trials give a rate of 1.333 and `missing_runs` of
  −1. Nothing reported rests on it — the published numbers come from the default
  path, which refuses that data outright. If you use the flag, read
  `missing_runs`; a negative value means duplicates, not completeness.
- **`--allow-incomplete` omits entirely-missing ASR cells.** A cell with zero
  rows is absent from the output rather than present with `complete=0`, because
  arms and conditions are discovered from the data. Same reasoning: the default
  path aborts instead.
- **`response.done` with `status == "failed"` reads as a normal finish.**
  `run_scenarios.py` only special-cases `cancelled`; a response the service marks
  failed, with no separate `error` event, sets `done` like any other. A partially
  failed call can therefore enter scoring if another turn produced text. Needs a
  specific upstream misbehaviour to trigger and did not occur in this run — all
  165 runs are error-free — but a future run could be scored on a call the
  service considered failed.
- **The final drain in `run_asr.py` catches `Exception`.** A websocket closure or
  JSON decode error during the end-of-batch drain is indistinguishable from the
  ordinary timeout that ends it, so the clip yields an empty, error-free
  hypothesis and is scored as a recognition miss rather than retried. The
  `CommitDesync` guard (#2) covers the equivalent failure during the main loop;
  this is the tail.
- **A cancelled response used to be attributed to the next turn.** VAD stopping
  at an intra-utterance pause ends the tentative response `cancelled`; treating
  that as turn completion let the wait exit early and recorded the replacement
  against the following turn, producing time-to-first-audio down to −5.4 s.
  Fixed in the runner; the committed runs cannot be repaired because the log
  does not record when the harness finished streaming the caller clip, so the
  14 affected runs carry `ttfa_trustworthy=0` and are excluded from the latency
  percentiles. Transcripts were never affected — they append in arrival order —
  so slots, grounding and success are sound.
- **Time-slot matching is approximate.** Numeric strings (phone numbers, dates)
  parse as clock mentions, and spoken composite times record only the hour, so
  both inflate. Stated in the report's limitations rather than chased further.
- **A mid-stream `ws.send()` failure can hang the run.** The mic task can die
  without setting the `last` event the turn is awaiting, so the run stops rather
  than erroring. This is operational, not a correctness defect: it halts a run
  instead of corrupting one, and a halted run is visible. It has never fired.

## Not verified, and knowingly so

- **TTFA has no expected denominator** (#10). A missing reply is invisible to the
  latency statistic; it shows up as a task failure instead.
- **`n_turns_expected` is recorded but unused.** It is the caller-turn count, not
  the expected-reply count; using it as a denominator produced false shortfalls.
- **Judge non-determinism** is measured (two seeds, reported in the report) but
  not gated — a single seed's verdict is accepted.

## Adding a check

State it in the table above *before* writing it, in the form "compares X against
Y". If you cannot name Y, there is no check — there is a value being read.
