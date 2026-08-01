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
    the endpoint honoured every field. The README claims the controls held —
    this is what backs that claim."""

    def test_clean_ga_echo_has_no_warnings(self):
        self.assertEqual(GA_ARM.verify_echo(ga_echo()), [])

    def test_clean_vl_echo_has_no_warnings(self):
        self.assertEqual(VL_ARM.verify_echo(vl_echo()), [])

    def test_semantic_arm_accepts_its_own_detector(self):
        echo = ga_echo(turn_detection={"type": "semantic_vad", "eagerness": "auto"})
        # the semantic arm asks for no threshold/silence, so only type matters
        self.assertEqual(SEM_ARM.verify_echo(echo), [])

    def test_detects_a_substituted_detector(self):
        echo = ga_echo(turn_detection={"type": "semantic_vad"})
        w = GA_ARM.verify_echo(echo)
        self.assertTrue(any("turn_detection.type" in x for x in w), w)

    def test_detects_a_silently_changed_hangover(self):
        # Voice Live defaults silence_duration_ms to 200; unpinned that is a
        # 350 ms artefact, so it must not pass unnoticed
        echo = vl_echo(turn_detection={"silence_duration_ms": 200})
        w = VL_ARM.verify_echo(echo)
        self.assertTrue(any("silence_duration_ms=200" in x for x in w), w)

    def test_detects_a_substituted_stt_model(self):
        w = GA_ARM.verify_echo(ga_echo(stt="azure-speech"))
        self.assertTrue(any("transcription.model" in x for x in w), w)

    def test_detects_a_substituted_voice(self):
        w = GA_ARM.verify_echo(ga_echo(voice="alloy"))
        self.assertTrue(any("voice=" in x for x in w), w)

    def test_detects_a_wrong_sample_rate(self):
        w = VL_ARM.verify_echo(vl_echo(rate=16000))
        self.assertTrue(any("rate=16000" in x for x in w), w)

    def test_missing_fields_are_not_reported_as_mismatches(self):
        # an endpoint that simply omits a field is not evidence it ignored it
        self.assertEqual(VL_ARM.verify_echo({"turn_detection": {
            "type": "server_vad", "threshold": 0.7,
            "prefix_padding_ms": 300, "silence_duration_ms": 550},
            "input_audio_transcription": {"model": "azure-speech"}}), [])

    def test_empty_echo_reports_the_detector(self):
        self.assertTrue(GA_ARM.verify_echo({}))


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
