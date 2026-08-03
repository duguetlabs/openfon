"""Tests for the pure statistics behind every table in the report.

The network path is not worth unit-testing, but these are: a wrong percentile
or a mispaired difference would silently corrupt the numbers we publish and
look entirely plausible while doing it.

  python3 -m unittest discover -s bench/realtime -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from analyze import (ALPHA, MIN_EQUIVALENCE_N, PRACTICAL_MS,  # noqa: E402
                     TAIL_FLOOR_MS, PairedResult, usable_for,
                     bootstrap_median_ci, compute_paired, describe,
                     holm, mcnemar_exact_p, paired, pct, sign_test_p,
                     split_cells, split_rate_table)
from arms import ARMS_BY_ID, invalidated_metrics  # noqa: E402
from bench import redact  # noqa: E402


def result(median, p_raw, p_adj, metric="ttfa_ms", lo=None, hi=None, n=None,
           diffs=None):
    n = MIN_EQUIVALENCE_N if n is None else n
    return PairedResult(metric=metric, treat="gw", ctrl="direct", question="q",
                        diffs=diffs if diffs is not None else [median] * n,
                        median=median,
                        lo=median - 10 if lo is None else lo,
                        hi=median + 10 if hi is None else hi,
                        p_raw=p_raw, p_adj=p_adj)


def turn(rnd, arm, utt, **metrics):
    base = {"round": rnd, "arm": arm, "utterance": utt, "ok": True,
            "ttfa_ms": None, "error": "", "false_starts": 0}
    base.update(metrics)
    return base


class TestPct(unittest.TestCase):
    def test_nearest_rank_endpoints(self):
        xs = [10, 20, 30, 40, 50]
        self.assertEqual(pct(xs, 100), 50)
        self.assertEqual(pct(xs, 1), 10)

    def test_nearest_rank_matches_definition(self):
        # nearest-rank: index = ceil(p/100 * n) - 1
        xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        self.assertEqual(pct(xs, 50), 5)     # ceil(5)-1 = 4 -> 5
        self.assertEqual(pct(xs, 90), 9)     # ceil(9)-1 = 8 -> 9
        self.assertEqual(pct(xs, 99), 10)    # ceil(9.9)-1 = 9 -> 10

    def test_unsorted_input_is_sorted_first(self):
        self.assertEqual(pct([50, 10, 30, 20, 40], 100), 50)
        self.assertEqual(pct([50, 10, 30, 20, 40], 20), 10)

    def test_single_element(self):
        self.assertEqual(pct([7], 50), 7)
        self.assertEqual(pct([7], 99), 7)

    def test_empty_is_nan_not_crash(self):
        self.assertNotEqual(pct([], 50), pct([], 50))   # NaN != NaN

    def test_never_indexes_out_of_range(self):
        for n in range(1, 40):
            xs = list(range(n))
            for p in (0.1, 1, 25, 50, 90, 99, 99.9, 100):
                self.assertIn(pct(xs, p), xs)


class TestDescribe(unittest.TestCase):
    def test_iqr_is_q3_minus_q1(self):
        d = describe([1, 2, 3, 4, 5, 6, 7, 8])
        self.assertEqual(d["iqr"], d["q3"] - d["q1"])
        self.assertEqual(d["n"], 8)
        self.assertEqual(d["min"], 1)
        self.assertEqual(d["max"], 8)

    def test_empty(self):
        self.assertEqual(describe([]), {})


class TestPaired(unittest.TestCase):
    def test_difference_is_treatment_minus_control(self):
        turns = [turn(0, "gw", "en", ttfa_ms=1100),
                 turn(0, "direct", "en", ttfa_ms=1000)]
        self.assertEqual(paired(turns, "gw", "direct", "ttfa_ms"), [100])

    def test_pairs_only_within_the_same_round_and_utterance(self):
        # same round, different utterance -> not a pair; same utterance,
        # different round -> not a pair either
        turns = [turn(0, "gw", "en", ttfa_ms=1100),
                 turn(0, "direct", "de", ttfa_ms=1000),
                 turn(1, "direct", "en", ttfa_ms=900)]
        self.assertEqual(paired(turns, "gw", "direct", "ttfa_ms"), [])

    def test_unpaired_and_failed_cells_are_dropped(self):
        turns = [turn(0, "gw", "en", ttfa_ms=1100),          # no control
                 turn(1, "gw", "en", ttfa_ms=1200),
                 turn(1, "direct", "en", ttfa_ms=1000),      # complete pair
                 turn(2, "gw", "en", ttfa_ms=1300),
                 turn(2, "direct", "en", ttfa_ms=None)]      # metric missing
        self.assertEqual(paired(turns, "gw", "direct", "ttfa_ms"), [200])

    def test_failed_turns_excluded(self):
        bad = turn(0, "direct", "en", ttfa_ms=1000)
        bad["ok"] = False
        turns = [turn(0, "gw", "en", ttfa_ms=1100), bad]
        self.assertEqual(paired(turns, "gw", "direct", "ttfa_ms"), [])

    def test_other_arms_are_ignored(self):
        turns = [turn(0, "gw", "en", ttfa_ms=1100),
                 turn(0, "direct", "en", ttfa_ms=1000),
                 turn(0, "third", "en", ttfa_ms=5000)]
        self.assertEqual(paired(turns, "gw", "direct", "ttfa_ms"), [100])


class TestSignTest(unittest.TestCase):
    def test_no_differences_is_p_one(self):
        self.assertEqual(sign_test_p([]), 1.0)
        self.assertEqual(sign_test_p([0, 0, 0]), 1.0)

    def test_all_one_sided_matches_exact_binomial(self):
        # 5 positives, 0 negatives -> 2 * (1/2)^5 = 0.0625
        self.assertAlmostEqual(sign_test_p([1, 2, 3, 4, 5]), 0.0625)
        # sign only, magnitude irrelevant
        self.assertAlmostEqual(sign_test_p([9, 9, 9, 9, 9]), 0.0625)

    def test_direction_does_not_matter(self):
        self.assertAlmostEqual(sign_test_p([1, 2, 3, 4, 5]),
                               sign_test_p([-1, -2, -3, -4, -5]))

    def test_balanced_is_p_one(self):
        self.assertAlmostEqual(sign_test_p([1, -1, 2, -2]), 1.0)

    def test_ties_are_dropped_not_counted(self):
        # zeros must not dilute the result
        self.assertAlmostEqual(sign_test_p([1, 2, 3, 4, 5, 0, 0, 0]),
                               sign_test_p([1, 2, 3, 4, 5]))

    def test_p_never_exceeds_one(self):
        for diffs in ([1, -1], [1, 1, -1, -1], [1, -1, -1], [5, -3, 2, -4]):
            self.assertLessEqual(sign_test_p(diffs), 1.0)

    def test_large_one_sided_sample_is_significant(self):
        self.assertLess(sign_test_p([1] * 20), 0.001)


class TestBootstrapCI(unittest.TestCase):
    def test_is_deterministic_for_a_fixed_seed(self):
        diffs = [3, -1, 4, 1, -5, 9, 2, 6, -5, 3]
        self.assertEqual(bootstrap_median_ci(diffs, iters=2000),
                         bootstrap_median_ci(diffs, iters=2000))

    def test_brackets_the_sample_median(self):
        diffs = [10, 12, 11, 13, 9, 10, 11, 12, 10, 11]
        lo, hi = bootstrap_median_ci(diffs, iters=4000)
        self.assertLessEqual(lo, 11)
        self.assertLessEqual(11, hi)

    def test_ci_lies_within_the_data_range(self):
        diffs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        lo, hi = bootstrap_median_ci(diffs, iters=4000)
        self.assertGreaterEqual(lo, min(diffs))
        self.assertLessEqual(hi, max(diffs))

    def test_constant_data_gives_a_degenerate_ci(self):
        self.assertEqual(bootstrap_median_ci([5] * 10, iters=1000), (5, 5))

    def test_empty_is_nan_not_crash(self):
        lo, hi = bootstrap_median_ci([])
        self.assertNotEqual(lo, lo)
        self.assertNotEqual(hi, hi)

    def test_tighter_data_gives_a_tighter_interval(self):
        tight = bootstrap_median_ci([10, 10, 11, 10, 11, 10, 10, 11], iters=4000)
        wide = bootstrap_median_ci([-90, 10, 110, -40, 60, 10, -70, 90], iters=4000)
        self.assertLess(tight[1] - tight[0], wide[1] - wide[0])


class TestHolm(unittest.TestCase):
    def test_single_test_is_unchanged(self):
        self.assertAlmostEqual(holm([0.04])[0], 0.04)

    def test_smallest_is_scaled_by_m(self):
        # 3 tests: smallest p scaled by 3
        self.assertAlmostEqual(holm([0.01, 0.5, 0.6])[0], 0.03)

    def test_step_down_scaling_by_rank(self):
        # ranks 0,1,2 -> multipliers 3,2,1
        adj = holm([0.01, 0.02, 0.03])
        self.assertAlmostEqual(adj[0], 0.03)   # 3 * 0.01
        self.assertAlmostEqual(adj[1], 0.04)   # 2 * 0.02
        self.assertAlmostEqual(adj[2], 0.04)   # 1 * 0.03, raised to stay monotone

    def test_enforces_monotonicity(self):
        adj = holm([0.01, 0.02, 0.03])
        self.assertEqual(adj, sorted(adj))

    def test_order_is_preserved(self):
        # the largest raw p is in position 0 and must stay there
        adj = holm([0.6, 0.01, 0.5])
        self.assertAlmostEqual(adj[1], 0.03)
        self.assertGreater(adj[0], adj[1])

    def test_capped_at_one(self):
        for a in holm([0.5, 0.6, 0.7, 0.9]):
            self.assertLessEqual(a, 1.0)

    def test_never_smaller_than_raw(self):
        raw = [0.001, 0.02, 0.04, 0.3, 0.9]
        for r, a in zip(raw, holm(raw)):
            self.assertGreaterEqual(a, r)

    def test_is_less_conservative_than_bonferroni(self):
        raw = [0.001, 0.02, 0.03]
        adj = holm(raw)
        bonf = [min(1.0, p * len(raw)) for p in raw]
        self.assertTrue(any(a < b for a, b in zip(adj, bonf)))

    def test_strong_result_still_survives_a_large_family(self):
        raw = [0.0001] + [0.8] * 20
        self.assertLess(holm(raw)[0], ALPHA)

    def test_borderline_result_does_not_survive_a_large_family(self):
        raw = [0.043] + [0.8] * 20
        self.assertGreater(holm(raw)[0], ALPHA)

    def test_empty(self):
        self.assertEqual(holm([]), [])


class TestVerdictGating(unittest.TestCase):
    """A directional claim needs BOTH a corrected p-value and a real effect."""

    def test_large_effect_surviving_correction_is_directional(self):
        r = result(-145, 0.000, 0.000)
        self.assertTrue(r.survives)
        self.assertIn("faster by 145 ms", r.verdict())

    def test_sign_is_reported_correctly(self):
        self.assertIn("slower", result(+145, 0.0, 0.0).verdict())
        self.assertIn("faster", result(-145, 0.0, 0.0).verdict())

    def test_borderline_p_is_not_minted_into_a_verdict(self):
        # the vl-native-brain ttfa case: real effect, p survives raw but not Holm
        r = result(-93, 0.043, 0.909)
        self.assertFalse(r.survives)
        self.assertIn("borderline", r.verdict())
        self.assertIn("not robust to Holm", r.verdict())

    def test_tiny_effect_is_not_minted_even_when_significant(self):
        # the config_ms case: p<0.05 raw, but 6 ms is noise. With a tight CI
        # this is a genuine equivalence claim, not merely a failure to detect.
        r = result(+6, 0.043, 0.909, lo=1, hi=43)
        self.assertFalse(r.survives)
        self.assertIn("equivalent within", r.verdict())

    def test_tiny_effect_surviving_correction_is_still_not_directional(self):
        # p can survive Holm and the effect still be too small to matter
        r = result(+46, 0.001, 0.017, lo=19, hi=83)
        self.assertLess(r.p_adj, ALPHA)
        self.assertFalse(r.survives)
        self.assertIn("below the", r.verdict())

    def test_practical_floor_boundary(self):
        self.assertFalse(result(PRACTICAL_MS - 0.1, 0.0, 0.0).practical)
        self.assertTrue(result(PRACTICAL_MS, 0.0, 0.0).practical)
        self.assertTrue(result(-PRACTICAL_MS, 0.0, 0.0).practical)

    def test_plain_null_states_the_bound_the_data_gives(self):
        """A bare "no detectable difference" hides how weak the evidence is;
        the verdict has to carry the interval."""
        v = result(-200, 0.7, 1.0, lo=-500, hi=100).verdict()
        self.assertIn("no detectable difference", v)
        self.assertIn("admits up to 500 ms", v)


class TestEquivalence(unittest.TestCase):
    """Equivalence is a claim about what the data RULES OUT, so it cannot be
    made from the point estimate alone."""

    def test_wide_ci_around_a_small_median_is_not_equivalence(self):
        # the shipped Voice Live proxy result: median -19, CI [-122, +60]
        r = result(-19, 1.0, 1.0, lo=-122, hi=60)
        self.assertFalse(r.equivalent)
        self.assertNotIn("no practical difference", r.verdict())
        self.assertIn("admits up to 122 ms", r.verdict())

    def test_tight_ci_inside_the_bounds_is_equivalence(self):
        r = result(+6, 1.0, 1.0, lo=-20, hi=30)
        self.assertTrue(r.equivalent)
        self.assertIn("equivalent within", r.verdict())

    def test_ci_touching_the_bound_is_not_equivalence(self):
        self.assertFalse(result(0, 1.0, 1.0, lo=-PRACTICAL_MS, hi=10).equivalent)
        self.assertFalse(result(0, 1.0, 1.0, lo=-10, hi=PRACTICAL_MS).equivalent)

    def test_bound_is_the_larger_side_of_the_interval(self):
        self.assertAlmostEqual(result(-19, 1.0, 1.0, lo=-122, hi=60).bound_ms, 122)
        self.assertAlmostEqual(result(+19, 1.0, 1.0, lo=-40, hi=200).bound_ms, 200)

    def test_nan_ci_is_never_equivalence(self):
        nan = float("nan")
        r = result(0, 1.0, 1.0, lo=nan, hi=nan)
        self.assertFalse(r.equivalent)

    def test_significant_but_tiny_reads_as_below_the_floor(self):
        # +46 ms surviving Holm: real, reproducible, and irrelevant to a caller
        r = result(+46, 0.001, 0.017, lo=19, hi=83)
        self.assertFalse(r.survives)
        self.assertIn("below the", r.verdict())

    def test_directional_verdict_still_requires_both_gates(self):
        r = result(-145, 0.0, 0.0, lo=-249, hi=-84)
        self.assertTrue(r.survives)
        self.assertIn("faster by 145 ms", r.verdict())


class TestComputePaired(unittest.TestCase):
    def test_correction_family_spans_all_metrics(self):
        # one pair per metric, so the family size is what drives the scaling
        turns = []
        for rnd in range(6):
            turns.append(turn(rnd, "native-gateway", "en",
                              ttfa_ms=1000 + rnd, connect_ms=500 + rnd))
            turns.append(turn(rnd, "native-direct", "en",
                              ttfa_ms=900 + rnd, connect_ms=400 + rnd))
        res = compute_paired(turns, ["ttfa_ms", "connect_ms"])
        self.assertEqual(set(res), {"ttfa_ms", "connect_ms"})
        flat = [r for v in res.values() for r in v]
        # both metrics give a perfectly one-sided result: raw p = 2*(1/2)^6
        for r in flat:
            self.assertAlmostEqual(r.p_raw, 0.03125)
            # scaled across the family of 2, not treated in isolation
            self.assertGreater(r.p_adj, r.p_raw)

    def test_metrics_with_no_pairs_are_omitted(self):
        turns = [turn(0, "native-gateway", "en", ttfa_ms=1000),
                 turn(0, "native-direct", "en", ttfa_ms=900)]
        res = compute_paired(turns, ["ttfa_ms", "connect_ms"])
        self.assertIn("ttfa_ms", res)
        self.assertNotIn("connect_ms", res)


class TestMcNemar(unittest.TestCase):
    """The split-rate data is MATCHED — same caller audio, same round — so
    Fisher's exact would discard the pairing and overstate significance."""

    def test_no_discordant_pairs_is_p_one(self):
        self.assertEqual(mcnemar_exact_p(0, 0), 1.0)

    def test_ten_discordant_one_way_matches_exact_binomial(self):
        # 2 * (1/2)^10 = 0.001953125 — NOT the ~1e-5 Fisher would report
        self.assertAlmostEqual(mcnemar_exact_p(0, 10), 0.001953125)
        self.assertAlmostEqual(mcnemar_exact_p(10, 0), 0.001953125)

    def test_six_discordant_one_way(self):
        # the main run's de-short cells: 2 * (1/2)^6
        self.assertAlmostEqual(mcnemar_exact_p(6, 0), 0.03125)

    def test_balanced_discordance_is_p_one(self):
        self.assertAlmostEqual(mcnemar_exact_p(5, 5), 1.0)

    def test_concordant_pairs_do_not_enter(self):
        # only discordant counts are arguments, so 100 concordant pairs
        # cannot manufacture significance
        self.assertAlmostEqual(mcnemar_exact_p(3, 0), 0.25)

    def test_is_more_conservative_than_the_unpaired_view(self):
        # 10 vs 0 discordant: McNemar 0.00195 is far larger than Fisher's ~1e-5
        self.assertGreater(mcnemar_exact_p(0, 10), 1e-4)

    def test_never_exceeds_one(self):
        for b, c in [(1, 1), (2, 3), (0, 1), (7, 6)]:
            self.assertLessEqual(mcnemar_exact_p(b, c), 1.0)


class TestSplitCells(unittest.TestCase):
    def test_pairs_by_round_and_utterance(self):
        turns = [turn(0, "a", "de", ttfa_ms=1, false_starts=1),
                 turn(0, "b", "de", ttfa_ms=1, false_starts=0)]
        self.assertEqual(split_cells(turns, "a", "b"), [(True, False)])

    def test_failed_turns_are_excluded_not_counted_as_clean(self):
        """The bug this guards: a turn that died in connect has ok=False and
        the default false_starts=0, and counting it as a clean non-split
        manufactures significance out of failures."""
        dead = turn(0, "b", "de", ttfa_ms=None, false_starts=0)
        dead["ok"] = False
        turns = [turn(0, "a", "de", ttfa_ms=1, false_starts=1), dead]
        self.assertEqual(split_cells(turns, "a", "b"), [])

    def test_incomplete_cells_are_dropped(self):
        turns = [turn(0, "a", "de", ttfa_ms=1, false_starts=1),
                 turn(1, "b", "de", ttfa_ms=1, false_starts=0)]
        self.assertEqual(split_cells(turns, "a", "b"), [])

    def test_multiple_false_starts_still_count_once(self):
        turns = [turn(0, "a", "de", ttfa_ms=1, false_starts=3),
                 turn(0, "b", "de", ttfa_ms=1, false_starts=0)]
        self.assertEqual(split_cells(turns, "a", "b"), [(True, False)])


class TestSplitRateTable(unittest.TestCase):
    def _turns(self, treat_splits, ctrl_splits, n=10, treat_ok=True):
        out = []
        for i in range(n):
            t = turn(i, "nat-semantic", "de-short", ttfa_ms=1,
                     false_starts=1 if i < treat_splits else 0)
            t["ok"] = treat_ok
            out.append(t)
            out.append(turn(i, "native-direct", "de-short", ttfa_ms=1,
                            false_starts=1 if i < ctrl_splits else 0))
        return out

    def test_reports_a_pair_with_splits(self):
        body = "\n".join(split_rate_table(self._turns(0, 10)))
        self.assertIn("0/10", body)
        self.assertIn("10/10", body)
        self.assertIn("0.00195", body)          # McNemar, not Fisher's 1e-5

    def test_omitted_when_nothing_split(self):
        self.assertEqual(split_rate_table(self._turns(0, 0)), [])

    def test_failed_treatment_turns_do_not_manufacture_a_result(self):
        # every treatment turn failed; there are no complete cells at all
        self.assertEqual(split_rate_table(self._turns(0, 10, treat_ok=False)), [])

    def test_only_pairs_present_in_the_data(self):
        turns = [turn(i, "nat-semantic", "de-short", ttfa_ms=1, false_starts=1)
                 for i in range(5)]
        self.assertEqual(split_rate_table(turns), [])


class TestRedact(unittest.TestCase):
    """Results files must never carry a credential — the gateway takes its key
    in the query string and libraries put the URI into exception text."""

    def test_removes_gateway_token(self):
        s = redact("connect: InvalidStatus: wss://api.kataleptic.com/v1/realtime"
                   "?model=gpt-realtime-2&token=dg_abc123SECRET rejected")
        self.assertNotIn("dg_abc123SECRET", s)
        self.assertIn("token=<redacted>", s)

    def test_removes_api_key_variants(self):
        for q in ("api-key=SEKRIT", "api_key=SEKRIT", "apikey=SEKRIT",
                  "API-KEY=SEKRIT"):
            out = redact(f"wss://host/path?model=x&{q}")
            self.assertNotIn("SEKRIT", out, q)

    def test_preserves_surrounding_query_parameters(self):
        out = redact("wss://h/p?model=gpt-realtime-2&token=SEKRIT&engine=azure")
        self.assertNotIn("SEKRIT", out)
        self.assertIn("model=gpt-realtime-2", out)
        self.assertIn("engine=azure", out)

    def test_stops_at_quotes_and_whitespace(self):
        out = redact("tried 'wss://h/p?token=SEKRIT' then gave up")
        self.assertNotIn("SEKRIT", out)
        self.assertIn("then gave up", out)

    def test_leaves_clean_text_alone(self):
        clean = "timeout waiting for response.done"
        self.assertEqual(redact(clean), clean)

    def test_accepts_non_strings(self):
        self.assertEqual(redact(ValueError("boom")), "boom")


if __name__ == "__main__":
    unittest.main()


class TestEquivalenceNeedsEnoughData(unittest.TestCase):
    """Resampling one paired difference always returns [d, d], so without a
    floor n=1 would "prove" equivalence from a single sample — and --rounds 1
    is the documented smoke test."""

    def test_single_observation_cannot_claim_equivalence(self):
        r = result(+5, 1.0, 1.0, lo=5, hi=5, n=1)
        self.assertFalse(r.equivalent)
        self.assertIn("too small to claim equivalence", r.verdict())

    def test_just_below_the_floor_cannot_claim_equivalence(self):
        r = result(+5, 1.0, 1.0, lo=-10, hi=20, n=MIN_EQUIVALENCE_N - 1)
        self.assertFalse(r.equivalent)

    def test_at_the_floor_equivalence_is_available(self):
        r = result(+5, 1.0, 1.0, lo=-10, hi=20, n=MIN_EQUIVALENCE_N)
        self.assertTrue(r.equivalent)
        self.assertIn("equivalent within", r.verdict())

    def test_small_n_still_reports_the_null(self):
        self.assertIn("no detectable difference",
                      result(+5, 1.0, 1.0, lo=5, hi=5, n=2).verdict())


class TestSplitFamilyIsOutcomeIndependent(unittest.TestCase):
    """Dropping zero-split comparisons before correcting would make the family
    size depend on the results — choosing which hypotheses to correct over
    based on their outcomes is the error we started this review with."""

    def _cells(self, rnd_from, arm_a, a_split, arm_b, b_split, n=10):
        out = []
        for i in range(rnd_from, rnd_from + n):
            out.append(turn(i, arm_a, "de-short", ttfa_ms=1,
                            false_starts=1 if a_split else 0))
            out.append(turn(i, arm_b, "de-short", ttfa_ms=1,
                            false_starts=1 if b_split else 0))
        return out

    def test_zero_split_comparison_still_enlarges_the_family(self):
        # one discordant comparison + one all-zero comparison = family of 2,
        # so the significant p is scaled by 2, not left alone
        turns = (self._cells(0, "nat-semantic", False, "native-direct", True)
                 + self._cells(0, "vlmini-azsemantic", False, "vl-direct", False))
        body = "\n".join(split_rate_table(turns))
        self.assertIn("0.00391", body)          # 2 x 0.001953
        self.assertIn("corrected over but not shown", body)

    def test_zero_split_rows_are_hidden_from_the_table(self):
        turns = (self._cells(0, "nat-semantic", False, "native-direct", True)
                 + self._cells(0, "vlmini-azsemantic", False, "vl-direct", False))
        body = "\n".join(split_rate_table(turns))
        self.assertNotIn("`vlmini-azsemantic` vs `vl-direct`", body)

    def test_table_omitted_entirely_when_nothing_split_anywhere(self):
        turns = self._cells(0, "vlmini-azsemantic", False, "vl-direct", False)
        self.assertEqual(split_rate_table(turns), [])


class TestConfirmedDifferentConfigIsExcluded(unittest.TestCase):
    """An unconfirmable control aborts the turn; a control confirmed DIFFERENT
    is strictly worse and must not be treated more leniently. It invalidates
    the metrics that depend on it — not the whole turn, since the headline does
    not depend on the STT path."""

    STT = ["transcription.model='whisper' (asked 'whisper-1')"]
    VOICE = ["voice='alloy' (asked 'marin')"]

    def test_stt_is_observational_on_a_native_speech_to_speech_arm(self):
        """The model hears the audio directly, so transcription only observes."""
        self.assertEqual(invalidated_metrics(self.STT, cascade=False),
                         ("transcript_ms",))

    def test_stt_is_load_bearing_on_a_cascade_arm(self):
        """Its text is what the language model reads, so a substitution moves
        everything downstream — same field, a pipeline stage rather than an
        observer."""
        bad = invalidated_metrics(self.STT, cascade=True)
        for m in ("transcript_ms", "ttft_ms", "ttfa_ms", "response_total_ms",
                  "audio_out_ms"):
            self.assertIn(m, bad)

    def test_cascade_flag_follows_the_brain(self):
        self.assertTrue(ARMS_BY_ID["vl-direct"].is_cascade)
        self.assertTrue(ARMS_BY_ID["vl-gateway"].is_cascade)
        self.assertFalse(ARMS_BY_ID["native-direct"].is_cascade)
        self.assertFalse(ARMS_BY_ID["vl-native-brain"].is_cascade)  # VL stack, S2S brain

    def test_analyzer_infers_cascade_from_the_arm_for_old_datasets(self):
        t = turn(0, "vl-gateway", "en", ttfa_ms=1800, config_warnings=self.STT)
        t.pop("invalid_metrics", None)
        self.assertFalse(usable_for(t, "ttfa_ms"))      # cascade: load-bearing
        t2 = turn(0, "native-gateway", "en", ttfa_ms=1800, config_warnings=self.STT)
        t2.pop("invalid_metrics", None)
        self.assertTrue(usable_for(t2, "ttfa_ms"))      # native: observational

    def test_stt_substitution_excludes_only_the_transcript_metric(self):
        t = turn(0, "gw", "en", transcript_ms=100, ttfa_ms=2000,
                 invalid_metrics=["transcript_ms"])
        self.assertFalse(usable_for(t, "transcript_ms"))
        self.assertTrue(usable_for(t, "ttfa_ms"))     # headline unaffected

    def test_voice_substitution_excludes_synthesis_dependent_metrics(self):
        bad = list(invalidated_metrics(self.VOICE))
        t = turn(0, "gw", "en", ttfa_ms=2000, response_total_ms=5000,
                 speech_stopped_ms=740, invalid_metrics=bad)
        self.assertFalse(usable_for(t, "ttfa_ms"))
        self.assertFalse(usable_for(t, "response_total_ms"))
        self.assertTrue(usable_for(t, "speech_stopped_ms"))   # not synthesis

    def test_old_datasets_are_classified_from_the_warning_text(self):
        """Datasets written before invalid_metrics existed still get excluded,
        through the same classifier the harness uses."""
        t = turn(0, "gw", "en", transcript_ms=100, config_warnings=self.STT)
        t.pop("invalid_metrics", None)
        self.assertFalse(usable_for(t, "transcript_ms"))

    def test_excluded_turns_do_not_enter_paired_differences(self):
        turns = [turn(0, "gw", "en", transcript_ms=110,
                      invalid_metrics=["transcript_ms"]),
                 turn(0, "direct", "en", transcript_ms=100),
                 turn(1, "gw", "en", transcript_ms=120),
                 turn(1, "direct", "en", transcript_ms=100)]
        self.assertEqual(paired(turns, "gw", "direct", "transcript_ms"), [20])

    def test_a_fully_excluded_comparison_reports_not_comparable(self):
        turns = []
        for i in range(5):
            turns.append(turn(i, "native-gateway", "en", transcript_ms=110,
                              invalid_metrics=["transcript_ms"],
                              config_warnings=self.STT))
            turns.append(turn(i, "native-direct", "en", transcript_ms=100))
        res = compute_paired(turns, ["transcript_ms"])
        rows = res.get("transcript_ms") or []
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0].not_comparable)
        self.assertIn("not comparable", rows[0].verdict())
        self.assertIn("transcription.model", rows[0].verdict())

    def test_not_comparable_rows_stay_out_of_the_holm_family(self):
        """They are not hypothesis tests, so they must not inflate the family
        and weaken the real results."""
        turns = []
        for i in range(12):
            turns.append(turn(i, "native-gateway", "en", transcript_ms=110,
                              ttfa_ms=200, invalid_metrics=["transcript_ms"],
                              config_warnings=self.STT))
            turns.append(turn(i, "native-direct", "en", transcript_ms=100,
                              ttfa_ms=100))
        res = compute_paired(turns, ["transcript_ms", "ttfa_ms"])
        ttfa = res["ttfa_ms"][0]
        # family is 1 real test, not 2 — so no scaling is applied
        self.assertAlmostEqual(ttfa.p_adj, ttfa.p_raw)


class TestBimodalCostIsNotReportedAsNull(unittest.TestCase):
    """A median says what a typical turn costs and is silent about a bimodal
    cost. OpenAI semantic VAD costs ~100 ms on four turns in five and ~3.5 s on
    the fifth; the median called that "no detectable difference" until a
    reviewer checked the percentiles. Third time a median hid a tail here."""

    # the real shape: 16 cheap turns, 4 catastrophic ones
    BIMODAL = [80, 90, 100, 110, 120, 95, 105, 130, 70, 115,
               100, 100, 100, 100, 100, 100, 3400, 3500, 3600, 3800]

    def test_the_real_case_is_flagged(self):
        r = result(106, 0.263, 1.000, lo=-106, hi=536, diffs=self.BIMODAL)
        self.assertTrue(r.tail_severe)
        self.assertIn("bimodal", r.verdict())
        self.assertIn("p90", r.verdict())
        self.assertNotIn("no detectable difference", r.verdict())

    def test_tail_is_the_p90_of_paired_differences(self):
        r = result(106, 0.263, 1.0, diffs=self.BIMODAL)
        self.assertGreater(r.tail_ms, 3000)

    def test_a_uniformly_small_cost_is_not_flagged(self):
        tight = [95, 100, 105, 98, 102, 99, 101, 103, 97, 100]
        r = result(100, 0.5, 1.0, lo=95, hi=105, diffs=tight)
        self.assertFalse(r.tail_severe)
        self.assertNotIn("bimodal", r.verdict())

    def test_a_large_but_consistent_effect_is_still_directional(self):
        big = [340, 350, 360, 345, 355, 352, 348, 351, 349, 353]
        r = result(-350, 0.000, 0.002, lo=-542, hi=-149,
                   diffs=[-x for x in big])
        self.assertFalse(r.tail_severe)
        self.assertIn("faster by 350 ms", r.verdict())

    def test_floor_stops_tiny_ratios_from_tripping_it(self):
        # p90 five times a 2 ms median is still nothing worth flagging
        r = result(2, 0.5, 1.0, diffs=[1, 2, 2, 2, 3, 2, 2, 2, 2, 40])
        self.assertLess(r.tail_ms, TAIL_FLOOR_MS)
        self.assertFalse(r.tail_severe)

    def test_empty_diffs_do_not_crash(self):
        r = result(0, 1.0, 1.0, diffs=[])
        self.assertFalse(r.tail_severe)
