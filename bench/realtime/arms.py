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
                "turn_detection": dict(TURN_DETECTION),
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
                    "turn_detection": dict(TURN_DETECTION),
                    "transcription": dict(self.transcription),
                },
                "output": {"format": {"type": "audio/pcm", "rate": SAMPLE_RATE}},
            },
        }
        if self.voice:
            sess["audio"]["output"]["voice"] = self.voice
        return sess


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

ARMS_BY_ID = {a.id: a for a in ARMS}

# Paired comparisons the analysis reports on: (treatment, control, question).
PAIRS = [
    ("native-gateway", "native-direct", "Kataleptic proxy cost, gpt-realtime-2"),
    ("vl-gateway", "vl-direct", "Kataleptic proxy cost, Voice Live"),
    ("vl-native-brain", "native-direct", "Voice Live serving cost, brain held constant"),
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
