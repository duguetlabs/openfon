"""Deterministic caller audio for the realtime latency benchmark.

Every arm must hear byte-identical input, so the caller utterances are
synthesized once with Azure Speech TTS and cached on disk as raw PCM16 at
24 kHz mono — the format every realtime endpoint under test accepts.

Trailing silence is trimmed: `ttfa_ms` is measured from the moment the last
*speech* frame goes out, so a WAV with 400 ms of TTS tail padding would
silently inflate every number by 400 ms.
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import urllib.error
import urllib.request
import wave
from dataclasses import dataclass
from pathlib import Path

SAMPLE_RATE = 24000
BYTES_PER_SAMPLE = 2
FRAME_MS = 20
FRAME_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * FRAME_MS // 1000  # 960

HERE = Path(__file__).resolve().parent
CACHE_DIR = Path(os.environ.get("BENCH_CACHE_DIR", HERE / "cache"))

# Silence trim: a 20 ms frame counts as silence when its peak amplitude is
# below this (int16 full scale 32768). TTS tails are digital-silence-ish but
# not exactly zero.
SILENCE_PEAK = 700


@dataclass(frozen=True)
class Utterance:
    id: str
    lang: str
    voice: str
    text: str
    pcm: bytes

    @property
    def duration_s(self) -> float:
        return len(self.pcm) / (SAMPLE_RATE * BYTES_PER_SAMPLE)

    def frames(self) -> list[bytes]:
        """20 ms frames, zero-padded to a whole frame."""
        pad = (-len(self.pcm)) % FRAME_BYTES
        buf = self.pcm + b"\x00" * pad
        return [buf[i:i + FRAME_BYTES] for i in range(0, len(buf), FRAME_BYTES)]


def _escape_xml(s: str) -> str:
    for a, b in (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"),
                 ("'", "&apos;"), ('"', "&quot;")):
        s = s.replace(a, b)
    return s


def _synthesize(text: str, voice: str, region: str, key: str) -> bytes:
    """Azure Speech REST → raw PCM16 @ 24 kHz mono. Mirrors src/providers.ts."""
    lang = "-".join(voice.split("-")[:2]) or "en-US"
    ssml = (f"<speak version='1.0' xml:lang='{lang}'>"
            f"<voice name='{voice}'>{_escape_xml(text)}</voice></speak>")
    req = urllib.request.Request(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
            "User-Agent": "openfon-bench",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Azure TTS {e.code}: {e.read()[:300].decode(errors='ignore')}")


def trim_silence(pcm: bytes) -> bytes:
    """Drop leading and trailing near-silent frames."""
    frames = [pcm[i:i + FRAME_BYTES] for i in range(0, len(pcm), FRAME_BYTES)]

    def loud(fr: bytes) -> bool:
        n = len(fr) // 2
        if not n:
            return False
        return max(abs(v) for v in struct.unpack(f"<{n}h", fr[:n * 2])) > SILENCE_PEAK

    first, last = 0, len(frames) - 1
    while first <= last and not loud(frames[first]):
        first += 1
    while last >= first and not loud(frames[last]):
        last -= 1
    if first > last:
        return pcm
    return b"".join(frames[first:last + 1])


def _write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(BYTES_PER_SAMPLE)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)


def _read_wav(path: Path) -> bytes:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == SAMPLE_RATE and w.getsampwidth() == BYTES_PER_SAMPLE
        return w.readframes(w.getnframes())


def cache_name(u: dict) -> str:
    """Cache filename keyed by a hash of everything that determines the audio.

    Keying on the id alone would silently replay stale audio after someone
    edits an utterance's text or voice — every arm would still hear identical
    input, so nothing would look wrong, but the run would not be testing what
    the spec says it tests.
    """
    h = hashlib.sha256(
        f"{u['text']}\x00{u['voice']}\x00{SAMPLE_RATE}".encode()).hexdigest()[:12]
    return f"{u['id']}-{h}.wav"


def load_utterances(spec_path: Path | None = None, *, region: str = "",
                    key: str = "", only: list[str] | None = None) -> list[Utterance]:
    """Load (and synthesize+cache on first use) the caller utterance set.

    `only` narrows the set BEFORE synthesis, so a focused run does not pay to
    generate — or require a Speech key for — audio it will never play.
    """
    spec = json.loads((spec_path or HERE / "utterances.json").read_text())
    if only is not None:
        known = {u["id"] for u in spec}
        missing = [i for i in only if i not in known]
        if missing:
            raise SystemExit(f"unknown utterance id(s): {', '.join(missing)}")
        spec = [u for u in spec if u["id"] in only]
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out: list[Utterance] = []
    for u in spec:
        wav = CACHE_DIR / cache_name(u)
        if wav.exists():
            pcm = _read_wav(wav)
        else:
            if not key:
                raise SystemExit(
                    f"{wav} missing and no Azure Speech key given — set AZURE_SPEECH_KEY "
                    "(see README) so the harness can synthesize the caller audio once.")
            pcm = trim_silence(_synthesize(u["text"], u["voice"], region, key))
            _write_wav(wav, pcm)
            print(f"  synthesized {u['id']}: {len(pcm)/(SAMPLE_RATE*2):.2f}s -> {wav.name}")
        out.append(Utterance(id=u["id"], lang=u["lang"], voice=u["voice"],
                             text=u["text"], pcm=pcm))
    return out
