"""Tests for the scoring functions. The measurements are the product here.

Nothing in this file touches the network. It pins the pure functions that turn
raw transcripts into the numbers in docs/research/voice-engine-quality-2026-08.md,
because a wrong normaliser or a slot matcher that fails closed would move every
number in that report without failing anything.

That is not hypothetical: the first version of the time matcher looked only for
"14" and so scored `new_time` as missed on all 15 reschedule runs where every
arm had in fact got it right. `test_time_twelve_hour_forms` is that bug.

  python -m unittest discover -s bench/quality -p 'test_*.py'
"""
from __future__ import annotations

import csv
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "prepare"))

from judge import JudgeParseError, parse_verdicts  # noqa: E402
from events import function_call, response_cancelled  # noqa: E402
from score_slots import (  # noqa: E402
    detect_lang, fact_present, score_run, slot_present, time_matches,
    times_mentioned,
)
from score_wer import normalize  # noqa: E402
from summarize import pct, sibling  # noqa: E402


class TestNormalize(unittest.TestCase):
    """Per-language WER normalisation, applied identically to hyp and ref."""

    def test_case_punctuation_whitespace(self):
        self.assertEqual(normalize("Hello,  World!", "en"), "hello world")

    def test_german_umlauts_transliterate_both_ways(self):
        # An engine that writes "Schroeder" is not making a recognition error.
        self.assertEqual(normalize("Schröder", "de"), normalize("Schroeder", "de"))
        self.assertEqual(normalize("Schröder", "de"), "schroeder")

    def test_german_eszett(self):
        self.assertEqual(normalize("Straße", "de"), normalize("Strasse", "de"))

    def test_russian_yo_folds_to_ye(self):
        self.assertEqual(normalize("приём", "ru"), normalize("прием", "ru"))

    def test_digits_spelled_in_utterance_language(self):
        self.assertEqual(normalize("15", "de"), "fuenfzehn")
        self.assertEqual(normalize("15", "en"), "fifteen")
        self.assertIn("quinze", normalize("15", "fr"))

    def test_time_digits_become_words(self):
        # "3:30" and "three thirty" must not count as a substitution.
        self.assertEqual(normalize("3:30", "en"), normalize("three thirty", "en"))

    def test_diacritics_are_kept_where_phonemic(self):
        # Only German is transliterated. Folding Swedish/Finnish/French
        # diacritics would hide real recognition errors, so it must not happen.
        for text, lang in (("för", "sv"), ("työ", "fi"), ("café", "fr"),
                           ("però", "it"), ("años", "es")):
            with self.subTest(lang=lang):
                self.assertEqual(normalize(text, lang), text.casefold())

    def test_idempotent(self):
        for text, lang in (("Schröder, 15 Uhr!", "de"), ("The 3:30 slot.", "en")):
            with self.subTest(text=text):
                once = normalize(text, lang)
                self.assertEqual(normalize(once, lang), once)

    def test_known_limitation_german_ordinals_expand_as_cardinals(self):
        # "15." is an ordinal ("fuenfzehnten") but num2words gives the cardinal.
        # Pinned so that a future fix is a deliberate change, and so the report's
        # "do not measure dates with WER" caveat stays true.
        self.assertEqual(normalize("15.", "de"), "fuenfzehn")
        self.assertNotEqual(normalize("15.", "de"), normalize("fünfzehnten", "de"))


class TestSlotMatching(unittest.TestCase):
    def test_phone_ignores_formatting(self):
        for written in ("0152 288 17386", "0152-288-17386",
                        "+49 152 28817386", "+49 (0)152 28817386"):
            with self.subTest(written=written):
                self.assertTrue(
                    slot_present(f"I have {written} on file.", "phone",
                                 ["015228817386"], "en"))

    def test_phone_rejects_a_different_number(self):
        self.assertFalse(
            slot_present("your number is 0152 288 17999", "phone",
                         ["015228817386"], "en"))

    def test_phone_absent(self):
        self.assertFalse(slot_present("no digits here", "phone", ["5550143"], "en"))

    def test_name_matches_through_the_normaliser(self):
        for spelling in ("Schröder", "Schroeder", "schröder"):
            with self.subTest(spelling=spelling):
                self.assertTrue(
                    slot_present(f"Danke, Frau {spelling}.", "last_name",
                                 ["Schröder", "Schroeder"], "de"))

    def test_time_twelve_hour_forms(self):
        """A caller asking for 14:00 says "at two"; the agent confirms "2 PM"."""
        for text in ("reschedule to Wednesday at 2 PM",
                     "make it Wednesday at 2",
                     "Wednesday at two",
                     "we can do 14:00",
                     "how about 2 o'clock"):
            with self.subTest(text=text):
                self.assertTrue(slot_present(text, "new_time", ["14:00"], "en"))

    def test_time_rejects_wrong_minutes_and_meridiem(self):
        """A bare-hour match dropped minutes and meridiem, so 14:00 == 2:30."""
        for text in ("how about 2:30", "how about 2 AM", "at 2 a.m.",
                     "we could do 2:45"):
            with self.subTest(text=text):
                self.assertFalse(slot_present(text, "new_time", ["14:00"], "en"))
        for text in ("at 2 PM", "at 2:00", "Wednesday at two", "we can do 14:00"):
            with self.subTest(text=text):
                self.assertTrue(slot_present(text, "new_time", ["14:00"], "en"))

    def test_german_time_rejects_wrong_minutes(self):
        self.assertFalse(slot_present("um 15:30", "time_after", ["15:00"], "de"))
        self.assertTrue(slot_present("um 15 Uhr", "time_after", ["15:00"], "de"))

    def test_spoken_hours_are_not_reconstructed_from_digits(self):
        """normalize("2:30") is "two thirty"; a word scan must not see "two"."""
        self.assertFalse(slot_present("2:30", "new_time", ["14:00"], "en"))
        self.assertFalse(slot_present("15:30", "time_after", ["15:00"], "de"))

    def test_time_rejects_the_wrong_hour(self):
        # The reschedule scenario turns on 10:00 being replaced by 14:00.
        self.assertFalse(
            slot_present("Could we do Wednesday at 10 instead", "new_time",
                         ["14:00"], "en"))

    def test_time_german_forms(self):
        for text in ("Donnerstag um 15 Uhr", "Donnerstag um fuenfzehn Uhr",
                     "Donnerstag um fünfzehn Uhr", "nach drei Uhr nachmittags"):
            with self.subTest(text=text):
                self.assertTrue(slot_present(text, "time_after", ["15:00"], "de"))
        self.assertFalse(slot_present("um 9 Uhr", "time_after", ["15:00"], "de"))

    def test_language_detection_for_code_switch(self):
        self.assertEqual(detect_lang("Yes, we can do that appointment for you"), "en")
        self.assertEqual(detect_lang("Ja, wir haben einen Termin frei"), "de")
        self.assertIsNone(detect_lang(""))

    def test_mentions_are_parsed_into_hour_and_minute(self):
        got = {(h, m) for h, m, _ctx, _at in times_mentioned("at 14:30", "en")}
        self.assertIn((14, 30), got)
        got = {(h, m) for h, m, _ctx, _at in times_mentioned("at 2 PM", "en")}
        self.assertIn((14, None), got)
        got = {(h, m) for h, m, _ctx, _at in times_mentioned("at 2 AM", "en")}
        self.assertIn((2, None), got)
        self.assertNotIn((14, None), got)

    def test_bare_hour_is_ambiguous_and_matches_either_reading(self):
        self.assertTrue(time_matches("Wednesday at 2", "14:00", "en"))
        self.assertTrue(time_matches("Wednesday at 2", "02:00", "en"))


class TestFactMatching(unittest.TestCase):
    """Grounded / forbidden claims. Both bugs here inverted real results."""

    def test_clock_times_compare_temporally(self):
        # normalize("14:00") is "fourteen zero"/"vierzehn null", which can never
        # match a spoken time. Every time-valued grounded fact was unsatisfiable,
        # so a correct answer scored as ungrounded.
        for utt in ("We close at 2 PM on Fridays.", "On Fridays we close at 14:00.",
                    "Fridays, two o'clock."):
            with self.subTest(utt=utt):
                self.assertTrue(fact_present([utt], "14:00", "en"))
        for utt in ("Freitags schließen wir um 14 Uhr.",
                    "Wir schließen freitags um vierzehn Uhr."):
            with self.subTest(utt=utt):
                self.assertTrue(fact_present([utt], "14:00", "de"))

    def test_clock_times_reject_the_wrong_hour(self):
        self.assertFalse(fact_present(["We close at 5 PM on Fridays."], "14:00", "en"))
        self.assertFalse(fact_present(["Wir schließen um 17 Uhr."], "14:00", "de"))

    def test_facts_do_not_span_utterances(self):
        """Two correct answers must not synthesise a forbidden claim."""
        utterances = ["We are open Monday until 17:00.",
                      "On Fridays we close at 14:00."]
        # Joining these and substring-matching yields "17:00 on Friday" — a
        # forbidden claim neither turn actually made.
        self.assertFalse(fact_present(utterances, "17:00 on Friday", "en"))
        # ...but a single utterance that really does say it must still fire.
        self.assertTrue(fact_present(["We close at 17:00 on Friday."],
                                     "17:00 on Friday", "en"))

    def test_negated_claims_do_not_match_the_claim_denied(self):
        """Any forbidden hit is a hard failure, so a correct denial must not fire."""
        for utt in ("We are not open on Saturday.",
                    "No, we are not open on Saturday.",
                    "Unfortunately we are not open on Saturday."):
            with self.subTest(utt=utt):
                self.assertFalse(fact_present([utt], "open on Saturday", "en"))
        self.assertTrue(fact_present(["We are open on Saturday."],
                                     "open on Saturday", "en"))

    def test_negated_times_do_not_match(self):
        self.assertFalse(fact_present(["Sorry, not 10:00 - I meant 14:00."],
                                      "10:00", "en"))
        self.assertTrue(fact_present(["We close at 10:00."], "10:00", "en"))
        self.assertFalse(fact_present(["Wir schliessen nicht um 17 Uhr."],
                                      "17:00", "de"))

    def test_german_negation(self):
        self.assertFalse(fact_present(["Am Samstag sind wir nicht geoeffnet."],
                                      "Samstag geöffnet", "de"))
        self.assertTrue(fact_present(["Wir sind samstags geschlossen."],
                                     "geschlossen", "de"))

    def test_plain_facts_still_match(self):
        self.assertTrue(fact_present(["We are closed on Saturday."], "closed", "en"))
        self.assertTrue(fact_present(["Samstags sind wir geschlossen."],
                                     "geschlossen", "de"))
        self.assertFalse(fact_present(["We are open."], "geschlossen", "de"))


class TestBargeInAdoption(unittest.TestCase):
    """`bargein_correct` must read the agent's reply, not the caller transcript."""

    SPEC = {"scenarios": [{
        "id": "b", "lang": "en_US", "intent": "book_appointment",
        "turns": [{"text": "the tenth"}, {"text": "no, the seventeenth",
                                          "barge_in_after_ms": 700}],
        "expected": {"tool_calls": [], "slots": {"day_of_month": ["17"]},
                     "grounded_facts": [], "forbidden": ["the tenth"]}}]}

    def run_with(self, agent_reply):
        return score_run({
            "arm": "a", "trial": 1, "scenario": "b", "lang": "en_US",
            "intent": "book_appointment", "tool_calls": [], "error": None,
            "transcript": [{"role": "caller_asr", "text": "no, the seventeenth"},
                           {"role": "agent", "text": agent_reply}],
            "turns": [{"index": 0, "agent_text": "What time on the tenth?"},
                      {"index": 1, "barge_in": True, "agent_text": agent_reply}],
        }, self.SPEC)

    def test_adopted_correction_passes(self):
        self.assertEqual(self.run_with("Certainly, the 17th it is.")["bargein_correct"], 1)

    def test_ignored_correction_fails(self):
        # The caller was transcribed perfectly, but the agent carried on with the
        # old date. Deriving this from the caller ASR scored it as adopted.
        self.assertEqual(self.run_with("What time on the tenth suits you?")["bargein_correct"], 0)


class TestToolCallDedup(unittest.TestCase):
    """One invocation, several events, one recorded call."""

    def test_same_call_id_across_event_types_is_one_call(self):
        cid = "call_abc"
        evs = [
            {"type": "response.output_item.added", "call_id": cid,
             "item": {"name": "end_call"}},
            {"type": "conversation.item.created",
             "item": {"type": "function_call", "name": "end_call", "call_id": cid}},
            {"type": "response.function_call_arguments.done", "call_id": cid,
             "name": "end_call"},
        ]
        seen, names = set(), []
        for ev in evs:
            got = function_call(ev)
            self.assertIsNotNone(got)
            call_id, name = got
            self.assertEqual(call_id, cid)
            if call_id not in seen:
                seen.add(call_id)
                names.append(name)
        self.assertEqual(names, ["end_call"])

    def test_two_distinct_calls_are_both_kept(self):
        seen, names = set(), []
        for cid in ("call_1", "call_2"):
            call_id, name = function_call(
                {"type": "response.function_call_arguments.done",
                 "call_id": cid, "name": "end_call"})
            if call_id not in seen:
                seen.add(call_id)
                names.append(name)
        self.assertEqual(names, ["end_call", "end_call"])

    def test_non_tool_events_are_ignored(self):
        for ev in ({"type": "response.audio.delta", "delta": "x"},
                   {"type": "response.function_call_arguments.delta",
                    "call_id": "c"},
                   {"type": "conversation.item.created",
                    "item": {"type": "message", "role": "assistant"}}):
            with self.subTest(ev=ev["type"]):
                self.assertIsNone(function_call(ev))


class TestRunAllReproducesTheReport(unittest.TestCase):
    def test_default_scenario_arms_include_the_vad_control(self):
        """The report is 165 calls across 5 arms; the default must produce that.

        Omitting vl-gpt41mini-semvad yields 132 calls and removes the control
        that keeps the brain comparison VAD-neutral.
        """
        sh = (HERE / "run_all.sh").read_text()
        line = next(l for l in sh.splitlines() if l.startswith("SC_ARMS="))
        for arm in ("vl-gpt41mini", "vl-gpt41mini-dns", "vl-gpt41mini-semvad",
                    "vl-native-brain", "native-gpt-realtime-2"):
            with self.subTest(arm=arm):
                self.assertIn(arm, line)


class TestJudgeParsing(unittest.TestCase):
    IDS = {"cand1", "cand2"}

    def good(self, **over):
        base = {"id": "cand1", "groundedness": 1, "resolution": 2, "tone": 2}
        base.update(over)
        return base

    def test_parses_a_well_formed_reply(self):
        import json
        raw = json.dumps([self.good(), self.good(id="cand2", groundedness=0)])
        got = parse_verdicts(raw, self.IDS)
        self.assertEqual([v["id"] for v in got], ["cand1", "cand2"])
        self.assertEqual(got[1]["groundedness"], 0)

    def test_strips_markdown_fence(self):
        import json
        raw = "```json\n" + json.dumps([self.good(), self.good(id="cand2")]) + "\n```"
        self.assertEqual(len(parse_verdicts(raw, self.IDS)), 2)

    # Each of these previously would have been swallowed, turning a judge
    # outage into "every arm scores badly" rather than into an error.
    def test_rejects_empty_reply(self):
        for raw in ("", "   ", None):
            with self.subTest(raw=raw):
                with self.assertRaises(JudgeParseError):
                    parse_verdicts(raw, self.IDS)

    def test_rejects_non_json(self):
        with self.assertRaises(JudgeParseError):
            parse_verdicts("I'm sorry, I can't help with that.", self.IDS)

    def test_rejects_non_array(self):
        with self.assertRaises(JudgeParseError):
            parse_verdicts('{"id": "cand1"}', self.IDS)

    def test_rejects_out_of_range_scores(self):
        import json
        # `True`/`False` matter specially: bool is a subclass of int, so a bare
        # membership test accepted them and float() then turned a positive
        # verdict into 0.0 with no error raised anywhere.
        for bad in ({"groundedness": 2}, {"resolution": 5}, {"tone": -1},
                    {"groundedness": None}, {"tone": "good"},
                    {"groundedness": True}, {"groundedness": False},
                    {"resolution": True}, {"tone": 1.0}, {"groundedness": "1"}):
            with self.subTest(bad=bad):
                raw = json.dumps([self.good(**bad), self.good(id="cand2")])
                with self.assertRaises(JudgeParseError):
                    parse_verdicts(raw, self.IDS)

    def test_rejects_unknown_candidate_id(self):
        import json
        raw = json.dumps([self.good(id="cand9"), self.good(id="cand2")])
        with self.assertRaises(JudgeParseError):
            parse_verdicts(raw, self.IDS)

    def test_rejects_missing_candidate(self):
        import json
        with self.assertRaises(JudgeParseError):
            parse_verdicts(json.dumps([self.good()]), self.IDS)

    def test_rejects_duplicate_candidates(self):
        import json
        raw = json.dumps([self.good(), self.good(), self.good(id="cand2")])
        with self.assertRaises(JudgeParseError):
            parse_verdicts(raw, self.IDS)


class TestAbsentDataNeverPasses(unittest.TestCase):
    """The class of bug this harness kept reproducing.

    Six independent places once let missing data read as a pass. Each is a
    separate `summarize.py` invocation here, because the guards live in `main()`
    and the point is that the *process* refuses, not that a helper returns False.
    """

    SLOTS_HEADER = (
        "arm,trial,scenario,lang,intent,n_slots,slot_heard,slots_all_heard,"
        "missed_heard,slot_echoed,slots_all_echoed,missed_echoed,tools_called,"
        "tool_ok,grounded_n,grounded_hit,grounded_ok,forbidden_hit,forbidden_terms,"
        "ttfa_ms_all,ttfa_p50_ms,bargein_attempts,bargein_inflight,bargein_stop_ms,"
        "bargein_correct,agent_turns,n_turns_expected,session_s,error,scored")

    def slot_row(self, arm="a", trial=1, scenario="s1", **over):
        row = {"arm": arm, "trial": trial, "scenario": scenario, "lang": "en_US",
               "intent": "grounded_qa", "n_slots": 0, "slot_heard": "",
               "slots_all_heard": "", "missed_heard": "", "slot_echoed": "",
               "slots_all_echoed": "", "missed_echoed": "", "tools_called": "",
               "tool_ok": 1, "grounded_n": 0, "grounded_hit": 0, "grounded_ok": 1,
               "forbidden_hit": 0, "forbidden_terms": "", "ttfa_ms_all": "900",
               "ttfa_p50_ms": 900, "bargein_attempts": 0, "bargein_inflight": 0,
               "bargein_stop_ms": "", "bargein_correct": "", "agent_turns": 2,
               "n_turns_expected": 2, "session_s": 20, "error": "", "scored": 1}
        row.update(over)
        return row

    def write(self, tmp, name, header, rows):
        p = Path(tmp) / name
        with open(p, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=header.split(","))
            w.writeheader()
            for r in rows:
                w.writerow(r)
        return p

    def scenario_fixture(self, tmp, ids):
        p = Path(tmp) / "scenarios.json"
        p.write_text(json.dumps({"scenarios": [{"id": i} for i in sorted(set(ids))]}))
        return p

    def summarize(self, tmp, slot_rows, judge_rows=None, extra=()):
        slots = self.write(tmp, "slots.csv", self.SLOTS_HEADER, slot_rows)
        spec = self.scenario_fixture(tmp, [r["scenario"] for r in slot_rows])
        cmd = [sys.executable, str(HERE / "summarize.py"), "--slots", str(slots),
               "--scenarios", str(spec),
               "--out", str(Path(tmp) / "out.csv"), "--trials", "1", *extra]
        if judge_rows is not None:
            jh = "scenario,arm,trial,lang,seed,groundedness,resolution,tone,groundedness_evidence,note"
            cmd += ["--judge", str(self.write(tmp, "judge.csv", jh, judge_rows))]
        return subprocess.run(cmd, capture_output=True, text=True)

    def judge_row(self, arm="a", trial=1, scenario="s1", groundedness=1):
        return {"scenario": scenario, "arm": arm, "trial": trial, "lang": "en_US",
                "seed": 1, "groundedness": groundedness, "resolution": 2, "tone": 2,
                "groundedness_evidence": "", "note": ""}

    def test_baseline_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = self.summarize(tmp, [self.slot_row()], [self.judge_row()])
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))
            self.assertEqual(float(out[0]["success_mean"]), 1.0)

    def test_empty_judge_file_is_not_no_judge(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = self.summarize(tmp, [self.slot_row()], [])
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("no verdict rows", r.stderr)

    def test_missing_judge_row_aborts(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = self.summarize(tmp, [self.slot_row()], [self.judge_row(scenario="other")])
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("no judge verdict", r.stderr)

    def test_missing_judge_row_scores_as_failure_when_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = self.summarize(tmp, [self.slot_row()], [self.judge_row(scenario="other")],
                               extra=("--allow-missing-judge",))
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))
            self.assertEqual(float(out[0]["success_mean"]), 0.0)

    def test_missing_trial_aborts_rather_than_counting_as_pass_k(self):
        # Two of three trials must never satisfy pass^3.
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.slot_row(trial=1), self.slot_row(trial=2)]
            judge = [self.judge_row(trial=1), self.judge_row(trial=2)]
            slots = self.write(tmp, "slots.csv", self.SLOTS_HEADER, rows)
            jh = "scenario,arm,trial,lang,seed,groundedness,resolution,tone,groundedness_evidence,note"
            j = self.write(tmp, "judge.csv", jh, judge)
            spec = self.scenario_fixture(tmp, [r["scenario"] for r in rows])
            r = subprocess.run(
                [sys.executable, str(HERE / "summarize.py"), "--slots", str(slots),
                 "--judge", str(j), "--trials", "3", "--scenarios", str(spec),
                 "--out", str(Path(tmp) / "out.csv")], capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("do not have exactly one row per trial 1..3", r.stderr)

    def test_missing_scenario_stays_in_the_pass_k_denominator(self):
        # Arm "b" never ran s2. Its pass^k must be 0.5, not 1.0.
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.slot_row(arm="a", scenario="s1"),
                    self.slot_row(arm="a", scenario="s2"),
                    self.slot_row(arm="b", scenario="s1")]
            judge = [self.judge_row(arm="a", scenario="s1"),
                     self.judge_row(arm="a", scenario="s2"),
                     self.judge_row(arm="b", scenario="s1")]
            r = self.summarize(tmp, rows, judge, extra=("--allow-incomplete",))
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = {x["arm"]: x for x in csv.DictReader(fh)}
            self.assertEqual(float(out["a"]["pass_k"]), 1.0)
            self.assertEqual(float(out["b"]["pass_k"]), 0.5)

    def test_errored_run_is_never_a_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = self.summarize(tmp, [self.slot_row(error="websocket closed")],
                               [self.judge_row()])
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))
            self.assertEqual(float(out[0]["success_mean"]), 0.0)

    def test_call_the_agent_never_joined_is_never_a_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = self.summarize(tmp, [self.slot_row(agent_turns=0)], [self.judge_row()])
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))
            self.assertEqual(float(out[0]["success_mean"]), 0.0)

    def test_unparseable_conjunction_input_aborts(self):
        # Defaulting a garbage forbidden_hit to 0 would read as "no forbidden claim".
        with tempfile.TemporaryDirectory() as tmp:
            r = self.summarize(tmp, [self.slot_row(forbidden_hit="n/a")],
                               [self.judge_row()])
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("not numeric", r.stderr)

    def test_ttfa_p95_is_over_turns_not_per_call_medians(self):
        """One slow turn inside an otherwise fast call must reach the p95."""
        with tempfile.TemporaryDirectory() as tmp:
            rows, judge = [], []
            for i in range(1, 11):
                # Each call: nine fast turns and one very slow one. The median of
                # each call is ~900; only turn-level aggregation sees the 9000.
                rows.append(self.slot_row(scenario=f"s{i}",
                                          ttfa_ms_all=";".join(["900"] * 9 + ["9000"]),
                                          ttfa_p50_ms=900))
                judge.append(self.judge_row(scenario=f"s{i}"))
            r = self.summarize(tmp, rows, judge)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))[0]
            self.assertEqual(out["ttfa_turns_n"], "100")
            self.assertEqual(out["ttfa_p95_ms"], "9000")

    def test_unmeasured_metric_says_so_instead_of_blank(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = self.summarize(tmp, [self.slot_row(ttfa_ms_all="")], [self.judge_row()])
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))[0]
            self.assertEqual(out["ttfa_p95_ms"], "no turns")


class TestPercentile(unittest.TestCase):
    """Nearest-rank, not `round()`. Three lines that would have caught it."""

    def test_matches_nearest_rank_definition(self):
        for n in range(1, 201):
            s = list(range(1, n + 1))
            for q in (0.5, 0.9, 0.95, 0.99):
                with self.subTest(n=n, q=q):
                    self.assertEqual(pct(s, q), math.ceil(q * n))

    def test_the_cases_round_gets_wrong(self):
        # round() is banker's rounding: round(20*0.95 + 0.5) == round(19.5) == 20,
        # selecting rank 20 of 20 where nearest-rank selects 19.
        self.assertEqual(pct(list(range(1, 21)), 0.95), 19)
        self.assertEqual(pct(list(range(1, 101)), 0.95), 95)

    def test_p95_is_not_the_maximum(self):
        vals = [1.0] * 95 + [100.0] * 5
        self.assertEqual(pct(vals, 0.95), 1.0)
        self.assertEqual(pct(vals, 0.96), 100.0)

    def test_single_value(self):
        self.assertEqual(pct([7.0], 0.95), 7.0)


class TestAggregatesKnowTheirDenominator(unittest.TestCase):
    """The rule: observations can differ from expectations, so compare them.

    Two instances of this survived the first fail-closed sweep — `success_mean`
    averaging only the rows present under `--allow-incomplete`, and `run_all.sh`
    exiting 0 after a failed runner.
    """

    def test_success_mean_denominates_on_expected_not_present(self):
        """Two successes out of an expected three is 0.667, never 1.0."""
        helper = TestAbsentDataNeverPasses()
        with tempfile.TemporaryDirectory() as tmp:
            rows = [helper.slot_row(scenario="s1", trial=1),
                    helper.slot_row(scenario="s1", trial=2)]
            judge = [helper.judge_row(scenario="s1", trial=1),
                     helper.judge_row(scenario="s1", trial=2)]
            slots = helper.write(tmp, "slots.csv", helper.SLOTS_HEADER, rows)
            jh = ("scenario,arm,trial,lang,seed,groundedness,resolution,tone,"
                  "groundedness_evidence,note")
            j = helper.write(tmp, "judge.csv", jh, judge)
            spec = helper.scenario_fixture(tmp, [r["scenario"] for r in rows])
            r = subprocess.run(
                [sys.executable, str(HERE / "summarize.py"), "--slots", str(slots),
                 "--judge", str(j), "--trials", "3", "--allow-incomplete",
                 "--scenarios", str(spec),
                 "--out", str(Path(tmp) / "out.csv")], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))[0]
            self.assertEqual(float(out["success_mean"]), round(2 / 3, 3))
            self.assertEqual(int(out["missing_runs"]), 1)
            self.assertEqual(int(out["runs_expected"]), 3)

    def test_tool_ok_and_grounded_ok_also_denominate_on_expected(self):
        helper = TestAbsentDataNeverPasses()
        with tempfile.TemporaryDirectory() as tmp:
            rows = [helper.slot_row(scenario="s1", trial=1)]
            judge = [helper.judge_row(scenario="s1", trial=1)]
            slots = helper.write(tmp, "slots.csv", helper.SLOTS_HEADER, rows)
            jh = ("scenario,arm,trial,lang,seed,groundedness,resolution,tone,"
                  "groundedness_evidence,note")
            j = helper.write(tmp, "judge.csv", jh, judge)
            spec = helper.scenario_fixture(tmp, [r["scenario"] for r in rows])
            r = subprocess.run(
                [sys.executable, str(HERE / "summarize.py"), "--slots", str(slots),
                 "--judge", str(j), "--trials", "2", "--allow-incomplete",
                 "--scenarios", str(spec),
                 "--out", str(Path(tmp) / "out.csv")], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))[0]
            for col in ("tool_ok", "grounded_ok", "success_mean"):
                with self.subTest(col=col):
                    self.assertEqual(float(out[col]), 0.5)

    def test_run_all_propagates_runner_failure(self):
        """A failed runner must make the matrix script exit non-zero."""
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            (data / "conditions").mkdir(parents=True)
            (data / "scenarios").mkdir(parents=True)
            failing = Path(tmp) / "fail.py"
            failing.write_text("import sys; sys.exit(3)\n")
            r = subprocess.run(
                ["bash", str(HERE / "run_all.sh")],
                # OUT redirects the destructive `: > results/*.jsonl` into tmp.
                # Without it this test truncates the committed results, because
                # run_all.sh cd's to its own directory regardless of cwd — which
                # is exactly what happened the first time it was written.
                env={**os.environ, "DATA": str(data), "PY": f"{sys.executable} {failing}",
                     "OUT": str(Path(tmp) / "out"), "TRACK": "b", "TRIALS": "1",
                     "SC_ARMS": "vl-gpt41mini"},
                capture_output=True, text=True, cwd=tmp)
            self.assertNotEqual(r.returncode, 0,
                                "run_all.sh exited 0 despite a failing runner")
            self.assertIn("INCOMPLETE", r.stderr)

    def test_score_asr_rejects_a_short_cell(self):
        """A WER over 8 of 25 clips must not be reported like one over 25."""
        with tempfile.TemporaryDirectory() as tmp:
            hyp = Path(tmp) / "asr.jsonl"
            rows = []
            for cond in ("clean", "tel"):
                n = 3 if cond == "clean" else 1      # deliberately ragged
                for i in range(n):
                    rows.append({"arm": "a", "lang": "en_us", "condition": cond,
                                 "id": f"{cond}{i}", "reference": "hello world",
                                 "hypothesis": "hello world", "error": None,
                                 "audio_seconds": 1.0, "latency_s": 0.1})
            hyp.write_text("".join(json.dumps(r) + "\n" for r in rows))
            cmd = [sys.executable, str(HERE / "score_asr.py"), "--hyp", str(hyp),
                   "--out", str(Path(tmp) / "out.csv")]
            r = subprocess.run(cmd, capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("cell problem", r.stderr)
            # ...and says so explicitly when allowed through.
            r2 = subprocess.run(cmd + ["--allow-incomplete"],
                                capture_output=True, text=True)
            self.assertEqual(r2.returncode, 0, r2.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = {x["condition"]: x for x in csv.DictReader(fh)}
            self.assertEqual(out["clean"]["complete"], "1")
            self.assertEqual(out["tel"]["complete"], "0")

    def test_score_asr_rejects_a_duplicated_clip_id(self):
        """A duplicate beside a missing clip totals correctly and skews the WER."""
        with tempfile.TemporaryDirectory() as tmp:
            hyp = Path(tmp) / "asr.jsonl"
            ids = ["c0", "c1", "c0"]        # count is 3, identity is not
            rows = [{"arm": "a", "lang": "en_us", "condition": "clean", "id": i,
                     "reference": "hello world", "hypothesis": "hello world",
                     "error": None, "audio_seconds": 1.0, "latency_s": 0.1}
                    for i in ids]
            hyp.write_text("".join(json.dumps(r) + "\n" for r in rows))
            r = subprocess.run(
                [sys.executable, str(HERE / "score_asr.py"), "--hyp", str(hyp),
                 "--expect-clips", "3", "--out", str(Path(tmp) / "out.csv")],
                capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("duplicate clip c0", r.stderr)

    def test_score_asr_rejects_arms_scored_on_different_clips(self):
        with tempfile.TemporaryDirectory() as tmp:
            hyp = Path(tmp) / "asr.jsonl"
            rows = []
            for arm, ids in (("a", ["c0", "c1"]), ("b", ["c0", "c2"])):
                for i in ids:
                    rows.append({"arm": arm, "lang": "en_us", "condition": "clean",
                                 "id": i, "reference": "hello world",
                                 "hypothesis": "hello world", "error": None,
                                 "audio_seconds": 1.0, "latency_s": 0.1})
            hyp.write_text("".join(json.dumps(r) + "\n" for r in rows))
            r = subprocess.run(
                [sys.executable, str(HERE / "score_asr.py"), "--hyp", str(hyp),
                 "--expect-clips", "2", "--out", str(Path(tmp) / "out.csv")],
                capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("clip set differs", r.stderr)

    def test_score_asr_without_a_clean_baseline_emits_no_robustness_rows(self):
        """`--conditions tel` used to IndexError after writing the detail CSV."""
        with tempfile.TemporaryDirectory() as tmp:
            hyp = Path(tmp) / "asr.jsonl"
            rows = [{"arm": "a", "lang": "en_us", "condition": "tel", "id": f"c{i}",
                     "reference": "hello world", "hypothesis": "hello world",
                     "error": None, "audio_seconds": 1.0, "latency_s": 0.1}
                    for i in range(2)]
            hyp.write_text("".join(json.dumps(r) + "\n" for r in rows))
            out = Path(tmp) / "out.csv"
            r = subprocess.run(
                [sys.executable, str(HERE / "score_asr.py"), "--hyp", str(hyp),
                 "--expect-clips", "2", "--out", str(out)],
                capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("no robustness summary", r.stderr)
            self.assertTrue(out.exists())
            self.assertFalse(Path(str(out).replace(".csv", "_summary.csv")).exists())


class TestCompletenessByIdentity(unittest.TestCase):
    """Counting rows is not verifying trials. See COMPLETENESS.md."""

    def setUp(self):
        self.h = TestAbsentDataNeverPasses()

    def summarize(self, tmp, slot_rows, trials, extra=()):
        slots = self.h.write(tmp, "slots.csv", self.h.SLOTS_HEADER, slot_rows)
        jh = ("scenario,arm,trial,lang,seed,groundedness,resolution,tone,"
              "groundedness_evidence,note")
        judge = [self.h.judge_row(arm=r["arm"], trial=r["trial"],
                                  scenario=r["scenario"]) for r in slot_rows]
        j = self.h.write(tmp, "judge.csv", jh, judge)
        spec = self.h.scenario_fixture(tmp, [r["scenario"] for r in slot_rows])
        return subprocess.run(
            [sys.executable, str(HERE / "summarize.py"), "--slots", str(slots),
             "--judge", str(j), "--trials", str(trials), "--scenarios", str(spec),
             "--out", str(Path(tmp) / "out.csv"), *extra],
            capture_output=True, text=True)

    def test_duplicate_trial_ids_do_not_satisfy_k(self):
        """Three copies of trial 1 is not trials 1, 2 and 3."""
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(trial=1) for _ in range(3)]
            r = self.summarize(tmp, rows, trials=3)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("duplicate trial 1", r.stderr)
            self.assertIn("missing trial 2,3", r.stderr)

    def test_duplicate_trials_do_not_produce_a_pass_k(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(trial=1) for _ in range(3)]
            r = self.summarize(tmp, rows, trials=3, extra=("--allow-incomplete",))
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))[0]
            self.assertEqual(float(out["pass_k"]), 0.0)

    def test_unexpected_trial_id_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(trial=t) for t in (1, 2, 7)]
            r = self.summarize(tmp, rows, trials=3)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("unexpected trial 7", r.stderr)
            self.assertIn("missing trial 3", r.stderr)

    def test_missing_scenario_for_one_arm_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(arm="a", scenario=sc, trial=t)
                    for sc in ("s1", "s2") for t in (1, 2)]
            rows += [self.h.slot_row(arm="b", scenario="s1", trial=t) for t in (1, 2)]
            r = self.summarize(tmp, rows, trials=2)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("b/s2", r.stderr)

    def test_missing_arm_entirely_is_simply_absent(self):
        """An arm with no rows cannot be detected here — documented in COMPLETENESS.md.

        Arms are discovered from the data, so an arm that never ran produces no
        rows and no arm entry. Nothing in a results file can reveal it; the run
        script's exit code (check #3) is what catches that.
        """
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(arm="a", trial=t) for t in (1, 2)]
            r = self.summarize(tmp, rows, trials=2)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                self.assertEqual([x["arm"] for x in csv.DictReader(fh)], ["a"])

    def test_a_globally_missing_scenario_is_caught(self):
        """The one gap the per-scenario trial checks cannot see.

        Omit a scenario from every arm and, if the universe is inferred from the
        rows, it vanishes from expected_runs and the pass_k denominator alike.
        """
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(arm=arm, scenario="s1", trial=t)
                    for arm in ("a", "b") for t in (1, 2)]
            slots = self.h.write(tmp, "slots.csv", self.h.SLOTS_HEADER, rows)
            # The fixture declares two scenarios; the results contain one.
            spec = self.h.scenario_fixture(tmp, ["s1", "s2"])
            r = subprocess.run(
                [sys.executable, str(HERE / "summarize.py"), "--slots", str(slots),
                 "--trials", "2", "--scenarios", str(spec),
                 "--out", str(Path(tmp) / "out.csv")], capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("no rows at all: s2", r.stderr)

    def test_a_globally_missing_scenario_stays_in_the_denominator(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(arm="a", scenario="s1", trial=t) for t in (1, 2)]
            slots = self.h.write(tmp, "slots.csv", self.h.SLOTS_HEADER, rows)
            spec = self.h.scenario_fixture(tmp, ["s1", "s2"])
            r = subprocess.run(
                [sys.executable, str(HERE / "summarize.py"), "--slots", str(slots),
                 "--trials", "2", "--scenarios", str(spec), "--allow-incomplete",
                 "--out", str(Path(tmp) / "out.csv")], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))[0]
            # Two scenarios expected, one passing -> 0.5, not 1.0.
            self.assertEqual(int(out["scenarios"]), 2)
            self.assertEqual(float(out["pass_k"]), 0.5)

    def test_results_cannot_introduce_a_scenario_the_fixture_lacks(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(scenario=sc, trial=1) for sc in ("s1", "rogue")]
            slots = self.h.write(tmp, "slots.csv", self.h.SLOTS_HEADER, rows)
            spec = self.h.scenario_fixture(tmp, ["s1"])
            r = subprocess.run(
                [sys.executable, str(HERE / "summarize.py"), "--slots", str(slots),
                 "--trials", "1", "--scenarios", str(spec),
                 "--out", str(Path(tmp) / "out.csv")], capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("rogue", r.stderr)

    def test_complete_data_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(arm=arm, scenario=sc, trial=t)
                    for arm in ("a", "b") for sc in ("s1", "s2") for t in (1, 2, 3)]
            r = self.summarize(tmp, rows, trials=3)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = {x["arm"]: x for x in csv.DictReader(fh)}
            self.assertEqual(float(out["a"]["pass_k"]), 1.0)
            self.assertEqual(int(out["a"]["missing_runs"]), 0)


class TestCancellationDetection(unittest.TestCase):
    """Interruption is `response.done` with status cancelled, not its own event."""

    def status_event(self, status):
        return {"type": "response.done", "response": {"status": status}}

    def test_cancelled_status_is_recognised(self):
        # There is no top-level `response.cancelled` on either service — zero
        # appear in any committed log — so a check for one never fires.
        ev = self.status_event("cancelled")
        self.assertEqual(ev["type"], "response.done")
        self.assertIn(ev["response"]["status"], ("cancelled", "canceled"))

    def test_response_cancelled_reads_the_status_field(self):
        self.assertTrue(response_cancelled(self.status_event("cancelled")))
        self.assertTrue(response_cancelled(self.status_event("canceled")))
        self.assertFalse(response_cancelled(self.status_event("completed")))
        self.assertFalse(response_cancelled({"type": "response.cancelled"}))
        self.assertFalse(response_cancelled({"type": "response.done"}))

    def test_committed_logs_encode_cancellation_this_way(self):
        """Guards the assumption against a service-side change."""
        import glob
        seen_status, seen_toplevel = set(), 0
        for p in glob.glob(str(HERE / "logs" / "sc-*bargein*.jsonl")):
            with open(p) as fh:
                for line in fh:
                    ev = json.loads(line).get("ev") or {}
                    if ev.get("type") == "response.done":
                        seen_status.add((ev.get("response") or {}).get("status"))
                    if ev.get("type") in ("response.cancelled", "response.canceled"):
                        seen_toplevel += 1
        if not seen_status:
            self.skipTest("no barge-in logs present")
        self.assertIn("cancelled", seen_status)
        self.assertEqual(seen_toplevel, 0)


class TestFinalLanguage(unittest.TestCase):
    """Language adherence is a property of the agent's last turn."""

    SPEC = {"scenarios": [{
        "id": "cs", "lang": "de_DE", "intent": "grounded_qa",
        "turns": [{"text": "auf Deutsch"}, {"text": "in English please"}],
        "expected": {"tool_calls": [], "slots": {"final_language": ["en"]},
                     "grounded_facts": [], "forbidden": []}}]}

    def run_with(self, agent_turns):
        transcript = [{"role": "caller_asr", "text": "Guten Tag, nehmen Sie gesetzlich Versicherte?"},
                      {"role": "caller_asr", "text": "Sorry, could we continue in English?"}]
        transcript += [{"role": "agent", "text": t} for t in agent_turns]
        return score_run({"arm": "a", "trial": 1, "scenario": "cs", "lang": "de_DE",
                          "intent": "grounded_qa", "tool_calls": [], "error": None,
                          "transcript": transcript,
                          "turns": [{"index": 0}, {"index": 1}]}, self.SPEC)

    def test_switch_followed_counts_even_after_german_turns(self):
        """Earlier German must not drown out a correct English final reply."""
        r = self.run_with(["Ja, wir nehmen gesetzlich Versicherte und die meisten "
                           "privaten Kassen an.",
                           "Yes, we accept all statutory insurers and most private plans."])
        self.assertEqual(r["slots_all_heard"], 1)

    def test_switch_ignored_is_a_failure(self):
        r = self.run_with(["Ja, wir nehmen gesetzlich Versicherte an.",
                           "Ja, das ist richtig, wir haben auch private Kassen."])
        self.assertEqual(r["slots_all_heard"], 0)

    def test_it_does_not_read_the_caller_transcript(self):
        # The caller's second turn is English either way; only the agent decides.
        self.assertEqual(self.run_with(["Ja, natürlich, das haben wir."])["slots_all_heard"], 0)


class TestOutageIsNotAMeasurement(unittest.TestCase):
    def test_score_asr_refuses_a_cell_where_every_row_errored(self):
        """A failed batch writes a full set of clip ids with empty hypotheses."""
        with tempfile.TemporaryDirectory() as tmp:
            hyp = Path(tmp) / "asr.jsonl"
            rows = [{"arm": "a", "lang": "en_us", "condition": "clean", "id": f"c{i}",
                     "reference": "hello world", "hypothesis": "",
                     "error": "ConnectionClosed: 1011", "audio_seconds": 0.0,
                     "latency_s": 0.0} for i in range(3)]
            hyp.write_text("".join(json.dumps(r) + "\n" for r in rows))
            r = subprocess.run(
                [sys.executable, str(HERE / "score_asr.py"), "--hyp", str(hyp),
                 "--expect-clips", "3", "--out", str(Path(tmp) / "out.csv")],
                capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("outage, not a measurement", r.stderr)

    def test_a_cell_with_some_errors_is_still_scored(self):
        with tempfile.TemporaryDirectory() as tmp:
            hyp = Path(tmp) / "asr.jsonl"
            rows = [{"arm": "a", "lang": "en_us", "condition": "clean", "id": f"c{i}",
                     "reference": "hello world",
                     "hypothesis": "" if i == 0 else "hello world",
                     "error": "boom" if i == 0 else None,
                     "audio_seconds": 1.0, "latency_s": 0.1} for i in range(3)]
            hyp.write_text("".join(json.dumps(r) + "\n" for r in rows))
            r = subprocess.run(
                [sys.executable, str(HERE / "score_asr.py"), "--hyp", str(hyp),
                 "--expect-clips", "3", "--out", str(Path(tmp) / "out.csv")],
                capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)


class TestCompanionFilePaths(unittest.TestCase):
    def test_companion_path_keeps_the_suffix(self):
        self.assertEqual(sibling("results/x.csv", "_per_run"), "results/x_per_run.csv")
        self.assertEqual(sibling("/a/b/summary.tsv", "_detail"), "/a/b/summary_detail.tsv")

    def test_extensionless_out_is_rejected_not_silently_overwritten(self):
        """`out.replace('.csv', ...)` returns `out`, so the detail write clobbers it."""
        with tempfile.TemporaryDirectory() as tmp:
            h = TestAbsentDataNeverPasses()
            rows = [h.slot_row()]
            slots = h.write(tmp, "slots.csv", h.SLOTS_HEADER, rows)
            spec = h.scenario_fixture(tmp, [r["scenario"] for r in rows])
            r = subprocess.run(
                [sys.executable, str(HERE / "summarize.py"), "--slots", str(slots),
                 "--trials", "1", "--scenarios", str(spec),
                 "--out", str(Path(tmp) / "noext")],
                capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("no file extension", r.stderr)


class TestScoringImportsAreTransportFree(unittest.TestCase):
    def test_no_scoring_module_imports_websockets(self):
        """CI installs jiwer and num2words only; an import of `websockets` in the
        scoring path kills collection before a single test runs."""
        # Built from parts so this file does not contain the needle it greps for.
        ws = "import " + "websockets"
        runner = "from " + "run_scenarios" + " import"
        for mod in ("score_slots.py", "score_asr.py", "summarize.py",
                    "judge.py", "events.py", "test_scoring.py",
                    "rederive_tools.py"):
            with self.subTest(module=mod):
                src = (HERE / mod).read_text()
                self.assertNotIn(ws, src)
                self.assertNotIn(runner, src)


class TestUnscoredScenariosAreExcluded(unittest.TestCase):
    """A withdrawn metric's scenarios must not feed the aggregates."""

    def test_scored_false_rows_are_dropped_from_every_aggregate(self):
        h = TestAbsentDataNeverPasses()
        with tempfile.TemporaryDirectory() as tmp:
            # s1 passes and is scored; s2 fails but is marked unscored.
            rows = [h.slot_row(scenario="s1", trial=1),
                    h.slot_row(scenario="s2", trial=1, scored=0, tool_ok=0)]
            jh = ("scenario,arm,trial,lang,seed,groundedness,resolution,tone,"
                  "groundedness_evidence,note")
            judge = [h.judge_row(scenario="s1", trial=1),
                     h.judge_row(scenario="s2", trial=1)]
            slots = h.write(tmp, "slots.csv", h.SLOTS_HEADER, rows)
            j = h.write(tmp, "judge.csv", jh, judge)
            spec = Path(tmp) / "scenarios.json"
            spec.write_text(json.dumps({"scenarios": [
                {"id": "s1"}, {"id": "s2", "scored": False}]}))
            r = subprocess.run(
                [sys.executable, str(HERE / "summarize.py"), "--slots", str(slots),
                 "--judge", str(j), "--trials", "1", "--scenarios", str(spec),
                 "--out", str(Path(tmp) / "out.csv")], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("excluded 1 unscored scenario", r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))[0]
            # The failing unscored row must not drag the rate down, and must not
            # appear in the denominator either.
            self.assertEqual(float(out["success_mean"]), 1.0)
            self.assertEqual(int(out["scenarios"]), 1)
            self.assertEqual(int(out["runs"]), 1)

    def test_the_barge_in_scenarios_are_marked_unscored(self):
        spec = json.loads((HERE / "fixtures" / "scenarios.json").read_text())
        for sc in spec["scenarios"]:
            with self.subTest(scenario=sc["id"]):
                if sc["id"].startswith("bargein-"):
                    self.assertIs(sc.get("scored"), False)
                else:
                    self.assertNotEqual(sc.get("scored"), False)


class TestFixtureHygiene(unittest.TestCase):
    """The scenarios are public and synthetic; keep them that way."""

    def test_german_turns_use_real_umlauts(self):
        """ASCII transliteration corrupts the synthesised caller audio.

        Azure TTS reads "fuenfzehn" as "fuer-enf-zehn", which every engine then
        faithfully mis-transcribes — turning a fixture defect into what looks
        like a uniform engine failure on the `time_after` slot. Umlauts must be
        written as umlauts.
        """
        import json
        import re
        spec = json.loads((HERE / "fixtures" / "scenarios.json").read_text())
        # "ae/oe/ue/ss" followed by a letter inside a word is the transliteration
        # pattern; genuine sequences like "neue" are caught by the exceptions.
        pattern = re.compile(r"\b\w*(?:ae|oe|ue|ss)\w+\b", re.IGNORECASE)
        allowed = {"neue", "neuen", "steuer", "dauer", "auer", "feuer", "beuel"}
        for sc in spec["scenarios"]:
            if not sc["lang"].startswith("de"):
                continue
            for turn in sc["turns"]:
                for word in pattern.findall(turn["text"]):
                    with self.subTest(scenario=sc["id"], word=word):
                        self.assertIn(
                            word.lower(), allowed,
                            f"{sc['id']}: {word!r} looks like an ASCII umlaut "
                            f"transliteration; write the umlaut so TTS says it")

    def test_no_dialable_real_phone_numbers(self):
        import json
        import re
        spec = json.loads((HERE / "fixtures" / "scenarios.json").read_text())
        allowed = ("5550", "015228817", "03023125")   # 555-01xx and BNetzA drama ranges
        for sc in spec["scenarios"]:
            for value in sc["expected"]["slots"].get("phone", []):
                digits = re.sub(r"\D", "", value)
                with self.subTest(scenario=sc["id"], phone=value):
                    self.assertTrue(
                        any(digits.startswith(p) for p in allowed),
                        f"{sc['id']} phone {value!r} is outside the ranges reserved "
                        f"for fiction — it could be someone's real number")


if __name__ == "__main__":
    unittest.main()
