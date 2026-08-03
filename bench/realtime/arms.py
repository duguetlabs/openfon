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


# Which metrics a confirmed-different control makes incomparable. A control we
# cannot confirm aborts the turn; a control we can confirm is *different* is
# strictly worse, so it must not be treated more leniently — but it only
# invalidates the metrics that actually depend on it, not the whole turn.
#
#   STT model   — the caller-transcript path only. Transcription runs in
#                 parallel with generation and cannot gate first audio.
#   Voice       — everything downstream of synthesis: when speech starts, when
#                 the response completes, how long the reply audio is.
#   STT model   — on a NATIVE speech-to-speech arm the transcription is
#                 observational: the model hears the audio directly, so a
#                 substituted STT moves only the caller-transcript metric. On a
#                 CASCADE arm the same field is the pipeline — its text is what
#                 the language model reads — so a substitution moves everything
#                 downstream of it. Same field, load-bearing on one arm and an
#                 observer on the other, which is why this is arm-dependent.
STT_OBSERVED = ("transcript_ms",)
DOWNSTREAM_OF_TEXT = ("ttft_ms", "ttfa_ms", "ttfa_minus_vad_ms",
                      "response_total_ms", "audio_out_ms")
VOICE_DEPENDENT = ("ttfa_ms", "ttfa_minus_vad_ms", "response_total_ms",
                   "audio_out_ms")


def invalidated_metrics(warnings, *, cascade: bool = False) -> tuple:
    """Metrics made incomparable by these advisory divergences.

    `cascade` says whether the arm's brain reads STT text rather than audio.
    Both the harness (recording per turn) and the analyzer (reading datasets
    written before the field existed) classify through this one function, so
    the two cannot disagree about what a given divergence invalidates.
    """
    out: set = set()
    for w in warnings or []:
        msg = w if isinstance(w, str) else getattr(w, "message", str(w))
        if msg.startswith("transcription.model"):
            out.update(STT_OBSERVED)
            if cascade:
                out.update(DOWNSTREAM_OF_TEXT)
        elif msg.startswith("voice="):
            out.update(VOICE_DEPENDENT)
    return tuple(sorted(out))


def _check_rate(label: str, rate, field: str) -> list:
    """Verify an echoed sample rate without trusting it to be a number.

    A malformed-but-present value ("24khz") must be reported as a control
    mismatch, not raise — the exception would surface as a generic turn failure
    and lose the very diagnostic this check exists to produce.
    """
    if rate is None:
        return [f"{field} absent — unverifiable"]
    try:
        got = int(rate)
    except (TypeError, ValueError):
        return [f"{field}={rate!r} unparseable — unverifiable"]
    return [] if got == SAMPLE_RATE else [f"{label} rate={got} (asked {SAMPLE_RATE})"]


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

    @property
    def is_cascade(self) -> bool:
        """True when the brain reads STT text rather than hearing audio, so the
        transcription model is part of the pipeline, not an observer of it."""
        return not self.brain.startswith("gpt-realtime")

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

    def verify_echo(self, session: dict) -> tuple[list[str], list[str]]:
        """Compare what the endpoint echoed against what we asked for.

        Returns `(fatal, advisory)`.

        The governing rule is **absent must not read as valid**. A control we
        cannot confirm is not a control, and a benchmark that quietly proceeds
        on unverified settings produces numbers indistinguishable from correct
        ones. So a missing field is a mismatch, not a skip.

        `fatal` aborts the turn — these are the settings whose violation would
        make the measurement wrong rather than merely different:

          * audio format and sample rate, both directions. `audio_out_ms` is
            derived from a byte count assuming PCM16 @ 24 kHz, so a silent
            codec substitution would corrupt every reply-length figure while
            looking entirely plausible.
          * turn detector type and its numeric parameters. The whole design
            holds these constant across arms; Voice Live defaults
            silence_duration_ms to 200 against the native endpoint's 500, so
            an unnoticed substitution is a 350 ms artefact.

        `advisory` is recorded and reported but does not abort: real
        divergences that cannot corrupt a timing (the gateway substituting its
        own transcription deployment, a voice coerced to the tier's default).
        """
        s = session or {}
        fatal: list[str] = []
        advisory: list[str] = []

        # Which echo shape to expect is determined by the dialect we spoke —
        # not sniffed from the payload, so a malformed echo cannot silently
        # select the branch that happens to pass.
        if self.dialect == "vl":
            td = s.get("turn_detection") or {}
            tr = s.get("input_audio_transcription") or {}
            v = s.get("voice")
            voice = v.get("name") if isinstance(v, dict) else v
            # Voice Live names the codec; "pcm16" *means* 24 kHz, and the
            # input rate is carried separately.
            for label, key in (("input", "input_audio_format"),
                               ("output", "output_audio_format")):
                got = s.get(key)
                if got != "pcm16":
                    fatal.append(f"{key}={got!r} (asked 'pcm16')"
                                 if got is not None else
                                 f"{key} absent — audio contract unverifiable")
            fatal += _check_rate("input", s.get("input_audio_sampling_rate"),
                                 "input_audio_sampling_rate")
        else:
            audio = s.get("audio")
            if not isinstance(audio, dict):
                fatal.append("session.audio absent — audio contract unverifiable")
                audio = {}
            inp = audio.get("input") or {}
            outp = audio.get("output") or {}
            td = inp.get("turn_detection") or {}
            tr = inp.get("transcription") or {}
            voice = outp.get("voice")
            for label, side in (("input", inp), ("output", outp)):
                fmt = side.get("format")
                if not isinstance(fmt, dict):
                    fatal.append(f"{label} format absent — audio contract unverifiable")
                    continue
                if fmt.get("type") != "audio/pcm":
                    fatal.append(f"{label} format.type={fmt.get('type')!r} "
                                 f"(asked 'audio/pcm')")
                fatal += _check_rate(label, fmt.get("rate"), f"{label} format.rate")

        # Every field we sent is verified, derived from the request rather than
        # a hardcoded list. A hardcoded list is how `eagerness` — added later,
        # for the semantic detector — went unchecked while the follow-up
        # attributed its results to exactly that setting.
        for k, want in self.turn_detection.items():
            got = td.get(k)
            if got is None:
                fatal.append(f"turn_detection.{k} absent — unverifiable "
                             f"(asked {want!r})")
            elif got != want:
                fatal.append(f"turn_detection.{k}={got!r} (asked {want!r})")

        want_stt = self.transcription.get("model")
        if want_stt and tr.get("model") != want_stt:
            advisory.append(f"transcription.model={tr.get('model')!r} "
                            f"(asked {want_stt!r})")
        if self.voice and voice != self.voice:
            advisory.append(f"voice={voice!r} (asked {self.voice!r})")
        return fatal, advisory


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

# ── gpt-realtime-2.1 tiers ───────────────────────────────────────────
# Added 2026-08-03, when the newer brains appeared on the gateway (Azure
# deployments dated 2026-07-07 on duguet-labs-eu). All reached through the
# Kataleptic gateway, because the question is what OpenFon's tiers should
# default to and OpenFon talks to the gateway.
#
# Two questions: whether 2.1 is faster than gpt-realtime-2, and whether it
# inherits gpt-realtime-2's habit of splitting an utterance at a clause pause
# under server VAD. The second is not assumed either way — a brain that does
# not split needs no semantic detector, and that is a real possible outcome.
GW = GATEWAY_URL


def _gw_arm(arm_id, model, td, label, notes, tags):
    return Arm(
        id=arm_id, label=label, dialect="ga", creds="kataleptic",
        voice="marin", voice_type="openai", transcription=WHISPER,
        brain=model, _url=f"{GW}?model={model}", turn_detection=td,
        notes=notes, tags=tags)


REALTIME_21_ARMS: list[Arm] = [
    _gw_arm("gw-2-server", "gpt-realtime-2", dict(TURN_DETECTION),
            "gpt-realtime-2 via gateway, server VAD",
            "Incumbent and positive control: known to split 10/10 on de-short.",
            ("native", "gateway", "incumbent")),
    _gw_arm("gw-21-server", "gpt-realtime-2.1", dict(TURN_DETECTION),
            "gpt-realtime-2.1 via gateway, server VAD",
            "Does the newer brain inherit the clause-pause split?",
            ("native", "gateway", "v21")),
    _gw_arm("gw-21-semantic", "gpt-realtime-2.1", SEMANTIC_VAD,
            "gpt-realtime-2.1 via gateway, semantic VAD",
            "What semantic detection costs on 2.1, and whether it is needed.",
            ("native", "gateway", "v21", "semantic")),
    _gw_arm("gw-21mini-server", "gpt-realtime-2.1-mini", dict(TURN_DETECTION),
            "gpt-realtime-2.1-mini via gateway, server VAD",
            "The candidate single default: gpt-realtime groundedness at cascade latency?",
            ("native", "gateway", "v21mini")),
    _gw_arm("gw-21mini-semantic", "gpt-realtime-2.1-mini", SEMANTIC_VAD,
            "gpt-realtime-2.1-mini via gateway, semantic VAD",
            "Same question for the mini tier.",
            ("native", "gateway", "v21mini", "semantic")),
    Arm(id="gw-hd-server", label="Voice Live gpt-4.1-mini via gateway HD tier",
        dialect="ga", creds="kataleptic",
        voice="en-US-AvaMultilingualNeural", voice_type="azure-standard",
        transcription=AZURE_SPEECH, brain="gpt-4.1-mini",
        _url=f"{GW}?model=kataleptic-realtime-hd",
        turn_detection=dict(TURN_DETECTION),
        notes="The other incumbent: fastest to first audio in the merged report.",
        tags=("vl", "gateway", "incumbent")),
]

# ── The proposed Kataleptic tier: Voice Live serving a gpt-realtime brain ──
# Azure's multilingual semantic detector eliminated clause-pause splitting on
# gpt-realtime-2 at NO latency cost, where OpenAI's semantic detector cost half
# a second with a multi-second tail. That combination — native speech-to-speech
# brain, Azure detector — is reachable only through Voice Live, and Kataleptic
# exposes no tier for it. These arms measure what such a tier would be worth.
#
# Direct to Azure, because the gateway cannot reach this combination today. The
# merged report bounds the proxy's own cost well below the differences here.
# Voice defaults to the model's own `marin`: Voice Live ACCEPTS an Azure neural
# voice on a native brain, which would silently convert the tier into a cascade
# and throw away the prosody that is the reason to want it.
VOICE_LIVE_TIER_ARMS: list[Arm] = [
    Arm(id="vl21-azsem",
        label="Voice Live serving gpt-realtime-2.1, Azure semantic VAD",
        dialect="vl", creds="azure",
        voice="marin", voice_type="openai", transcription=WHISPER,
        brain="gpt-realtime-2.1",
        _url=(f"wss://{AZURE_HOST}/voice-live/realtime"
              f"?api-version={VOICE_LIVE_API_VERSION}&model=gpt-realtime-2.1"),
        turn_detection=AZURE_SEMANTIC_VAD,
        notes="The candidate best tier: newest brain, free detector.",
        tags=("native", "direct", "voicelive-stack", "semantic", "v21")),
    Arm(id="vl21mini-azsem",
        label="Voice Live serving gpt-realtime-2.1-mini, Azure semantic VAD",
        dialect="vl", creds="azure",
        voice="marin", voice_type="openai", transcription=WHISPER,
        brain="gpt-realtime-2.1-mini",
        _url=(f"wss://{AZURE_HOST}/voice-live/realtime"
              f"?api-version={VOICE_LIVE_API_VERSION}&model=gpt-realtime-2.1-mini"),
        turn_detection=AZURE_SEMANTIC_VAD,
        notes=("Whether Azure's detector fixes the splitting that OpenAI's only "
               "mitigated on this brain — 4/12 through the gateway."),
        tags=("native", "direct", "voicelive-stack", "semantic", "v21mini")),
]

ARMS_BY_ID = {a.id: a for a in ARMS + VAD_ARMS + REALTIME_21_ARMS
              + VOICE_LIVE_TIER_ARMS}

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
    # gpt-realtime-2.1: does the detector matter, and is the brain faster?
    ("gw-21-semantic", "gw-21-server",
     "semantic vs server VAD, brain gpt-realtime-2.1"),
    ("gw-21mini-semantic", "gw-21mini-server",
     "semantic vs server VAD, brain gpt-realtime-2.1-mini"),
    ("gw-21-server", "gw-2-server",
     "gpt-realtime-2.1 vs gpt-realtime-2, server VAD"),
    ("gw-21mini-server", "gw-2-server",
     "gpt-realtime-2.1-mini vs gpt-realtime-2, server VAD"),
    ("gw-21mini-server", "gw-hd-server",
     "gpt-realtime-2.1-mini vs Voice Live gpt-4.1-mini"),
    ("gw-21-server", "gw-hd-server",
     "gpt-realtime-2.1 vs Voice Live gpt-4.1-mini"),
    # the proposed tier, against what it would replace
    ("vl21-azsem", "vlnat-azsemantic",
     "gpt-realtime-2.1 vs 2 on the Voice-Live-served tier"),
    ("vl21-azsem", "gw-hd-server",
     "proposed tier vs the current HD tier"),
    ("vl21-azsem", "gw-2-server",
     "proposed tier vs the current gpt-realtime-2 tier"),
    ("vl21mini-azsem", "vl21-azsem",
     "mini vs full brain on the proposed tier"),
    ("vl21mini-azsem", "gw-hd-server",
     "proposed mini tier vs the current HD tier"),
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
