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

from analyze import (bootstrap_median_ci, describe, paired, pct,  # noqa: E402
                     sign_test_p)
from bench import redact  # noqa: E402


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
