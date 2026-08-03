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

**The operational form of the rule: hold a declared expectation that does not
come from the data being checked.** Every instance of this bug is a branch that
checks data against itself. A floor over however many cells happened to resolve;
a scenario universe inferred from the results that are supposed to fill it; a
rate denominated on the rows that arrived; an agreement figure required only when
it is already present. Each one is satisfied by its input degrading, because the
expectation degrades with it. The fix is always the same shape — take the
expectation from somewhere the checked data cannot influence: the fixture, the
arm list, a count declared in the source, the baseline snapshot.

Corollary for *checkers* specifically, which is where this class concentrates: a
checker's output is derived from what it checks, so when its input goes missing
the result drifts toward "fine" rather than toward an error. Absent input and
clean input produce the same verdict unless something outside both distinguishes
them. Ask of every branch: **if the input were missing or malformed here, would
this report a problem or fall through?** A `KeyError` is that failure at its
loudest, a bare `continue` at its quietest, and an `any()` at its most
plausible-looking.

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
| 14 | `check_report.py` | do the reports still quote their own data | every resolvable table cell, judge-agreement figure, cost total, run count, Track A condition list, and any count written beside a named CSV or results directory, against the tree that report was written from (`RESULTS_FOR`) | **free prose**, deliberately: a count not tied to a named artifact is not matched. Each report must resolve its **declared** cell count, enforced per report; an unmapped report is an error, not a skip; an empty judge intersection is reported, not raised. |

**Every branch in `check_report.py` was swept against the question above**, after
three findings in one round were all fall-throughs inside it. Nine places were
changed: an alias resolving to an arm absent from `summary.csv` raised `KeyError`
and produced no output at all; missing agreement fields `continue`d, so deleting
the entire three-row table while keeping the heading exited zero; the condition
set was accepted if `any` arm matched, letting the other carry a different
matrix; a cited CSV that does not exist, an empty CSV, a missing
`summary_per_run.csv`, an unparseable total cell, a total with no line items, and
a non-numeric count all fell through silently. Each now reports.

**Why the floor is per report.** It was first written as one global minimum, and
that is the same bug in the check that exists to catch the bug: with 25 cells
from one document and 40 from the other, a floor of 30 is cleared by either
alone — so one report's tables could stop resolving entirely, be certified
unchecked, and the run would still print clean. Two documents masked each other.
The count is now declared per report in `RESULTS_FOR` and compared per report,
which is the rule at the top of this file applied to the checker's own coverage.
Removing a table on purpose means lowering that number in the same commit, so a
coverage change shows up in the diff instead of in nothing.

**What #14 does not cover, and why.** Scanning every "N arms" in the text found
five false positives on two documents — sentences about judge files, about
scenario matrices, about arms in a table. A checker that cries wolf gets switched
off, so counts are only checked where they sit beside the artifact they describe:
``` `judge.csv` (seed 1, 246 rows, eight arms) ``` or a sentence naming
`results/`. **Write a count next to the file it describes and it gets checked;
write it in free prose and nothing will catch it going stale.** That is a real
gap, stated rather than papered over — it is how "all seven arms" reached the
merged report one commit after this checker landed.

### Why #14 exists: the prose variant of the same class

The rule at the top of this file — *compare what you got against what you
expected* — was written about the scorers. It applies unchanged to the reports,
and that took three further review rounds to see.

**Extending a study invalidates prose that quoted the original pass, and prose
does not fail CI.** Every stale-report finding has this shape: a sentence that
was true when written, describing a pass that has since been re-run. Found in the
addendum as a results table, a groundedness band, a judge-agreement figure, an
arm count ("seven arms" after an eighth was added) and a run count ("seven of 54"
after a third new arm made it ten of 81); and in the merged report as a cost
total that never equalled its own line items.

Two consequences are now permanent:

- **Every number in a report is generated or checked against something
  generated.** #14 is that check, and `test_scoring.py` runs it, so a stale
  figure now fails CI exactly like stale code.
- **A re-run must not overwrite the pass an existing report quotes.** The 2.1 run
  re-judged all arms and rewrote `results/` in place, which left the merged
  report's figures unreproducible from the repository until its pass was restored
  to `results/main-report/`. A future study should write to its own directory and
  add a `RESULTS_FOR` entry rather than repeating this.

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
- **Which hangs the bounds actually cover.** "Bounded" is narrower than it
  reads, so: `asyncio.wait_for` schedules its cancellation on the event loop and
  therefore cannot fire while the loop is blocked. Anything synchronous on that
  thread is invisible to it — which meant the 300 s scenario bound could not
  have stopped a stalled `az` or `ffmpeg`, the two most likely environmental
  hangs for someone re-running this later. Those now carry their own
  `subprocess.run(timeout=)` (`AZ_CLI_TIMEOUT_S`, `FFMPEG_TIMEOUT_S`), which is
  the only mechanism that bounds them. **Covered:** stalled handshake, silent
  peer, a stuck `await` anywhere in a scenario or batch, a hung `az` or
  `ffmpeg`. **Not covered:** any *other* long-running synchronous call added to
  the event-loop thread in future — the outer bound will not save it, so give it
  its own timeout or move it off-thread.
- **A timeout reports which bound fired.** Inner `wait_for` timeouts raise the
  same `TimeoutError` as the outer one, so every failure used to be logged as
  "hard timeout after 300s" regardless of whether it took 300 s or 10. The
  handler now reports measured elapsed time and labels inner versus outer. A
  message that misreports which bound fired is worse than none: it sends the
  next debugger to the wrong place.
- **Hangs are bounded in three layers, after two incidents.** `open_timeout`
  and keepalive pings bound the handshake; `asyncio.wait_for` bounds every
  individual receive, including the first (`open_timeout` does *not* cover the
  wait for `session.created` — that is a separate, and separately bounded,
  wait); and `SCENARIO_HARD_TIMEOUT_S` / `BATCH_HARD_TIMEOUT_S` bound the whole
  unit regardless of which step stalled. The third layer exists because the
  first two hangs arrived by routes nobody had predicted, so the next one is
  assumed rather than enumerated.
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

## Running this without the author's cloud setup

The scoring path — everything `bench-scoring` exercises — must import and run
with **no Azure credentials and no `az` on PATH**. That is what a CI runner
looks like, and what anyone cloning this repo looks like. A test asserting on
the transport timeout policy once reached `connect_kwargs`, which resolves the
Azure key eagerly by shelling out, so inspecting a constant required a cloud
login; `transport_kwargs()` exists to separate the two. Verify with:

    env -u AZURE_AI_KEY PATH=/usr/bin:/bin python -m unittest discover \
        -s bench/quality -p 'test_*.py'

Only the runners and probes may need credentials. Nothing that computes or
checks a number may.

## Adding a check

State it in the table above *before* writing it, in the form "compares X against
Y". If you cannot name Y, there is no check — there is a value being read.
