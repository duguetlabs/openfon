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

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "prepare"))

from judge import JudgeParseError, parse_verdicts  # noqa: E402
from score_slots import detect_lang, slot_present, time_forms  # noqa: E402
from score_wer import normalize  # noqa: E402


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

    def test_time_forms_are_valid_regexes(self):
        import re
        for lang in ("en", "de"):
            for f in time_forms("14:00", lang):
                with self.subTest(lang=lang, form=f):
                    re.compile(f)


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
        for bad in ({"groundedness": 2}, {"resolution": 5}, {"tone": -1},
                    {"groundedness": None}, {"tone": "good"}):
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
