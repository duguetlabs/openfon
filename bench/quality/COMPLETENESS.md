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
line uncheckable and silent, `1.0 dB` hid an unresolved arm row. Then whole
*tables*: the two before/after tables, whose header names an arm **pair**
("server → semantic VAD, …") rather than either arm, so neither axis resolved
and `check_tables` skipped them entirely — twenty figures, including the strict
success value the VAD-control argument rests on. And one more number format,
`24 %`, because `%` sat inside a `\b…\b` group and `%` is not a word character,
which silently dropped the five English DNS percentages carrying the
noise-suppression recommendation. Each fix was right and each left the next
dimension open, because "unrecognised" was being enumerated rather than defined.

Then the *family* table, whose rows are arm families and whose cells are
ranges — unresolved on the arm axis like the delta tables, and invisible to the
unresolved-row report as well, because `looks_numeric` does not recognise a
range. And the *stated change* in each delta cell: the endpoints were compared
and the `(−0.074)` beside them was dropped, so the checker verified a
subtraction's inputs and not its result.

Seven rounds of this, so state the generalisation rather than the list: **the
checker only sees a figure if a table shape it already knows resolves both an
arm and a metric for it.** Every gap so far has been a new way for one of those
to come out empty, and the coverage count cannot see any of them — an
unresolved cell is not counted, so the declared total still matches. The count
proves nothing about what was skipped, only about what was found; the mutation
sweep is the only thing that has ever found these, and it should be run against
every table a report adds.

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
- The snapshot copied only the generated CSVs, while `check_report.py` also
  recomputes the merged report's noise-suppression tables from
  `main-report/dns_probe_*.jsonl` — and nothing in the workflow ran
  `probe_dns.py` at all, because the probes are a separate experiment from the
  matrix `run_all.sh` drives. Step 7 therefore failed for every reader whose
  `results/` was not already populated. The test executes the workflow's own
  `mkdir`/`cp` over a fake tree rather than matching their text: a glob either
  picks a file up or it does not, and only running it can say which.

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

**And three more, one per class, which is why the classes are written down
rather than the instances.** Each is a previously-fixed check found short of
the same property a second time:

- **The completeness checker took its expectation from the data it was
  checking.** `score_asr.py` built the expected cross-product from the arms,
  languages and conditions *present in the rows*, so a value missing from every
  row never entered it: if every `tel_loss3` invocation failed before writing
  anything, no cell was expected for it, nothing was reported, and
  `--allow-incomplete` exited 0 with every visible cell marked complete. The
  signature defect of this file, inside the file's own check #15 — which had
  been fixed once already, for absent *cells*, by iterating the cross-product
  the data defined. All four axes are declared on the command line now
  (`--expect-arms/-langs/-conditions/-clips`, all required), and a declared
  value with **no rows anywhere** is an integrity failure rather than a
  coverage gap, because otherwise the documented invocation — which always
  passes `--allow-incomplete` — would emit the `complete=0` rows and still exit
  0 over them. The declared asymmetry is per-cell; it never removes a whole arm,
  language or condition. `summarize.py`'s arm axis was the same bug on the same
  day: declared now too, by `--expect-arms`.
- **An equality guard that ignored multiplicity.** `rederive_tools.py` compared
  distinct names in order of first appearance — itself the fix for a set
  comparison that had missed reordering — and two distinct call ids sharing a
  function name rebuild as `["end_call", "end_call"]`, whose distinct names in
  order are identical to `["end_call"]`'s. So the guard permitted a rewrite that
  **added** an invocation of the one tool whose reliability this study reports
  on. The rewrite must now be a set-preserving subsequence of the original with
  first appearance intact; the subsequence is what carries multiplicity, and
  every guard tried before it compared names.
- **A uniqueness assumption that was never validated.** A `--scenarios` fixture
  with a repeated id mapped both entries to one raw log path, so
  `--preflight-logs` saw one file, found it free and exited 0, and the run then
  billed the first scenario before `open_log` refused the second — or, under
  `--force-logs`, truncated the log the first had just paid for. A preflight
  that passes because two things look like one is the `FORCE=1` shape again.
  The id was assumed unique by the runner, the judge, `summarize.py` and
  `score_slots.py` and checked by none of them; `events.scenario_ids` checks it
  once for all four. `preflight_logs` also refuses two units that name one path,
  because a caller that deduplicates into a dict before calling hides the
  collision from it — which is how this one arrived.

The sweep for further instances of each is at the end of this file.

**And the fix's own shadow, which is the fourth time this has happened inside a
remedy.** The dedupe guard above now refuses a log that would invent a call —
and then printed `rewrote N runs` and **exited 0**. A refused row is
byte-identical to a row that needed no repair, so nothing downstream could tell
a complete re-derivation from a partial refusal: `rederive_tools.py &&
summarize.py` scored the second as the first. Before the fix the tool did the
wrong thing loudly enough for review to catch; after it, it did nothing quietly
and reported success.

**A tool that declines to do what it was asked must say so in its exit status,
not only in its stdout.** State it as a rule because the boundary keeps moving
and the new boundary keeps going unchecked: absent data reading as a pass, then
an absent code path reading as a pass, now an absent *repair* reading as a pass.
The file is still written — the accepted rows are correctly deduplicated and the
refused ones are unchanged, so a partial repair is safe — but the exit says it
was partial, and the count says how many rows actually moved rather than how
many were in the file.

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
| 16 | `engines.open_log`, `engines.preflight_logs` | may this raw log be replaced | the target is absent or empty, unless `--force-logs`. `preflight_logs` asks the same question of **every** log an invocation will write, before the first one is opened, and exits `LOG_COLLISION_EXIT` (97) so a caller can tell a collision from a preflight that could not run. It also refuses two *units* naming one path — a collision no filesystem check can see, because such a path is free exactly once — which `--force-logs` does not override, since replacing another run's log is a different decision from overwriting your own output mid-run | nothing known. Nothing guarded `logs/` at all: the runners open with mode `"w"` before doing any work and `--logdir` defaults to the committed directory, so a stray invocation from `bench/quality` empties a log and a subsequent failure leaves it empty. That happened — `sc-vl-gpt41mini-book-de-01-t1.jsonl` was zeroed while *verifying a test*, and the run became unre-scorable while its result still claimed an `end_call`. Guarding one file at the moment it is opened was the next bug: see "destroy-then-recreate" below. |
| 3 | `run_all.sh` | did the matrix complete | every runner invocation's exit code; collects failures and **exits non-zero**. Also **refuses to start** if the result file *this `TRACK` will truncate* is non-empty, unless `APPEND=1` (adds arms, destroys nothing) or `FORCE=1` (replaces); and walks the whole matrix once with `--preflight-logs` **before** any truncation, so a raw-log collision stops the run while the results it would replace still exist. The guard is scoped to the selected track because refusing over a file the run never touches teaches people to reach for `FORCE=1` | a runner that exits 0 having swallowed its errors — which is why #1 exists. The refusal was added after the README's own step 4 was found to destroy the committed study: `OUT` defaults to `$HERE`, so the documented invocation truncated the data both reports quote and replaced it with a smaller run under the old arm set. `FORCE=1` then reintroduced it from the other side — see below. |
| 4 | `summarize.py` trial check | did every arm run everything | **set of trial ids** per `(arm, scenario)` equals `{1..k}`, no duplicates, no extras | nothing known. Counting rows was the bug: three copies of trial 1 satisfied `--trials 3`. Runners append to JSONL, so re-runs duplicate rather than replace. |
| 5 | `summarize.py` judge check | was every run judged | a verdict row exists for every `(arm, trial, scenario)`; empty `--judge` file is an **error**, not "no judge" | a judge that returns verdicts for the wrong candidates — blocked in `parse_verdicts` by id membership. |
| 5b | `summarize.py` scenario universe | which scenarios should exist | the **fixture's** scored scenario ids, against the ids present; rejects both gaps and rogues | nothing known. Inferring the set from the results was the bug, and the only one the per-scenario trial checks could not see: they verify trials *within* a scenario, this loses the scenario. |
| 6 | `summarize.py` conjunction | did this run succeed | `error` empty **and** `agent_turns > 0` **and** slots/tools/grounded/forbidden **and** a judge verdict | an unparseable numeric — blocked by `strict_num`, which aborts rather than defaulting. |
| 7 | `summarize.py` rates | `success_mean`, `tool_ok`, `grounded_ok` | numerator over **expected** runs (`scenarios × trials`), not rows present | nothing known. Averaging present rows was the bug: 2 of an expected 3 reported 1.0. |
| 8 | `summarize.py` `pass_k` | did it pass every trial | trial ids `{1..k}` each present exactly once **and** all succeeded; denominator is every scenario | nothing known. |
| 9 | `summarize.py` descriptives | `slot_heard`, `judge_*` | carries its own n, flagged `(of n/expected)` when short | these cannot be imputed, only reported. A short n is visible, not corrected. |
| 10 | `summarize.py` TTFA | latency percentiles | **nothing** — deliberately | a turn only yields a latency if the agent replied, and the closing turn usually gets none by design, so there is no a-priori denominator. Run-level completeness (#4, #7) carries it. This is the one check that cannot be tightened. |
| 11 | `score_asr.py` cell check | is every ASR cell whole | **set of clip ids** per `(arm, lang, condition)`: no duplicates, size equals `--expect-clips`, and identical across arms for the same `(lang, condition)`. The cells iterated are the **declared** cross-product (check #15) | clips present but with empty references — surfaced separately as `unscorable_refs`. Counting rows was the bug: a duplicated id beside a missing one totals correctly and double-weights the duplicate in the WER. `--expect-clips` used to default to the largest cell present, so a run where every cell came up short had its own shortfall define "complete". |
| 13 | `score_asr.py` robustness rows | can dWER/SNR50 be computed | a `clean` baseline exists per `(arm, lang)`; **emits nothing and says so** if not | nothing known. `summary[0]` used to raise `IndexError` after the detailed CSV had been written. Absent cells are excluded from the index by type, so an empty WER cannot pass the `clean is None` guard and then fail on the subtraction. |
| 15 | `score_asr.py` declared matrix | which cells should exist | the cross-product of the **declared** axes (`--expect-arms`, `--expect-langs`, `--expect-conditions`, all required), against the rows present. Absent cells are emitted with `n=0`, `complete=0`, empty WER; a declared axis value with no rows *anywhere*, or a row on an axis value never declared, is an integrity failure that `--allow-incomplete` cannot relax | nothing known. Two bugs, one fix apart. Iterating only the groups that existed meant an absent cell produced no row, so all 72 rows read `complete=1`. Deriving the cross-product from the rows then meant an entirely-absent arm, language or condition never entered it at all — the same invisibility one level up, and the reason the axes are declared rather than discovered. |
| 17 | `events.scenario_ids` | is the scenario fixture well-formed | every `id` in `fixtures/scenarios.json` appears exactly once, checked by the runner, the judge, `summarize.py` and `score_slots.py` before each keys the fixture by id | nothing known. The uniqueness was assumed at four sites and checked at none: a repeat was one scenario to the runner's log map (so `--preflight-logs` cleared a run that would overwrite its own log), two paid passes to the judge, and two entries in the denominator of every rate in `summarize.py`. |
| 12 | `judge.py` `parse_verdicts` | is this verdict usable | one verdict per expected candidate id, scores literally `int` in range | nothing known. `bool` passing as `int` was the bug: `true` became `0.0` downstream. |
| 18 | `check_report.py` DNS loader | is this probe file the study it claims | per leg: no errored rows, one row per clip id, `DNS_CLIPS` distinct ids, and the **same** id set in every leg | nothing known. It accepted whatever rows it found, which left `n` the one published figure nothing verified: duplicating every row in `dns_probe_en.jsonl` doubles n from 50 to 100 and leaves every WER and percentage identical — ratios are invariant under duplication — so the checker certified a file describing twice the study. The declared-matrix rule on a different input. |
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

**The gap bit once, and the sentence was wrong in a way the numbers were not.**
The addendum read "`vl-native-brain-21` matches the other Voice Live arms
10/27" — a *group* phrase over a count that is per-arm: 10/27 is against
`vl-gpt41mini-semvad` alone, the group figures are 21/27 and 13/27, and the
strongest single match is `vl-native-brain` at **19/27**. So the sentence
understated its own evidence and attributed it to the wrong comparator, in the
prose and again in the claims table a reader meets first. The conclusion was
never at risk — 19 against the same-surface arm versus 1 against the whisper-1
arm is the sharper version of the same finding — but **a correct number with
the wrong noun beside it is still a wrong claim**, and nothing in this harness
was looking at it. It is recomputed from `scenarios.jsonl` by a test now.

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

**A refusal that is right but late is still a defect, because the money is
already spent.** Five findings on this harness share the shape: the verdict was
correct and the run had been billed before it arrived. A log collision on
condition 5 (after four were paid for); an unknown arm or missing manifest
found by the runner rather than the preflight; a short cell or duplicate clip
id caught by the scorer; a `--arms` selection that cannot cover the fixture,
which judged nine scenarios and *then* reported the two it could never have
covered. Every one was knowable from the inputs before the first call.

The rule: **if a failure is derivable from the arguments and the files on disk,
derive it there.** Not because the late check is wrong — each of these fails
safe, and none has ever produced a wrong published number — but because a check
that costs money to run is one people learn to skip. None of these fixes
loosened an expectation; each moved the same expectation earlier.

## Known limitations, documented rather than fixed

The line: **anything that can silently contaminate a reported number gets fixed;
anything that fails visibly, or only under a debug flag, gets written down.**

- **`--allow-incomplete` counts rows, not identities.** The default path
  validates by trial identity (check #4), but the escape hatch does not: four
  rows against three expected trials give a rate of 1.333 and `missing_runs` of
  −1. Nothing reported rests on it — the published numbers come from the default
  path, which refuses that data outright. If you use the flag, read
  `missing_runs`; a negative value means duplicates, not completeness.

  In `score_asr.py` this went further and had to be fixed rather than
  documented: the flag suppressed *every* cell problem, and the ASR matrix is
  asymmetric by design so the documented workflow always passes it. Outages,
  duplicate clip ids and cross-arm clip-set mismatches were therefore
  suppressed too — checks #2a and #11 defeated by the flag standing next to
  them. **An escape hatch may only relax the property it was opened for.** A
  short cell is a statement about coverage, which `--allow-incomplete` is
  allowed to relax; an outage is a statement about whether the numbers mean
  anything, which nothing may. Two lists now, and only the first is
  suppressible.
- **Was: "`--allow-incomplete` omits entirely-missing ASR cells".** Fixed, and
  the second sentence of this entry was wrong in the way this file keeps warning
  about. It read: "a cell with zero rows is absent from the output rather than
  present with `complete=0`, because arms and conditions are discovered from the
  data. Same reasoning: the default path aborts instead." The default path did
  **not** abort — with the axes discovered from the data there was no
  expectation left to violate, so a condition absent from every row was not
  merely omitted from the CSV, it was invisible to every check. A limitation
  written down instead of fixed still has to be true; this one described the
  behaviour of a check that did not exist. The axes are declared now (#15).
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
- **`APPEND=1` does not check for unit collisions.** It is the one path that
  neither truncates nor verifies: if `$OUT/results/*.jsonl` already holds rows
  for an (arm, lang, condition) or (arm, scenario, trial) the run is about to
  produce, both are appended and the scorers reject the duplicate — check #4 by
  trial identity, check #11 by clip identity — *after* the calls are paid for.
  It fails safe and no published number can come from it, but it is the last
  known instance of the late-refusal shape above. Fixing it means the runners
  reading `--out` during preflight, which needs a way to distinguish "these
  rows are about to be truncated" from "these rows are staying", so it is
  written down rather than done in passing.
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

## The sweep for the three classes, including what it did not find

Three fixes landed together and each was an instance of a class, so the whole of
`bench/quality/` was read against each class rather than each line. Recorded
because a sweep that reports only its hits is indistinguishable from one that
looked in the wrong place — the failure this file opens by naming.

**Class 1 — an expectation derived from the data it checks.** Two more found,
both fixed above: `score_asr.py`'s `--expect-clips` defaulting to the largest
cell present, and `summarize.py`'s arm axis. The rest of the harness holds:
`summarize.py` takes trials from `--trials` and scenarios from the fixture,
`check_report.py` takes its per-report cell counts from `RESULTS_FOR` and its
metric list from `UNCHECKED_METRICS`, and `judge.py` measures coverage against
the fixture. One knowing exception remains, and it is display rather than
verification: `probe_dns.py`'s console summary iterates the legs present in its
own rows, so a leg that produced nothing prints nothing. The published numbers
do not come from that print: `check_report.check_dns_tables` recomputes them,
naming the required German legs explicitly, and an English leg the probe file
lacks drops out of the coverage count that must *equal* the report's declared
one. The console summary is the one place a missing leg is invisible, and
nothing reads it.

**Class 2 — an identity guard blind to multiplicity.** No further instances.
The three other places that compare collections all carry multiplicity already:
`summarize.py` counts trial ids with `.count()`, `judge.parse_verdicts` rejects
duplicates with `len(set(seen)) != len(seen)`, and `run_asr.py` does the same
for manifest clip ids. `score_asr.py`'s cross-arm comparison genuinely uses
`frozenset` and genuinely ignores multiplicity — but the per-cell duplicate
check runs first over the same rows and both feed one `integrity` list, so a
duplicate cannot reach it unreported. `score_slots.py`'s `tool_ok` compares sets
by intent: calling a tool twice is not a scoring failure, only never calling it
is. One residual, written down rather than fixed: `summarize.py` *averages*
multiple judge verdicts for one `(arm, trial, scenario)`, so duplicate verdict
rows are absorbed silently rather than reported. Nothing in the workflow
produces them now that the fixture ids are unique and `parse_verdicts` rejects a
repeat within one reply; it would take hand-concatenated judge files.

**Class 3 — a uniqueness assumption never validated.** Two more found and
fixed: `probe_dns.py` validated neither its `--legs` list (empty, repeated, or
unknown — the last raising `KeyError` after the earlier legs were billed) nor
its manifest's clip ids, though it reads the *same* manifests `run_asr.py`
validates and feeds the WER behind "never enable Azure noise suppression". A
uniqueness assumption checked on one path and trusted on another is the same
gap as one checked nowhere. Elsewhere the assumption is now validated at every
site that makes it: fixture scenario ids (`events.scenario_ids`, four callers),
`--conditions` and manifest clip ids (`run_asr.py`), `ASR_ARMS`/`SC_ARMS`
(`run_all.sh` `nodup`), the declared axes (`events.declared_axis`, used by both scorers),
`summarize.py`), and raw-log targets (`engines.preflight_logs`, which now
refuses two units naming one path instead of trusting callers to have
deduplicated).

## The sweep for silent partial completion

Prompted by `rederive_tools.py` refusing a rewrite and exiting 0. The question
asked of every CLI in `bench/quality/`: **can this skip, refuse, or partly
complete its work and still exit 0?** Three more found, all fixed.

- **`probe_session.py` — the documented pre-flight could not fail.** `probe()`
  deliberately reports failures inside its JSON rather than raising ("a probe
  reports failures, never raises"), and `main` printed each result and exited 0.
  So README step 3 — the gate in front of a paid run — reported every arm
  unreachable and still let `probe_session.py && ./run_all.sh` proceed. It now
  exits non-zero on an exception, on service errors, and on a `--wav` that
  round-trips no transcript, which is the case that flag exists to prove.
- **`probe_dns.py` — an outage was indistinguishable from the finding.** A clip
  that never bound an item id, or never got a transcription event, was written
  as an empty hypothesis — the same row the service produces when deep noise
  suppression *drops* an utterance, which is precisely what this probe measures
  and what "never enable Azure noise suppression" rests on. A lost session
  therefore prints a high empty rate and a high WER: the shape of the published
  result. Rows now carry `error`, and any clip with one aborts, on the same rule
  as check #2a. A leg with no rows at all aborts too.
- **`prepare/prepare_fleurs.py` — a short corpus was written silently.** The
  loop ends at `--n` *or* when the split runs out, and two `continue`s skip
  examples on their way (undecodable audio, duration out of range), so a filter
  slightly too tight yields a quietly smaller manifest and exit 0. Every
  downstream cell inherits that size. `run_asr.py` does refuse a short cell —
  after the calls are paid for, which is the late-refusal shape this file keeps
  moving earlier.

Clean, with the reason each is already covered: `judge.py` (exits on
`failures`), `summarize.py` and `score_asr.py` (gaps/integrity lists, with
`--allow-incomplete` the *declared* escape hatch), `run_asr.py` (#2a),
`run_scenarios.py` (#1), `run_all.sh` (#3), `check_report.py` (problems list),
`score_slots.py` (no skip path — an unknown scenario raises),
`prepare/make_conditions.py` (copies the clean manifest verbatim, so the
conditioned set cannot come out short) and `prepare/render_scenarios.py` (TTS
failures raise).

`test_every_cli_that_collects_failures_exits_on_them` is the mechanical
backstop: any module that appends to a failure list and never reaches
`sys.exit` has collected those failures for nobody. It catches the shape every
instance so far has had, and not the tool that never noticed the failure at
all — which is what the rest of this file is for.

### The sweep missed an instance in a file it had open

The strongest example in this document, so it is worth stating plainly. The
sweep above edited `probe_session.py` to add three failure branches — and left
a fourth collection matching none of them. `probe()` records
`accepted: false` when `session.updated` never arrives; on a bare timeout there
is no `exception` and `errors` is empty, so that result fell past
`if exception / elif errors / elif no transcript` and the pre-flight passed a
session that was never established. **A sweep for "work that can be skipped and
still exit 0" produced an instance of it, in the file it was editing, in the
same commit.**

That is four sweeps now that missed instances of the class they were sweeping
for, which this file opens by naming as the failure mode rather than bad luck.
The lesson is not "look harder": it is that enumerating the failure branches you
thought of leaves the ones you did not, so the branches must **partition** the
result rather than list its known-bad shapes. Ask of the last `elif`: *what is
left over, and is it a pass?* Here the leftover was "connected, said nothing,
no error" — the quietest possible failure, and the only one with no evidence
attached to name it by.

### And the complement of the rule, learned the same round

Turning silence into a non-zero exit is only correct when the thing being
reported is a failure. The same commit made `probe_session.py` probe **every**
arm with `session_asr`, including the two Voice-Live gpt-realtime arms that the
service is *documented* to reject that payload for and that `run_all.sh`
deliberately keeps out of `ASR_ARMS`. The documented pre-flight — README step 3,
run without `--arms` — therefore failed deterministically on arms that are
perfectly valid for Track B.

**A false alarm in a pre-flight is not a safer failure than a silent pass; it is
the failure that gets the check disabled.** "Say it in the exit status" needs its
complement: *say it only when it is true.* The fix is the declared-expectation
rule again — `Arm.asr_manual_commit` states which arms can run Track A, so the
probe sends each arm a payload it is meant to accept instead of discovering a
documented refusal by provoking it.

## Adding a check

State it in the table above *before* writing it, in the form "compares X against
Y". If you cannot name Y, there is no check — there is a value being read.
