"""Tests for the harness controls — the things that make the run trustworthy
rather than the things that summarise it.

  python3 -m unittest discover -s bench/realtime -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from arms import ARMS_BY_ID, SAMPLE_RATE  # noqa: E402
from audio import FRAME_BYTES, Utterance, cache_name, trim_silence  # noqa: E402

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
