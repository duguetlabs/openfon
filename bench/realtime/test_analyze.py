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

from analyze import (ALPHA, PRACTICAL_MS, PairedResult,  # noqa: E402
                     bootstrap_median_ci, compute_paired, describe,
                     fisher_exact_p, holm, paired, pct, sign_test_p,
                     split_rate_table)
from bench import redact  # noqa: E402


def result(median, p_raw, p_adj, metric="ttfa_ms"):
    return PairedResult(metric=metric, treat="gw", ctrl="direct", question="q",
                        diffs=[median], median=median, lo=median - 10,
                        hi=median + 10, p_raw=p_raw, p_adj=p_adj)


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
        r = result(-93, 0.043, 0.779)
        self.assertFalse(r.survives)
        self.assertIn("borderline", r.verdict())
        self.assertIn("not robust to Holm", r.verdict())

    def test_tiny_effect_is_not_minted_even_when_significant(self):
        # the config_ms case: p<0.05 raw, but 6 ms is noise
        r = result(+6, 0.043, 0.779)
        self.assertFalse(r.survives)
        self.assertIn("no practical difference", r.verdict())
        self.assertIn("despite p<0.05", r.verdict())

    def test_tiny_effect_surviving_correction_is_still_not_directional(self):
        # p can survive Holm and the effect still be too small to matter
        r = result(+46, 0.001, 0.017)
        self.assertLess(r.p_adj, ALPHA)
        self.assertFalse(r.survives)
        self.assertIn("no practical difference", r.verdict())

    def test_practical_floor_boundary(self):
        self.assertFalse(result(PRACTICAL_MS - 0.1, 0.0, 0.0).practical)
        self.assertTrue(result(PRACTICAL_MS, 0.0, 0.0).practical)
        self.assertTrue(result(-PRACTICAL_MS, 0.0, 0.0).practical)

    def test_plain_null_reads_as_no_detectable_difference(self):
        self.assertEqual(result(-200, 0.7, 1.0).verdict(), "no detectable difference")


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


class TestFisherExact(unittest.TestCase):
    def test_no_association_is_p_one(self):
        self.assertAlmostEqual(fisher_exact_p(5, 5, 5, 5), 1.0)

    def test_matches_known_value(self):
        # the classic tea-tasting 2x2: two-sided p = 0.4857...
        self.assertAlmostEqual(fisher_exact_p(3, 1, 1, 3), 0.4857, places=3)

    def test_complete_separation_is_significant(self):
        # 10/10 vs 0/10 — the shape of the VAD split-rate result
        p = fisher_exact_p(10, 0, 0, 10)
        self.assertLess(p, 1e-4)

    def test_small_complete_separation_is_not_oversold(self):
        # 2/2 vs 0/2 is complete separation but far too small to be conclusive
        self.assertGreater(fisher_exact_p(2, 0, 0, 2), 0.05)

    def test_symmetric_under_row_swap(self):
        self.assertAlmostEqual(fisher_exact_p(8, 2, 3, 7),
                               fisher_exact_p(3, 7, 8, 2))

    def test_never_exceeds_one(self):
        for t in [(1, 1, 1, 1), (0, 5, 5, 0), (7, 3, 6, 4), (1, 0, 0, 1)]:
            self.assertLessEqual(fisher_exact_p(*t), 1.0)

    def test_empty_table(self):
        self.assertEqual(fisher_exact_p(0, 0, 0, 0), 1.0)


class TestSplitRateTable(unittest.TestCase):
    def _turns(self, treat_splits, ctrl_splits, n=10):
        out = []
        for i in range(n):
            out.append(turn(i, "nat-semantic", "de-short", ttfa_ms=1,
                            false_starts=1 if i < treat_splits else 0))
            out.append(turn(i, "native-direct", "de-short", ttfa_ms=1,
                            false_starts=1 if i < ctrl_splits else 0))
        return out

    def test_reports_a_pair_with_splits(self):
        rows = split_rate_table(self._turns(0, 10))
        body = "\n".join(rows)
        self.assertIn("0/10", body)
        self.assertIn("10/10", body)

    def test_omitted_when_nothing_split(self):
        self.assertEqual(split_rate_table(self._turns(0, 0)), [])

    def test_only_pairs_present_in_the_data(self):
        # control arm absent -> no comparison can be formed
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
