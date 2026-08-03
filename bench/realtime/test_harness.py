"""Tests for the harness controls — the things that make the run trustworthy
rather than the things that summarise it.

  python3 -m unittest discover -s bench/realtime -v
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from arms import ARMS_BY_ID, SAMPLE_RATE  # noqa: E402
from audio import FRAME_BYTES, Utterance, cache_name, trim_silence  # noqa: E402
import bench  # noqa: E402
from bench import discard_fragment, transcript_belongs_to_turn  # noqa: E402
from safety import redact, scrub_record  # noqa: E402

GA_ARM = ARMS_BY_ID["native-direct"]        # marin / whisper-1 / server_vad
VL_ARM = ARMS_BY_ID["vl-direct"]            # Ava / azure-speech / server_vad
SEM_ARM = ARMS_BY_ID["nat-semantic"]        # marin / whisper-1 / semantic_vad


def ga_echo(**over):
    td = {"type": "server_vad", "threshold": 0.7, "prefix_padding_ms": 300,
          "silence_duration_ms": 550}
    td.update(over.pop("turn_detection", {}))
    sess = {
        "instructions": "…",
        "audio": {
            "input": {"format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                      "turn_detection": td,
                      "transcription": {"model": over.pop("stt", "whisper-1")}},
            "output": {"format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                       "voice": over.pop("voice", "marin")},
        },
    }
    return sess


def vl_echo(**over):
    td = {"type": "server_vad", "threshold": 0.7, "prefix_padding_ms": 300,
          "silence_duration_ms": 550}
    td.update(over.pop("turn_detection", {}))
    return {
        "instructions": "…",
        "turn_detection": td,
        "input_audio_transcription": {"model": over.pop("stt", "azure-speech")},
        "input_audio_format": "pcm16", "output_audio_format": "pcm16",
        "input_audio_sampling_rate": over.pop("rate", SAMPLE_RATE),
        "voice": {"name": over.pop("voice", "en-US-AvaMultilingualNeural"),
                  "type": "azure-standard"},
    }


class TestVerifyEcho(unittest.TestCase):
    """Matching the marker proves our update was processed; it does not prove
    the endpoint honoured every field. The governing rule is ABSENT MUST NOT
    READ AS VALID — a control that cannot be confirmed is not a control."""

    # — clean echoes verify —

    def test_clean_ga_echo_is_clean(self):
        self.assertEqual(GA_ARM.verify_echo(ga_echo()), ([], []))

    def test_clean_vl_echo_is_clean(self):
        self.assertEqual(VL_ARM.verify_echo(vl_echo()), ([], []))

    def test_semantic_arm_accepts_its_own_detector(self):
        echo = ga_echo(turn_detection={"type": "semantic_vad", "eagerness": "auto"})
        self.assertEqual(SEM_ARM.verify_echo(echo), ([], []))

    # — format substitution is FATAL, both branches, both directions —

    def test_ga_output_codec_substitution_is_fatal(self):
        echo = ga_echo()
        echo["audio"]["output"]["format"] = {"type": "audio/pcmu"}
        fatal, _ = GA_ARM.verify_echo(echo)
        self.assertTrue(any("output format.type" in x for x in fatal), fatal)

    def test_ga_input_codec_substitution_is_fatal(self):
        echo = ga_echo()
        echo["audio"]["input"]["format"] = {"type": "audio/pcma", "rate": 8000}
        fatal, _ = GA_ARM.verify_echo(echo)
        self.assertTrue(any("input format.type" in x for x in fatal), fatal)

    def test_vl_output_codec_substitution_is_fatal(self):
        echo = vl_echo()
        echo["output_audio_format"] = "g711_ulaw"
        fatal, _ = VL_ARM.verify_echo(echo)
        self.assertTrue(any("output_audio_format" in x for x in fatal), fatal)

    def test_vl_input_codec_substitution_is_fatal(self):
        """input_audio_format was previously not checked at all."""
        echo = vl_echo()
        echo["input_audio_format"] = "g711_alaw"
        fatal, _ = VL_ARM.verify_echo(echo)
        self.assertTrue(any("input_audio_format" in x for x in fatal), fatal)

    # — absent must not read as valid —

    def test_ga_absent_format_is_fatal_not_skipped(self):
        echo = ga_echo()
        del echo["audio"]["output"]["format"]
        fatal, _ = GA_ARM.verify_echo(echo)
        self.assertTrue(any("output format absent" in x for x in fatal), fatal)

    def test_ga_absent_rate_is_fatal_not_skipped(self):
        echo = ga_echo()
        echo["audio"]["input"]["format"] = {"type": "audio/pcm"}      # no rate
        fatal, _ = GA_ARM.verify_echo(echo)
        self.assertTrue(any("input format.rate absent" in x for x in fatal), fatal)

    def test_vl_absent_format_is_fatal_not_skipped(self):
        echo = vl_echo()
        del echo["output_audio_format"]
        fatal, _ = VL_ARM.verify_echo(echo)
        self.assertTrue(any("output_audio_format absent" in x for x in fatal), fatal)

    def test_vl_absent_rate_is_fatal_not_skipped(self):
        echo = vl_echo()
        del echo["input_audio_sampling_rate"]
        fatal, _ = VL_ARM.verify_echo(echo)
        self.assertTrue(any("sampling_rate absent" in x for x in fatal), fatal)

    def test_missing_audio_block_is_fatal(self):
        fatal, _ = GA_ARM.verify_echo({"instructions": "x"})
        self.assertTrue(any("session.audio absent" in x for x in fatal), fatal)

    def test_empty_echo_is_fatal_on_both_branches(self):
        self.assertTrue(GA_ARM.verify_echo({})[0])
        self.assertTrue(VL_ARM.verify_echo({})[0])

    def test_absent_turn_detection_param_is_fatal(self):
        echo = vl_echo()
        del echo["turn_detection"]["silence_duration_ms"]
        fatal, _ = VL_ARM.verify_echo(echo)
        self.assertTrue(any("silence_duration_ms absent" in x for x in fatal), fatal)

    # — wrong rate / detector are fatal —

    def test_wrong_sample_rate_is_fatal(self):
        fatal, _ = VL_ARM.verify_echo(vl_echo(rate=16000))
        self.assertTrue(any("rate=16000" in x for x in fatal), fatal)

    def test_substituted_detector_is_fatal(self):
        fatal, _ = GA_ARM.verify_echo(ga_echo(turn_detection={"type": "semantic_vad"}))
        self.assertTrue(any("turn_detection.type" in x for x in fatal), fatal)

    def test_silently_changed_hangover_is_fatal(self):
        # Voice Live defaults silence_duration_ms to 200; unpinned that is a
        # 350 ms artefact and must not pass as a warning
        fatal, _ = VL_ARM.verify_echo(vl_echo(turn_detection={"silence_duration_ms": 200}))
        self.assertTrue(any("silence_duration_ms=200" in x for x in fatal), fatal)

    # — divergences that cannot corrupt a timing stay advisory —

    def test_substituted_stt_model_is_advisory(self):
        fatal, advisory = GA_ARM.verify_echo(ga_echo(stt="azure-speech"))
        self.assertEqual(fatal, [])
        self.assertTrue(any("transcription.model" in x for x in advisory), advisory)

    def test_substituted_voice_is_advisory(self):
        fatal, advisory = GA_ARM.verify_echo(ga_echo(voice="alloy"))
        self.assertEqual(fatal, [])
        self.assertTrue(any("voice=" in x for x in advisory), advisory)

    def test_absent_voice_is_reported_not_silently_passed(self):
        echo = ga_echo()
        del echo["audio"]["output"]["voice"]
        _, advisory = GA_ARM.verify_echo(echo)
        self.assertTrue(any("voice=None" in x for x in advisory), advisory)

    def test_dialect_selects_the_branch_not_the_payload_shape(self):
        """A GA arm handed a Voice-Live-shaped echo must fail, not silently
        pass by matching whichever branch happens to fit."""
        fatal, _ = GA_ARM.verify_echo(vl_echo())
        self.assertTrue(any("session.audio absent" in x for x in fatal), fatal)


class TestCacheName(unittest.TestCase):
    """Keying the cache on the id alone would silently replay stale audio
    after someone edits an utterance — every arm would still hear identical
    input, so nothing would look wrong."""

    def test_same_spec_is_stable(self):
        u = {"id": "en-short", "text": "hello", "voice": "v"}
        self.assertEqual(cache_name(u), cache_name(dict(u)))

    def test_edited_text_changes_the_key(self):
        a = cache_name({"id": "x", "text": "hello", "voice": "v"})
        b = cache_name({"id": "x", "text": "hello!", "voice": "v"})
        self.assertNotEqual(a, b)

    def test_changed_voice_changes_the_key(self):
        a = cache_name({"id": "x", "text": "hello", "voice": "v1"})
        b = cache_name({"id": "x", "text": "hello", "voice": "v2"})
        self.assertNotEqual(a, b)

    def test_keeps_the_id_readable(self):
        self.assertTrue(cache_name({"id": "de-short", "text": "t",
                                    "voice": "v"}).startswith("de-short-"))


class TestUtteranceFraming(unittest.TestCase):
    def test_frames_are_whole_and_padded(self):
        u = Utterance(id="x", lang="en", voice="v", text="t",
                      pcm=b"\x01\x02" * 1000)          # not a frame multiple
        frames = u.frames()
        self.assertTrue(all(len(f) == FRAME_BYTES for f in frames))
        self.assertGreaterEqual(len(frames) * FRAME_BYTES, 2000)

    def test_duration_matches_the_sample_count(self):
        u = Utterance(id="x", lang="en", voice="v", text="t",
                      pcm=b"\x00" * (SAMPLE_RATE * 2))  # exactly 1 s
        self.assertAlmostEqual(u.duration_s, 1.0)


class TestTrimSilence(unittest.TestCase):
    """ttfa is measured from the last speech frame, so TTS tail padding would
    inflate every number in the report."""

    def test_removes_leading_and_trailing_silence(self):
        quiet = b"\x00" * FRAME_BYTES
        loud = b"\xff\x7f" * (FRAME_BYTES // 2)
        self.assertEqual(trim_silence(quiet * 3 + loud + quiet * 3), loud)

    def test_keeps_interior_silence(self):
        quiet = b"\x00" * FRAME_BYTES
        loud = b"\xff\x7f" * (FRAME_BYTES // 2)
        self.assertEqual(trim_silence(loud + quiet + loud), loud + quiet + loud)

    def test_all_silence_is_returned_unchanged(self):
        quiet = b"\x00" * FRAME_BYTES * 3
        self.assertEqual(trim_silence(quiet), quiet)


if __name__ == "__main__":
    unittest.main()


class _T:
    """Minimal stand-in for Turn's fragment counters."""
    def __init__(self):
        self.false_starts = 0
        self.false_starts_audible = 0
        self.false_start_audio_ms = 0.0


class TestDiscardFragment(unittest.TestCase):
    """The "splits are inaudible" conclusion rests on this count, so it must
    not be able to undercount."""

    def test_silent_fragment_counts_as_a_split_but_not_audible(self):
        t = _T()
        self.assertEqual(discard_fragment(t, 0), 0)
        self.assertEqual((t.false_starts, t.false_starts_audible), (1, 0))
        self.assertEqual(t.false_start_audio_ms, 0.0)

    def test_audible_fragment_is_counted_and_measured(self):
        t = _T()
        discard_fragment(t, 48 * 250)          # 250 ms at 24 kHz PCM16
        self.assertEqual((t.false_starts, t.false_starts_audible), (1, 1))
        self.assertAlmostEqual(t.false_start_audio_ms, 250.0)

    def test_counter_is_reset_so_fragments_do_not_bleed_together(self):
        t = _T()
        left = discard_fragment(t, 48 * 100)
        self.assertEqual(left, 0)
        discard_fragment(t, left)              # a second, silent fragment
        self.assertEqual((t.false_starts, t.false_starts_audible), (2, 1))
        self.assertAlmostEqual(t.false_start_audio_ms, 100.0)

    def test_audio_spanning_the_speech_end_boundary_is_attributed(self):
        """A fragment can start before speech ends and be cancelled after; one
        counter spans both, so its audio is not lost to the boundary."""
        t = _T()
        pre, post = 48 * 40, 48 * 60           # 40 ms before, 60 ms after
        discard_fragment(t, pre + post)
        self.assertEqual(t.false_starts_audible, 1)
        self.assertAlmostEqual(t.false_start_audio_ms, 100.0)


class TestSafetyBoundary(unittest.TestCase):
    """Redaction lives where text leaves the process, because a later script
    reintroduced the leak simply by printing an exception."""

    SECRET_URL = "wss://api.kataleptic.com/v1/realtime?model=x&token=dg_abc123SECRETKEY9999"

    def test_redacts_query_credentials(self):
        out = redact(f"InvalidURI: {self.SECRET_URL} is not valid")
        self.assertNotIn("dg_abc123SECRETKEY9999", out)
        self.assertIn("token=<redacted>", out)

    def test_redacts_a_bare_key_without_its_query_parameter(self):
        out = redact("auth failed for dg_abc123SECRETKEY9999")
        self.assertNotIn("abc123SECRETKEY9999", out)

    def test_scrub_record_walks_nested_structures(self):
        rec = {"error": f"connect: {self.SECRET_URL}",
               "usage": {"note": [f"retry {self.SECRET_URL}"]},
               "ok": False, "ms": 12.5}
        out = scrub_record(rec)
        blob = json.dumps(out)
        self.assertNotIn("dg_abc123SECRETKEY9999", blob)
        self.assertEqual(out["ok"], False)      # non-strings pass through
        self.assertEqual(out["ms"], 12.5)

    def test_scrub_record_is_a_last_line_for_new_fields(self):
        """A field added later, whose author forgot to redact, is still caught
        on the way to disk."""
        out = scrub_record({"some_new_field": self.SECRET_URL})
        self.assertNotIn("dg_abc123SECRETKEY9999", out["some_new_field"])

    def test_clean_text_is_untouched(self):
        self.assertEqual(redact("timeout waiting for response.done"),
                         "timeout waiting for response.done")


class TestEveryRequestedDetectorFieldIsVerified(unittest.TestCase):
    """The check is derived from the request payload, not a hardcoded list —
    which is how `eagerness`, added later for the semantic detector, went
    unverified while the follow-up attributed its results to that setting."""

    def test_dropped_eagerness_is_fatal(self):
        echo = ga_echo(turn_detection={"type": "semantic_vad"})   # no eagerness
        fatal, _ = SEM_ARM.verify_echo(echo)
        self.assertTrue(any("eagerness absent" in x for x in fatal), fatal)

    def test_substituted_eagerness_is_fatal(self):
        echo = ga_echo(turn_detection={"type": "semantic_vad", "eagerness": "low"})
        fatal, _ = SEM_ARM.verify_echo(echo)
        self.assertTrue(any("eagerness=" in x for x in fatal), fatal)

    def test_every_requested_key_is_actually_checked(self):
        """Whatever an arm asks for, dropping it must be caught — so a field
        added to any arm in future cannot be silently unverified."""
        for arm, echo_fn in ((GA_ARM, ga_echo), (VL_ARM, vl_echo),
                             (SEM_ARM, ga_echo)):
            for key in arm.turn_detection:
                echo = echo_fn()
                td = (echo["audio"]["input"]["turn_detection"]
                      if "audio" in echo else echo["turn_detection"])
                td.update(arm.turn_detection)
                td.pop(key)
                fatal, _ = arm.verify_echo(echo)
                self.assertTrue(any(f"turn_detection.{key}" in x for x in fatal),
                                f"{arm.id}: dropping {key} was not caught")


class TestTranscriptCorrelation(unittest.TestCase):
    """Used by both the main loop and the post-response grace window, so the
    two paths cannot drift apart — the grace path previously kept the old
    uncorrelated behaviour after the main path was fixed."""

    def test_final_item_is_accepted(self):
        self.assertTrue(transcript_belongs_to_turn("item_b", {"item_a"}, {"item_b"}))

    def test_fragment_item_is_rejected(self):
        self.assertFalse(transcript_belongs_to_turn("item_a", {"item_a"}, {"item_b"}))

    def test_unknown_item_is_rejected_when_finals_are_known(self):
        self.assertFalse(transcript_belongs_to_turn("item_z", set(), {"item_b"}))

    def test_accepts_when_there_is_nothing_to_correlate_on(self):
        # no item_id on the event, or no commits observed
        self.assertTrue(transcript_belongs_to_turn("", {"item_a"}, {"item_b"}))
        self.assertTrue(transcript_belongs_to_turn("item_x", set(), set()))


class TestKeyPrecedence(unittest.TestCase):
    """src/call-session.ts uses REALTIME_API_KEY || DEFAULT_LLM_API_KEY. Reading
    whichever name appeared first in the file would authenticate the gateway
    arms with a different key than production uses, and fail the whole run
    despite a valid realtime key being present."""

    def _load(self, text, env=None):
        import tempfile
        d = Path(tempfile.mkdtemp())
        (d / ".dev.vars").write_text(text)
        old_root = bench.REPO_ROOT
        old_env = os.environ.pop("KATALEPTIC_KEY", None)
        if env:
            os.environ["KATALEPTIC_KEY"] = env
        bench.REPO_ROOT = d
        try:
            return bench.load_kataleptic_key()
        finally:
            bench.REPO_ROOT = old_root
            os.environ.pop("KATALEPTIC_KEY", None)
            if old_env is not None:
                os.environ["KATALEPTIC_KEY"] = old_env

    def test_realtime_key_wins_even_when_listed_second(self):
        self.assertEqual(
            self._load("DEFAULT_LLM_API_KEY=dg_default\nREALTIME_API_KEY=dg_realtime\n"),
            "dg_realtime")

    def test_realtime_key_wins_when_listed_first(self):
        self.assertEqual(
            self._load("REALTIME_API_KEY=dg_realtime\nDEFAULT_LLM_API_KEY=dg_default\n"),
            "dg_realtime")

    def test_falls_back_to_the_default_when_realtime_absent(self):
        self.assertEqual(self._load("DEFAULT_LLM_API_KEY=dg_default\n"), "dg_default")

    def test_environment_overrides_the_file(self):
        self.assertEqual(
            self._load("REALTIME_API_KEY=dg_realtime\n", env="dg_env"), "dg_env")

    def test_quotes_are_stripped(self):
        self.assertEqual(self._load("REALTIME_API_KEY='dg_quoted'\n"), "dg_quoted")


class TestMalformedRateIsRecordedNotRaised(unittest.TestCase):
    """A malformed-but-present value must surface as a control mismatch. An
    exception would become a generic turn failure and lose the diagnostic."""

    def test_unparseable_vl_rate(self):
        fatal, _ = VL_ARM.verify_echo(vl_echo(rate="24khz"))
        self.assertTrue(any("unparseable" in x for x in fatal), fatal)

    def test_unparseable_ga_rate(self):
        echo = ga_echo()
        echo["audio"]["input"]["format"] = {"type": "audio/pcm", "rate": "24k"}
        fatal, _ = GA_ARM.verify_echo(echo)
        self.assertTrue(any("unparseable" in x for x in fatal), fatal)

    def test_numeric_string_rate_is_accepted(self):
        self.assertEqual(VL_ARM.verify_echo(vl_echo(rate="24000"))[0], [])


class TestMarkerIsPerCellNotPerArm(unittest.TestCase):
    """The marker goes into the system prompt. Generating a fresh one per arm
    put a different random token in treatment and control within the same
    (round, utterance) cell — variance introduced by the very check meant to
    remove uncertainty. It must be an argument, supplied once per cell."""

    def test_run_turn_requires_a_marker_from_the_caller(self):
        import inspect
        from bench import run_turn
        sig = inspect.signature(run_turn)
        self.assertIn("marker", sig.parameters)
        self.assertEqual(sig.parameters["marker"].kind,
                         inspect.Parameter.KEYWORD_ONLY)

    def test_run_turn_does_not_mint_its_own_marker(self):
        import inspect
        from bench import run_turn
        src = inspect.getsource(run_turn)
        self.assertNotIn("token_hex", src,
                         "run_turn must not generate a marker; the cell owns it")

    def test_the_same_marker_reaches_every_arm_in_a_cell(self):
        """Two arms handed the same marker must produce byte-identical
        instructions, which is what the pairing assumes."""
        a, b = ARMS_BY_ID["native-direct"], ARMS_BY_ID["native-gateway"]
        pa = a.session_payload("MKCELL01")
        pb = b.session_payload("MKCELL01")
        self.assertEqual(pa["instructions"], pb["instructions"])

    def test_different_cells_still_get_different_markers(self):
        a = ARMS_BY_ID["native-direct"]
        self.assertNotEqual(a.session_payload("MKCELL01")["instructions"],
                            a.session_payload("MKCELL02")["instructions"])


class TestVerifierCoversEveryRegisteredArm(unittest.TestCase):
    """verify_live iterated a hand-maintained subset and printed OK while
    checking none of the newest combinations — "absent reads as a pass", in the
    tool built to catch exactly that."""

    def test_verifier_enumerates_the_registry(self):
        import inspect, verify_live
        src = inspect.getsource(verify_live.main)
        self.assertIn("ARMS_BY_ID.values()", src)
        self.assertNotIn("ARMS + VAD_ARMS", src)

    def test_no_registered_arm_is_unreachable_from_the_cli(self):
        """Every arm must be selectable, so a registered arm cannot be dead."""
        import bench, inspect
        self.assertIn('args.arms == "all"', inspect.getsource(bench.main))
        self.assertTrue(len(ARMS_BY_ID) >= 17)


class TestMutationChecksNeedAVerifiedBaseline(unittest.TestCase):
    """A mutation check asks "would the checker notice this substitution?".
    Against an echo that is ALREADY invalid the answer is yes regardless, so
    every mutation reports "detected" for the wrong reason. verify_live kept
    the bad echo after a clean retry and ran mutations against it — a false
    pass in the tool built to catch false passes."""

    def _bad_echo(self):
        echo = ga_echo()
        echo["audio"]["input"]["turn_detection"]["threshold"] = 0.5   # substituted
        return echo

    def test_an_invalid_baseline_makes_every_mutation_look_detected(self):
        """The property that makes the bug silent: the check passes anyway."""
        bad = self._bad_echo()
        self.assertTrue(GA_ARM.verify_echo(bad)[0], "baseline must be invalid")
        for kind in ("codec", "rate"):
            mutated = dict(bad)
            fatal, _ = GA_ARM.verify_echo(mutated)
            self.assertTrue(fatal, "an unmutated bad echo already reports fatal — "
                                   "so a mutation against it proves nothing")

    def test_a_clean_baseline_makes_the_check_meaningful(self):
        clean = ga_echo()
        self.assertEqual(GA_ARM.verify_echo(clean)[0], [])
        broken = ga_echo()
        broken["audio"]["output"]["format"] = {"type": "audio/pcmu"}
        self.assertTrue(GA_ARM.verify_echo(broken)[0])

    def test_verifier_skips_mutations_when_the_echo_did_not_verify(self):
        import inspect, verify_live
        src = inspect.getsource(verify_live.main)
        self.assertIn("mutations not run", src)

    def test_verifier_adopts_the_retry_echo(self):
        """State must not survive the retry boundary: the clean echo replaces
        the bad one, and advisory is re-derived from it."""
        import inspect, verify_live
        src = inspect.getsource(verify_live.main)
        self.assertIn("sess, fatal, advisory = again, refatal, readvisory", src)


class TestVerifierNeverDropsAnAdvisory(unittest.TestCase):
    """Three findings in verify_live this round, all the retry path swallowing
    information: the wrong echo, then the wrong advisory. An advisory is
    appended to whatever note already exists, never gated on it being empty."""

    def test_advisory_is_appended_not_conditional(self):
        import inspect, verify_live
        src = inspect.getsource(verify_live.main)
        self.assertIn('note += f"  (advisory:', src)
        self.assertNotIn("if advisory and not note:", src)

    def test_a_clean_retry_can_still_carry_an_advisory(self):
        """The real shape: gateway substitutes turn_detection (fatal, races),
        retry is clean on that but still substitutes the STT model."""
        echo = ga_echo(stt="whisper")            # advisory-only divergence
        fatal, advisory = GA_ARM.verify_echo(echo)
        self.assertEqual(fatal, [])
        self.assertTrue(advisory, "retry echo must still surface its advisory")


class TestReportCheckerCoversEveryFigureRow(unittest.TestCase):
    """Three review rounds, three row layouts the checker silently dropped.

    A metric prefix before the pair; a split-rate row joined by `vs` rather than
    a dash; a column-oriented table naming its arms in the header. Each was
    invisible, each reported success for rows nobody looked at, and each was
    found by someone reading the parser rather than by the parser failing. So
    the tests here are about the *shape* — that every figure-bearing row in a
    table that names an arm is accounted for, and that a pass cannot be produced
    by data that is absent, unbound or altered.
    """

    @classmethod
    def setUpClass(cls):
        import check_report_tables as c
        cls.c = c
        cls.docs = Path(__file__).resolve().parent.parent.parent / "docs" / "research"
        cls.reports = [cls.docs / r for r in c.REPORTS]

    def run_check(self, path):
        """The checker's own verdict on a document, without its output."""
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            bad = self.c.check(path)
        return bad, buf.getvalue()

    def mask(self, line):
        """Blank out what the checker treats as an identifier, keeping offsets.

        Mutating `gpt-realtime-2` into `gpt-realtime-98765` is not a drifted
        figure, and a test that did it would be asserting the checker catches
        something it is right to ignore.
        """
        out = line
        for pat in (r"<sub>.*?</sub>", r"`[^`]*`", self.c.ARM_RE,
                    r"gpt-[\w.\-]+"):
            out = re.sub(pat, lambda m: " " * len(m.group(0)), out)
        return out

    def rewritten(self, report, text):
        """Same file name — bindings and declared counts are keyed on it."""
        d = tempfile.mkdtemp()
        p = Path(d) / report.name
        p.write_text(text)
        return p

    def test_the_declared_reports_verify_against_the_committed_data(self):
        for r in self.reports:
            bad, out = self.run_check(r)
            self.assertEqual(bad, 0, f"{r.name}\n{out}")

    def test_every_row_is_verified_allowlisted_or_reported(self):
        """Coverage by identity: the three buckets must exhaust the rows, and
        the total must equal the count declared outside the parser."""
        for r in self.reports:
            _bad, out = self.run_check(r)
            m = re.search(r"(\d+) figure-bearing rows in arm tables — (\d+) "
                          r"verified, (\d+) allowlisted, (\d+) unresolved", out)
            self.assertIsNotNone(m, out)
            total, ok, alw, un = (int(g) for g in m.groups())
            self.assertEqual(ok + alw + un, total, out)
            self.assertEqual(total, self.c.REPORTS[r.name],
                             "declared row count must equal what was found")

    def test_altering_any_verified_figure_is_caught(self):
        """The strongest form of 'try to fool it': every row that reports as
        verified must fail when one of its figures moves. A checker that passes
        a document it never read passes this suite otherwise."""
        for r in self.reports:
            text = r.read_text()
            for tbl in self.c.tables(text):
                if tbl.header.strip() in self.c.UNCHECKABLE_TABLES:
                    continue
                header_arms = self.c.row_arms(tbl.header)
                if not header_arms and not any(self.c.row_arms(l)
                                               for _, l in tbl.body):
                    continue
                for n, line in tbl.body:
                    if not self.c.figures(line) or self.c.allowlisted_row(line):
                        continue
                    fig = self.c.FIGURE.search(self.mask(line))
                    broken = line[:fig.start()] + "98765" + line[fig.end():]
                    lines = text.split("\n")
                    lines[n - 1] = broken
                    bad, out = self.run_check(
                        self.rewritten(r, "\n".join(lines)))
                    self.assertGreater(bad, 0,
                                       f"{r.name}:{n} altered and not caught\n"
                                       f"  {broken}\n{out}")

    def test_every_row_layout_in_the_reports_is_actually_exercised(self):
        """By identity, not by count: each layout that has been dropped once
        must be present among the rows the checker verifies. Coverage that only
        counts rows cannot tell that a whole shape has gone missing."""
        seen = set()
        for r in self.reports:
            for tbl in self.c.tables(r.read_text()):
                if tbl.header.strip() in self.c.UNCHECKABLE_TABLES:
                    continue
                header_arms = self.c.row_arms(tbl.header)
                for _n, line in tbl.body:
                    if not self.c.figures(line):
                        continue
                    if len(header_arms) >= 2:
                        seen.add("column-oriented")
                    elif " vs " in line and len(self.c.row_arms(line)) >= 2:
                        seen.add("vs pair")
                    elif re.match(r"\|\s*`[\w_]+`\s*,", line):
                        seen.add("metric-prefixed pair")
                    elif len(self.c.row_arms(line)) >= 2:
                        seen.add("dash pair")
                    elif len(self.c.row_arms(line)) == 1:
                        seen.add("single arm")
                    if any(lbl in line for lbl in self.c.PROSE_PAIRS):
                        seen.add("prose pair")
        self.assertEqual(seen, {"column-oriented", "vs pair", "dash pair",
                                "metric-prefixed pair", "single arm",
                                "prose pair"})

    def test_a_table_without_a_binding_is_a_problem(self):
        """Absence is never a pass: an unbound table cannot be checked, so it
        must be reported rather than skipped."""
        r = self.reports[0]
        text = r.read_text().replace("<!-- data: full2 -->", "", 1)
        bad, out = self.run_check(self.rewritten(r, text))
        self.assertGreater(bad, 0)
        self.assertIn("UNBOUND", out)

    def test_a_binding_naming_a_dataset_that_is_not_there_is_a_problem(self):
        r = self.reports[0]
        text = r.read_text().replace("<!-- data: full2 -->",
                                     "<!-- data: no-such-run -->", 1)
        bad, out = self.run_check(self.rewritten(r, text))
        self.assertGreater(bad, 0)
        self.assertIn("MISSING DATA", out)

    def test_a_binding_must_sit_directly_above_its_table(self):
        """Otherwise a directive earlier in the document would silently bind a
        table someone added later, against a run it has nothing to do with."""
        tbl = self.c.tables("<!-- data: full2 -->\n\n| arm |\n|---|\n| `vl-direct` | 1 |")
        self.assertEqual(tbl[0].binding.all_tags, ("full2",))
        tbl = self.c.tables("<!-- data: full2 -->\n\nprose\n\n| arm |\n|---|\n| `vl-direct` | 1 |")
        self.assertIsNone(tbl[0].binding)

    def test_a_superseded_run_cannot_validate_a_current_section(self):
        """The reason bindings exist. `vltier-ttfa` predates the per-cell marker
        fix and was replaced by `vltier2-ttfa`; it is not in `published/`, and
        naming it is an error rather than a second opinion."""
        self.assertEqual(list(self.c.DATA.glob("*vltier-ttfa.jsonl")), [])
        for report in self.reports:
            for tbl in self.c.tables(report.read_text()):
                self.assertNotIn("vltier-ttfa",
                                 tbl.binding.all_tags if tbl.binding else ())

    def test_no_run_sits_in_the_evidence_directory_unquoted(self):
        """The other direction of the same rule. A superseded run left beside its
        replacement is how a retracted figure stayed verifiable; nothing reading
        it today is not a reason to keep it."""
        self.assertEqual(self.c.orphans(self.reports), [])

    def test_every_binding_names_a_committed_run(self):
        for report in self.reports:
            for tbl in self.c.tables(report.read_text()):
                for tag in (tbl.binding.all_tags if tbl.binding else ()):
                    self.assertEqual(
                        len(list(self.c.DATA.glob(f"turns-*-{tag}.jsonl"))), 1,
                        f"{report.name}: binding `{tag}` resolves to no single run")

    # — the hole a table-level binding still left open —

    def test_a_column_answers_to_its_own_run(self):
        """`full2,full` unioned both runs and dropped which produced what, so the
        headline table's primary-run delta could be replaced by the *other*
        run's and still pass. That is the superseded-data hole one level down."""
        r = self.docs / "realtime-latency-2026-08.md"
        text = r.read_text()
        self.assertIn('column "run 1" = full', text,
                      "the run-1 column must name its own run")
        bad, out = self.run_check(self.rewritten(r, text.replace(
            "| gpt-realtime-2 via gateway − direct | **+12 ms** |",
            "| gpt-realtime-2 via gateway − direct | **−18 ms** |", 1)))
        self.assertGreater(bad, 0, "run 1's figure passed in run 2's column")
        self.assertIn("-18", out)

    def test_every_figure_cell_resolves_to_one_run(self):
        """The invariant the clauses exist to hold. A cell that could have come
        from either of two runs has not been checked against the one it claims —
        which is the merge bug, and it is a property of the *bindings*, not of
        the checker, so it has to be asserted against the documents."""
        multi = []
        for report in self.reports:
            for tbl in self.c.tables(report.read_text()):
                if not tbl.binding:
                    continue
                head = tbl.head_cells
                for n, line in tbl.body:
                    if not self.c.figures(line) or self.c.allowlisted_row(line):
                        continue
                    cells = self.c.cells_of(line)
                    for i, cell in enumerate(cells):
                        if not self.c.figures("| " + cell):
                            continue
                        tags = tbl.binding.tags_for(
                            cells[0], head[i] if i < len(head) else "")
                        if len(tags) > 1:
                            multi.append((report.name, n, tags, cell.strip()))
        # The one exception is additive by nature: `gw-hd-server` appears in two
        # blocks and its deflection denominator is the sum. Counts add across
        # runs; no percentile ever does, which is why this list is enumerated
        # rather than tolerated.
        self.assertEqual([(r, c) for r, _n, _t, c in multi],
                         [("realtime-21-2026-08.md", "**1/40 — 2.5%**")],
                         f"cells bound to more than one run: {multi}")

    def test_a_cell_bound_to_nothing_is_reported(self):
        """An empty row ∩ column intersection means the directive contradicts
        itself. Falling back to the default would be absence reading as a pass."""
        b = self.c.parse_binding(
            '<!-- data: full2; column "x" = full; row "y" = full2 -->')
        self.assertEqual(b.tags_for("y row", "x column"), ())
        self.assertEqual(b.tags_for("other", "x column"), ("full",))
        self.assertEqual(b.tags_for("y row", "other"), ("full2",))
        self.assertEqual(b.tags_for("other", "other"), ("full2",))

    # — direction —

    def test_reversing_a_comparison_reverses_its_statistics(self):
        """`X − Y` and `Y − X` are not the same claim, and a reader cannot tell
        a swapped label from a sign error by inspection."""
        ev = self.c.evidence(("full2",))
        fwd = ("| `vl-gateway` − `vl-direct` | 25 | **−100** | [−280, −15] "
               "| **−374 / +171** | **7 / 18** | 0.043 | 0.866 |")
        rev = ("| `vl-direct` − `vl-gateway` | 25 | **+100** | [+15, +280] "
               "| **−171 / +374** | **18 / 7** | 0.043 | 0.866 |")
        for row in (fwd, rev):
            self.assertEqual(
                self.c.figures(row) - self.c.available(ev, self.c.row_arms(row)),
                set(), row)
        stale = rev.replace("**+100**", "**−100**")
        self.assertIn("-100", str(sorted(
            self.c.figures(stale) - self.c.available(ev, self.c.row_arms(stale)))))

    # — allowlists no wider than the unverifiable part —

    def test_a_manual_count_still_checks_its_denominator(self):
        """Exempting the deflection tables wholesale exempted `20` and `10.0%`
        along with the hand-counted `2`, so `2/19` passed against a run of 20."""
        ev = self.c.evidence(("vltier2-ttfa",))
        self.assertEqual(
            self.c.check_manual_count(ev, "**2/20 — 10.0%**", ["vl21mini-azsem"]), "")
        self.assertIn("denominator", self.c.check_manual_count(
            ev, "**2/19 — 10.5%**", ["vl21mini-azsem"]))
        self.assertIn("not 2/20", self.c.check_manual_count(
            ev, "**2/20 — 40.0%**", ["vl21mini-azsem"]))
        self.assertIn("exceeds", self.c.check_manual_count(
            ev, "**21/20**", ["vl21mini-azsem"]))
        self.assertIn("expected a `k/n`", self.c.check_manual_count(
            ev, "**about a fifth**", ["vl21mini-azsem"]))

    def test_a_manual_count_denominator_adds_across_the_bound_runs(self):
        """Counts add; distributions do not. `gw-hd-server` appears in two
        blocks, so its denominator is 40 and no percentile ever crosses runs."""
        ev = self.c.evidence(("vltier2-ttfa", "v21-ttfa"))
        self.assertEqual(ev.n_ok("gw-hd-server"),
                         self.c.evidence(("vltier2-ttfa",)).n_ok("gw-hd-server")
                         + self.c.evidence(("v21-ttfa",)).n_ok("gw-hd-server"))
        self.assertEqual(
            self.c.check_manual_count(ev, "**1/40 — 2.5%**", ["gw-hd-server"]), "")

    def test_no_allowlist_entry_is_wider_than_it_needs_to_be(self):
        """`UNCHECKABLE_TABLES` is empty because every entry it once held was
        either exempting a derivable denominator or exempting a table with no
        figures at all. An entry has to name the part that is unverifiable."""
        self.assertEqual(self.c.UNCHECKABLE_TABLES, {})
        for allow in (self.c.MANUAL_COUNT_TABLES, self.c.UNCHECKABLE_ROWS):
            for key, reason in allow.items():
                self.assertTrue(reason.strip(),
                                f"{key} allowlisted without a reason")
                self.assertNotIn("not yet", reason.lower(),
                                 f"{key}: 'not yet checked' is a plan, not a reason")

    def test_a_multi_run_binding_unions_derivations_not_turns(self):
        """Rounds are numbered from 1 in every run, so concatenating two would
        collide in the `(round, utterance)` cell key and lose half the pairs."""
        one = self.c.evidence(("full2",))
        both = self.c.evidence(("full2", "full"))
        self.assertNotIsInstance(both, str, both)
        for arm in one.runs[0].arm:
            self.assertTrue(one.arm(arm) <= both.arm(arm),
                            "a union must not drop what one run derived alone")
        self.assertTrue(any(both.arm(a) - one.arm(a) for a in one.runs[0].arm),
                        "and it must add what the other run derived")

    def test_a_row_that_names_no_arm_anywhere_is_reported(self):
        tbl = self.c.tables("<!-- data: full2 -->\n| x | y |\n|---|---|\n"
                            "| something | 123 |")[0]
        why = self.c.check_row(tbl, "| something | 123 |",
                               lambda _r, _c: self.c.evidence(("full2",)))
        self.assertIn("names no arm", why)

    def test_the_sign_is_part_of_the_figure(self):
        """`+352` where the analyzer says `−352` is a drift, not a match."""
        ev = self.c.evidence(("full2",))
        row = "| `vl-gateway` − `vl-direct` | 25 | **−100** | [−280, −15] |"
        self.assertEqual(
            self.c.figures(row) - self.c.available(ev, self.c.row_arms(row)), set())
        flipped = row.replace("**−100**", "**+100**")
        self.assertIn("+100", self.c.figures(flipped)
                      - self.c.available(ev, self.c.row_arms(flipped)))

    def test_identifiers_are_not_figures(self):
        """`gw-2-server` and `gpt-4.1-mini` carry digits and are not values."""
        self.assertEqual(
            self.c.figures("| `gw-2-server` | gpt-4.1-mini | vl21mini-azsem |"),
            set())

    def test_the_allowlist_is_the_only_way_to_not_check_a_table(self):
        for allow in (self.c.UNCHECKABLE_TABLES, self.c.UNCHECKABLE_ROWS):
            for key, reason in allow.items():
                self.assertTrue(reason.strip(),
                                f"{key} allowlisted without a reason")
                self.assertNotIn("not yet", reason.lower(),
                                 f"{key}: 'not yet checked' is a plan, not a reason")

    def test_the_checker_refuses_reports_it_does_not_own(self):
        """The quality study uses the same arm names against different data;
        globbing `docs/research/*.md` would check it against this harness's runs."""
        other = self.docs / "voice-engine-quality-2026-08.md"
        if other.exists():
            self.assertNotIn(other.name, self.c.REPORTS)
