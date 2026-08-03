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

**The parser's non-matches were invisible in one more dimension each round.**
Rows first (the compound `TTFA p50 / p95`), then columns (the grouped headline
labels), then arm labels on both axes, then number *formats* — `~15` made a cost
line uncheckable and silent, `1.0 dB` hid an unresolved arm row. Each fix was
right and each left the next dimension open, because "unrecognised" was being
enumerated rather than defined.

The cheapest way to find the next one is not to read the parser: **change a
number and see whether anything complains.** `test_every_committed_figure_is_
actually_compared` does that for every numeric cell in both reports, and it found
34 unchecked figures the round it was written — the (recogniser, VAD) table
carrying the addendum's structural claim, the noise-suppression probe tables
carrying "never enable Azure DNS", and the second judge seed. All are checked
now; the only cells still exempt are the catalog `$/min` prices, which are
Azure's published rates with nothing in the repository to check them against.

**A fourth, about documentation rather than code: instructions get verified
against the repository as it stands, not against a fresh run.** Six findings on
this harness share it, and every one passes when `results/` is already populated
and fails when it is not — which is the only state a new reader is ever in.

- Step 5 used bare relative paths, which resolve to the committed `results/`
  because a `cd` earlier in the workflow is still in effect. Reading it from
  this checkout, it works; from a fresh `$OUT`, it scores the wrong data and
  overwrites the right data.
- Scoring happened only after the extension was appended, so a fresh run never
  created `results/main-report/` and the documented `check_report.py` step —
  added so a reader could confirm the numbers — could not succeed at all.
- The seed-2 judge rerun had no arm filter, so it judged 246 rows where the
  committed pass has 219, and the reader then failed the checker for following
  the instructions.
- `CONDITIONS` was not overrideable; `--only` was never passed; an unknown
  `--only` id ran nothing and exited 0.

The other diagnostics ask where an expectation comes from. This one asks **what
state is the reader in when they follow this, and have I ever been in it?** The
answer here was "no" six times. The countermeasure is not more careful prose: it
is asserting the instructions against the data — the tests now check that the
documented arm, scenario and condition lists *equal* what the committed results
contain, and that the workflow's steps are ordered so its own verification step
can run.

**A third form, and the one that keeps recurring after a fix: a tightening can
stop one step short of the property it was reaching for.** Three found in a
single round, each a *narrower* version of a check already tightened once:

- **set instead of sequence.** The dedupe guard compared `set(before)` against
  `set(after)`, having already been fixed once to check both directions. A
  reordering has an identical set, is not a deduplication, and order carries
  scoring meaning. Membership is a weaker property than the sequence it stands
  in for; it now compares distinct names in order of first appearance.
- **present instead of declared.** `check_conditions` was fixed from "any arm
  matches" to "every expected arm matches" — and then computed `expected` by
  intersecting with the observed rows, so an arm with *no* data left the
  expectation and an entirely absent arm passed. The declared-expectation rule
  broken inside the fix for the previous finding.
- **truncation instead of any write.** `run_all.sh` was guarded against
  truncating committed results; the documented step 5 then overwrote the same
  files through relative paths, because a `cd` earlier in the workflow was still
  in effect. Guarding the command that destroys data does not guard the
  outcome.

The test for it: after fixing a check, ask **what is the weakest input that
still passes?** If the answer is a case you would call a bug, the fix landed
short. Each of these was found by someone asking that; none was found by the
person who had just tightened the check.

**Verifying a fix is itself a run, and it destroyed data.** The guard on
`results/` was added, then a raw log was emptied anyway — by the act of checking
that a new test failed against the old behaviour, which ran the real runner
against the real `logs/` directory. The protected artifact was not the one at
risk. Ask of any guard: *what else does this operation touch?* Here the answer
was the only artifact from which a result can be rebuilt without paying for the
call again.

Two more of the same, both in the `--only`/`CONDITIONS` validation added to stop
typos: **a malformed selection read as an absent one.** `--only ','` parsed to an
empty set and the caller tested `if want`, so every paid scenario ran;
`CONDITIONS=','` bypassed the default, `run_asr.py` parsed zero conditions and
exited 0, and `run_all.sh` had already truncated `asr.jsonl` — data cleared by a
run that then did nothing and reported success. Empty-is-absent, inside the fix
for a different problem. Both now raise, and `run_all.sh` validates **before** it
truncates, because checking afterwards reports the failure and has still
destroyed the file.

**Destroy-then-recreate is only safe when the recreate cannot fail, and here it
failed by construction.** `FORCE=1` — the option whose whole purpose is
"replace what is there" — truncated `$OUT/results/*.jsonl` and then never
forwarded any log-replacement option to the runners. Every raw log already on
disk therefore made `open_log` refuse, on the *first* invocation: the results
were erased and the forced replacement could not start. The two guards were each
correct and their composition was not, which is the thing to look for — ask of
any destructive step **what has to succeed afterwards for this to have been
safe, and is that guaranteed or merely likely?** The fix is ordering plus an
explicit option: `FORCE_LOGS=1` propagates `--force-logs`, and the whole matrix
is walked once with `--preflight-logs` before anything is truncated.

**And the fix reproduced the bug inside itself, which is why it is written up
rather than quietly patched.** The first version of the preflight returned
before the arm was resolved or the data root read, so it answered "are these
logs free?" while `run_all.sh` was asking "is this run safe to start?".
`FORCE=1` with an unknown arm therefore cleared the results and failed on the
first invocation — the identical destroy-then-recreate failure, through a
different input, inside its own remedy. **A preflight is only as strong as the
question it answers; state that question and check every input that can
falsify it.** Both runners now validate arm, data root, manifests, clip counts
and caller audio before the preflight returns, and hoisting the manifests out
of the loop closed the same shape a third time (a missing manifest for
condition 5 used to abort after four had been billed).

Two more arrived on the *next* review of the same fix, both "the file parsed"
standing in for "the run can proceed": a manifest with fewer entries than `--n`
(a short cell, which the scorer refuses — after the calls are paid for), and a
manifest naming a wav that is not on disk (which ffmpeg discovers mid-run).
**A preflight that reads a listing has checked the listing, not the inputs.**

Two riders, both instances of rules already in this file. A guard that fires at
the moment one file is opened is a guard that fires **after** earlier units of
the same run have been billed — `run_asr.py` held every condition's transcripts
in memory until after the loop, so a collision on the last condition discarded
all of them. Rows are now written as each condition completes, and both runners
validate every target log up front. And the preflight exits a *distinct* status
(`LOG_COLLISION_EXIT`), because reporting a missing interpreter or a bad
argument as "these logs are populated" is the timeout-naming-the-wrong-bound
defect in a new place: it sends the next person to delete files that were never
the problem.

**The other half, and the one you can answer by inspection: what sentence was
this check written for, and is that sentence inside what it reads?** The rule
above is about where the *expectation* comes from; this is about whether the
check is even pointed at the claim. `check_cost_table` was written because a
report's headline `Actual spend` had never equalled its line items — and it read
only the table. The headline lives in the opening paragraph, so restoring the
original bug in either report left the run green. The guard covered everything
except its own motivating case.

**And a variant of it on the arm axis: the grouping *is* the claim, so a grouped
row has to be able to fail.** The `gpt-realtime-2 / 2.1` row of the (recogniser,
VAD, brain) table states one slot-capture figure for two arms, and that row is
what backs the addendum's structural finding — capture is a function of
(recogniser, VAD) and not of the brain. It was compared against
`native-gpt-realtime-2` alone, so if 2.1's capture moved, the stale shared value
still passed on the incumbent: an assertion that two things agree, validated in a
way that cannot notice them disagreeing. `RECOGNISER_ROWS` now maps every row to
a **tuple** of arms and compares each; a single-arm value is what made the gap
invisible, so there are no bare strings left to hide in. The sweep for the same
shape elsewhere found one other multi-arm construct, `ARM_GROUPS`, which already
compares the group's min and max — and one adjacent fall-through, a compound
metric under a group column, which is now reported rather than skipped.

That check was the only instance in the file, and the reason is worth stating,
because it is the test for the next one: **every other check compares a document
claim against generated data; that one compared a document claim against a
neighbouring part of the same document.** A check that reads only the document is
checking a story for internal consistency, which a wrong story can have.

The same applies to prose about code. The header comment here once said
unresolved cells are "counted and reported, never silently dropped" while only
the arm-label path did that and the metric path still fell through — which is why
CI stayed green on a table nobody was checking. **A comment describing an
invariant the code half-implements is this class in documentation form:** it too
degrades toward "fine", and it is more convincing than the code because it states
the intent rather than the behaviour.

---

## The checks

| # | Where | Decides | Compares | Fooled by |
|---|---|---|---|---|
| 1 | `run_scenarios.py` `main()` | did this arm/trial complete | every scenario ran without raising **and** produced at least one agent turn; **exits non-zero** if any failed | nothing known. A silently-empty scenario used to reach the scorer as a valid row. |
| 2a | `run_asr.py` `main()` | did every condition produce results | retries not exhausted for any condition; **exits non-zero** if any were | nothing known. Exiting zero was the bug: a full cell of error rows has every expected clip id, so the scorer scored an outage as 100% WER. Paired with #11's all-error guard. |
| 2 | `run_asr.py` `transcribe_batch()` | is this session still coherent | each clip gets `input_audio_buffer.committed`; a timeout **raises** `CommitDesync` rather than continuing | nothing known. Continuing was the bug: a late commit was consumed as the next clip's, cascading wrong hypotheses. |
| 16 | `engines.open_log`, `engines.preflight_logs` | may this raw log be replaced | the target is absent or empty, unless `--force-logs`. `preflight_logs` asks the same question of **every** log an invocation will write, before the first one is opened, and exits `LOG_COLLISION_EXIT` (97) so a caller can tell a collision from a preflight that could not run | nothing known. Nothing guarded `logs/` at all: the runners open with mode `"w"` before doing any work and `--logdir` defaults to the committed directory, so a stray invocation from `bench/quality` empties a log and a subsequent failure leaves it empty. That happened — `sc-vl-gpt41mini-book-de-01-t1.jsonl` was zeroed while *verifying a test*, and the run became unre-scorable while its result still claimed an `end_call`. Guarding one file at the moment it is opened was the next bug: see "destroy-then-recreate" below. |
| 3 | `run_all.sh` | did the matrix complete | every runner invocation's exit code; collects failures and **exits non-zero**. Also **refuses to start** if `$OUT/results/*.jsonl` are non-empty, unless `APPEND=1` (adds arms, destroys nothing) or `FORCE=1` (replaces); and walks the whole matrix once with `--preflight-logs` **before** any truncation, so a raw-log collision stops the run while the results it would replace still exist | a runner that exits 0 having swallowed its errors — which is why #1 exists. The refusal was added after the README's own step 4 was found to destroy the committed study: `OUT` defaults to `$HERE`, so the documented invocation truncated the data both reports quote and replaced it with a smaller run under the old arm set. `FORCE=1` then reintroduced it from the other side — see below. |
| 4 | `summarize.py` trial check | did every arm run everything | **set of trial ids** per `(arm, scenario)` equals `{1..k}`, no duplicates, no extras | nothing known. Counting rows was the bug: three copies of trial 1 satisfied `--trials 3`. Runners append to JSONL, so re-runs duplicate rather than replace. |
| 5 | `summarize.py` judge check | was every run judged | a verdict row exists for every `(arm, trial, scenario)`; empty `--judge` file is an **error**, not "no judge" | a judge that returns verdicts for the wrong candidates — blocked in `parse_verdicts` by id membership. |
| 5b | `summarize.py` scenario universe | which scenarios should exist | the **fixture's** scored scenario ids, against the ids present; rejects both gaps and rogues | nothing known. Inferring the set from the results was the bug, and the only one the per-scenario trial checks could not see: they verify trials *within* a scenario, this loses the scenario. |
| 6 | `summarize.py` conjunction | did this run succeed | `error` empty **and** `agent_turns > 0` **and** slots/tools/grounded/forbidden **and** a judge verdict | an unparseable numeric — blocked by `strict_num`, which aborts rather than defaulting. |
| 7 | `summarize.py` rates | `success_mean`, `tool_ok`, `grounded_ok` | numerator over **expected** runs (`scenarios × trials`), not rows present | nothing known. Averaging present rows was the bug: 2 of an expected 3 reported 1.0. |
| 8 | `summarize.py` `pass_k` | did it pass every trial | trial ids `{1..k}` each present exactly once **and** all succeeded; denominator is every scenario | nothing known. |
| 9 | `summarize.py` descriptives | `slot_heard`, `judge_*` | carries its own n, flagged `(of n/expected)` when short | these cannot be imputed, only reported. A short n is visible, not corrected. |
| 10 | `summarize.py` TTFA | latency percentiles | **nothing** — deliberately | a turn only yields a latency if the agent replied, and the closing turn usually gets none by design, so there is no a-priori denominator. Run-level completeness (#4, #7) carries it. This is the one check that cannot be tightened. |
| 11 | `score_asr.py` cell check | is every ASR cell whole | **set of clip ids** per `(arm, lang, condition)`: no duplicates, size equals `--expect-clips`, and identical across arms for the same `(lang, condition)` | clips present but with empty references — surfaced separately as `unscorable_refs`. Counting rows was the bug: a duplicated id beside a missing one totals correctly and double-weights the duplicate in the WER. |
| 13 | `score_asr.py` robustness rows | can dWER/SNR50 be computed | a `clean` baseline exists per `(arm, lang)`; **emits nothing and says so** if not | nothing known. `summary[0]` used to raise `IndexError` after the detailed CSV had been written. Absent cells are excluded from the index by type, so an empty WER cannot pass the `clean is None` guard and then fail on the subtraction. |
| 15 | `score_asr.py` output rows | which cells exist | rows are emitted for the **expected cross-product** of (arm, lang, condition), absent ones with `n=0`, `complete=0`, empty WER | nothing known. Iterating only the groups that existed was the bug: an absent cell produced no row, so all 72 rows read `complete=1` and the field could never be 0 — a consumer trusting the documented signal saw a complete matrix because the gaps were invisible, not because they were filled. |
| 12 | `judge.py` `parse_verdicts` | is this verdict usable | one verdict per expected candidate id, scores literally `int` in range | nothing known. `bool` passing as `int` was the bug: `true` became `0.0` downstream. |
| 14 | `check_report.py` | do the reports still quote their own data | every resolvable table cell, judge-agreement figure, cost total, run count, Track A condition list, and any count written beside a named CSV or results directory, against the tree that report was written from (`RESULTS_FOR`). A row or column standing for several arms is compared against **every** arm it covers — `ARM_GROUPS` against the group's min and max, `RECOGNISER_ROWS` against each arm's `slot_heard` — and each arm counts as a cell | **free prose**, deliberately: a count not tied to a named artifact is not matched. Each report must resolve its **declared** cell count, enforced per report; an unmapped report is an error, not a skip; an empty judge intersection is reported, not raised. |

**The runner was written for the original matrix; the documented invocations
describe a study it could not produce.** Five reproducibility findings landed on
this shape. `CONDITIONS` was a bare assignment, so the documented override was
ignored and the extension would run all eight conditions — 800 ASR rows against
the 600 the reports describe, billed to the service, and unable to reproduce the
committed asymmetry. There was no scenario filter at all, so the three new arms
would run 11 scenarios each (99 runs) rather than the nine scored ones (81).
Both are now overrideable, `APPEND=1` lets the extension land in the same
directory as the base pass, and a test asserts the documented `ONLY` and
`CONDITIONS` lists **equal** the scenarios and conditions the committed data
actually contains — so the instructions cannot drift from the study again.

**Every branch in `check_report.py` was swept against the question above**, after
three findings in one round were all fall-throughs inside it. Nine places were
changed: an alias resolving to an arm absent from `summary.csv` raised `KeyError`
and produced no output at all; missing agreement fields `continue`d, so deleting
the entire three-row table while keeping the heading exited zero; the condition
set was accepted if `any` arm matched, letting the other carry a different
matrix; a cited CSV that does not exist, an empty CSV, a missing
`summary_per_run.csv`, an unparseable total cell, a total with no line items, and
a non-numeric count all fell through silently. Each now reports.

**A guard can miss its own motivating case** — `check_cost_table` did, and the
diagnostic that finds that shape is at the top of this file. `check_cost_table`
now reads the headline `Actual spend` as well as the table, in both directions:
a table with no headline, and a headline with no table, are each reported.

It also had a fall-through of the quietest kind: a line whose rate or minutes
were *stated but unreadable* took the same `continue` as a line that states no
inputs at all, so rewriting a rate as `bogus` switched that line's arithmetic
off and the run stayed green while the column total still summed the unchanged
dollar figure. **Blank is an absence; non-blank and unparseable is a finding**,
and collapsing the two is how a checker certifies what it never read. The em
dash these tables write for an unused leg is a *stated* absence, so `is_absent`
names the placeholders explicitly rather than treating everything it cannot
parse as missing.

**The DNS tables carried two more, and the second is the sharpest instance of
"absence reads as agreement" in this file.** An unmapped German condition row
was a bare `continue` — and because nothing incremented `checked`, the *exact*
coverage count still certified the document as fully compared, so the silent
gap came with a receipt. Worse: `wer_cer([])` is `NaN`, every comparison
against `NaN` is False, and the cell counted as checked anyway — so a probe
file missing its `off` or `deep` leg certified **any** WER the document stated,
at full coverage. `abs(got - want) > tol` is not a test that a recomputation
happened; it is a test that it did not disagree, and a value that cannot
disagree passes it. Required legs are now checked for presence and every
recomputed figure for finiteness, on both the English and German paths.

**A coverage number counted from current behaviour certifies current behaviour,
including its blind spots.** The per-report counts were first read off whatever
the parser resolved at the time — 25 and 40 — so they encoded the parser's own
gap. The addendum's compound `TTFA p50 / p95` row matched no label, six latency
figures were skipped, and the declared count called the document fully compared
anyway. Altering all six left the run green.

The declared expectation has to come from the document's *structure* — how many
numeric cells it contains beside an arm — not from how many the parser managed to
resolve. Two changes make those the same number: an unrecognised label carrying
figures is now a problem (`UNCHECKED_METRICS` is the declared list of rows that
genuinely are not summary figures, each with its reason), and the count must
**equal** the declaration rather than merely clear it. So a newly-mapped metric
forces the number up in the same commit.

Equality is enforced **in the checker**, not only in its test. It ran as `<`
while the test asserted `==`, which is the half-implemented-invariant shape
again: true on one path, documented as true generally, and a stale declaration
would pass a direct `check_report.py` run while failing CI. A floor certifies
"at least this much was checked"; equality certifies "exactly what we declared,
and nothing moved". **The surplus direction is the more useful of the two** — it
means the document grew figures nobody accounted for — and a floor cannot see it. Closing the gap
took the counts from 25/40 to 50/51 — **36 figures that were never being
compared**, including every latency value in the tier recommendation.

**A declared allowlist is a hiding place unless entries earn their place.**
Track A WER and SNR₅₀ went into `UNCHECKED_METRICS` because they live in
`asr_scores.csv` rather than `summary.csv` — which is a reason they need a
*different source*, not a reason to skip them. They carried the DNS
recommendation ("never enable Azure noise suppression", 4.83 → 47.76 WER and the
empty-transcript counts), so the study's most actionable numbers were the ones
nothing verified, inside the file built to stop exactly that.

They are checked now: `check_wer_tables` against `asr_scores.csv` — WER **and**
the `(8e)` empty-transcript annotations, with the table's language *section rows*
tracked so a `de_DE` figure is not compared against `en_US` — and
`check_snr50_table` against `asr_scores_summary.csv`, including the literal `<0
(degenerate)`. That took the merged report from 50 checked cells to 152.

**And it happened again one round later, in the entry that read as a category.**
"Judge-free recomputation" sounds like a kind of thing rather than an excuse, so
`slots all heard` and `deterministic success` stayed allowlisted while both were
computable from `summary_per_run.csv` — the decision-supporting table could be
edited from 0.593 to 0.999 and pass. `PER_RUN_METRICS` now recomputes both. The
convention that makes them reproduce is worth recording: a scenario with no slots
satisfies "all slots heard" *vacuously* (`slots_all_heard` is empty, not 0, for
the twelve information-only runs), which is what `summarize.py` does for
`success`; counting only `"1"` gives 0.333 against the report's 0.778.

Two rules guard the list now. **No entry may say "not yet checked"** — wording,
and too weak alone, since both of the above passed it. **No entry may name a
column present in any committed CSV** — mechanical, and honest about its reach:
it catches `slots all heard`, whose label is a column, but not `deterministic
success` (derived, no column) nor the Track A labels (`cafe 20 dB` is a display
name for the value `cafe_snr20`). It covers the easiest third of the cases; the
judgement still has to be exercised.

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
