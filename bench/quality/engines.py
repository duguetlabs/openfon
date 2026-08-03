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
import sys
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
                timeout=AZ_CLI_TIMEOUT_S,
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
    # gpt-realtime-2.1 and its mini, both deployed 2026-07-07 on duguet-labs-eu.
    # Same Foundry GA surface as gpt-realtime-2, so the only variable is the model.
    "vl-native-brain-21": Arm(
        name="vl-native-brain-21", dialect="flat", model="gpt-realtime-2.1",
        brain="gpt-realtime-2.1", stack="voice-live", voice=VOICE_AZURE,
        noise_reduction=None, echo_cancellation=False,
        vad_type="azure_semantic_vad_multilingual",
        usd_per_min=0.07,
        notes="Voice Live serving gpt-realtime-2.1 (reported as "
              "gpt-realtime-2.1-global-standard). The candidate single tier: "
              "azure-speech recognition with a gpt-realtime brain. Semantic VAD "
              "is forced — Voice Live rejects server_vad for gpt-realtime brains "
              "— so compare slot capture against vl-gpt41mini-semvad, not "
              "vl-gpt41mini.",
    ),
    "native-gpt-realtime-21": Arm(
        name="native-gpt-realtime-21", dialect="ga", model="gpt-realtime-2.1",
        brain="gpt-realtime-2.1", stack="foundry-native", voice=VOICE_OPENAI,
        noise_reduction=None, echo_cancellation=False,
        usd_per_min=0.07,
        notes="Successor to gpt-realtime-2 on the same surface. The question is "
              "whether it keeps 2's groundedness while closing the slot-capture "
              "and latency gaps to Voice Live.",
    ),
    "native-gpt-realtime-21-mini": Arm(
        name="native-gpt-realtime-21-mini", dialect="ga",
        model="gpt-realtime-2.1-mini",
        brain="gpt-realtime-2.1-mini", stack="foundry-native", voice=VOICE_OPENAI,
        noise_reduction=None, echo_cancellation=False,
        usd_per_min=0.035,
        notes="The interesting one: if it reaches gpt-4.1-mini's latency and cost "
              "with gpt-realtime-class groundedness, the split recommendation "
              "collapses into a single default.",
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


# A stalled handshake must not hang the run. `websockets.connect` waits forever
# by default: a Voice Live session that accepted the TCP connection and then
# never sent `session.created` stopped a run dead for 13 minutes with a
# zero-byte log and no error. `open_timeout` bounds the handshake; `ping_*`
# make a silently dead connection surface as an exception rather than a stall.
CONNECT_TIMEOUT_S = 30
# `az` runs synchronously on the event-loop thread, so a stalled CLI blocks the
# loop itself and no asyncio timeout can fire while it is stuck. Its own timeout
# is the only thing that bounds it.
AZ_CLI_TIMEOUT_S = 60
PING_INTERVAL_S = 20
PING_TIMEOUT_S = 20


def transport_kwargs() -> dict[str, Any]:
    """Transport bounds only — deliberately free of credentials.

    Split from `connect_kwargs` because that resolves the Azure key eagerly by
    shelling out to `az`, so merely *inspecting* the timeout policy required a
    cloud login. That failed on a CI runner and would fail for anyone cloning
    the repo without this Azure setup. The timeout policy is a property of the
    harness, not of whoever is authenticated.
    """
    return {"max_size": 32 * 1024 * 1024,
            "open_timeout": CONNECT_TIMEOUT_S,
            "ping_interval": PING_INTERVAL_S,
            "ping_timeout": PING_TIMEOUT_S}


def connect_kwargs(arm: Arm) -> dict[str, Any]:
    return {"additional_headers": {"api-key": azure_key()}, **transport_kwargs()}


def load_prompt() -> dict[str, Any]:
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "fixtures", "riverside-prompt.json")) as f:
        return json.load(f)


def log_is_populated(path) -> bool:
    return os.path.exists(path) and os.path.getsize(path) > 0


# A raw-log collision exits with this rather than the usual 1, so `run_all.sh`
# can tell "these logs are populated" apart from "the preflight could not run at
# all" — a missing interpreter, a bad argument, an import error. Reporting the
# second as the first sends the next person to the wrong problem, which is the
# same defect as a timeout naming the wrong bound. Deliberately not 1, 2 (what
# argparse exits with) or 3.
LOG_COLLISION_EXIT = 97


def preflight_logs(paths, force: bool = False) -> None:
    """Refuse a run whose raw logs already hold events, *before* it starts.

    `open_log` guards each file at the moment the runner opens it, which is one
    step short of the property it was reaching for. Two consequences, both paid
    for in data:

    * A runner asked for several units opens the second log after the first has
      been billed, so a collision there discards transcripts already paid for.
    * `run_all.sh`'s `FORCE=1` path truncates the result file first and never
      forwarded a log-replacement option, so this guard fired *after* the
      results it was meant to replace were gone, and the replacement could not
      be produced. Destroy-then-recreate is only safe when the recreate cannot
      fail; there it failed by construction.

    Every colliding target is listed, not just the first: discovering them one
    aborted run at a time is the same wasted-work loop in slow motion.
    """
    bad = [str(p) for p in paths if not force and log_is_populated(p)]
    if bad:
        print(f"refusing to start: {len(bad)} raw log(s) this run would replace "
              "already hold events:\n  " + "\n  ".join(bad) +
              "\nRaw logs are the only artifact a result can be re-scored from "
              "without paying for the call again. Point --logdir somewhere new, "
              "or pass --force-logs to replace them.", file=sys.stderr)
        raise SystemExit(LOG_COLLISION_EXIT)


def open_log(path, force: bool = False):
    """Open a raw event log for writing, refusing to destroy a populated one.

    The runners open their log with mode "w" *before* doing any work, and
    `--logdir` defaults to `logs` — the committed directory. So any invocation
    from `bench/quality` that names an arm/scenario/trial already on disk empties
    that log, and if the run then fails (missing audio, no credentials, a
    validation exit) the file stays empty.

    That is not hypothetical: `sc-vl-gpt41mini-book-de-01-t1.jsonl` was emptied
    exactly this way while verifying that a new test failed against the old
    behaviour — the check ran the real runner against the real log directory.
    The result row still recorded its `end_call`, so the run became
    unre-scorable and `rederive_tools.py` reported a log/result disagreement.

    `run_all.sh` guards `results/`; nothing guarded `logs/`, and the logs are the
    only artifact from which results can be rebuilt without paying again.
    """
    if not force and log_is_populated(path):
        raise SystemExit(
            f"refusing to truncate {path}, which already holds "
            f"{os.path.getsize(path)} bytes. Raw logs are the only artifact a "
            f"result can be re-scored from without re-running the call. Pass "
            f"--logdir somewhere new, or --force-logs to replace it.")
    return open(path, "w")
