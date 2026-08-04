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

import asyncio
import csv
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "prepare"))

from judge import JudgeParseError, parse_verdicts  # noqa: E402
from events import (  # noqa: E402
    function_call, response_cancelled, scenario_filter, scenario_ids,
)
from score_slots import (  # noqa: E402
    detect_lang, fact_present, score_run, slot_present, time_matches,
    times_mentioned,
)
from score_wer import normalize  # noqa: E402
from summarize import pct, sibling  # noqa: E402

# The Track A matrix as the study declares it. Written out rather than derived
# from `results/asr.jsonl`, because an expectation read off the file it checks
# degrades with the file — the defect the `--expect-*` flags exist to close.
# `test_the_documented_asr_axes_match_the_committed_matrix` holds these, the
# README's declarations and the committed data to each other.
ASR_ARMS_ALL = ("native-gpt-realtime-2,native-gpt-realtime-21,"
                "native-gpt-realtime-21-mini,vl-gpt41mini,vl-gpt41mini-dns")
ASR_CONDITIONS = ("cafe_snr0,cafe_snr10,cafe_snr20,cafe_snr5,clean,tel,"
                  "tel_cafe_snr10,tel_loss3")


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

    def test_contracted_negation(self):
        """The normaliser turns "aren't" into "aren t", not "arent"."""
        for utt, fact in [("We aren't open on Saturday.", "open on Saturday"),
                          ("We don't close at 17:00 on Friday.", "17:00 on Friday"),
                          ("We can't do 10:00.", "10:00"),
                          ("We couldn't offer 10:00.", "10:00"),
                          ("We won't be open on Saturday.", "open on Saturday")]:
            with self.subTest(utt=utt):
                self.assertFalse(fact_present([utt], fact, "en"))

    def test_typographic_apostrophe_too(self):
        self.assertFalse(fact_present(["We aren\u2019t open on Saturday."],
                                      "open on Saturday", "en"))

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

    def declared_arms(self, slot_rows):
        """The arm axis these rows are meant to cover.

        Tests that are not about the arm axis declare exactly what they wrote,
        so the declaration is a no-op for them; the ones that *are* about it
        pass `arms=` and declare an arm the rows do not contain.
        """
        return ",".join(sorted({str(r["arm"]) for r in slot_rows}))

    def summarize(self, tmp, slot_rows, judge_rows=None, extra=(), arms=None):
        slots = self.write(tmp, "slots.csv", self.SLOTS_HEADER, slot_rows)
        spec = self.scenario_fixture(tmp, [r["scenario"] for r in slot_rows])
        cmd = [sys.executable, str(HERE / "summarize.py"), "--slots", str(slots),
               "--scenarios", str(spec), "--expect-arms",
               arms if arms is not None else self.declared_arms(slot_rows),
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
                 "--expect-arms", "a",
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
                 "--scenarios", str(spec), "--expect-arms", "a",
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
                 "--scenarios", str(spec), "--expect-arms", "a",
                 "--out", str(Path(tmp) / "out.csv")], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = list(csv.DictReader(fh))[0]
            for col in ("tool_ok", "grounded_ok", "success_mean"):
                with self.subTest(col=col):
                    self.assertEqual(float(out[col]), 0.5)

    def test_run_all_propagates_runner_failure(self):
        """A failed runner must make the matrix script exit non-zero.

        The stub clears the log preflight and fails only when asked to do work,
        so this exercises the run phase rather than stopping at the gate in
        front of it. A stub that failed both would pass this test while proving
        nothing about the runner loop.
        """
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            (data / "conditions").mkdir(parents=True)
            (data / "scenarios").mkdir(parents=True)
            failing = Path(tmp) / "fail.sh"
            failing.write_text('#!/bin/bash\ncase "$*" in *--preflight-logs*)'
                               ' exit 0;; esac\nexit 3\n')
            failing.chmod(0o755)
            r = subprocess.run(
                ["bash", str(HERE / "run_all.sh")],
                # OUT redirects the destructive `: > results/*.jsonl` into tmp.
                # Without it this test truncates the committed results, because
                # run_all.sh cd's to its own directory regardless of cwd — which
                # is exactly what happened the first time it was written.
                env={**os.environ, "DATA": str(data), "PY": str(failing),
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
                   "--expect-arms", "a", "--expect-langs", "en_us",
                   "--expect-conditions", "clean,tel", "--expect-clips", "3",
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
                 "--expect-arms", "a", "--expect-langs", "en_us",
                 "--expect-conditions", "clean",
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
                 "--expect-arms", "a,b", "--expect-langs", "en_us",
                 "--expect-conditions", "clean",
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
                 "--expect-arms", "a", "--expect-langs", "en_us",
                 "--expect-conditions", "tel",
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

    def summarize(self, tmp, slot_rows, trials, extra=(), arms=None):
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
             "--expect-arms",
             arms if arms is not None else self.h.declared_arms(slot_rows),
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

    def test_missing_arm_entirely_is_caught(self):
        """The arm axis is declared, so an arm with no rows at all is a failure.

        It used to be discovered from the data: an arm that never ran produced
        no rows, therefore no arm entry, therefore no check that could fire —
        the same shape as a globally missing scenario, on the axis check #5b did
        not cover. Declaring the axis is what makes the absence visible.
        """
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(arm="a", trial=t) for t in (1, 2)]
            r = self.summarize(tmp, rows, trials=2, arms="a,b")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("b/s1", r.stderr)

    def test_a_declared_arm_with_no_rows_stays_in_the_denominator(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(arm="a", trial=t) for t in (1, 2)]
            r = self.summarize(tmp, rows, trials=2, arms="a,b",
                               extra=("--allow-incomplete",))
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(Path(tmp) / "out.csv") as fh:
                out = {x["arm"]: x for x in csv.DictReader(fh)}
            self.assertEqual(sorted(out), ["a", "b"])
            self.assertEqual(float(out["b"]["success_mean"]), 0.0)
            self.assertEqual(int(out["b"]["missing_runs"]), 2)

    def test_results_cannot_introduce_an_arm_the_declaration_lacks(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [self.h.slot_row(arm=arm, trial=1) for arm in ("a", "rogue")]
            r = self.summarize(tmp, rows, trials=1, arms="a")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("rogue", r.stderr)

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
                 "--trials", "2", "--scenarios", str(spec), "--expect-arms", "a,b",
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
                 "--expect-arms", "a",
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
                 "--trials", "1", "--scenarios", str(spec), "--expect-arms", "a",
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


class TestCancellationAttribution(unittest.TestCase):
    """A cancelled response is not the turn's answer."""

    def test_runner_does_not_mark_a_cancelled_response_done(self):
        src = (HERE / "run_scenarios.py").read_text()
        # The cancelled branch must reset the turn and keep waiting; only the
        # non-cancelled branch may set `done`.
        self.assertIn("cur.first_audio_t = None", src)
        self.assertIn("del result[\"transcript\"][cur.transcript_mark:]", src)
        cancelled_block = src.split("if response_cancelled(ev):")[1].split("else:")[0]
        self.assertNotIn("cur.done = True", cancelled_block)

    def test_no_committed_run_has_a_negative_ttfa_in_the_scored_set(self):
        """A negative time-to-first-audio is proof of mis-attribution."""
        path = HERE / "results" / "slots.csv"
        if not path.exists():
            self.skipTest("no committed results")
        with open(path) as fh:
            rows = list(csv.DictReader(fh))
        bad = []
        for r in rows:
            if r.get("ttfa_trustworthy") == "0":
                continue          # excluded from the percentiles by design
            for v in (r.get("ttfa_ms_all") or "").split(";"):
                if v and float(v) < 0:
                    bad.append((r["arm"], r["scenario"], r["trial"], v))
        self.assertEqual(bad, [], f"negative TTFA in trusted rows: {bad[:5]}")


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
                 "--expect-arms", "a", "--expect-langs", "en_us",
                 "--expect-conditions", "clean",
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
                 "--expect-arms", "a", "--expect-langs", "en_us",
                 "--expect-conditions", "clean",
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
                 "--trials", "1", "--scenarios", str(spec), "--expect-arms", "a",
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
                    "rederive_tools.py", "check_report.py"):
            with self.subTest(module=mod):
                src = (HERE / mod).read_text()
                self.assertNotIn(ws, src)
                self.assertNotIn(runner, src)

    def test_no_test_shells_out_to_a_transport_importing_module(self):
        """Importing the runner is not the only way to depend on its transport.

        A test that invokes `run_scenarios.py` as a subprocess to exercise a
        pure validation fails on CI with ModuleNotFoundError — which is how the
        `--only` validation test first broke the build. It passed locally only
        because the developer's venv happens to have `websockets` installed;
        the check above could not see it, because the dependency was in an
        argument list rather than an import.
        """
        import ast
        transport = {"run_scenarios.py", "run_asr.py", "probe_session.py",
                     "probe_dns.py"}
        tree = ast.parse((HERE / "test_scoring.py").read_text())
        offenders = []
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "run"
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "subprocess"):
                continue
            # Reading one of these files as *text* is fine — several tests do,
            # to assert on their source. Executing one is not.
            for c in ast.walk(node):
                if (isinstance(c, ast.Constant) and isinstance(c.value, str)
                        and c.value in transport):
                    offenders.append((c.value, node.lineno))
        self.assertEqual(
            offenders, [],
            "these tests execute a module that imports the websocket client CI "
            "does not install. Extract the pure part into events.py and test "
            "that instead.")


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
                 "--expect-arms", "a",
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


class TestRederiveIsDedupeOnly(unittest.TestCase):
    """`rederive_tools.py` may collapse repeats and do nothing else."""

    def run_tool(self, tmp, runs, logs):
        logdir = Path(tmp) / "logs"
        logdir.mkdir(exist_ok=True)
        for name, calls in logs.items():
            with open(logdir / f"sc-a-{name}-t1.jsonl", "w") as f:
                for i, c in enumerate(calls):
                    f.write(json.dumps({"t": 0, "ev": {
                        "type": "response.function_call_arguments.done",
                        "call_id": f"c{i}", "name": c}}) + "\n")
        rp = Path(tmp) / "runs.jsonl"
        rp.write_text("".join(json.dumps(r) + "\n" for r in runs))
        r = subprocess.run(
            [sys.executable, str(HERE / "rederive_tools.py"), "--runs", str(rp),
             "--logdir", str(logdir)], capture_output=True, text=True)
        return r, [json.loads(l) for l in open(rp)]

    def test_duplicates_are_collapsed(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, out = self.run_tool(
                tmp, [{"arm": "a", "scenario": "s", "trial": 1,
                       "tool_calls": ["end_call", "end_call"]}],
                {"s": ["end_call"]})
            self.assertEqual(out[0]["tool_calls"], ["end_call"])

    def test_a_reordering_is_refused(self):
        """Same calls, different order, identical sets.

        The guard compared sets, so a reordering passed as a "deduplication"
        and the run's tool sequence was replaced by the log's. Order carries
        scoring meaning in the multi-tool scenarios, and membership is a weaker
        property than the sequence it was standing in for.
        """
        with tempfile.TemporaryDirectory() as tmp:
            r, out = self.run_tool(
                tmp, [{"arm": "a", "scenario": "s", "trial": 1,
                       "tool_calls": ["lookup", "end_call"]}],
                {"s": ["end_call", "lookup"]})
            self.assertEqual(out[0]["tool_calls"], ["lookup", "end_call"],
                             "the run's order was overwritten by the log's")
            self.assertIn("reordered", r.stderr)

    def test_a_reordering_with_repeats_is_still_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, out = self.run_tool(
                tmp, [{"arm": "a", "scenario": "s", "trial": 1,
                       "tool_calls": ["lookup", "lookup", "end_call"]}],
                {"s": ["end_call", "lookup"]})
            self.assertEqual(out[0]["tool_calls"],
                             ["lookup", "lookup", "end_call"])

    def test_a_log_missing_a_call_is_refused(self):
        """A partial log must not delete a tool call the run recorded."""
        with tempfile.TemporaryDirectory() as tmp:
            r, out = self.run_tool(
                tmp, [{"arm": "a", "scenario": "s", "trial": 1,
                       "tool_calls": ["end_call", "other"]}],
                {"s": ["end_call"]})
            self.assertEqual(out[0]["tool_calls"], ["end_call", "other"])
            self.assertIn("missing=['other']", r.stderr)

    def test_a_log_inventing_a_call_is_refused(self):
        """The contract is dedupe-only: additions are as wrong as deletions."""
        with tempfile.TemporaryDirectory() as tmp:
            r, out = self.run_tool(
                tmp, [{"arm": "a", "scenario": "s", "trial": 1,
                       "tool_calls": ["end_call"]}],
                {"s": ["end_call", "invented"]})
            self.assertEqual(out[0]["tool_calls"], ["end_call"])
            self.assertIn("extra=['invented']", r.stderr)

    def test_a_refusal_reaches_the_exit_status(self):
        """A refused row must not report success. The guard's own shadow.

        Refusing the rewrite was the fix; the refusal being invisible to
        automation is the same class one step further out. The tool printed
        `rewrote N runs` and exited 0, so a caller chaining
        `rederive_tools.py && summarize.py` scored a partial repair as a
        complete one — and a refused row is byte-identical to a row that needed
        no repair, so nothing downstream could tell.
        """
        with tempfile.TemporaryDirectory() as tmp:
            # One row that deduplicates cleanly, one the log contradicts.
            r, out = self.run_tool(
                tmp, [{"arm": "a", "scenario": "ok", "trial": 1,
                       "tool_calls": ["end_call", "end_call"]},
                      {"arm": "a", "scenario": "bad", "trial": 1,
                       "tool_calls": ["end_call"]}],
                {"ok": ["end_call"], "bad": ["end_call", "invented"]})
            self.assertNotEqual(r.returncode, 0,
                                "a partial re-derivation exited 0")
            self.assertIn("were NOT re-derived", r.stderr)
            self.assertIn("a/bad/t1", r.stderr)
            # The good row is still repaired and the refused one untouched:
            # partial repair is safe, silent partial repair is not.
            self.assertEqual(out[0]["tool_calls"], ["end_call"])
            self.assertEqual(out[1]["tool_calls"], ["end_call"])
            # ...and the count must not overclaim.
            self.assertIn("rewrote 1 of 2 runs", r.stdout)

    def test_a_missing_log_also_reaches_the_exit_status(self):
        """"I could not check this row" is not "this row was fine"."""
        with tempfile.TemporaryDirectory() as tmp:
            r, out = self.run_tool(
                tmp, [{"arm": "a", "scenario": "absent", "trial": 1,
                       "tool_calls": ["end_call"]}], {})
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("no log at", r.stderr)
            self.assertEqual(out[0]["tool_calls"], ["end_call"])

    def test_a_complete_rederivation_still_exits_zero(self):
        """The refusal must be the signal, not the mere act of running."""
        with tempfile.TemporaryDirectory() as tmp:
            r, out = self.run_tool(
                tmp, [{"arm": "a", "scenario": "s", "trial": 1,
                       "tool_calls": ["end_call", "end_call"]}],
                {"s": ["end_call"]})
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(out[0]["tool_calls"], ["end_call"])

    def test_a_log_inventing_a_SECOND_call_of_a_known_name_is_refused(self):
        """Codex on 70bfd10: re-derivation could add an `end_call`.

        Two distinct call ids carrying the same function name rebuild as
        ["end_call", "end_call"], whose distinct-names-in-order is identical to
        ["end_call"]'s — so the guard saw no difference and wrote the longer
        sequence back. That is not deduplication, it is fabrication, and it
        fabricates the exact event whose reliability this study reports on.

        Every guard tried here so far compared *names*; this difference is only
        in the count, which is why `is_deduplication` requires the rewrite to be
        a subsequence of what the run recorded.
        """
        with tempfile.TemporaryDirectory() as tmp:
            logdir = Path(tmp) / "logs"
            logdir.mkdir()
            with open(logdir / "sc-a-s-t1.jsonl", "w") as f:
                for cid in ("call_1", "call_2"):   # one name, two invocations
                    f.write(json.dumps({"t": 0, "ev": {
                        "type": "response.function_call_arguments.done",
                        "call_id": cid, "name": "end_call"}}) + "\n")
            rp = Path(tmp) / "runs.jsonl"
            rp.write_text(json.dumps({"arm": "a", "scenario": "s", "trial": 1,
                                      "tool_calls": ["end_call"]}) + "\n")
            r = subprocess.run(
                [sys.executable, str(HERE / "rederive_tools.py"), "--runs",
                 str(rp), "--logdir", str(logdir)], capture_output=True, text=True)
            out = [json.loads(l) for l in open(rp)]
            self.assertEqual(out[0]["tool_calls"], ["end_call"],
                             "re-derivation invented a second end_call")
            self.assertIn("inflated=['end_call 1->2']", r.stderr)

    def test_a_genuine_second_call_survives_a_dedupe_of_another_tool(self):
        """The refusal must not be "any repeat is suspicious"."""
        with tempfile.TemporaryDirectory() as tmp:
            logdir = Path(tmp) / "logs"
            logdir.mkdir()
            with open(logdir / "sc-a-s-t1.jsonl", "w") as f:
                for cid, name in (("c1", "lookup"), ("c2", "lookup"),
                                  ("c3", "end_call")):
                    f.write(json.dumps({"t": 0, "ev": {
                        "type": "response.function_call_arguments.done",
                        "call_id": cid, "name": name}}) + "\n")
            rp = Path(tmp) / "runs.jsonl"
            rp.write_text(json.dumps(
                {"arm": "a", "scenario": "s", "trial": 1,
                 # The runner logged each of the three invocations twice.
                 "tool_calls": ["lookup", "lookup", "lookup", "lookup",
                                "end_call", "end_call"]}) + "\n")
            r = subprocess.run(
                [sys.executable, str(HERE / "rederive_tools.py"), "--runs",
                 str(rp), "--logdir", str(logdir)], capture_output=True, text=True)
            out = [json.loads(l) for l in open(rp)]
            self.assertEqual(out[0]["tool_calls"],
                             ["lookup", "lookup", "end_call"], r.stderr)

    def test_dropping_the_first_of_two_is_refused(self):
        """A set-preserving subsequence can still reorder by deleting."""
        from rederive_tools import is_deduplication
        self.assertFalse(is_deduplication(["a", "b", "a"], ["b", "a"]))
        self.assertTrue(is_deduplication(["a", "b", "a"], ["a", "b"]))
        self.assertFalse(is_deduplication(["end_call"], ["end_call", "end_call"]))
        self.assertTrue(is_deduplication(["end_call", "end_call"], ["end_call"]))


class TestDecliningWorkReachesTheExitStatus(unittest.TestCase):
    """A tool that skips, refuses or partly completes must say so in `$?`.

    `rederive_tools.py` refused to apply a bad log and then printed
    `rewrote N runs` and exited 0 — a silent failure wearing a safety fix's
    clothes. That is exercised directly in `TestRederiveIsDedupeOnly`; this
    class sweeps the rest of the CLIs for the same shape.

    The three transport-importing ones cannot be executed here (see
    `test_no_test_shells_out_to_a_transport_importing_module`), so they are
    pinned against their source, which is the same convention
    `test_run_asr_never_records_a_falsy_error` uses. Weaker than running them,
    and stated as such — the point is that removing the guard has to show up in
    a diff rather than in nothing.
    """

    def test_probe_session_fails_when_an_arm_does_not_pass(self):
        """README step 3 gates a paid run; it used to exit 0 whatever it found.

        `probe(...)` reports failures inside its JSON rather than raising, so
        every arm could come back unreachable and `probe_session.py && ./run_all.sh`
        would still spend on the matrix.
        """
        src = (HERE / "probe_session.py").read_text()
        self.assertIn('if res.get("exception"):', src)
        self.assertIn('elif res.get("errors"):', src)
        self.assertIn("did not pass the ", src)
        self.assertIn("failed.append(", src)
        # A --wav that round-trips nothing is the case the flag exists for.
        self.assertIn("no transcript came back", src)

    def test_the_preflight_probes_each_arm_with_a_payload_it_accepts(self):
        """A false alarm is not a safer failure than a silent pass.

        Making the pre-flight exit non-zero was right; sending every arm the
        ASR payload was not. README step 3 runs without `--arms`, so it probed
        `vl-native-brain` and `vl-native-brain-21` with `session_asr` — a
        combination Voice Live is *documented* to reject, and which the study
        never uses on those arms. The expected refusal was then recorded as a
        failed arm, so the documented pre-flight failed deterministically on
        valid arms. A check that cries wolf is the one that gets switched off.

        The capability is declared on the arm rather than discovered by sending
        a payload known to be rejected.
        """
        from engines import ARMS
        for name in ("vl-native-brain", "vl-native-brain-21"):
            with self.subTest(arm=name):
                self.assertFalse(ARMS[name].asr_manual_commit)
        # Everything run_all.sh puts in ASR_ARMS must still be probed as ASR.
        run_all = (HERE / "run_all.sh").read_text()
        declared = re.search(r'ASR_ARMS="\$\{ASR_ARMS:-([^}]*)\}"', run_all)
        self.assertIsNotNone(declared, "run_all.sh declares no ASR_ARMS")
        for name in declared.group(1).split():
            with self.subTest(arm=name):
                self.assertTrue(
                    ARMS[name].asr_manual_commit,
                    f"{name} is in ASR_ARMS but declared unable to do Track A")
        src = (HERE / "probe_session.py").read_text()
        self.assertIn("if arm.asr_manual_commit", src)
        self.assertIn("arm.session_dialog(MARKER", src)

    def test_the_preflight_fails_a_session_that_was_never_accepted(self):
        """`accepted: false` with no exception and no error events.

        A bare timeout waiting for `session.updated` produces exactly that, and
        it matched none of the failure branches — so a session that was never
        established passed the pre-flight. Found in the file the sweep for this
        very class had just edited, which is why it is in COMPLETENESS.md.
        """
        src = (HERE / "probe_session.py").read_text()
        self.assertIn('elif not res.get("accepted"):', src)
        self.assertIn("never accepted", src)
        # The transcript branch must come after it, or an unaccepted session
        # would be reported as a missing transcript instead.
        self.assertLess(src.index('elif not res.get("accepted"):'),
                        src.index("no transcript came back"))

    def test_probe_dns_separates_an_outage_from_the_finding(self):
        """Its empty-transcript rate IS the published result, so a lost session
        and the effect it measures produce the same row. Only the recorded
        error, and the exit status, tell them apart."""
        src = (HERE / "probe_dns.py").read_text()
        self.assertIn('"error": err', src)
        self.assertIn("no transcription event for this clip", src)
        self.assertIn("if errored :=", src)
        self.assertIn("not because the engine ", src)

    def test_prepare_fleurs_refuses_a_short_corpus(self):
        src = (HERE / "prepare" / "prepare_fleurs.py").read_text()
        self.assertIn("if n < args.n:", src)
        self.assertIn("is SHORT", src)

    def test_every_cli_that_collects_failures_exits_on_them(self):
        """Mechanical backstop: a module that builds a list of failures and
        never reaches `sys.exit` has collected them for nobody.

        Only catches the shape where failures are accumulated in a named list —
        which is every instance found so far, including the one that prompted
        this class — and is honest about that reach: it would not catch a tool
        that never noticed the failure at all.
        """
        import ast
        names = {"failed", "failures", "declined", "problems", "gaps",
                 "integrity", "exhausted", "errored", "missing_legs"}
        for mod in sorted(p.name for p in HERE.glob("*.py")
                          if p.name != "test_scoring.py"):
            src = (HERE / mod).read_text()
            tree = ast.parse(src)
            appended = {
                n.func.value.id
                for n in ast.walk(tree)
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                and n.func.attr == "append" and isinstance(n.func.value, ast.Name)
                and n.func.value.id in names
            }
            if not appended:
                continue
            with self.subTest(module=mod, collects=sorted(appended)):
                exits = [n for n in ast.walk(tree)
                         if isinstance(n, ast.Call) and (
                             (isinstance(n.func, ast.Attribute)
                              and n.func.attr == "exit")
                             or (isinstance(n.func, ast.Name)
                                 and n.func.id == "SystemExit"))]
                self.assertTrue(
                    exits,
                    f"{mod} accumulates {sorted(appended)} and never exits "
                    "non-zero, so whatever it collected reaches nobody")


class TestHangsAreBounded(unittest.TestCase):
    """Every wait in the runners has a bound. Two hangs found by two routes."""

    def test_transport_bounds_are_set(self):
        import engines
        kw = engines.transport_kwargs()
        for k in ("open_timeout", "ping_interval", "ping_timeout"):
            with self.subTest(kw=k):
                self.assertIsInstance(kw.get(k), (int, float))
                self.assertGreater(kw[k], 0)

    def test_inspecting_transport_bounds_needs_no_credentials(self):
        """The timeout policy is a property of the harness, not of whoever is
        logged in. Run in a subprocess with no Azure key and no `az` on PATH —
        which is what a CI runner looks like, and is how this was caught."""
        env = {k: v for k, v in os.environ.items()
               if k not in ("AZURE_AI_KEY", "PATH")}
        env["PATH"] = "/nonexistent"
        r = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0, %r); import engines; "
             "print(sorted(engines.transport_kwargs()))" % str(HERE)],
            capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("open_timeout", r.stdout)

    def test_first_receive_is_bounded_not_open_ended(self):
        """`open_timeout` covers the handshake only, not the first message."""
        for mod in ("run_scenarios.py", "run_asr.py"):
            with self.subTest(module=mod):
                src = (HERE / mod).read_text()
                at = src.index("async with websockets.connect")
                head = src[at:at + 1400]
                self.assertIn("asyncio.wait_for(ws.recv()", head)
                self.assertIn("timeout=", head)

    def test_blocking_subprocesses_carry_their_own_timeout(self):
        """`asyncio.wait_for` cannot fire while the event loop is blocked, so a
        synchronous subprocess on that thread is invisible to the outer bound."""
        import re
        for mod, const in (("engines.py", "AZ_CLI_TIMEOUT_S"),
                           ("run_scenarios.py", "FFMPEG_TIMEOUT_S"),
                           ("run_asr.py", "FFMPEG_TIMEOUT_S"),
                           ("probe_session.py", "FFMPEG_TIMEOUT_S"),
                           ("probe_dns.py", "FFMPEG_TIMEOUT_S")):
            with self.subTest(module=mod):
                src = (HERE / mod).read_text()
                self.assertIn(const, src)
                for call in re.finditer(r"subprocess\.run\((.*?)\)\s*[.\n]", src, re.S):
                    self.assertIn("timeout=", call.group(1),
                                  f"{mod}: a subprocess.run without a timeout")

    def test_a_timeout_reports_which_bound_fired(self):
        """Both runners, not just the one where this was first found.

        The inner `ws.recv()` waits raise the same `asyncio.TimeoutError` as the
        outer wall-clock bound, so a handler that names the outer bound
        unconditionally misstates cause and duration together. It was fixed in
        `run_scenarios.py` first and `run_asr.py` kept the old shape for a round;
        that is why this test iterates.
        """
        for mod, outer in (("run_scenarios.py", "outer wall-clock bound"),
                           ("run_asr.py", "outer BATCH_HARD_TIMEOUT_S bound")):
            with self.subTest(module=mod):
                src = (HERE / mod).read_text()
                self.assertIn(outer, src)
                self.assertIn("not the outer bound", src)
                # ...and the measured duration, not the nominal one.
                self.assertIn("timeout after {elapsed:.1f}s", src)
                self.assertIn("elapsed = time.time() - t_start", src)
        scen = (HERE / "run_scenarios.py").read_text()
        self.assertNotIn("hard timeout after {SCENARIO_HARD_TIMEOUT_S}s", scen)
        asr = (HERE / "run_asr.py").read_text()
        self.assertNotIn("batch exceeded BATCH_HARD_TIMEOUT_S", asr,
                         "run_asr.py still attributes every TimeoutError to the "
                         "900-second bound")

    def test_an_asr_timeout_reason_is_never_falsy(self):
        """`str(TimeoutError())` is "", and score_asr.py tests `error` for truth,
        so an empty reason turns an outage back into a 100 %-WER data point."""
        src = (HERE / "run_asr.py").read_text()
        self.assertIn('str(e) or f"{type(e).__name__} (no message)"', src)
        self.assertIn('"error": reason', src)

    def test_each_runner_has_an_outer_wall_clock_bound(self):
        """Belt-and-braces: no step-specific timeout can cover a step nobody
        thought of, so the whole unit is bounded too."""
        sc = (HERE / "run_scenarios.py").read_text()
        self.assertIn("SCENARIO_HARD_TIMEOUT_S", sc)
        self.assertIn("asyncio.wait_for(\n                    run_scenario(", sc)
        self.assertIn("timeout after", sc)
        asr = (HERE / "run_asr.py").read_text()
        self.assertIn("BATCH_HARD_TIMEOUT_S", asr)
        self.assertIn("transcribe_batch(a.arm, a.lang, clips, log),", asr)


class TestFailuresAreNeverFalsy(unittest.TestCase):
    """`score_asr.py` tells an outage from an empty transcript by truthiness."""

    def test_timeout_error_stringifies_empty(self):
        # The premise of the bug, pinned so nobody "simplifies" the fix away.
        self.assertEqual(str(asyncio.TimeoutError()), "")

    def test_run_asr_never_records_a_falsy_error(self):
        src = (HERE / "run_asr.py").read_text()
        self.assertIn('reason = str(e) or f"{type(e).__name__} (no message)"', src)
        self.assertIn('"error": reason,', src)
        self.assertNotIn('"error": str(e),', src)

    def test_documented_scoring_command_matches_the_committed_matrix(self):
        """A report whose scoring step can't be re-run from its own README is
        the reproducibility problem this harness already fixed once."""
        readme = (HERE / "README.md").read_text()
        line = next(l for l in readme.splitlines() if "score_asr.py" in l and "--hyp" in l)
        self.assertIn("--allow-incomplete", line,
                      "the committed matrix is asymmetric; without this the "
                      "documented command aborts and writes nothing")


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


class TestTrackAGapsAreVisible(unittest.TestCase):
    """`complete` must be able to be 0, and the runner must not eat the data."""

    def _workflow_commands(self) -> list[str]:
        """The README's bash block, comments and blanks stripped.

        Assertions about the workflow must read the commands, not the prose
        describing them: the surrounding comments name every step in whatever
        order reads best, so matching against the raw block tests the writing
        rather than the procedure.

        Backslash continuations are joined for the same reason. A command split
        across lines is one command, and a test that reads it line-by-line is
        reading the formatting: rewrapping an invocation would silently move an
        argument out of view of whatever was searching for it.
        """
        import re
        block = re.search(r"```bash\n(.*?)```",
                          (HERE / "README.md").read_text(), re.S)
        self.assertIsNotNone(block, "no bash block in the README")
        joined = re.sub(r"\\\n\s*", " ", block.group(1))
        return [l for l in joined.splitlines()
                if l.strip() and not l.strip().startswith("#")]

    def test_absent_cells_are_emitted_with_complete_zero(self):
        """The scorer iterated only the groups that existed.

        So an absent (arm, condition) cell produced no row, every row carried
        complete=1, and `complete` could never be 0 — a consumer trusting the
        documented signal saw a complete matrix because the gaps were invisible,
        not because they were filled. Absent data reading as complete, in the
        field named `complete`.
        """
        with (HERE / "results" / "asr_scores.csv").open() as f:
            rows = list(csv.DictReader(f))
        arms = {r["arm"] for r in rows}
        langs = {r["lang"] for r in rows}
        conds = {r["condition"] for r in rows}
        self.assertEqual(len(rows), len(arms) * len(langs) * len(conds),
                         "the CSV is not the full cross-product, so an absent "
                         "cell is still invisible rather than complete=0")
        incomplete = [r for r in rows if r["complete"] == "0"]
        self.assertTrue(incomplete, "no cell reports complete=0, but the "
                                    "committed matrix is asymmetric by design")
        for r in incomplete:
            self.assertEqual(r["n"], "0")
            self.assertEqual(r["wer"], "", "an absent cell must have no WER")

    def test_an_entirely_absent_axis_is_not_a_complete_matrix(self):
        """Codex on 70bfd10: the checker's own expectation came from its input.

        The cross-product was built from the arms, languages and conditions
        *present in the rows*, so a value missing from every row never entered
        it. Delete every `tel_loss3` row — one condition failing before it could
        write anything — and no cell was expected for it, nothing was reported,
        and `--allow-incomplete` exited 0 with every visible cell marked
        complete. The signature defect of this harness, inside the completeness
        checker: a checker that derives its expectations from the data cannot
        detect missing data.

        Both directions, because a declaration is only as good as its coupling
        to the file: a condition in the data that the declaration never named is
        equally a disagreement about what study this is.
        """
        rows = [json.loads(l) for l in
                (HERE / "results" / "asr.jsonl").read_text().splitlines() if l.strip()]

        def score(rs, conditions=ASR_CONDITIONS):
            with tempfile.TemporaryDirectory() as tmp:
                hyp = Path(tmp) / "asr.jsonl"
                hyp.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n"
                                       for r in rs))
                return subprocess.run(
                    [sys.executable, str(HERE / "score_asr.py"), "--hyp", str(hyp),
                     "--expect-clips", "25", "--allow-incomplete",
                     "--expect-arms", ASR_ARMS_ALL, "--expect-langs", "en_us,de_de",
                     "--expect-conditions", conditions,
                     "--out", str(Path(tmp) / "out.csv")],
                    capture_output=True, text=True, cwd=str(HERE),
                    env={"PATH": "/usr/bin:/bin"})

        self.assertEqual(score(rows).returncode, 0, "the committed run no longer scores")

        # A whole condition that never produced a row.
        thinned = [r for r in rows if r["condition"] != "tel_loss3"]
        self.assertTrue(len(thinned) < len(rows), "the fixture lost its premise")
        r = score(thinned)
        self.assertNotEqual(r.returncode, 0,
                            "a condition absent from every row was certified complete")
        self.assertIn("tel_loss3", r.stderr)

        # And the same for an arm.
        r = score([r for r in rows if r["arm"] != "vl-gpt41mini-dns"])
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("vl-gpt41mini-dns", r.stderr)

        # The other direction: data the declaration does not name.
        r = score(rows, conditions="clean,tel")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not declared", r.stderr)

    def test_a_declared_axis_may_not_repeat_or_be_empty(self):
        """The fix must not reproduce the class it is fixing.

        A repeated name inflates the declared matrix while covering nothing
        extra; an empty list makes the expected cross-product empty, so no cell
        can be missing and every cell is a rogue. Malformed is not absent — the
        confusion this harness has now produced in `--only`, `--arms`,
        `CONDITIONS` and `--conditions`.
        """
        with tempfile.TemporaryDirectory() as tmp:
            hyp = Path(tmp) / "asr.jsonl"
            hyp.write_text(json.dumps(
                {"arm": "a", "lang": "en_us", "condition": "clean", "id": "c0",
                 "reference": "hello", "hypothesis": "hello", "error": None,
                 "audio_seconds": 1.0, "latency_s": 0.1}) + "\n")

            def score(**over):
                args = {"--expect-arms": "a", "--expect-langs": "en_us",
                        "--expect-conditions": "clean", **over}
                return subprocess.run(
                    [sys.executable, str(HERE / "score_asr.py"), "--hyp", str(hyp),
                     "--expect-clips", "1", "--out", str(Path(tmp) / "out.csv")]
                    + [x for kv in args.items() for x in kv],
                    capture_output=True, text=True)

            self.assertEqual(score().returncode, 0, score().stderr)
            r = score(**{"--expect-conditions": "clean,clean"})
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("more than once", r.stderr)
            r = score(**{"--expect-arms": ","})
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("names nothing", r.stderr)

    def test_allow_incomplete_does_not_excuse_an_outage(self):
        """Codex, on 2f4abfc: one flag suppressed two different things.

        `--allow-incomplete` exists because the committed matrix is asymmetric
        by design, so the documented workflow *always* passes it. Outages,
        duplicate clip ids and cross-arm clip-set mismatches shared the same
        `problems` list, so following the README could publish an exhausted
        runner as a complete 100 % WER cell — precisely the failure checks #2a
        and #11 exist to prevent, defeated by the flag next to them.

        A missing cell is a statement about coverage, which the flag may
        relax. An outage is a statement about whether the numbers mean
        anything, which nothing may.
        """
        rows = [json.loads(l) for l in
                (HERE / "results" / "asr.jsonl").read_text().splitlines()
                if l.strip()]

        def score(mutate):
            with tempfile.TemporaryDirectory() as tmp:
                hyp = Path(tmp) / "asr.jsonl"
                hyp.write_text("".join(
                    json.dumps(mutate(dict(r)), ensure_ascii=False) + "\n"
                    for r in rows))
                return subprocess.run(
                    [sys.executable, str(HERE / "score_asr.py"), "--hyp",
                     str(hyp), "--expect-clips", "25", "--allow-incomplete",
                     # Literal, not read off `rows`: an axis taken from the data
                     # under test is the defect this declaration exists to fix,
                     # and it would follow the mutation instead of catching it.
                     # test_the_documented_asr_axes_match_the_committed_matrix
                     # pins these against the README and the committed file.
                     "--expect-arms", ASR_ARMS_ALL,
                     "--expect-langs", "en_us,de_de",
                     "--expect-conditions", ASR_CONDITIONS,
                     "--out", str(Path(tmp) / "out.csv")],
                    capture_output=True, text=True, cwd=str(HERE),
                    env={"PATH": "/usr/bin:/bin"})

        # The committed matrix, asymmetric by design, still scores.
        self.assertEqual(score(lambda r: r).returncode, 0,
                         "the committed run no longer scores")

        # One cell turned into an outage must not.
        def outage(r):
            if (r["arm"], r["lang"], r["condition"]) == (
                    "native-gpt-realtime-2", "en_us", "clean"):
                r["error"], r["hypothesis"] = "transport outage", ""
            return r

        r = score(outage)
        self.assertNotEqual(r.returncode, 0,
                            "--allow-incomplete published an outage as a 100 % "
                            "WER cell")
        self.assertIn("not gaps in coverage", r.stderr + r.stdout)

    def test_the_readme_documents_the_signal_the_scorer_emits(self):
        readme = (HERE / "README.md").read_text()
        self.assertIn("complete=0", readme)
        self.assertIn("--allow-incomplete", readme)

    def _fake_run_all(self, tmp, **env):
        """Run run_all.sh with a stub interpreter, capturing the invocations."""
        log = Path(tmp) / "calls.txt"
        py = Path(tmp) / "fakepy"
        py.write_text('#!/bin/bash\necho "INVOKED: $*" >> "%s"\n' % log)
        py.chmod(0o755)
        base = {"PATH": "/usr/bin:/bin", "DATA": "/x", "OUT": tmp,
                "PY": str(py), "APPEND": "1"}
        base.update(env)
        subprocess.run(["/bin/bash", str(HERE / "run_all.sh")],
                       capture_output=True, text=True, cwd=str(HERE), env=base)
        return log.read_text() if log.exists() else ""

    def test_conditions_and_scenario_filter_are_overrideable(self):
        """The documented extension commands must reach the runners.

        CONDITIONS was a bare assignment, so the documented override was ignored
        and the extension ran all eight conditions — 800 ASR rows where the
        reports describe 600, at the service's expense, and unable to reproduce
        the committed matrix. There was no scenario filter at all, so the three
        new arms would run 11 scenarios each (99 runs) rather than the 9 scored
        ones (81).
        """
        with tempfile.TemporaryDirectory() as tmp:
            out = self._fake_run_all(
                tmp, TRACK="a", ASR_ARMS="native-gpt-realtime-21",
                CONDITIONS="clean,cafe_snr10,cafe_snr5,cafe_snr0,tel,tel_cafe_snr10")
            self.assertIn("--conditions clean,cafe_snr10,cafe_snr5,cafe_snr0,"
                          "tel,tel_cafe_snr10", out)
            self.assertNotIn("cafe_snr20", out)
            self.assertNotIn("tel_loss3", out)
        with tempfile.TemporaryDirectory() as tmp:
            out = self._fake_run_all(
                tmp, TRACK="b", TRIALS="1", SC_ARMS="native-gpt-realtime-21",
                ONLY="book-de-01,hours-en-01")
            self.assertIn("--only book-de-01,hours-en-01", out)
        with tempfile.TemporaryDirectory() as tmp:
            # No ONLY means no filter, not an empty one.
            out = self._fake_run_all(tmp, TRACK="b", TRIALS="1",
                                     SC_ARMS="vl-gpt41mini")
            self.assertNotIn("--only", out)

    def test_the_readme_extension_reproduces_the_committed_matrix(self):
        """The documented arms and scenarios must match what results/ holds."""
        import re
        readme = (HERE / "README.md").read_text()
        with (HERE / "results" / "scenarios.jsonl").open() as f:
            runs = [json.loads(l) for l in f]
        new = {"native-gpt-realtime-21", "native-gpt-realtime-21-mini",
               "vl-native-brain-21"}
        scenarios = {r["scenario"] for r in runs if r["arm"] in new}
        m = re.search(r'ONLY="([^"]+)"', readme)
        self.assertIsNotNone(m, "the README states no scenario filter")
        self.assertEqual(set(m.group(1).split(",")), scenarios,
                         "the documented ONLY list does not match the scenarios "
                         "the new arms actually ran")
        conds = {r["condition"] for r in
                 (json.loads(l) for l in
                  (HERE / "results" / "asr.jsonl").read_text().splitlines())
                 if r["arm"] == "native-gpt-realtime-21"}
        m = re.search(r'CONDITIONS="([^"]+)"', readme)
        self.assertIsNotNone(m)
        self.assertEqual(set(m.group(1).split(",")), conds)

    def test_the_documented_workflow_never_writes_to_committed_results(self):
        """Once OUT is introduced, every path must go through it.

        Step 4 wrote the fresh run to $OUT while step 5 still used bare
        `results/...`, which resolves against bench/quality because the earlier
        `cd` is still in effect. Following the workflow therefore scored the
        committed data and overwrote the committed CSVs with the result — the
        destruction the truncation guard prevents in step 4, arriving through
        path resolution instead of a truncating command.

        Checked as a shape rather than a line: no command after OUT appears may
        name `results/` without `$OUT`.
        """
        lines = self._workflow_commands()
        out_at = next((i for i, l in enumerate(lines) if "OUT=" in l), None)
        self.assertIsNotNone(out_at, "the workflow never sets OUT")
        offenders = [
            l for l in lines[out_at:]
            if "results/" in l and "$OUT/results/" not in l
            and "$R/" not in l and "OUT=" not in l
        ]
        self.assertEqual(offenders, [],
                         "these commands resolve against the committed "
                         "results/ directory")

    def test_an_unknown_scenario_id_is_refused(self):
        """A typo in --only used to act as a filter matching nothing.

        A mixed list quietly dropped that scenario; a wholly wrong list produced
        no runs at all while run_all.sh reported success on an empty matrix. The
        fixture is already the declared scenario universe, so an id not in it is
        a mistake, not a selection.

        Tests `events.scenario_filter` rather than shelling out to the runner:
        the first version of this test invoked `run_scenarios.py`, which imports
        `websockets`, and failed on CI for a reason unrelated to what it checks —
        the transport entanglement `events.py` was extracted to prevent.
        """
        known = {sc["id"] for sc in
                 json.loads((HERE / "fixtures" / "scenarios.json").read_text())
                 ["scenarios"]}
        for only in ("book-de-01,typo-01", "nope-01"):
            with self.subTest(only=only):
                with self.assertRaises(ValueError) as cm:
                    scenario_filter(only, known)
                self.assertIn("not in the fixture", str(cm.exception))
        # A valid list still selects, and an absent one still means "all".
        self.assertEqual(scenario_filter("book-de-01", known), {"book-de-01"})
        self.assertIsNone(scenario_filter(None, known))
        self.assertIsNone(scenario_filter("", known))

    def test_a_malformed_filter_is_not_an_absent_one(self):
        """`--only ','` parsed to an empty set and read as "no filter".

        The caller tested `if want`, so every paid scenario ran. The same
        empty-is-absent confusion the whole harness keeps producing, this time
        inside the validation added to stop typos slipping through.
        """
        with self.assertRaises(ValueError) as cm:
            scenario_filter(",", {"a"})
        self.assertIn("names no scenario ids", str(cm.exception))
        with self.assertRaises(ValueError):
            scenario_filter(" , , ", {"a"})
        # Genuinely absent still means "run everything".
        self.assertIsNone(scenario_filter(None, {"a"}))
        self.assertIsNone(scenario_filter("", {"a"}))

    def test_a_repeated_fixture_id_is_refused(self):
        """Codex on 70bfd10: a duplicate scenario id collapsed into one.

        The runner maps ids to raw log paths, so two entries sharing an id gave
        one path: `--preflight-logs` saw one file, found it free and exited 0,
        and the real run then billed the first scenario before `open_log`
        refused the second — or, with `--force-logs`, truncated the log the
        first had just paid for. A preflight that passes because two things look
        like one, which is the `FORCE=1` shape again.

        Every other consumer keys the same fixture by id too, so the check is
        one function and all four call it.
        """
        with self.assertRaises(ValueError) as cm:
            scenario_ids([{"id": "a"}, {"id": "b"}, {"id": "a"}], "fixture.json")
        self.assertIn("more than once", str(cm.exception))
        self.assertIn("a", str(cm.exception))
        # The real fixture is well-formed, and order is preserved for callers
        # that walk the scenarios in file order.
        spec = json.loads((HERE / "fixtures" / "scenarios.json").read_text())
        self.assertEqual(scenario_ids(spec["scenarios"], "f"),
                         [sc["id"] for sc in spec["scenarios"]])

    def test_a_preflight_cannot_certify_a_run_that_collides_with_itself(self):
        """Two units, one log path: checking the filesystem cannot see it.

        Each path is free exactly once, so a filesystem check clears the run and
        the second unit overwrites what the first paid for. Callers that
        deduplicate before calling — a dict keyed by unit — hide it here, which
        is how the duplicate scenario id reached the run.
        """
        import contextlib
        import io
        from engines import LOG_COLLISION_EXIT, preflight_logs
        with tempfile.TemporaryDirectory() as tmp:
            one, two = (Path(tmp) / n for n in ("a.jsonl", "b.jsonl"))
            preflight_logs([one, two])                    # distinct: fine
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit) as cm:
                    preflight_logs([one, two, one])
            self.assertEqual(cm.exception.code, LOG_COLLISION_EXIT)
            self.assertIn("more than one unit", err.getvalue())
            # --force-logs is about replacing OTHER runs' logs; it cannot make a
            # run that overwrites its own output safe.
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    preflight_logs([one, one], force=True)

    def test_a_malformed_condition_list_does_not_clear_the_data(self):
        """`CONDITIONS=','` truncated asr.jsonl and reported success.

        run_asr.py parsed zero conditions and exited 0, while run_all.sh had
        already emptied the file — real data cleared by a run that then did
        nothing. Validation has to happen before the truncation, not after.
        """
        with tempfile.TemporaryDirectory() as tmp:
            res = Path(tmp) / "results"
            res.mkdir()
            (res / "asr.jsonl").write_text('{"row": 1}\n')
            before = (res / "asr.jsonl").read_bytes()
            env = {"PATH": "/usr/bin:/bin", "DATA": "/x", "OUT": tmp,
                   "APPEND": "1", "CONDITIONS": ","}
            r = subprocess.run(["/bin/bash", str(HERE / "run_all.sh")],
                               capture_output=True, text=True, cwd=str(HERE),
                               env=env)
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertIn("names nothing", r.stderr)
            self.assertEqual((res / "asr.jsonl").read_bytes(), before,
                             "the data was cleared before the check ran")

    def test_an_unknown_judge_arm_is_refused(self):
        r = subprocess.run(
            [sys.executable, str(HERE / "judge.py"), "--runs",
             str(HERE / "results" / "scenarios.jsonl"), "--out", "/dev/null",
             "--arms", "no-such-arm"],
            capture_output=True, text=True, cwd=str(HERE),
            env={"PATH": "/usr/bin:/bin", "KATALEPTIC_KEY": "x"})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no runs", r.stderr + r.stdout)

    def test_a_malformed_judge_arm_list_is_not_an_absent_one(self):
        """`--arms ','` excluded every arm and blamed the data.

        The guard read `if a.arms:`, so a truthy value parsing to an empty set
        passed the unknown-arm check with nothing to reject, filtered every run
        away, and exited with "judge produced no verdicts at all" — a message
        about the runs, for a defect in the flag. `--arms ""` went the other
        way and judged everything. Same empty-is-absent confusion already fixed
        for `--only` and `CONDITIONS`.
        """
        for arms in (",", " , ", ""):
            with self.subTest(arms=arms):
                r = subprocess.run(
                    [sys.executable, str(HERE / "judge.py"), "--runs",
                     str(HERE / "results" / "scenarios.jsonl"),
                     "--out", "/dev/null", "--arms", arms],
                    capture_output=True, text=True, cwd=str(HERE),
                    env={"PATH": "/usr/bin:/bin", "KATALEPTIC_KEY": "x"})
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("names no arms", r.stderr + r.stdout)

    def test_an_uncoverable_judge_selection_is_refused_before_spending(self):
        """Codex, twice: nine paid passes preceded a knowable failure.

        The 2.1 arms deliberately skipped the two unscored barge-in scenarios,
        so `--arms native-gpt-realtime-21` leaves those with no candidates. The
        loop judged the nine it could, recorded the two as failures and exited
        non-zero — the right verdict, reached after the money. The expectation
        is unchanged (still every scenario in the fixture); only the moment of
        refusal moves.
        """
        r = subprocess.run(
            [sys.executable, str(HERE / "judge.py"), "--runs",
             str(HERE / "results" / "scenarios.jsonl"), "--out", "/dev/null",
             "--arms", "native-gpt-realtime-21"],
            capture_output=True, text=True, cwd=str(HERE),
            env={"PATH": "/usr/bin:/bin", "KATALEPTIC_KEY": "x"})
        self.assertNotEqual(r.returncode, 0)
        out = r.stderr + r.stdout
        self.assertIn("no runs to judge", out)
        self.assertIn("bargein-en-01", out)
        # The covered scenarios must not be mentioned at all: the old path
        # attempted each one and logged it ("book-en-01: judge failed …"),
        # which is the attempt this check exists to prevent. A key that cannot
        # authenticate makes every attempt *fail*, so asserting on the failure
        # text would pass either way — the discriminator is whether the request
        # was made.
        self.assertNotIn("book-en-01", out, "it attempted the covered "
                                            "scenarios before refusing")

        # The documented seed-2 selection covers the fixture and must get past
        # the check — a guard that refuses everything would pass the assertions
        # above for free.
        r = subprocess.run(
            [sys.executable, str(HERE / "judge.py"), "--runs",
             str(HERE / "results" / "scenarios.jsonl"), "--out", "/dev/null",
             "--arms", "native-gpt-realtime-2,native-gpt-realtime-21,"
             "native-gpt-realtime-21-mini,vl-gpt41mini,vl-gpt41mini-dns,"
             "vl-gpt41mini-semvad,vl-native-brain"],
            capture_output=True, text=True, cwd=str(HERE),
            env={"PATH": "/usr/bin:/bin", "KATALEPTIC_KEY": "x"})
        self.assertNotIn("no runs to judge", r.stderr + r.stdout,
                         "the documented seed-2 pass was refused")

    def test_the_documented_seed2_arms_match_the_committed_pass(self):
        """The seed-2 rerun must reproduce its own denominator.

        judge.py had no arm filter, so the documented command judged all 246
        rows while judge_seed2.csv holds 219 across seven arms — a reader
        following the instructions got a different denominator and then failed
        check_report.py, the checker correctly rejecting a run the README told
        them to do.
        """
        cmds = self._workflow_commands()
        m = re.search(r'"((?:[\w-]+,)+[\w-]+)"', "\n".join(
            l for l in cmds if l.startswith("score ")))
        self.assertIsNotNone(m, "the README documents no seed-2 arm list")
        documented = set(m.group(1).split(","))
        with (HERE / "results" / "judge_seed2.csv").open() as f:
            actual = {r["arm"] for r in csv.DictReader(f)}
        self.assertEqual(documented, actual,
                         "the documented seed-2 arms do not match the arms in "
                         "judge_seed2.csv")

    def test_the_documented_asr_axes_match_the_committed_matrix(self):
        """A declared expectation is only worth what pins it to the study.

        `--expect-arms/-langs/-conditions` moved the Track A matrix out of the
        data and onto the command line, which is the whole point: an axis read
        off the rows cannot be missing from them. But a declaration nobody
        checks drifts, and a *stale* declaration is the same defect wearing the
        fix's clothes. So the README's declarations, the constants this file
        scores with, and the committed `asr.jsonl` are held to each other — the
        treatment `ONLY` and `CONDITIONS` already get.

        If an arm or condition ever legitimately leaves the study, this fails
        until the declaration is updated in the same commit, which is where a
        coverage change belongs: in the diff, not in nothing.
        """
        lines = self._workflow_commands()
        cmds = "\n".join(lines)
        assigned = dict(re.findall(r"^(\w+)=(\S+)$", cmds, re.M))
        self.assertTrue(assigned, "the workflow assigns no axis variables")

        def value(name):
            """The workflow's own value for `NAME`, `$VAR` references resolved."""
            self.assertIn(name, assigned, f"the workflow never sets {name}")
            text = assigned[name]
            for _ in range(5):
                if not (m := re.search(r"\$(\w+)", text)):
                    return set(text.split(","))
                self.assertIn(m.group(1), assigned,
                              f"the workflow never sets ${m.group(1)}")
                text = text.replace(m.group(0), assigned[m.group(1)])
            self.fail(f"could not resolve the variables in {assigned[name]!r}")

        def col(path, field):
            text = (HERE / "results" / path).read_text()
            if path.endswith(".jsonl"):
                return {json.loads(l)[field] for l in text.splitlines() if l.strip()}
            return {r[field] for r in csv.DictReader(text.splitlines())}

        # The declared axes equal the study, per pass: the base pass is the
        # merged report's own snapshot, the combined pass is what results/ holds.
        self.assertEqual(value("ASR_ALL"), col("asr.jsonl", "arm"))
        self.assertEqual(value("SC_ALL"), col("slots.csv", "arm"))
        self.assertEqual(value("ASR_BASE"), col("main-report/asr_scores.csv", "arm"))
        self.assertEqual(value("SC_BASE"), col("main-report/summary.csv", "arm"))
        self.assertEqual(value("CONDS"), col("asr.jsonl", "condition"))

        # ...and those variables are what actually reaches the scorers. A
        # declaration the invocation does not use is prose.
        self.assertIn('--expect-arms "$AARMS"', cmds)
        self.assertIn('--expect-conditions "$CONDS"', cmds)
        self.assertIn('--expect-langs en_us,de_de', cmds)
        self.assertEqual(col("asr.jsonl", "lang"), {"en_us", "de_de"})
        self.assertIn('--expect-arms "$SARMS"', cmds)
        for call in ('score $OUT/results "$ASR_BASE" "$SC_BASE"',
                     'score $OUT/results "$ASR_ALL" "$SC_ALL"'):
            self.assertIn(call, cmds, "the workflow does not pass its own "
                                      "declared axes to the scorers")

        # And the constants this file scores the committed matrix with.
        self.assertEqual(set(ASR_ARMS_ALL.split(",")), col("asr.jsonl", "arm"))
        self.assertEqual(set(ASR_CONDITIONS.split(",")), col("asr.jsonl", "condition"))

    def test_the_snapshot_carries_everything_the_checker_reads(self):
        """Codex, on 2f4abfc: step 7 could not succeed on a fresh $OUT.

        `check_report.py` recomputes the merged report's noise-suppression
        tables from `main-report/dns_probe_*.jsonl`, and the snapshot copied
        only the generated CSVs — so the documented verification step failed
        for everyone whose `results/` was not already populated. Seventh
        instance of the same class: **instructions get checked against the
        repository as it stands, not against a fresh run.**

        Asserted by *executing* the workflow's own mkdir and cp over a fake
        tree, rather than by matching their text — a glob in the copy either
        picks a file up or it does not, and only running it can say which.
        """
        want = {p.name for p in (HERE / "results" / "main-report").iterdir()
                if p.is_file()}
        self.assertTrue(want, "the merged report's snapshot is empty")
        # The mkdir and the cp that follows it, taken as one contiguous block
        # including the cp's line continuations. Filtering by keyword instead
        # spliced in unrelated continuation lines from elsewhere in the
        # workflow and produced a script that did not parse.
        cmds = self._workflow_commands()
        start = next(i for i, l in enumerate(cmds)
                     if "mkdir" in l and "main-report" in l)
        block, i = [cmds[start]], start + 1
        while i < len(cmds):
            block.append(cmds[i])
            if not cmds[i].rstrip().endswith("\\"):
                break
            i += 1
        script = "\n".join(block)
        self.assertIn("cp ", script, "the workflow never snapshots the pass")

        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "results"
            src.mkdir()
            for p in (HERE / "results").iterdir():      # what the run produces
                if p.is_file():
                    (src / p.name).write_text("x")
            r = subprocess.run(["/bin/bash", "-c", script],
                               capture_output=True, text=True,
                               env={"PATH": "/usr/bin:/bin", "OUT": tmp})
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            got = {p.name for p in (src / "main-report").iterdir()}
        self.assertEqual(
            want - got, set(),
            "the documented snapshot omits files check_report.py reads from "
            "main-report/, so step 7 fails on any fresh $OUT")

    def test_the_workflow_generates_the_probe_inputs_it_verifies(self):
        """The other half: copying them is no use if nothing produces them.

        `run_all.sh` does not run the noise-suppression probes — they are a
        separate experiment — so the workflow has to invoke `probe_dns.py`
        itself, for every probe file the reports are checked against.
        """
        cmds = "\n".join(self._workflow_commands())
        self.assertIn("probe_dns.py", cmds,
                      "nothing in the workflow generates the DNS probe inputs")
        names = {p.stem for p in (HERE / "results" / "main-report").glob(
            "dns_probe_*.jsonl")}
        # de_clean / de_cafe_snr10 / ... -> the condition token each needs.
        for stem in names:
            token = stem.replace("dns_probe_de_", "").replace("dns_probe_", "")
            with self.subTest(probe=stem):
                self.assertIn(token, cmds,
                              f"{stem}.jsonl is checked against but the "
                              f"workflow never probes {token!r}")

    def test_the_workflow_snapshots_the_base_pass_before_appending(self):
        """Step 7 must be runnable on a fresh $OUT.

        check_report.py requires results/main-report/ for the five-arm report,
        and a fresh run only creates it if the base pass is scored and
        snapshotted before the extension is appended. Scoring only at the end
        left the documented verification step unable to succeed — the step added
        so a reader could confirm the numbers was the one that could not run.
        """
        cmds = self._workflow_commands()

        def first(token):
            hits = [i for i, l in enumerate(cmds) if token in l]
            self.assertTrue(hits, f"no workflow command contains {token!r}")
            return hits[0]

        # Commands only — the prose around them mentions all three in a
        # different order, which is what made the first version of this test
        # fail against a correct workflow.
        self.assertLess(first("main-report"), first("APPEND=1"),
                        "the base pass is snapshotted after the extension is "
                        "appended, so main-report/ would hold the combined run")
        self.assertLess(first("APPEND=1"), first("check_report.py"),
                        "the check runs before the extension is appended")

    def test_every_committed_result_can_be_rescored_from_its_log(self):
        """The logs are the only artifact a result rebuilds from without paying.

        `sc-vl-gpt41mini-book-de-01-t1.jsonl` was emptied while verifying that a
        new test failed against the old behaviour: the check ran the real runner,
        whose `--logdir` defaults to the committed `logs/`, and it opens the log
        with mode "w" before doing any work. The result row still recorded its
        `end_call`, so the run became unre-scorable.
        """
        with (HERE / "results" / "scenarios.jsonl").open() as f:
            runs = [json.loads(l) for l in f if l.strip()]
        empty = []
        for r in runs:
            log = (HERE / "logs" /
                   f"sc-{r['arm']}-{r['scenario']}-t{r['trial']}.jsonl")
            if not log.exists() or log.stat().st_size == 0:
                empty.append(log.name)
        self.assertEqual(empty, [], "these runs cannot be re-scored from raw events")

    def test_a_populated_log_is_not_truncated(self):
        """`--logdir` defaults to the committed directory, so this is the guard
        standing between a stray invocation and unrecoverable data."""
        from engines import open_log
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "log.jsonl"
            with open_log(p) as f:          # fresh file: fine
                f.write("{}\n")
            with self.assertRaises(SystemExit) as cm:
                open_log(p)                 # populated: refused
            self.assertIn("refusing to truncate", str(cm.exception))
            self.assertEqual(p.read_text(), "{}\n", "the log was modified")
            with open_log(p, force=True) as f:   # explicit replacement
                f.write("")
            self.assertEqual(p.read_text(), "")

    def test_both_runners_guard_their_logs(self):
        for mod in ("run_scenarios.py", "run_asr.py"):
            with self.subTest(module=mod):
                src = (HERE / mod).read_text()
                self.assertIn("open_log(logp", src)
                self.assertNotIn('open(logp, "w")', src)

    def test_run_all_refuses_to_truncate_committed_results(self):
        """Following the README must not destroy the data the reports quote.

        `run_all.sh` truncates $OUT/results/*.jsonl and OUT defaults to this
        directory, so the documented invocation in a clean checkout replaced the
        committed study with a smaller one — the same in-place overwrite that
        made the merged report unreproducible, reached by following the
        instructions.
        """
        before = (HERE / "results" / "asr.jsonl").read_bytes()
        r = subprocess.run(["/bin/bash", str(HERE / "run_all.sh")],
                           capture_output=True, text=True, cwd=str(HERE),
                           env={"PATH": "/usr/bin:/bin", "DATA": "/nonexistent"})
        self.assertEqual(r.returncode, 2, f"expected a refusal: {r.stdout}{r.stderr}")
        self.assertIn("refusing to truncate", r.stderr)
        self.assertEqual((HERE / "results" / "asr.jsonl").read_bytes(), before,
                         "the committed results were modified")

    def test_preflight_names_every_colliding_log(self):
        """The up-front form of the guard above, and it must list all of them.

        `open_log` fires at the moment a runner opens one file, which is too
        late twice over: earlier units of the same invocation have already been
        billed, and `run_all.sh` has already truncated the results the run was
        meant to replace. Discovering the collisions one aborted run at a time
        is the same wasted work in slow motion.
        """
        import contextlib
        import io
        from engines import LOG_COLLISION_EXIT, preflight_logs
        with tempfile.TemporaryDirectory() as tmp:
            fresh, one, two = (Path(tmp) / n for n in ("a", "b", "c"))
            one.write_text("{}\n")
            two.write_text("{}\n")
            preflight_logs([fresh])                      # nothing there: fine
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit) as cm:
                    preflight_logs([fresh, one, two])
            # A distinct status, so a caller can tell a collision apart from a
            # preflight that could not run at all.
            self.assertEqual(cm.exception.code, LOG_COLLISION_EXIT)
            for p in (one, two):
                self.assertIn(str(p), err.getvalue(), "a collision went unnamed")
            self.assertIn("--force-logs", err.getvalue())
            self.assertEqual(one.read_text(), "{}\n", "the log was modified")
            preflight_logs([fresh, one, two], force=True)   # explicit override

    def test_force_does_not_erase_results_it_cannot_regenerate(self):
        """FORCE=1 truncated the results, then aborted on the first raw log.

        `run_all.sh` never forwarded a log-replacement option, so every existing
        log made `open_log` refuse — leaving the results erased and the forced
        replacement unable to run. Destroy-then-recreate is safe only when the
        recreate cannot fail, and this one failed by construction. The log
        collisions are now preflighted through the runners' own invocations,
        before anything is truncated.
        """
        with tempfile.TemporaryDirectory() as tmp:
            res = Path(tmp) / "results"
            res.mkdir()
            (res / "asr.jsonl").write_text('{"row": 1}\n')
            (res / "scenarios.jsonl").write_text('{"row": 1}\n')
            before = (res / "asr.jsonl").read_bytes()
            # A stub interpreter that reports a collision from the preflight
            # pass — standing in for the runners' own check, which CI cannot run
            # because they import the websocket client it does not install.
            from engines import LOG_COLLISION_EXIT
            py = Path(tmp) / "fakepy"
            py.write_text('#!/bin/bash\ncase "$*" in *--preflight-logs*)'
                          ' echo "refusing to start" >&2; exit %d;; esac\n'
                          % LOG_COLLISION_EXIT)
            py.chmod(0o755)
            r = subprocess.run(
                ["/bin/bash", str(HERE / "run_all.sh")],
                capture_output=True, text=True, cwd=str(HERE),
                env={"PATH": "/usr/bin:/bin", "DATA": "/x", "OUT": tmp,
                     "PY": str(py), "FORCE": "1"})
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertIn("FORCE_LOGS=1", r.stderr,
                          "the refusal does not say how to proceed")
            self.assertEqual((res / "asr.jsonl").read_bytes(), before,
                             "the results were erased by a run that then "
                             "could not regenerate them")

    def test_a_repeated_arm_is_refused_before_anything_runs(self):
        """A run can collide with itself, and no preflight can see that.

        Two identical units write the same raw log, so the second finds it
        populated and aborts after the first has been billed — the collision the
        preflight exists to catch, arriving from inside the matrix rather than
        from the directory. Deduping quietly would hide a typo that costs money.
        """
        with tempfile.TemporaryDirectory() as tmp:
            res = Path(tmp) / "results"
            res.mkdir()
            (res / "asr.jsonl").write_text('{"row": 1}\n')
            before = (res / "asr.jsonl").read_bytes()
            r = subprocess.run(
                ["/bin/bash", str(HERE / "run_all.sh")],
                capture_output=True, text=True, cwd=str(HERE),
                env={"PATH": "/usr/bin:/bin", "DATA": "/x", "OUT": tmp,
                     "APPEND": "1", "TRACK": "a",
                     "ASR_ARMS": "vl-gpt41mini native-gpt-realtime-2 vl-gpt41mini"})
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertIn("more than once", r.stderr)
            self.assertIn("vl-gpt41mini", r.stderr)
            self.assertEqual((res / "asr.jsonl").read_bytes(), before)

    def test_a_bad_input_does_not_clear_the_results_it_cannot_replace(self):
        """The preflight has to mean "safe to start", not "the logs are free".

        Codex, on 1200a40, against the fix for the original finding: the
        preflight returned before the arm was resolved or the data root read,
        so an unknown arm cleared the safety pass, `FORCE=1` truncated the
        result file, and the run failed on the first invocation. That is the
        same destroy-then-recreate defect the preflight was added to stop,
        surviving inside its own fix and reached through a different input.

        Driven through run_all.sh with the real runners, because the composition
        is what broke — each part was individually correct.
        """
        # The composition — "nothing is truncated until a preflight has
        # succeeded" — is asserted on every interpreter, including CI's, where
        # the runners cannot even import. Skipping there would leave the
        # property untested exactly where nobody watches it. The specific
        # refusal message is asserted only where the runner can run.
        venv = Path(HERE).parents[2] / "venv" / "bin" / "python"
        py, real = (str(venv), True) if venv.exists() else (sys.executable, False)
        for track, fname, env in (
                ("a", "asr.jsonl", {"ASR_ARMS": "NO-SUCH-ARM"}),
                ("a", "asr.jsonl", {"ASR_ARMS": "vl-gpt41mini",
                                    "CONDITIONS": "clean"}),
                ("b", "scenarios.jsonl", {"SC_ARMS": "vl-gpt41mini",
                                          "TRIALS": "1"})):
            with self.subTest(track=track, **env), tempfile.TemporaryDirectory() as tmp:
                res = Path(tmp) / "results"
                res.mkdir()
                (res / fname).write_text('{"row": 1}\n')
                before = (res / fname).read_bytes()
                r = subprocess.run(
                    ["/bin/bash", str(HERE / "run_all.sh")],
                    capture_output=True, text=True, cwd=str(HERE),
                    env={"PATH": "/usr/bin:/bin", "PY": py, "OUT": tmp,
                         "FORCE": "1", "TRACK": track,
                         # A data root that does not exist: every arm's inputs
                         # are unreadable, which the preflight must see.
                         "DATA": str(Path(tmp) / "nowhere"), **env})
                self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
                self.assertEqual(
                    (res / fname).read_bytes(), before,
                    "FORCE=1 erased results before discovering the run could "
                    "not produce their replacement")
                if real:
                    self.assertRegex(
                        r.stderr,
                        r"not a known arm|no clip manifest|audio file\(s\) are "
                        r"missing",
                        "the preflight stopped the run without saying which "
                        "input was wrong")

    def test_the_preflight_refuses_a_cell_the_scorer_would_reject(self):
        """Codex, on 1200a40, twice over the same guarantee.

        A manifest that exists is not a manifest that can be run. A short cell
        (fewer entries than `--n`) and a manifest naming a wav that is not
        there both cleared the preflight, so `run_all.sh` truncated the results
        and the failure surfaced during scoring or from ffmpeg — after the
        calls had been billed. "Validated" has to mean the inputs were looked
        at, not that a file listing them parsed.
        """
        venv = Path(HERE).parents[2] / "venv" / "bin" / "python"
        if not venv.exists():                            # pragma: no cover
            self.skipTest("the runner needs websockets; the composition is "
                          "asserted by test_a_bad_input_does_not_clear_the_"
                          "results_it_cannot_replace, which runs everywhere")
        rows = [{"id": "c1", "wav": "c1.wav", "reference": "hello"},
                {"id": "c2", "wav": "c2.wav", "reference": "there"}]

        def run(manifest, wavs):
            """run_all.sh over a fabricated DATA root, FORCE=1 over results.

            Both languages are built whole; only en_us is degraded per case, so
            a failure names the property under test rather than an incidental
            gap in the fixture.
            """
            tmp = tempfile.mkdtemp()
            self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
            for lang in ("en_us", "de_de"):
                whole = Path(tmp) / "conditions" / "clean" / lang
                whole.mkdir(parents=True)
                (whole / "manifest.jsonl").write_text(
                    "".join(json.dumps(x) + "\n" for x in rows))
                for w in ("c1.wav", "c2.wav"):
                    (whole / w).write_bytes(b"RIFF")
            d = Path(tmp) / "conditions" / "clean" / "en_us"
            (d / "manifest.jsonl").write_text(
                "".join(json.dumps(x) + "\n" for x in manifest))
            for w in ("c1.wav", "c2.wav"):
                (d / w).unlink()
            for w in wavs:
                (d / w).write_bytes(b"RIFF")
            res = Path(tmp) / "results"
            res.mkdir()
            (res / "asr.jsonl").write_text('{"row": 1}\n')
            r = subprocess.run(
                ["/bin/bash", str(HERE / "run_all.sh")],
                capture_output=True, text=True, cwd=str(HERE),
                env={"PATH": "/usr/bin:/bin", "PY": str(venv), "OUT": tmp,
                     "DATA": str(tmp), "FORCE": "1", "TRACK": "a", "N": "2",
                     "ASR_ARMS": "vl-gpt41mini", "CONDITIONS": "clean"})
            return r, (res / "asr.jsonl").read_bytes()

        # A duplicated clip id: the scorer rejects it as an identity violation,
        # which --allow-incomplete cannot excuse — so it has to be caught here,
        # before the cell is paid for and the results truncated.
        r, kept = run([rows[0], dict(rows[0], wav="c2.wav")], ["c1.wav", "c2.wav"])
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("more than once", r.stderr)
        self.assertEqual(kept, b'{"row": 1}\n', "the results were truncated")

        # One manifest entry against --n 2: a short cell the scorer refuses.
        r, kept = run(rows[:1], ["c1.wav"])
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("--n is 2", r.stderr)
        self.assertEqual(kept, b'{"row": 1}\n', "the results were truncated")

        # Two entries, one wav: the manifest parses and still cannot be run.
        r, kept = run(rows, ["c1.wav"])
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("do not exist", r.stderr)
        self.assertIn("c2.wav", r.stderr)
        self.assertEqual(kept, b'{"row": 1}\n', "the results were truncated")

        # A whole matrix clears the preflight and the run proceeds — the guard
        # must not refuse everything, which would pass both assertions above
        # for free. (The runners then fail on the network, which is not what
        # this asserts: the preflight is what must have let them through.)
        r, _ = run(rows, ["c1.wav", "c2.wav"])
        self.assertNotIn("--n is 2", r.stderr)
        self.assertNotIn("do not exist", r.stderr)
        self.assertNotIn("not certified safe to start", r.stderr,
                         "a whole matrix was refused before it could start")

    def test_the_truncation_guard_covers_only_the_selected_track(self):
        """Codex, on 60d2d6e: TRACK=a refused over a file it never touches.

        A guard that blocks a run which would destroy nothing is not caution —
        it teaches people to reach for FORCE=1, which is the single habit this
        guard exists to prevent.
        """
        for track, populated, refuse in (("a", "scenarios.jsonl", False),
                                         ("b", "scenarios.jsonl", True),
                                         ("b", "asr.jsonl", False),
                                         ("a", "asr.jsonl", True)):
            with self.subTest(track=track, populated=populated), \
                    tempfile.TemporaryDirectory() as tmp:
                res = Path(tmp) / "results"
                res.mkdir()
                (res / populated).write_text('{"row": 1}\n')
                r = subprocess.run(
                    ["/bin/bash", str(HERE / "run_all.sh")],
                    capture_output=True, text=True, cwd=str(HERE),
                    env={"PATH": "/usr/bin:/bin", "DATA": "/x", "OUT": tmp,
                         "PY": "/usr/bin/python3", "TRACK": track,
                         "ASR_ARMS": "vl-gpt41mini", "SC_ARMS": "vl-gpt41mini",
                         "TRIALS": "1"})
                refused = "refusing to truncate" in r.stderr
                self.assertEqual(
                    refused, refuse,
                    f"TRACK={track} with a populated {populated}: "
                    f"{'refused' if refused else 'allowed'}\n{r.stderr}")

    def test_a_broken_preflight_is_not_reported_as_a_log_collision(self):
        """"Bounded" naming the wrong bound, in a new place.

        A preflight that cannot run — no interpreter, a bad argument, an import
        error — says nothing about the logs. Reporting it as "these logs are
        populated" sends the next person to delete files that are not the
        problem. It still stops the run, and it still truncates nothing.
        """
        with tempfile.TemporaryDirectory() as tmp:
            py = Path(tmp) / "fakepy"
            py.write_text('#!/bin/bash\ncase "$*" in *--preflight-logs*)'
                          ' echo "boom" >&2; exit 1;; esac\n')
            py.chmod(0o755)
            r = subprocess.run(
                ["/bin/bash", str(HERE / "run_all.sh")],
                capture_output=True, text=True, cwd=str(HERE),
                env={"PATH": "/usr/bin:/bin", "DATA": "/x", "OUT": tmp,
                     "PY": str(py), "TRACK": "a", "ASR_ARMS": "vl-gpt41mini"})
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertIn("NOT a log collision", r.stderr)
            self.assertNotIn("would replace raw logs", r.stderr,
                             "a broken preflight was blamed on the logs")

    def test_run_all_propagates_the_log_replacement_option(self):
        """The option has to reach the runners, or FORCE_LOGS=1 does nothing.

        Preflighting is only half the fix: a user who says "yes, replace the
        logs" must have that decision forwarded, otherwise the run still aborts
        in open_log — the original defect with an extra step.
        """
        with tempfile.TemporaryDirectory() as tmp:
            out = self._fake_run_all(tmp, FORCE_LOGS="1", TRACK="a",
                                     ASR_ARMS="vl-gpt41mini")
            self.assertIn("--force-logs", out)
        with tempfile.TemporaryDirectory() as tmp:
            out = self._fake_run_all(tmp, TRACK="a", ASR_ARMS="vl-gpt41mini")
            self.assertNotIn("--force-logs", out,
                             "logs are replaced without anyone asking for it")
        with tempfile.TemporaryDirectory() as tmp:
            # FORCE covers results/ only. A log is the one artifact a result can
            # be rebuilt from without paying again, so replacing it stays a
            # separate, explicit decision.
            out = self._fake_run_all(tmp, TRACK="a", ASR_ARMS="vl-gpt41mini",
                                     APPEND="0", FORCE="1")
            self.assertNotIn("--force-logs", out,
                             "FORCE=1 silently replaced the raw logs too")

    def test_the_preflight_covers_the_matrix_the_run_writes(self):
        """A preflight over a different set of files is not a preflight."""
        with tempfile.TemporaryDirectory() as tmp:
            out = self._fake_run_all(tmp, TRACK="both", TRIALS="2",
                                     ASR_ARMS="vl-gpt41mini",
                                     SC_ARMS="vl-gpt41mini vl-native-brain")
            pre = sorted(l.replace(" --preflight-logs", "")
                         for l in out.splitlines() if "--preflight-logs" in l)
            run = sorted(l for l in out.splitlines()
                         if "--preflight-logs" not in l)
            self.assertTrue(pre, "nothing was preflighted")
            self.assertEqual(pre, run,
                             "the preflight and the run cover different "
                             "invocations, so a collision can still land "
                             "mid-run")

    def test_both_runners_persist_each_unit_as_it_completes(self):
        """Rows that have been paid for must not wait on the rest of the run.

        `run_asr.py` accumulated every condition's transcripts in memory and
        wrote them after the loop, so a failure in a later condition — an
        `open_log` refusal above all — exited without persisting cells that had
        already been billed. `run_scenarios.py` already wrote per scenario; this
        pins both.

        Checked structurally, on the source, because these modules import the
        websocket client CI does not install (TestScoringImportsAreTransport-
        Free): every write to the output file must sit inside the loop over
        units, and none may sit after it.
        """
        import ast
        for mod in ("run_scenarios.py", "run_asr.py"):
            with self.subTest(module=mod):
                tree = ast.parse((HERE / mod).read_text())
                main = next(n for n in ast.walk(tree)
                            if isinstance(n, ast.AsyncFunctionDef)
                            and n.name == "main")
                writes = [n for n in ast.walk(main)
                          if isinstance(n, ast.Call)
                          and isinstance(n.func, ast.Name) and n.func.id == "open"
                          and n.args and isinstance(n.args[0], ast.Attribute)
                          and n.args[0].attr == "out"]
                self.assertTrue(writes, f"{mod} never writes its results")
                inside = set()
                for loop in (n for n in main.body if isinstance(n, ast.For)):
                    inside |= {id(n) for n in ast.walk(loop)}
                stranded = [w.lineno for w in writes if id(w) not in inside]
                self.assertEqual(
                    stranded, [],
                    f"{mod} writes results outside its per-unit loop (line(s) "
                    f"{stranded}), so an abort discards everything before it")


class TestReportsMatchTheirData(unittest.TestCase):
    """The reports are checked against the CSVs, and the checker can fail.

    Three consecutive review rounds found the same defect: prose that was correct
    when written and stale after the study was extended. Code that goes stale
    fails a test; prose fails nothing. `check_report.py` closes that gap, and
    these tests exist because a verifier nobody has seen fail is not evidence.
    """

    def _run(self, docs=None, results=None):
        cmd = [sys.executable, str(HERE / "check_report.py"), "--json"]
        if docs:
            cmd += ["--docs", str(docs)]
        if results:
            cmd += ["--results", str(results)]
        p = subprocess.run(cmd, capture_output=True, text=True,
                           env={"PATH": "/usr/bin:/bin"})
        return json.loads(p.stdout), p.returncode

    def _sandbox(self, tmp):
        """A docs dir of copies, checked against the real results tree."""
        docs = Path(tmp) / "research"
        docs.mkdir()
        src = HERE / ".." / ".." / "docs" / "research"
        for f in src.glob("voice-engine-quality-*.md"):
            (docs / f.name).write_text(f.read_text())
        return docs

    def test_committed_reports_agree_with_committed_results(self):
        out, code = self._run()
        self.assertEqual(out["problems"], [], "the reports disagree with results/")
        self.assertEqual(code, 0)
        self.assertGreaterEqual(out["cells_checked"], 30)

    def test_a_wrong_table_cell_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            p.write_text(p.read_text().replace("| 0.667 |", "| 0.815 |"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("judge_grounded" in x for x in out["problems"]),
                            out["problems"])

    def test_a_stale_agreement_figure_is_caught(self):
        """The exact defect: agreement quoted from an earlier, smaller pass."""
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            p.write_text(p.read_text().replace("209/219 (**95.4 %**)",
                                               "214/219 (**97.7 %**)"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("groundedness" in x for x in out["problems"]),
                            out["problems"])

    def test_a_stale_run_count_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            p.write_text(p.read_text().replace("**Ten of the 81 new runs**",
                                               "**Seven of the 54 new runs**"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("new runs" in x for x in out["problems"]),
                            out["problems"])

    def test_a_cost_total_that_does_not_sum_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08.md"
            p.write_text(p.read_text().replace("| **total** | | | | **22.82** |",
                                               "| **total** | | | | **23.19** |"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("cost table" in x for x in out["problems"]),
                            out["problems"])

    def test_an_unreadable_cost_input_is_not_a_missing_one(self):
        """Codex, on 1200a40: rewriting a rate switched its line's check off.

        A stated-but-unparseable rate or minute count took the same `continue`
        as a line that states no inputs at all, so the arithmetic was never
        verified while the column total still summed the unchanged dollar
        figure — the checker certifying a line it had not read. The em dash
        these tables use for an unused leg must stay a legitimate absence.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            self.assertIn("0.070", p.read_text())
            p.write_text(p.read_text().replace("0.070", "bogus", 1))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1, "an unreadable rate must not pass")
            self.assertTrue(any("cannot read" in x for x in out["problems"]),
                            out["problems"])
        # ...and the committed reports, which are full of em dashes, stay clean.
        out, code = self._run()
        self.assertEqual(code, 0, out["problems"])

    # The German DNS table lives in the merged report, which RESULTS_FOR maps to
    # results/main-report/ — so the probe files to degrade are the ones there.
    GERMAN_DNS_ROW = "| cafe 5 dB | 9.84 | **16.84** | 1 |"

    def test_an_unmapped_german_dns_condition_is_reported(self):
        """Codex, on 1200a40: a new row was skipped *and* left coverage exact.

        The bare `continue` meant arbitrary figures in an unmapped condition
        row were never compared, and because nothing incremented `checked`, the
        exact per-report count still agreed the document was fully compared —
        the silent gap and the certificate that hides it, in one branch. The
        English DNS path already reported this.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08.md"
            self.assertIn(self.GERMAN_DNS_ROW, p.read_text(),
                          "the German DNS table has moved")
            p.write_text(p.read_text().replace(
                self.GERMAN_DNS_ROW,
                self.GERMAN_DNS_ROW + "\n| cafe 99 dB | 1.11 | 2.22 | 3 |"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1, "an unmapped condition row must not pass")
            self.assertTrue(any("DNS_GERMAN_ROWS" in x for x in out["problems"]),
                            out["problems"])

    def test_a_dns_row_that_recomputes_to_nan_is_reported(self):
        """`wer_cer([])` is NaN, and every comparison against NaN is False.

        A probe file missing its `off` or `deep` leg therefore certified any
        WER the document stated, while still counting the cell as checked —
        absence reading as agreement, with full coverage to vouch for it.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            res = self._results_copy(tmp)
            for f in (HERE / "results" / "main-report").glob("dns_probe_*.jsonl"):
                (res / "main-report" / f.name).write_text(f.read_text())
            target = res / "main-report" / "dns_probe_de_cafe_snr5.jsonl"
            self.assertTrue(target.exists(), "the German DNS probe has moved")
            kept = [l for l in target.read_text().splitlines()
                    if l.strip() and json.loads(l)["leg"] != "off"]
            target.write_text("\n".join(kept) + "\n")
            out, code = self._run(docs=docs, results=res)
            self.assertEqual(code, 1, "a missing leg must not certify the row")
            self.assertTrue(any("cannot be recomputed" in x
                                for x in out["problems"]), out["problems"])

    def test_duplicating_every_dns_row_does_not_still_certify(self):
        """Codex, on a357d94: n was the one figure nothing verified.

        The loader took whatever rows it found. Duplicating every row in
        `dns_probe_en.jsonl` doubles n from 50 to 100 while leaving every WER
        and every percentage identical — ratios are invariant under
        duplication — so the checker certified that all figures agreed with a
        file describing twice the study it claims. Both reports write `n=50`
        beside these tables, and that is a published figure like any other.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            res = self._results_copy(tmp)
            for f in (HERE / "results" / "main-report").glob("dns_probe_*.jsonl"):
                (res / "main-report" / f.name).write_text(f.read_text())
            target = res / "main-report" / "dns_probe_en.jsonl"
            lines = [l for l in target.read_text().splitlines() if l.strip()]
            target.write_text("\n".join(lines + lines) + "\n")
            out, code = self._run(docs=docs, results=res)
            self.assertEqual(code, 1, "a doubled probe file still certified")
            self.assertTrue(any("repeats clip" in x for x in out["problems"]),
                            out["problems"])

    def test_an_errored_dns_row_is_not_counted_as_a_measurement(self):
        """`probe_dns.py` marks a clip that produced no transcription event.

        Such a row is empty because the session failed, and this table's whole
        subject is how often the engine returns an empty transcript — so an
        outage would be published as the effect being measured.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            res = self._results_copy(tmp)
            for f in (HERE / "results" / "main-report").glob("dns_probe_*.jsonl"):
                (res / "main-report" / f.name).write_text(f.read_text())
            target = res / "main-report" / "dns_probe_en.jsonl"
            rows = [json.loads(l) for l in target.read_text().splitlines() if l.strip()]
            rows[0]["error"] = "no transcription event for this clip within 60 s"
            rows[0]["hypothesis"] = ""
            target.write_text("".join(json.dumps(r) + "\n" for r in rows))
            out, code = self._run(docs=docs, results=res)
            self.assertEqual(code, 1, "an outage was scored as a measurement")
            self.assertTrue(any("outages, not" in x for x in out["problems"]),
                            out["problems"])

    def test_a_short_dns_leg_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            res = self._results_copy(tmp)
            for f in (HERE / "results" / "main-report").glob("dns_probe_*.jsonl"):
                (res / "main-report" / f.name).write_text(f.read_text())
            target = res / "main-report" / "dns_probe_en.jsonl"
            rows = [json.loads(l) for l in target.read_text().splitlines() if l.strip()]
            # Drop one clip from the `deep` leg only: the id sets diverge and
            # the leg falls short of the declared count.
            dropped = next(r for r in rows if r["leg"] == "deep")
            rows.remove(dropped)
            target.write_text("".join(json.dumps(r) + "\n" for r in rows))
            out, code = self._run(docs=docs, results=res)
            self.assertEqual(code, 1)
            self.assertTrue(
                any("distinct clip" in x or "different clips" in x
                    for x in out["problems"]), out["problems"])

    def test_the_reports_declare_the_dns_clip_count(self):
        """`DNS_CLIPS` is the declared expectation; the prose must agree.

        A declaration nobody checks drifts, and a stale declaration is the
        defect wearing the fix's clothes — the same reasoning that pins the
        documented arm and condition lists against the committed data.
        """
        import check_report
        src = HERE / ".." / ".." / "docs" / "research"
        for name in check_report.RESULTS_FOR:
            md = (src / name).read_text()
            if "| leg |" not in md and "no noise reduction" not in md:
                continue          # this report has no DNS table
            with self.subTest(report=name):
                declared = set(re.findall(r"n=(\d+)", md))
                self.assertIn(str(check_report.DNS_CLIPS), declared,
                              f"{name} states n={declared} beside its DNS "
                              f"tables; DNS_CLIPS is {check_report.DNS_CLIPS}")

    def test_a_before_after_table_is_checked_against_both_arms(self):
        """Codex, on 60d2d6e: two whole tables took neither branch.

        Their header names an arm *pair* ("server → semantic VAD, ...") rather
        than either arm, so `col_arms` and `row_arms` were both empty and
        `check_tables` skipped the table entirely — including the strict
        success figure the VAD-control argument rests on, which could be set to
        0.999 with the run green and its coverage count unchanged. The arm axis
        going unresolved was made loud once already; this is the same hole one
        table shape further along.
        """
        for cell, arm in (("| strict success | 0.333 → 0.259 (**−0.074**) |",
                           "vl-gpt41mini"),
                          ("| strict success | 0.259 → 0.407 (**+0.148**) |",
                           "vl-native-brain")):
            with self.subTest(arm=arm), tempfile.TemporaryDirectory() as tmp:
                docs = self._sandbox(tmp)
                p = docs / "voice-engine-quality-2026-08.md"
                self.assertIn(cell.strip(), p.read_text(),
                              "the before/after table has moved")
                p.write_text(p.read_text().replace(
                    cell.strip(),
                    cell.strip().replace("0.333", "0.999")
                              .replace("0.407", "0.999")))
                out, code = self._run(docs=docs)
                self.assertEqual(code, 1, "an edited delta cell passed")
                self.assertTrue(any("delta table" in x for x in out["problems"]),
                                out["problems"])

    def test_an_unmapped_delta_table_is_reported(self):
        """Not knowing which arms a table compares is not a reason to skip it."""
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08.md"
            p.write_text(p.read_text().replace(
                "| server → semantic VAD, gpt-4.1-mini on Voice Live | change |",
                "| whatever → something else | change |"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("DELTA_TABLES" in x for x in out["problems"]),
                            out["problems"])

    def test_a_percentage_cell_is_read_as_a_number(self):
        """`%` sat inside a word-boundary group and never matched.

        So `parse_number("24 %")` was None and the English DNS
        empty-transcript column — five figures, one of them the 24 % rate
        behind "never enable Azure noise suppression" — was skipped in silence.
        A unit the parser does not know is a cell it does not check, which is
        the fourth dimension this same blind spot has appeared in.
        """
        import check_report
        for cell, want in (("24 %", 24.0), ("0 %", 0.0), ("~15", 15.0),
                           ("1.0 dB", 1.0), ("2077 ms", 2077.0)):
            with self.subTest(cell=cell):
                self.assertEqual(check_report.parse_number(cell), want)
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08.md"
            self.assertIn("| **24 %** |", p.read_text())
            p.write_text(p.read_text().replace("| **24 %** |", "| **99 %** |"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1, "an edited DNS percentage passed")
            self.assertTrue(any("DNS" in x for x in out["problems"]),
                            out["problems"])

    def test_the_family_ranges_are_checked_on_both_seeds(self):
        """Codex, on 4c89a84: the seed-comparison evidence was unchecked.

        The family table's rows are arm *families* and its cells are ranges, so
        neither axis resolved — and a range is not `looks_numeric` either, so
        the unresolved-row report stayed silent too. Both halves of the
        "families separate cleanly under reseeding" claim could be replaced
        with arbitrary ranges.
        """
        for row, edited in (
                ("| 0.926–0.963 | 0.889–0.963 |", "| 0.111–0.999 | 0.889–0.963 |"),
                ("| 0.778–0.815 | 0.704–0.815 |", "| 0.778–0.815 | 0.111–0.999 |")):
            with self.subTest(row=row), tempfile.TemporaryDirectory() as tmp:
                docs = self._sandbox(tmp)
                p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
                self.assertIn(row, p.read_text(), "the family table has moved")
                p.write_text(p.read_text().replace(row, edited))
                out, code = self._run(docs=docs)
                self.assertEqual(code, 1, "an edited family range passed")
                self.assertTrue(any("family" in x for x in out["problems"]),
                                out["problems"])

    def test_an_undeclared_seed2_gap_is_reported(self):
        """The seed-2 pass covers seven arms, and that has to be *declared*.

        An arm intentionally unjudged and an arm whose rows went missing look
        identical in judge_seed2.csv. `SEED2_ABSENT` names the one with its
        reason; any other absence must fail rather than quietly shrink the
        range the document is checked against.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            res = self._results_copy(tmp)
            with (res / "judge_seed2.csv").open() as f:
                rows = list(csv.DictReader(f))
            keep = [r for r in rows if r["arm"] != "vl-native-brain"]
            self.assertLess(len(keep), len(rows), "vl-native-brain has moved")
            with (res / "judge_seed2.csv").open("w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows(keep)
            out, code = self._run(docs=docs, results=res)
            self.assertEqual(code, 1, "an undeclared seed-2 gap passed")
            self.assertTrue(any("SEED2_ABSENT" in x for x in out["problems"]),
                            out["problems"])

    def test_a_stated_change_is_checked_against_its_endpoints(self):
        """A subtraction's inputs were verified and its result was not.

        The parenthetical is a published figure like any other: with the
        endpoints correct, `−0.074` could be rewritten `−9.999` and the run
        stayed green with unchanged coverage.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08.md"
            self.assertIn("(**−0.074**)", p.read_text())
            p.write_text(p.read_text().replace("(**−0.074**)", "(**−9.999**)"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1, "a stale stated change passed")
            self.assertTrue(any("states a change" in x for x in out["problems"]),
                            out["problems"])

    def test_an_unmapped_report_fails_rather_than_being_skipped(self):
        """A document nothing checks must not read as a document that passed."""
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            (docs / "voice-engine-quality-2027-01-new-study.md").write_text(
                "# A later study\n\n| arm | strict success |\n|---|---|\n"
                "| gpt-realtime-2 | 0.999 |\n")
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("RESULTS_FOR" in x for x in out["problems"]),
                            out["problems"])

    def test_a_parser_that_matches_nothing_fails(self):
        """The signature bug of this repository, aimed at the checker itself.

        If the table format changes and the parser silently stops resolving
        cells, "no problems" would mean "nothing was compared". That must be an
        error, not a pass.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            for f in docs.glob("*.md"):
                f.write_text("\n".join(
                    line for line in f.read_text().splitlines()
                    if not line.strip().startswith("|")))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertLess(out["cells_checked"], 30)
            self.assertTrue(any("no longer being checked" in x
                                for x in out["problems"]), out["problems"])

    def test_one_report_going_blind_is_not_covered_by_the_other(self):
        """The floor holds per report, not in aggregate.

        Enforced globally, 25 cells from one document and 40 from the other
        clear a floor of 30 — so either could fall to zero, its tables silently
        unchecked, while the run still reported clean. Strip the tables from one
        document only and the run must still fail, naming that document.
        """
        for victim in ("voice-engine-quality-2026-08.md",
                       "voice-engine-quality-2026-08-gpt-realtime-2-1.md"):
            with self.subTest(report=victim), tempfile.TemporaryDirectory() as tmp:
                docs = self._sandbox(tmp)
                p = docs / victim
                p.write_text("\n".join(
                    line for line in p.read_text().splitlines()
                    if not line.strip().startswith("|")))
                out, code = self._run(docs=docs)
                self.assertEqual(out["cells_per_report"][victim], 0)
                self.assertEqual(code, 1, "a blind report must fail on its own")
                self.assertTrue(
                    any(x.startswith(victim) and "no longer being checked" in x
                        for x in out["problems"]),
                    f"nothing named {victim}: {out['problems']}")

    def test_every_mapped_report_reports_its_own_coverage(self):
        """Coverage is only actionable if you can see where it went."""
        out, _ = self._run()
        import check_report
        self.assertEqual(set(out["cells_per_report"]), set(check_report.RESULTS_FOR))
        for doc, (_sub, want) in check_report.RESULTS_FOR.items():
            self.assertGreaterEqual(out["cells_per_report"][doc], want)

    def test_a_stale_arm_count_beside_a_named_tree_is_caught(self):
        """"…covering all seven arms" when the CSV holds eight.

        Prose counts were outside the first version's coverage, which is how
        this one reached the merged report a commit after the checker landed.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08.md"
            p.write_text(p.read_text().replace("covering **eight** arms",
                                               "covering **seven** arms"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("arms" in x for x in out["problems"]),
                            out["problems"])

    def test_a_stale_count_beside_a_named_csv_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            p.write_text(p.read_text().replace("(seed 1, 246 rows, eight arms)",
                                               "(seed 1, 240 rows, nine arms)"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("240 rows" in x for x in out["problems"]),
                            out["problems"])
            self.assertTrue(any("nine arms" in x for x in out["problems"]),
                            out["problems"])

    def test_a_condition_stated_but_not_named_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            p.write_text(p.read_text().replace(
                "`cafe_snr0`, `tel` and\n`tel_cafe_snr10`",
                "`cafe_snr0` and\n`tel_cafe_snr10`"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("conditions but names 5" in x
                                for x in out["problems"]), out["problems"])
            # ...and against the data, not only against its own count. Every
            # expected arm is named, not just the first one that disagrees.
            for arm in ("native-gpt-realtime-21", "native-gpt-realtime-21-mini"):
                self.assertTrue(
                    any(f"but {arm} has" in x for x in out["problems"]),
                    f"{arm} unreported: {out['problems']}")

    def test_no_shared_judge_rows_is_reported_not_raised(self):
        """An empty intersection is a legitimate state that needs a message.

        Dividing by `len(shared)` made the verifier crash instead of saying it
        could not verify — the failure mode this checker exists to prevent,
        reappearing inside the checker.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            res = Path(tmp) / "results"
            res.mkdir()
            src = HERE / "results"
            for f in ("summary.csv", "summary_per_run.csv", "slots.csv",
                      "asr.jsonl", "asr_fixed.jsonl", "asr_control.jsonl"):
                if (src / f).exists():
                    (res / f).write_text((src / f).read_text())
            (res / "main-report").mkdir()
            for f in (HERE / "results" / "main-report").glob("*.csv"):
                (res / "main-report" / f.name).write_text(f.read_text())
            # Two judge files with no (scenario, arm, trial) key in common.
            head = "scenario,arm,trial,lang,seed,groundedness,resolution,tone\n"
            (res / "judge.csv").write_text(head + "a,x,1,en,1,1,2,2\n")
            (res / "judge_seed2.csv").write_text(head + "b,y,2,en,2,1,2,2\n")
            out, code = self._run(docs=docs, results=res)
            self.assertEqual(code, 1, "should report, not pass")
            self.assertTrue(any("share no" in x for x in out["problems"]),
                            out["problems"])

    def _results_copy(self, tmp, drop_arm=None, drop_condition=None):
        """A writable copy of the results tree, optionally degraded."""
        res = Path(tmp) / "results"
        (res / "main-report").mkdir(parents=True)
        for f in (HERE / "results").glob("*.csv"):
            (res / f.name).write_text(f.read_text())
        for f in (HERE / "results").glob("*.jsonl"):
            (res / f.name).write_text(f.read_text())
        for f in (HERE / "results" / "main-report").glob("*.csv"):
            (res / "main-report" / f.name).write_text(f.read_text())
        if drop_arm:
            with (res / "summary.csv").open() as f:
                rows = [r for r in csv.DictReader(f) if r["arm"] != drop_arm]
            with (res / "summary.csv").open("w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows(rows)
        if drop_condition:
            arm, cond = drop_condition
            keep = [l for l in (res / "asr.jsonl").read_text().splitlines()
                    if not (json.loads(l)["arm"] == arm
                            and json.loads(l)["condition"] == cond)]
            (res / "asr.jsonl").write_text("\n".join(keep) + "\n")
        return res

    def test_an_arm_missing_from_summary_is_reported_not_raised(self):
        """An alias can point at an arm the CSV does not have.

        Indexing `summary[arm]` raised KeyError and produced no output at all —
        the checker saying nothing about a real report/data disagreement. Second
        instance of crash-instead-of-report in this file.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            res = self._results_copy(tmp, drop_arm="native-gpt-realtime-21")
            out, code = self._run(docs=docs, results=res)
            self.assertEqual(code, 1)
            self.assertTrue(any("not in this report's summary.csv" in x
                                for x in out["problems"]), out["problems"])

    def test_deleting_the_agreement_evidence_fails(self):
        """The reliability evidence disappearing must not read as compliance.

        Missing fields used to `continue`, so removing the whole three-row table
        while leaving the heading exited zero: the check built because agreement
        was quoted from the wrong pass could be satisfied by there being no
        agreement figures at all.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            import re as _re
            p.write_text(_re.sub(r"\| field \| agreement \|.*?\| tone \|[^\n]*\n",
                                 "", p.read_text(), flags=_re.S))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1, "deleted evidence must not pass")
            for field in ("groundedness", "resolution", "tone"):
                self.assertTrue(any(field in x for x in out["problems"]),
                                f"{field} unreported: {out['problems']}")

    def test_conditions_are_checked_against_every_expected_arm(self):
        """`any(...)` accepted the claim as soon as one arm matched.

        The other could then carry a different matrix while the report's
        coverage statement went unchallenged.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            res = self._results_copy(
                tmp, drop_condition=("native-gpt-realtime-21-mini", "tel"))
            out, code = self._run(docs=docs, results=res)
            self.assertEqual(code, 1)
            self.assertTrue(
                any("native-gpt-realtime-21-mini has" in x
                    for x in out["problems"]),
                f"the arm that lost a condition went unreported: {out['problems']}")

    def test_the_compound_latency_row_is_checked(self):
        """`TTFA p50 / p95` matched no label, so six figures were skipped.

        And the declared coverage count was read off what the parser resolved,
        so it certified the document as fully compared with the gap inside it.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            p.write_text(p.read_text().replace(
                "| TTFA p50 / p95 | **1315 / 1719** | 2087 / 2975 | 1876 / **2560** |",
                "| TTFA p50 / p95 | **9999 / 8888** | 7777 / 6666 | 5555 / **4444** |"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1, "altered latency figures must not pass")
            for field in ("ttfa_p50_ms", "ttfa_p95_ms"):
                self.assertTrue(any(field in x for x in out["problems"]),
                                f"{field} unchecked: {out['problems']}")

    def test_an_unrecognised_numeric_row_is_reported(self):
        """A metric label nobody mapped must be loud, not skipped.

        This is the property that would have caught the compound row without
        anyone noticing it: an unknown label beside figures is a gap in the
        checker, and gaps in the checker have to be visible.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            p.write_text(p.read_text().replace(
                "| Slots heard | **0.960** | 0.893 | 0.893 | 0.893 |",
                "| Widget rate | **0.960** | 0.893 | 0.893 | 0.893 |"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("resolves to no summary.csv field" in x
                                for x in out["problems"]), out["problems"])

    def test_a_surplus_of_resolved_cells_also_fails(self):
        """Equality in the checker, not only in the test.

        `check_report.py` used `<` while the test asserted equality, so the
        invariant held on one path and was documented as holding generally.
        A floor certifies "at least this much was checked"; equality certifies
        "exactly what we declared, and nothing moved". The surplus direction is
        the more interesting one — the document grew figures and nobody updated
        the declaration — and a floor cannot see it at all.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            row = "| Slots heard | **0.960** | 0.893 | 0.893 | 0.893 |"
            self.assertIn(row, p.read_text())
            p.write_text(p.read_text().replace(
                row, row + "\n| pass^3 | 0.333 | 0.444 | 0.222 | 0.111 |"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1, "a surplus must fail, not pass a floor")
            self.assertTrue(any("grown figures" in x for x in out["problems"]),
                            out["problems"])

    def test_declared_coverage_matches_what_the_documents_contain(self):
        """The count must equal the resolvable cells, not merely be below them.

        A count derived from current behaviour certifies current behaviour,
        blind spots included — which is exactly how the latency row survived.
        Requiring equality means a newly-resolved metric forces the number up in
        the same commit, rather than hiding under a floor set too low.
        """
        out, code = self._run()
        self.assertEqual(code, 0, out["problems"])
        import check_report
        for doc, (_sub, want) in check_report.RESULTS_FOR.items():
            self.assertEqual(
                out["cells_per_report"][doc], want,
                f"{doc}: resolves {out['cells_per_report'][doc]} cells but "
                f"RESULTS_FOR declares {want}; re-derive the count")

    def test_an_entirely_absent_track_a_arm_is_reported(self):
        """`expected` must not be filtered by what is present.

        It was intersected with the observed arms, so an arm with no ASR rows
        at all dropped out of the expectation and the remaining one satisfied
        the claim — an absent arm passed. That is the declared-expectation rule
        broken inside the fix for the `any()` finding: "every expected arm" is
        only as strong as where `expected` comes from.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            res = self._results_copy(tmp)
            keep = [l for l in (res / "asr.jsonl").read_text().splitlines()
                    if json.loads(l)["arm"] != "native-gpt-realtime-21-mini"]
            (res / "asr.jsonl").write_text("\n".join(keep) + "\n")
            out, code = self._run(docs=docs, results=res)
            self.assertEqual(code, 1, "an absent arm must not pass")
            self.assertTrue(
                any("native-gpt-realtime-21-mini" in x and "no ASR rows" in x
                    for x in out["problems"]), out["problems"])

    def test_the_track_a_arm_declaration_excludes_the_track_b_only_arm(self):
        """`vl-native-brain-21` has no ASR rows by design.

        An intentionally unrun arm and a missing one look identical in the data;
        only a declaration tells them apart, which is why the set is declared.
        """
        import check_report
        declared = set(check_report.TRACK_A_ARMS[
            "voice-engine-quality-2026-08-gpt-realtime-2-1.md"])
        self.assertNotIn("vl-native-brain-21", declared)
        with (HERE / "results" / "asr.jsonl").open() as f:
            present = {json.loads(l)["arm"] for l in f}
        self.assertNotIn("vl-native-brain-21", present)
        self.assertTrue(declared <= present, f"{declared - present} declared "
                                             "but absent from the ASR rows")

    def test_a_cited_csv_that_does_not_exist_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            p.write_text(p.read_text().replace("`results/judge.csv` (seed 1,",
                                               "`results/nonexistent.csv` (seed 1,"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("does not exist" in x for x in out["problems"]),
                            out["problems"])

    def test_a_claim_whose_data_file_is_missing_is_reported(self):
        """A missing file matters exactly when something depends on it."""
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            res = self._results_copy(tmp)
            (res / "summary_per_run.csv").unlink()
            out, code = self._run(docs=docs, results=res)
            self.assertEqual(code, 1)
            self.assertTrue(any("summary_per_run.csv" in x and "missing" in x
                                for x in out["problems"]), out["problems"])

    def test_track_a_wer_is_checked_against_asr_scores(self):
        """The DNS recommendation rests on these numbers.

        "Never enable Azure noise suppression" is carried by 4.83 -> 47.76 and
        the empty-transcript counts. They were declared unchecked while
        everything around them was verified — and asr_scores.csv existing is a
        second source to check against, not a reason to skip.
        """
        cases = [
            ("| clean | 4.83 | 47.76 (8e) | **4.47** |",
             "| clean | 4.83 | 37.76 (8e) | **4.47** |", "WER"),
            ("| cafe 20 dB | 5.01 | 55.99 (10e) | **4.47** |",
             "| cafe 20 dB | 5.01 | 55.99 (2e) | **4.47** |", "empty transcripts"),
            # A de_DE row: proves the language section header is tracked, not
            # that every row is attributed to the first section.
            ("| clean | 3.70 | 3.90 | **3.31** |",
             "| clean | 3.70 | 3.90 (2e) | **3.31** |", "de_de"),
        ]
        for original, mutated, expect in cases:
            with self.subTest(expect=expect), tempfile.TemporaryDirectory() as tmp:
                docs = self._sandbox(tmp)
                p = docs / "voice-engine-quality-2026-08.md"
                self.assertIn(original, p.read_text())
                p.write_text(p.read_text().replace(original, mutated))
                out, code = self._run(docs=docs)
                self.assertEqual(code, 1, f"{expect} change must not pass")
                self.assertTrue(any(expect in x for x in out["problems"]),
                                out["problems"])

    def test_snr50_is_checked_including_the_degenerate_value(self):
        """`<0 (degenerate)` is stored literally and must still compare."""
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08.md"
            p.write_text(p.read_text().replace(
                "| vl-gpt41mini-dns | <0 (degenerate) | 9.6 dB |",
                "| vl-gpt41mini-dns | 1.5 dB | 9.6 dB |"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("SNR50" in x for x in out["problems"]),
                            out["problems"])

    def test_no_report_figure_is_left_declared_unchecked(self):
        """UNCHECKED_METRICS must not become a hiding place.

        Two rules. The first — no entry may say "not yet checked" — was too weak
        on its own: the judge-free entries passed it because "judge-free
        recomputation" reads as a category rather than an excuse, while both
        figures were sitting in summary_per_run.csv the whole time.

        So the second, which is mechanical rather than a matter of wording: **no
        entry may name a column that exists in any committed CSV.** Living in a
        different file is an argument for checking against that file, not for
        skipping.

        Its reach, stated rather than assumed — it catches `slots all heard`,
        whose label *is* a column, and would have caught it the day it was
        allowlisted. It does **not** catch `deterministic success` (a derived
        conjunction, no column of its own) or the Track A labels (`cafe 20 dB`
        is a display name for the value `cafe_snr20`, not a column). So it is a
        partial guard covering the easiest third of the cases, and the judgement
        the first rule asks for still has to be exercised. Claiming otherwise
        would be the half-implemented invariant this file keeps finding.
        """
        import check_report
        columns = set()
        for csv_path in sorted((HERE / "results").rglob("*.csv")):
            with csv_path.open() as f:
                columns.update(next(csv.reader(f), []))
        for label, reason in check_report.UNCHECKED_METRICS.items():
            with self.subTest(label=label):
                self.assertNotIn(
                    "not yet checked", reason.lower(),
                    f"{label!r} is a report figure with no verification; either "
                    "check it against its source or say why it cannot be")
                self.assertNotIn(
                    label.replace(" ", "_"), columns,
                    f"{label!r} names a column present in the committed CSVs, "
                    "so it is checkable; verify it instead of allowlisting it")

    def test_the_headline_table_is_checked(self):
        """Grouped labels resolved to no arm, so the table was skipped whole.

        `Voice Live + gpt-4.1-mini` and `gpt-realtime-2 (either stack)` matched
        nothing, and the report's main comparison — the table a reader looks at
        first — could be set to 9999–9999 and stay green. The group column states
        a range, so it is checked against the min and max across its arms.
        """
        cases = [
            ("| Time to first audio, p95 | **1719 ms** | 3325–3722 ms |",
             "| Time to first audio, p95 | **1719 ms** | 9999–9999 ms |"),
            # A degenerate range: both arms agree, so it is written as one value.
            ("| Judge groundedness | 0.704 | **1.000** |",
             "| Judge groundedness | 0.704 | **0.500** |"),
            # And the single-arm column of the same table.
            ("| Time to first audio, p50 | **1315 ms** | 2077–2408 ms |",
             "| Time to first audio, p50 | **1111 ms** | 2077–2408 ms |"),
        ]
        for original, mutated in cases:
            with self.subTest(row=original[:40]), tempfile.TemporaryDirectory() as tmp:
                docs = self._sandbox(tmp)
                p = docs / "voice-engine-quality-2026-08.md"
                self.assertIn(original, p.read_text())
                p.write_text(p.read_text().replace(original, mutated))
                out, code = self._run(docs=docs)
                self.assertEqual(code, 1, "the headline table must be checked")

    def test_an_unresolved_arm_column_or_row_is_reported(self):
        """The arm axis had the row fix's hole, in both directions.

        A column whose header names no arm was omitted from the comprehension,
        so its cells were never compared — and because the *resolved* count was
        unchanged, `RESULTS_FOR` still matched exactly. That defeats the coverage
        equality as well as the comparison.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08-gpt-realtime-2-1.md"
            s = p.read_text().replace(
                "| | VL + gpt-4.1-mini | **VL + 2.1** | Foundry 2.1 |",
                "| | VL + gpt-4.1-mini | **VL + 2.1** | Foundry 2.1 | vl-gpt41min |"
            ).replace(
                "| slots heard | **0.960** | 0.920 | 0.893 |",
                "| slots heard | **0.960** | 0.920 | 0.893 | 9.999 |")
            p.write_text(s)
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1, "a misspelled arm column must not pass")
            self.assertTrue(any("names no arm" in x for x in out["problems"]),
                            out["problems"])
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08.md"
            p.write_text(p.read_text().replace(
                "| vl-gpt41mini-dns | <0 (degenerate) | 9.6 dB |",
                "| vl-gpt41mini-dns | <0 (degenerate) | 9.6 dB |\n"
                "| vl-typo-arm | 1.0 dB | 2.0 dB |"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1, "a misspelled arm row must not pass")
            self.assertTrue(any("names no arm" in x for x in out["problems"]),
                            out["problems"])

    def test_units_and_estimate_markers_do_not_hide_a_figure(self):
        """A cell the parser cannot read is a cell it silently skips.

        `~15` made a cost line uncheckable *and* silent — "approximate" is not
        "unverifiable" — and `1.0 dB` hid an unresolved arm row, because the
        row only reports when it carries something recognised as a figure.
        """
        import check_report
        for cell, want in (("~15", 15.0), ("~0.05", 0.05), ("2.0 dB", 2.0),
                           ("1719 ms", 1719.0), ("$0.03/min", 0.03),
                           ("**4.47**", 4.47)):
            with self.subTest(cell=cell):
                self.assertEqual(check_report.parse_number(cell), want)
        # Genuinely unparseable stays unparseable.
        for cell in ("<0 (degenerate)", "47.76 (8e)", "Foundry `/openai/v1/`"):
            with self.subTest(cell=cell):
                self.assertIsNone(check_report.parse_number(cell))

    def test_estimate_lines_are_checked_not_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            p = docs / "voice-engine-quality-2026-08.md"
            p.write_text(p.read_text().replace(
                "| pilots and probes | ~15 | — | ~0.05 | 0.75 |",
                "| pilots and probes | ~150 | — | ~0.05 | 0.75 |"))
            out, code = self._run(docs=docs)
            self.assertEqual(code, 1)
            self.assertTrue(any("pilots and probes" in x for x in out["problems"]),
                            out["problems"])

    def test_every_committed_figure_is_actually_compared(self):
        """The cheapest test of a checker: change a number, expect a complaint.

        Run over every numeric table cell in both reports rather than the ones
        someone thought to try — each silent-skip found so far (compound cell,
        grouped column, misspelled column, unit-suffixed value, estimate marker)
        was invisible to inspection and obvious to mutation.
        """
        import check_report
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            unchecked = []
            for report in sorted(docs.glob("*.md")):
                original = report.read_text()
                lines = original.splitlines()
                for i, line in enumerate(lines):
                    if not line.strip().startswith("|"):
                        continue
                    cells = line.strip().strip("|").split("|")
                    header = (lines[i - 2].strip().strip("|").split("|")
                              if i >= 2 and lines[i - 2].strip().startswith("|")
                              else [])
                    for j, cell in enumerate(cells):
                        # Only cells that ARE a figure. Bumping the first decimal
                        # on the line hits `gpt-4.1-mini` and reports a model
                        # name as an unchecked measurement.
                        val = check_report.parse_number(cell)
                        if val is None:
                            continue
                        # Cells declared unchecked, with a reason, are exempt —
                        # the catalog $/min prices are Azure's published rates
                        # and nothing in this repository can verify them. The
                        # exemption is only as good as UNCHECKED_METRICS, which
                        # its own test polices.
                        labels = {check_report.norm_label(cells[0])}
                        if j < len(header):
                            labels.add(check_report.norm_label(header[j]))
                        if labels & set(check_report.UNCHECKED_METRICS):
                            continue
                        mutated = list(cells)
                        mutated[j] = cell.replace(
                            f"{val:g}", f"{val + 1:g}", 1) if f"{val:g}" in cell \
                            else f" {val + 1:g} "
                        lines[i] = "| " + " | ".join(
                            c.strip() for c in mutated) + " |"
                        report.write_text("\n".join(lines) + "\n")
                        _, code = self._run(docs=docs)
                        if code == 0:
                            unchecked.append(
                                f"{report.name}:{i + 1} cell {j}: {cell.strip()}"
                                f"  in  {line.strip()[:60]}")
                        lines[i] = line
                report.write_text(original)
            self.assertEqual(
                unchecked, [],
                "these table figures can be changed without any check noticing")

    def test_each_cost_line_satisfies_its_own_arithmetic(self):
        """Summing the last column left the inputs unverified.

        70.0 minutes could become 700.0 with $6.33 unchanged — the same
        internal-consistency-of-a-subset gap that let the headline spend drift
        away from the table it summarises.
        """
        cases = [
            ("voice-engine-quality-2026-08.md",
             "| native-gpt-realtime-2 | 70.0 | 20.4 | 0.07 | 6.33 |",
             "| native-gpt-realtime-2 | 700.0 | 20.4 | 0.07 | 6.33 |"),
            ("voice-engine-quality-2026-08-gpt-realtime-2-1.md",
             "| `gpt-realtime-2.1` | 52.5 | 13.5 | 0.070 | 4.62 |",
             "| `gpt-realtime-2.1` | 52.5 | 13.5 | 0.140 | 4.62 |"),
        ]
        for report, original, mutated in cases:
            with self.subTest(report=report), tempfile.TemporaryDirectory() as tmp:
                docs = self._sandbox(tmp)
                p = docs / report
                self.assertIn(original, p.read_text())
                p.write_text(p.read_text().replace(original, mutated))
                out, code = self._run(docs=docs)
                self.assertEqual(code, 1)
                self.assertTrue(any("cost line" in x for x in out["problems"]),
                                out["problems"])

    def test_the_headline_spend_is_checked_against_the_cost_table(self):
        """The guard must catch the defect it was written for.

        It validated only the table's internal arithmetic, while the figure a
        reader quotes lives in the opening paragraph. Both reports' headlines had
        been unreconciled estimates ($23.19 vs $22.82; $9.03 vs $8.85) — reverting
        either left the table untouched and the run green.
        """
        for report, stale, current in (
                ("voice-engine-quality-2026-08.md",
                 "Actual spend **$23.19**", "Actual spend **$22.82**"),
                ("voice-engine-quality-2026-08-gpt-realtime-2-1.md",
                 "Spend **$9.03** (cap $12)", "Spend **$8.85** (cap $12)")):
            with self.subTest(report=report), tempfile.TemporaryDirectory() as tmp:
                docs = self._sandbox(tmp)
                p = docs / report
                self.assertIn(current, p.read_text())
                p.write_text(p.read_text().replace(current, stale))
                out, code = self._run(docs=docs)
                self.assertEqual(code, 1, "a stale headline spend must fail")
                self.assertTrue(any("headline spend" in x for x in out["problems"]),
                                out["problems"])

    def test_the_transcript_identity_counts_are_reproducible(self):
        """Codex, on a6fdfc4 — the one finding that moved a published claim.

        The addendum read "`vl-native-brain-21` matches the other Voice Live
        arms 10/27", which describes a *group* while 10/27 is the count against
        one arm, `vl-gpt41mini-semvad`. The group figures are 21/27 (any of the
        four Voice Live arms) and 13/27 (any gpt-4.1-mini one), and the
        strongest single match is `vl-native-brain` at 19/27 — so the sentence
        understated its own evidence while attributing it to the wrong
        comparator. The conclusion is unchanged and better supported: 19 against
        the same-surface arm, 1 against the whisper-1 arm.

        These counts sit in prose, which #14 deliberately does not match, so
        they are recomputed here instead — the same rule the harness applies
        everywhere else: a number nothing regenerates is a number that goes
        stale.
        """
        runs = [json.loads(l) for l in
                (HERE / "results" / "scenarios.jsonl").read_text().splitlines()
                if l.strip()]
        by: dict[str, dict] = {}
        for r in runs:
            by.setdefault(r["arm"], {})[(r["scenario"], r["trial"])] = tuple(
                m["text"] for m in r.get("transcript", [])
                if m["role"] == "caller_asr")
        target = by["vl-native-brain-21"]

        def identical(other: str) -> int:
            o = by.get(other, {})
            return sum(1 for k, v in target.items() if k in o and o[k] == v)

        md = (HERE / ".." / ".." / "docs" / "research" /
              "voice-engine-quality-2026-08-gpt-realtime-2-1.md").read_text()
        for arm, label in (("vl-native-brain", "`vl-native-brain`"),
                           ("vl-gpt41mini-semvad", "`vl-gpt41mini-semvad`"),
                           ("native-gpt-realtime-21", "Foundry 2.1")):
            with self.subTest(arm=arm):
                n = identical(arm)
                self.assertIn(f"{n}/{len(target)}", md,
                              f"the report states no {n}/{len(target)} count "
                              f"for {label}; recomputed from scenarios.jsonl")
        # And the comparator must be named, not left as "the other arms" — the
        # count is per-arm, so a group phrase misdescribes it. Checked
        # everywhere the claim appears: the same wording was in the claims
        # table at the top of the document as well as in the prose below it,
        # and fixing only the prose left the summary a reader meets first
        # saying the old thing.
        for phrase in ("the other Voice Live arms 10/27",
                       "10/27 transcript matches to the other Voice Live arms"):
            self.assertNotIn(phrase, md)

    def test_the_merged_report_keeps_its_own_results_snapshot(self):
        """The 2.1 run re-judged every arm and overwrote results/ in place.

        Without the snapshot the merged report's numbers are unverifiable, and a
        reader re-running the scorers gets different figures with no explanation.
        """
        snap = HERE / "results" / "main-report" / "summary.csv"
        self.assertTrue(snap.exists(), "merged-report results snapshot is missing")
        with snap.open() as f:
            rows = {r["arm"]: r for r in csv.DictReader(f)}
        self.assertEqual(rows["native-gpt-realtime-2"]["success_mean"], "0.593")
        with (HERE / "results" / "summary.csv").open() as f:
            cur = {r["arm"]: r for r in csv.DictReader(f)}
        self.assertNotEqual(cur["native-gpt-realtime-2"]["success_mean"],
                            rows["native-gpt-realtime-2"]["success_mean"],
                            "if these ever agree, drop the snapshot and the "
                            "RESULTS_FOR indirection rather than keeping both")

    def test_a_grouped_row_is_checked_against_every_arm_it_covers(self):
        """The grouping IS the claim, so it has to be able to fail.

        The `gpt-realtime-2 / 2.1` recogniser row states one slot-capture figure
        for two arms, and that row is what backs the addendum's structural
        finding — slot capture is a function of (recogniser, VAD) and not of the
        brain. It was compared against `native-gpt-realtime-2` only, so if 2.1's
        capture moved the stale shared value still passed on the incumbent: an
        assertion that two arms agree, validated in a way that cannot notice
        them disagreeing.
        """
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._sandbox(tmp)
            res = self._results_copy(tmp)
            with (res / "summary.csv").open() as f:
                rows = list(csv.DictReader(f))
            moved = False
            for r in rows:
                if r["arm"] == "native-gpt-realtime-21":
                    self.assertEqual(r["slot_heard"], "0.893")
                    r["slot_heard"], moved = "0.777", True
            self.assertTrue(moved, "the 2.1 arm is missing from summary.csv")
            with (res / "summary.csv").open("w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows(rows)
            out, code = self._run(docs=docs, results=res)
            self.assertEqual(code, 1)
            self.assertTrue(
                any("gpt-realtime-2 / 2.1" in x
                    and "native-gpt-realtime-21" in x for x in out["problems"]),
                f"the grouped row passed on its other arm: {out['problems']}")

    def test_every_multi_arm_row_declares_all_its_arms(self):
        """The declaration is a tuple so a group cannot silently shrink to one.

        A single-arm value made the one-arm-only comparison invisible: nothing
        about `"native-gpt-realtime-2"` said the row covered two. Requiring a
        tuple everywhere makes adding an arm to a row an edit to the arm list
        rather than a decision nobody records.
        """
        import check_report
        for key, arms in check_report.RECOGNISER_ROWS.items():
            with self.subTest(row=key):
                self.assertIsInstance(arms, tuple, f"{key} names a bare arm")
                self.assertTrue(arms, f"{key} names no arm at all")
        # And the row whose label states two versions must declare two arms.
        grouped = [k for k in check_report.RECOGNISER_ROWS if "/" in k[2]]
        self.assertTrue(grouped, "the grouped recogniser row has disappeared")
        for k in grouped:
            self.assertEqual(
                len(check_report.RECOGNISER_ROWS[k]), len(k[2].split("/")),
                f"{k[2]!r} names {len(k[2].split('/'))} brains but "
                f"{len(check_report.RECOGNISER_ROWS[k])} arm(s) check it")


if __name__ == "__main__":
    unittest.main()
