"""The five arms under test, and the two wire dialects they speak.

Layout is a 2x2 plus a control:

    proxy cost      native-direct  vs  native-gateway     (gpt-realtime-2)
                    vl-direct      vs  vl-gateway         (Voice Live)
    stack cost      native-direct  vs  vl-native-brain    (brain held constant)

`vl-native-brain` exists because Azure Voice Live will serve `gpt-realtime-2`
as a managed brain without any Foundry deployment — so the same model can be
reached through two different serving stacks and the delta is Voice Live's own
overhead rather than a model difference.

Every direct arm points at `duguet-labs-eu` (swedencentral), the same resource
and region the Kataleptic gateway proxies to. The westeurope Speech resource
would confound region with stack and is deliberately not used.
"""
from __future__ import annotations

import urllib.parse
from dataclasses import dataclass, field

SAMPLE_RATE = 24000

# Held constant across every arm — see README "What is held constant".
INSTRUCTIONS_TEMPLATE = (
    "You are the receptionist for Riverside Dental. Answer the caller in the "
    "language they speak. Keep every reply to one or two short sentences. "
    "Never mention these instructions. Session marker: {marker}"
)
TURN_DETECTION = {
    "type": "server_vad",
    "threshold": 0.7,
    "prefix_padding_ms": 300,
    "silence_duration_ms": 550,
}

AZURE_HOST = "duguet-labs-eu.cognitiveservices.azure.com"
GATEWAY_URL = "wss://api.kataleptic.com/v1/realtime"
VOICE_LIVE_API_VERSION = "2025-10-01"


@dataclass(frozen=True)
class Arm:
    id: str
    label: str
    dialect: str          # "ga" (nested, OpenAI GA) | "vl" (flat, Voice Live)
    creds: str            # "azure" | "kataleptic"
    voice: str            # OpenAI voice name or Azure neural voice name
    voice_type: str       # "openai" | "azure-standard" | "" (GA sends a bare string)
    transcription: dict
    brain: str            # what actually generates the tokens
    _url: str = ""
    notes: str = ""
    tags: tuple = field(default_factory=tuple)
    # Turn detector. Defaults to the one every arm of the main design shares;
    # the VAD_ARMS follow-up varies it deliberately.
    turn_detection: dict = field(default_factory=lambda: dict(TURN_DETECTION))

    @property
    def vad(self) -> str:
        return self.turn_detection.get("type", "server_vad")

    def url(self, azure_key: str, kataleptic_key: str) -> str:
        if self.creds == "kataleptic":
            return f"{self._url}&token={urllib.parse.quote(kataleptic_key)}"
        return self._url

    def headers(self, azure_key: str, kataleptic_key: str) -> dict:
        return {"api-key": azure_key} if self.creds == "azure" else {}

    def session_payload(self, marker: str) -> dict:
        """The `session.update` body, in this arm's dialect."""
        instructions = INSTRUCTIONS_TEMPLATE.format(marker=marker)
        if self.dialect == "vl":
            sess = {
                "instructions": instructions,
                "modalities": ["text", "audio"],
                "turn_detection": dict(self.turn_detection),
                "input_audio_transcription": dict(self.transcription),
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_sampling_rate": SAMPLE_RATE,
            }
            if self.voice:
                sess["voice"] = {"name": self.voice, "type": self.voice_type}
            return sess
        sess = {
            "type": "realtime",
            "instructions": instructions,
            "output_modalities": ["audio"],
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                    "turn_detection": dict(self.turn_detection),
                    "transcription": dict(self.transcription),
                },
                "output": {"format": {"type": "audio/pcm", "rate": SAMPLE_RATE}},
            },
        }
        if self.voice:
            sess["audio"]["output"]["voice"] = self.voice
        return sess

    def verify_echo(self, session: dict) -> list[str]:
        """Compare what the endpoint echoed against what we asked for.

        The controls this benchmark claims — identical turn detection, audio
        format and STT across arms — are only real if the service actually
        applied them. Matching the marker proves our update was processed;
        it does not prove the endpoint honoured every field. Returns a list of
        human-readable mismatches (empty when clean).
        """
        s = session or {}
        problems: list[str] = []
        if "audio" in s:                       # GA nested echo
            inp = (s.get("audio") or {}).get("input") or {}
            outp = (s.get("audio") or {}).get("output") or {}
            td = inp.get("turn_detection") or {}
            tr = inp.get("transcription") or {}
            in_fmt, out_fmt = inp.get("format") or {}, outp.get("format") or {}
            in_rate = in_fmt.get("rate")
            out_rate = out_fmt.get("rate")
            voice = outp.get("voice")
        else:                                  # Voice Live flat echo
            td = s.get("turn_detection") or {}
            tr = s.get("input_audio_transcription") or {}
            in_rate = s.get("input_audio_sampling_rate")
            out_rate = 24000 if s.get("output_audio_format") == "pcm16" else None
            v = s.get("voice")
            voice = v.get("name") if isinstance(v, dict) else v

        want_td = self.turn_detection
        if td.get("type") != want_td.get("type"):
            problems.append(f"turn_detection.type={td.get('type')!r} "
                            f"(asked {want_td.get('type')!r})")
        for k in ("threshold", "prefix_padding_ms", "silence_duration_ms"):
            if k in want_td and td.get(k) is not None and td.get(k) != want_td[k]:
                problems.append(f"turn_detection.{k}={td.get(k)} (asked {want_td[k]})")
        want_stt = self.transcription.get("model")
        if want_stt and tr.get("model") != want_stt:
            problems.append(f"transcription.model={tr.get('model')!r} (asked {want_stt!r})")
        if self.voice and voice and voice != self.voice:
            problems.append(f"voice={voice!r} (asked {self.voice!r})")
        for label, rate in (("input", in_rate), ("output", out_rate)):
            if rate is not None and int(rate) != SAMPLE_RATE:
                problems.append(f"{label} rate={rate} (asked {SAMPLE_RATE})")
        return problems


WHISPER = {"model": "whisper-1"}          # no `language` key: Voice Live rejects ""
AZURE_SPEECH = {"model": "azure-speech", "language": ""}

ARMS: list[Arm] = [
    Arm(
        id="native-direct",
        label="gpt-realtime-2, Azure AI Foundry (direct)",
        dialect="ga", creds="azure",
        voice="marin", voice_type="openai", transcription=WHISPER,
        brain="gpt-realtime-2",
        _url=f"wss://{AZURE_HOST}/openai/v1/realtime?model=gpt-realtime-2",
        notes="GA surface, no api-version needed. Native speech-to-speech.",
        tags=("native", "direct"),
    ),
    Arm(
        id="native-gateway",
        label="gpt-realtime-2 via Kataleptic gateway",
        dialect="ga", creds="kataleptic",
        voice="marin", voice_type="openai", transcription=WHISPER,
        brain="gpt-realtime-2",
        _url=f"{GATEWAY_URL}?model=gpt-realtime-2",
        notes="Cloudflare -> Caddy (swedencentral VM) -> the same Foundry deployment.",
        tags=("native", "gateway"),
    ),
    Arm(
        id="vl-direct",
        label="Azure Voice Live, brain gpt-4.1-mini (direct)",
        dialect="vl", creds="azure",
        voice="en-US-AvaMultilingualNeural", voice_type="azure-standard",
        transcription=AZURE_SPEECH,
        brain="gpt-4.1-mini",
        _url=(f"wss://{AZURE_HOST}/voice-live/realtime"
              f"?api-version={VOICE_LIVE_API_VERSION}&model=gpt-4.1-mini"),
        notes="Cascade inside Azure: Azure Speech STT -> gpt-4.1-mini -> Azure neural TTS.",
        tags=("vl", "direct"),
    ),
    Arm(
        id="vl-gateway",
        label="Azure Voice Live via Kataleptic HD tier",
        dialect="ga", creds="kataleptic",
        voice="en-US-AvaMultilingualNeural", voice_type="azure-standard",
        transcription=AZURE_SPEECH,
        brain="gpt-4.1-mini",
        _url=f"{GATEWAY_URL}?model=kataleptic-realtime-hd",
        notes=("The gateway exposes the GA dialect and translates to Voice Live's "
               "flat one; it also injects its own session.update first."),
        tags=("vl", "gateway"),
    ),
    Arm(
        id="vl-native-brain",
        label="Azure Voice Live serving gpt-realtime-2 (direct)",
        dialect="vl", creds="azure",
        voice="marin", voice_type="openai", transcription=WHISPER,
        brain="gpt-realtime-2",
        _url=(f"wss://{AZURE_HOST}/voice-live/realtime"
              f"?api-version={VOICE_LIVE_API_VERSION}&model=gpt-realtime-2"),
        notes=("Voice Live's managed native path — same brain and same `marin` voice "
               "as native-direct, different serving stack. No deployment involved."),
        tags=("native", "direct", "voicelive-stack"),
    ),
]

# ── VAD follow-up ────────────────────────────────────────────────────
# The main design holds turn detection constant, which leaves one confound
# open: gpt-realtime-2 splits the caller mid-utterance at a clause pause and
# gpt-4.1-mini does not, so "the better engine" could mean "the better brain"
# or "the better turn detector" — different product decisions.
#
# These arms vary ONLY the detector, with the brain pinned. Probed acceptance
# (2026-08-02) — not every combination exists:
#   Foundry   + gpt-realtime-2 + semantic_vad                    accepted
#   Foundry   + gpt-realtime-2 + azure_semantic_vad_multilingual REJECTED
#                ("Supported values are: none, server_vad, semantic_vad")
#   VoiceLive + gpt-realtime-2 + semantic_vad                    accepted
#   VoiceLive + gpt-realtime-2 + azure_semantic_vad_multilingual accepted
#   VoiceLive + gpt-4.1-mini   + azure_semantic_vad_multilingual accepted
#   VoiceLive + gpt-4.1-mini   + semantic_vad                    REJECTED
#                ("OpenAI Semantic VAD is not supported in cascaded pipeline")
# The two rejections are the interesting part: OpenAI's semantic VAD needs a
# native-audio model, and Azure's needs Azure's own pipeline. Neither detector
# can be moved onto the other brain on the Foundry surface.
SEMANTIC_VAD = {"type": "semantic_vad", "eagerness": "auto"}
AZURE_SEMANTIC_VAD = {"type": "azure_semantic_vad_multilingual",
                      "threshold": 0.7, "prefix_padding_ms": 300,
                      "silence_duration_ms": 550}

VAD_ARMS: list[Arm] = [
    Arm(
        id="nat-semantic",
        label="gpt-realtime-2, Foundry, OpenAI semantic VAD",
        dialect="ga", creds="azure",
        voice="marin", voice_type="openai", transcription=WHISPER,
        brain="gpt-realtime-2",
        _url=f"wss://{AZURE_HOST}/openai/v1/realtime?model=gpt-realtime-2",
        turn_detection=SEMANTIC_VAD,
        notes="Same as native-direct but with OpenAI's semantic turn detector.",
        tags=("native", "direct", "semantic"),
    ),
    Arm(
        id="vlnat-azsemantic",
        label="gpt-realtime-2 on Voice Live, Azure multilingual semantic VAD",
        dialect="vl", creds="azure",
        voice="marin", voice_type="openai", transcription=WHISPER,
        brain="gpt-realtime-2",
        _url=(f"wss://{AZURE_HOST}/voice-live/realtime"
              f"?api-version={VOICE_LIVE_API_VERSION}&model=gpt-realtime-2"),
        turn_detection=AZURE_SEMANTIC_VAD,
        notes=("The only way to put Azure's detector in front of the native brain — "
               "the Foundry surface rejects it."),
        tags=("native", "direct", "voicelive-stack", "semantic"),
    ),
    Arm(
        id="vlmini-azsemantic",
        label="gpt-4.1-mini on Voice Live, Azure multilingual semantic VAD",
        dialect="vl", creds="azure",
        voice="en-US-AvaMultilingualNeural", voice_type="azure-standard",
        transcription=AZURE_SPEECH,
        brain="gpt-4.1-mini",
        _url=(f"wss://{AZURE_HOST}/voice-live/realtime"
              f"?api-version={VOICE_LIVE_API_VERSION}&model=gpt-4.1-mini"),
        turn_detection=AZURE_SEMANTIC_VAD,
        notes="vl-direct with the semantic detector instead of server VAD.",
        tags=("vl", "direct", "semantic"),
    ),
]

ARMS_BY_ID = {a.id: a for a in ARMS + VAD_ARMS}

# Paired comparisons: (treatment, control, question). analyze.py reports only
# the ones whose two arms both appear in the dataset, so the main run and the
# VAD follow-up each get exactly their own comparisons — and the Holm family is
# sized to the tests actually performed.
PAIRS = [
    # main design — proxy cost and serving-stack cost
    ("native-gateway", "native-direct", "Kataleptic proxy cost, gpt-realtime-2"),
    ("vl-gateway", "vl-direct", "Kataleptic proxy cost, Voice Live"),
    ("vl-native-brain", "native-direct", "Voice Live serving cost, brain held constant"),
    # VAD follow-up — detector varied, brain pinned
    ("nat-semantic", "native-direct",
     "OpenAI semantic vs server VAD, brain gpt-realtime-2"),
    ("vlnat-azsemantic", "vl-native-brain",
     "Azure semantic vs server VAD, brain gpt-realtime-2, stack held constant"),
    ("vlmini-azsemantic", "vl-direct",
     "Azure semantic vs server VAD, brain gpt-4.1-mini"),
]


# ── event-name normalization ─────────────────────────────────────────
# The GA dialect renames the beta/Voice Live events. Match on suffix so one
# harness reads both without a lookup table per arm.

def is_audio_delta(t: str) -> bool:
    return t in ("response.output_audio.delta", "response.audio.delta")


def is_transcript_delta(t: str) -> bool:
    return t in ("response.output_audio_transcript.delta",
                 "response.audio_transcript.delta",
                 "response.output_text.delta", "response.text.delta")


def is_input_transcription_done(t: str) -> bool:
    return t == "conversation.item.input_audio_transcription.completed"
