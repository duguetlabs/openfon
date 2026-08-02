"""Arm definitions and dialect handling for the two realtime serving stacks.

Azure exposes the same capability behind two incompatible wire dialects:

  ga   — /openai/v1/realtime, nested `session.audio.{input,output}`,
         `conversation.item.input_audio_transcription.completed`
  flat — /voice-live/realtime, flat `session.*`, Azure extensions
         (`input_audio_echo_cancellation`, `input_audio_noise_reduction`)

Everything dialect-specific lives here so the runners never branch on arm.

Traps encoded below (all from bench/realtime recon, see the report):
  * Voice Live rejects any event before a valid `session.update`.
  * Voice Live treats `session` as replace-not-merge — always send it whole.
  * Voice Live forbids changing `turn_detection.type` mid-session.
  * Voice Live defaults `silence_duration_ms` to 200, the GA surface to 500;
    unpinned, the two arms would be running different end-of-turn policies.
  * Native `gpt-realtime-2` defaults transcription OFF; Voice Live defaults it ON.
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from typing import Any

AZURE_HOST = "duguet-labs-eu.cognitiveservices.azure.com"
AZURE_RG = "qptr-projects"
AZURE_ACCOUNT = "duguet-labs-eu"
VOICELIVE_API_VERSION = "2025-10-01"

# OpenFon production VAD (src/call-session.ts). Pinned identically on every arm.
VAD_THRESHOLD = 0.7
VAD_PREFIX_MS = 300
VAD_SILENCE_MS = 550

SAMPLE_RATE = 24000

END_CALL_TOOL = {
    "type": "function",
    "name": "end_call",
    "description": "End the phone call after you have said goodbye to the caller.",
    "parameters": {"type": "object", "properties": {}},
}

_KEY_CACHE: dict[str, str] = {}


def azure_key() -> str:
    if "key" not in _KEY_CACHE:
        env = os.environ.get("AZURE_AI_KEY")
        if env:
            _KEY_CACHE["key"] = env.strip()
        else:
            _KEY_CACHE["key"] = subprocess.run(
                ["az", "cognitiveservices", "account", "keys", "list",
                 "-n", AZURE_ACCOUNT, "-g", AZURE_RG, "--query", "key1", "-o", "tsv"],
                check=True, capture_output=True, text=True,
            ).stdout.strip()
    return _KEY_CACHE["key"]


@dataclass(frozen=True)
class Arm:
    name: str
    dialect: str          # "ga" | "flat"
    model: str            # value of the ?model= query parameter
    brain: str            # human-readable brain, for the report
    stack: str            # "voice-live" | "foundry-native"
    voice: str
    # Azure-only audio front-end knobs; None on the GA surface.
    noise_reduction: str | None = None      # e.g. "azure_deep_noise_suppression"
    echo_cancellation: bool = False
    # Voice Live only. `server_vad` is accepted on the gpt-4.1-mini brain, but on
    # the gpt-realtime-2 brain it is rejected outright ("When using azure-speech
    # as InputAudioTranscription, turn_detection must be of type
    # AzureSemanticVAD or AzureMultilingualSemanticVAD"). The gateway's HD tier
    # rewrites to azure_semantic_vad_multilingual anyway, so that is also the
    # production-faithful setting. Varying it per arm makes the confound
    # explicit and lets us hold it constant where it matters.
    vad_type: str = "server_vad"
    usd_per_min: float = 0.0
    notes: str = ""

    @property
    def url(self) -> str:
        if self.dialect == "ga":
            return f"wss://{AZURE_HOST}/openai/v1/realtime?model={self.model}"
        return (f"wss://{AZURE_HOST}/voice-live/realtime"
                f"?api-version={VOICELIVE_API_VERSION}&model={self.model}")

    # ── session payloads ────────────────────────────────────────────────

    def session_asr(self, language: str, marker: str) -> dict[str, Any]:
        """Transcription-only session: no VAD, no responses, no audio out.

        Track A never needs the agent to speak. Disabling turn detection means
        we commit each utterance by hand and are billed for input audio only —
        it is both cheaper and a cleaner measurement, because the transcript is
        of exactly the clip we sent rather than of whatever the VAD carved out.
        """
        if self.dialect == "ga":
            return {"type": "realtime",
                    "instructions": marker,
                    "output_modalities": ["text"],
                    "audio": {"input": {
                        "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                        "turn_detection": None,
                        "transcription": {"model": "whisper-1", "language": language},
                    }}}
        s: dict[str, Any] = {
            "instructions": marker,
            "modalities": ["text"],
            "turn_detection": None,
            "input_audio_transcription": {"model": "azure-speech", "language": language},
            "input_audio_format": "pcm16",
            "input_audio_sampling_rate": SAMPLE_RATE,
        }
        self._apply_frontend(s, duplex=False)
        return s

    def session_dialog(self, instructions: str, language: str) -> dict[str, Any]:
        """Full duplex session for Track B: VAD on, audio out, end_call tool."""
        if self.dialect == "ga":
            return {"type": "realtime",
                    "instructions": instructions,
                    "tools": [END_CALL_TOOL],
                    "tool_choice": "auto",
                    "audio": {
                        "input": {
                            "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                            "turn_detection": {"type": "server_vad",
                                               "threshold": VAD_THRESHOLD,
                                               "prefix_padding_ms": VAD_PREFIX_MS,
                                               "silence_duration_ms": VAD_SILENCE_MS},
                            "transcription": {"model": "whisper-1", "language": language},
                        },
                        "output": {"format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                                   "voice": self.voice},
                    }}
        s: dict[str, Any] = {
            "instructions": instructions,
            "modalities": ["text", "audio"],
            "voice": {"name": self.voice, "type": "azure-standard"},
            "turn_detection": {"type": self.vad_type,
                               "threshold": VAD_THRESHOLD,
                               "prefix_padding_ms": VAD_PREFIX_MS,
                               "silence_duration_ms": VAD_SILENCE_MS},
            "input_audio_transcription": {"model": "azure-speech", "language": language},
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "input_audio_sampling_rate": SAMPLE_RATE,
            "tools": [END_CALL_TOOL],
            "tool_choice": "auto",
        }
        self._apply_frontend(s, duplex=True)
        return s

    def _apply_frontend(self, s: dict[str, Any], *, duplex: bool) -> None:
        """Azure audio front-end knobs — the thing under test in the noise A/B.

        Both default to null on Voice Live, i.e. OFF. OpenFon's shipped
        session.update never sets either, so the HD tier in production runs with
        no noise suppression at all.

        Accepted `input_audio_noise_reduction.type` (probed 2026-08-02):
        `azure_deep_noise_suppression`, `near_field`, `far_field`.

        Echo cancellation is rejected outright when modalities are text-only
        ("ec_not_supported"), which is why it is duplex-only here. That costs us
        nothing: with no agent audio there is no echo to cancel.
        """
        if self.noise_reduction:
            s["input_audio_noise_reduction"] = {"type": self.noise_reduction}
        if duplex and self.echo_cancellation:
            s["input_audio_echo_cancellation"] = {"type": "server_echo_cancellation"}

    # ── event parsing ───────────────────────────────────────────────────

    def caller_transcript(self, ev: dict[str, Any]) -> tuple[str, str] | None:
        """Return (item_id, transcript) for a completed caller transcript.

        The item_id matters: transcription is asynchronous, so on a session that
        commits several clips the completed events do not necessarily arrive in
        submission order. Matching on item_id is the difference between a real
        WER and one where every clip is scored against its neighbour's text.
        """
        t = ev.get("type", "")
        if t == "conversation.item.input_audio_transcription.completed":
            return (ev.get("item_id") or "", ev.get("transcript") or "")
        # Voice Live may also carry the transcript on the item itself.
        if t in ("conversation.item.created", "conversation.item.done"):
            item = ev.get("item") or {}
            if item.get("role") == "user":
                for part in item.get("content") or []:
                    if part.get("type") in ("input_audio", "audio") and part.get("transcript"):
                        return (item.get("id") or "", part["transcript"])
        return None

    def agent_audio_delta(self, ev: dict[str, Any]) -> str | None:
        if ev.get("type") in ("response.output_audio.delta", "response.audio.delta"):
            return ev.get("delta")
        return None

    def agent_text_done(self, ev: dict[str, Any]) -> str | None:
        if ev.get("type") in ("response.output_audio_transcript.done",
                              "response.audio_transcript.done",
                              "response.text.done"):
            return ev.get("transcript") or ev.get("text")
        return None


VOICE_AZURE = "en-US-AvaMultilingualNeural"   # multilingual: follows a language switch
VOICE_OPENAI = "marin"

ARMS: dict[str, Arm] = {
    # NOTE ON THE BASELINE: Voice Live defaults both audio front-end knobs to
    # null, and OpenFon's session.update never sets them. So "the HD tier as
    # shipped" means noise suppression OFF. `vl-gpt41mini` reproduces that
    # exactly; `vl-gpt41mini-dns` is the same arm with suppression switched on.
    # Reporting only the suppressed variant would flatter the product OpenFon
    # actually runs.
    "vl-gpt41mini": Arm(
        name="vl-gpt41mini", dialect="flat", model="gpt-4.1-mini",
        brain="gpt-4.1-mini", stack="voice-live", voice=VOICE_AZURE,
        noise_reduction=None, echo_cancellation=False,
        usd_per_min=0.03,
        notes="The HD tier exactly as shipped: Azure Speech STT -> gpt-4.1-mini -> "
              "Azure neural TTS, no audio front-end.",
    ),
    "vl-gpt41mini-dns": Arm(
        name="vl-gpt41mini-dns", dialect="flat", model="gpt-4.1-mini",
        brain="gpt-4.1-mini", stack="voice-live", voice=VOICE_AZURE,
        noise_reduction="azure_deep_noise_suppression", echo_cancellation=True,
        usd_per_min=0.03,
        notes="As shipped plus azure_deep_noise_suppression. The delta against "
              "vl-gpt41mini is the value OpenFon is leaving on the table.",
    ),
    "vl-native-brain": Arm(
        name="vl-native-brain", dialect="flat", model="gpt-realtime-2",
        brain="gpt-realtime-2", stack="voice-live", voice=VOICE_AZURE,
        noise_reduction=None, echo_cancellation=False,
        vad_type="azure_semantic_vad_multilingual",
        usd_per_min=0.07,
        notes="Voice Live serving the native brain, front-end off to match "
              "vl-gpt41mini. Separates 'better brain' from 'better serving stack'. "
              "Forced onto semantic VAD by the service; compare against "
              "vl-gpt41mini-semvad, not vl-gpt41mini, to hold VAD constant.",
    ),
    "vl-gpt41mini-semvad": Arm(
        name="vl-gpt41mini-semvad", dialect="flat", model="gpt-4.1-mini",
        brain="gpt-4.1-mini", stack="voice-live", voice=VOICE_AZURE,
        noise_reduction=None, echo_cancellation=False,
        vad_type="azure_semantic_vad_multilingual",
        usd_per_min=0.03,
        notes="VAD control. Identical to vl-gpt41mini but on the semantic VAD "
              "that vl-native-brain is forced onto — and that the Kataleptic HD "
              "tier actually ships. Makes the brain comparison VAD-neutral.",
    ),
    "native-gpt-realtime-2": Arm(
        name="native-gpt-realtime-2", dialect="ga", model="gpt-realtime-2",
        brain="gpt-realtime-2", stack="foundry-native", voice=VOICE_OPENAI,
        noise_reduction=None, echo_cancellation=False,
        usd_per_min=0.07,
        notes="Native speech-to-speech on the Foundry GA surface. No Azure audio "
              "front-end exists here — that asymmetry is itself a finding.",
    ),
}


def connect_kwargs(arm: Arm) -> dict[str, Any]:
    return {"additional_headers": {"api-key": azure_key()}, "max_size": 32 * 1024 * 1024}


def load_prompt() -> dict[str, Any]:
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "fixtures", "riverside-prompt.json")) as f:
        return json.load(f)
