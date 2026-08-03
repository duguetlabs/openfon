# Completeness inventory — realtime latency harness

Every place this harness decides **"this turn counts / this control held / this
figure is current"** — what each check compares, and how it can be fooled.

Companion to [`bench/quality/COMPLETENESS.md`](../quality/COMPLETENESS.md),
whose rule this file adopts:

> **Every check must compare what it got against what it expected, by identity
> rather than by count. Absence is never a pass.**

The reason for a second copy is worth stating. The two harnesses were built
independently, each learned "verify the document against generated data", and
**each implemented it with a parser that silently dropped what it did not
recognise** — the quality harness with a compound `TTFA p50 / p95` row, this one
with metric-prefixed rows like ``| `connect_ms`, `vl-gateway` − `vl-direct` |``.
Twelve rows here went unchecked, including the entire table of results that
survive correction, and the checker reported OK throughout. The lesson
transferred between harnesses; the failure mode transferred with it. Expect to
reintroduce it rather than to have designed it out.

**And it recurred twice more after that was written, which is the part worth
reading.** Fixing the metric-prefixed layout produced a parser that recognised
*two* layouts and still dropped everything else: split-rate rows joined by `vs`
rather than a dash, and column-oriented tables naming their arms in the header
rather than in the row. Three rounds, three layouts, each invisible, each found
by a reviewer reading the parser rather than by the parser failing. A report
containing only unrecognised rows exited **successfully with zero rows checked**.

The fix that finally held is not a third pattern. It is a change of unit:

> **The table is the unit, not the row.** If anything in a table names an arm,
> every figure-bearing row in it must be accounted for — verified, or
> allowlisted with a reason. An unrecognised row is a reported problem.

Recognising layouts is open-ended and fails silently; accounting for rows is
closed and fails loudly. Coverage went from **19 rows to 107** the moment the
question changed from "does this row match a pattern I know" to "is this row
accounted for". The twelve previously-invisible rows all matched; the eighty-eight
newly visible ones held **two drifts**, both in tables nobody had been checking
since publication — a Holm-adjusted p published from a family of 31 where the
current analyzer's is 36, and the one below.

**A second lesson, about evidence rather than parsing.** The same checker read
every file under `results/`, merged them, and accepted a row if *any* of them
reproduced it. That meant a **superseded** run could validate a current section:
the pre-marker `vltier-ttfa` block and its replacement `vltier2-ttfa` contain the
same arms, so re-introducing a retracted figure still passed. A guard against
stale numbers that accepts the stale numbers is worse than no guard, because it
is quoted as evidence. Evidence is now named: `published/` is committed and is the
published study, `results/` is scratch, and each table declares its run in the
document (`<!-- data: vltier2-ttfa -->`) directly above it. A table with no
binding fails; a binding naming an absent run fails.

**That was not hypothetical.** The 2.1 report's recommendation table — the first
table in the document — still carried the superseded block's end-of-turn row,
731 / 732 / 725, a page below the banner announcing that block was superseded.
The replacement run says 733 / 731 / 717. No conclusion moved, which is the
point: the retraction was written, published, and applied everywhere a reader
would look for it, and the number survived anyway in the table readers actually
act on. **A retraction is not self-applying.** Only a check that knows *which*
run a table quotes could have found it, and the checker that merged everything
would have confirmed it as verified.

A third rule follows from the same place, and closes the other direction: **a run
that no table quotes does not belong in `published/`.** Nothing reading it today
is not a reason to keep it, because "nothing reads it" is one edit away from
"something reads it again". Two runs were caught by that rule when it was added;
one earned a table, the other was removed.

---

## The checks

| # | Where | Decides | Compares | Fooled by |
|---|---|---|---|---|
| 1 | `bench.py` config gate | did this turn run under the requested settings | the echoed `session.updated` against the request, **field by field, derived from the payload** rather than a hardcoded list; fatal divergence **aborts the turn** | nothing known. A hardcoded field list was the bug: `eagerness`, added later, went unverified while the follow-up attributed its results to that setting. |
| 2 | `arms.verify_echo` audio contract | is the audio contract intact | codec *and* rate, both directions, both dialects; **absent or unparseable is fatal**, not skipped | nothing known. Checking the rate but not the codec was the bug: `audio_out_ms` is a byte count assuming PCM16 @ 24 kHz, so a substituted codec would have corrupted every reply-length figure while looking plausible. |
| 3 | `bench.py` response status | is this a measurement | `response.done` with `status == "completed"`; anything else records the status as an error | nothing known. Accepting any `response.done` was the bug: a truncated reply entered `response_total_ms` and the paired statistics. |
| 4 | `bench.py` fragment accounting | was a split audible | audio bytes for the **whole in-flight response**, spanning the speech-end boundary | nothing known. Two counters split at that boundary was the bug: a fragment cancelled after speech ended was checked against post-boundary bytes only and could read as silent. |
| 5 | `bench.py` transcript correlation | does this transcript describe this turn | the completion's `item_id` against items committed **after** speech ended; one predicate shared by the main loop and the grace window | nothing known. Fixing only the main loop was the bug — the grace path kept the old behaviour. |
| 6 | `analyze.usable_for` | may this turn contribute to this metric | the turn's `invalid_metrics`, arm-aware: STT is observational on a native brain and **load-bearing on a cascade**, where it invalidates everything downstream | nothing known. A single global mapping was the bug in waiting: it would have mis-scoped the first time a cascade arm diverged. |
| 7 | `analyze.split_cells` | is this split-rate cell real | complete matched cells where **both** turns produced a usable measurement | nothing known. Counting all turns was the bug: a turn that died in connect has `false_starts = 0` by default and read as a clean non-split, manufacturing significance out of failures. |
| 8 | `analyze.compute_paired` | which comparisons enter the correction | every comparison **with data**, including those that turned out to have no splits | nothing known. Dropping zero-split comparisons first was the bug: the family size then depended on the outcomes, which is choosing what to correct over based on results. |
| 9 | `PairedResult.equivalent` | may equivalence be claimed | the **whole interval** inside ±`PRACTICAL_MS`, and n ≥ `MIN_EQUIVALENCE_N` | nothing known. The point estimate alone was the bug, and n=1 resampling returns `[d, d]` — the documented smoke test would have "proved" equivalence from one sample. |
| 10 | `PairedResult.upper_tail_dominates` | is a large p90 a cost or variance | p10 against p90 — **magnitude**, plus the sign counts reported alongside | it describes; it does not diagnose. Two quantiles cannot establish bimodality, and an earlier version asserted it. It also cannot tell frequency: the cost case was faster on 35% of turns, and "almost never faster" was wrong. |
| 11 | `verify_live.py` | does the config verifier still match reality | every **registered** arm's real echo verifies clean, **and** four mutations of that echo are each caught | a hand-maintained arm list was the bug — it printed OK while checking none of the newest arms. A fatal first echo now retries, and the **clean** echo is adopted before mutations run. |
| 12 | `check_report_tables.py` | is every published figure current | **every figure-bearing row of every table that names an arm** — row-major or column-major, dash or `vs`, prefixed or not — against the analyzer, re-derived from the run that table declares. Coverage compared by **equality** against a count declared in the checker | free prose, deliberately: a figure not in a table beside an arm is not matched. Everything else is verified or in `UNCHECKABLE_TABLES` with a reason, and no entry may name something the analyzer computes. |
| 12b | `check_report_tables.py` bindings | which data may validate this table | the `<!-- data: … -->` directive **in the document**, resolved against committed `published/`; a table with no binding, or one naming an absent run, is reported, and a run no table quotes is reported too | a row quoting two runs is bound to both, so a run-1 figure in a run-2 column would pass. Merging every file under `results/` was the bug it replaced: a superseded run validated a section written from its replacement, and did. |
| 12c | `test_harness.py` mutation sweep | can the checker be fooled by a document it never read | **every** figure the checker reports as verified, altered one at a time; each alteration must be caught | nothing known. This is the test that a checker passing on absent, unbound or unparsed data cannot survive. |
| 13 | `safety.py` | can a credential leave the process | every string through `safe_print` or `scrub_record`, at the **process boundary** | per-call-site redaction was the bug: it was fixed in `bench.py` and a later script reintroduced the leak simply by printing an exception. |

## Known limitations, documented rather than fixed

- **The gateway's session-update injection race is detected, not prevented.** It
  substitutes the STT model, and sometimes `turn_detection`, on roughly one
  session in eight. Turns where it wins are rejected (#1), so the benchmark is
  clean — but production has no such read-back, and any default set through the
  gateway will intermittently not take effect.
- **`v21` latency blocks predate the per-cell marker fix.** Treatment and
  control received different random system-prompt tokens. The tier block was
  rerun for this reason; the `v21` blocks were not, and are marked where they
  appear. Split rates are unaffected — the marker is in the system prompt and
  splitting is the detector acting on byte-identical caller audio.
- **The Voice Live model→tier price mapping is unverified.** Meters are named by
  service tier, not by model, so the proposed tier costs $0.020/min if Std and
  $0.062 if Pro. Both are published; neither is asserted.
- **Figures in free prose are not checked**, nor are tables that name no arm at
  all — the run-1/run-2 summary at the top of the merged report is covered only
  because two comparisons are declared in `PROSE_PAIRS` by name. A sentence
  quoting a millisecond value in the body text can still go stale. Stated rather
  than papered over: the same gap is documented in the quality harness, and it is
  how "all seven arms" reached a report one commit after its checker landed.
- **A column-oriented paired Δ that does not name its control is checked against
  any comparison where that column's arm is the treatment.** The report's
  convention is that each arm is compared with its own baseline, and the row
  gives no way to know which; naming the control in the row label — as the
  `config_ms` row does — narrows it to the one pair.
- **A row is checked against its table's declared run, not its own.** A row that
  legitimately quotes two runs — the merged report's headline table carries a
  run-1 column — is bound to both, and a figure from either satisfies it. Binding
  at row granularity would catch a run-1 value pasted into a run-2 column; this
  does not.
- **One vantage point.** All measurements are from a laptop in Austria, where
  the Cloudflare edge is 30 ms away and Azure swedencentral 61 ms. Pairing
  cancels drift, not path length. A Worker-side run would settle it.

## Adding a check

State it in the table above *before* writing it, in the form "compares X against
Y". If you cannot name Y, there is no check — there is a value being read.
