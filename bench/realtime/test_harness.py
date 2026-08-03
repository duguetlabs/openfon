"""Tests for the harness controls — the things that make the run trustworthy
rather than the things that summarise it.

  python3 -m unittest discover -s bench/realtime -v
"""
from __future__ import annotations

import json
import os
import sys
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
