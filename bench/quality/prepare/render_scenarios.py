"""Render the Riverside Dental caller scripts to 16 kHz mono WAV turns.

Two backends:
  --tts say     macOS `say` — offline, deterministic, zero credentials. Good
                enough to prove out the harness and to measure latency/barge-in,
                but the voices are obviously synthetic.
  --tts azure   Azure Speech neural voices — what the real run should use.
                Needs AZURE_SPEECH_KEY + AZURE_SPEECH_REGION.

Each turn becomes <scenario>/t<NN>.wav plus a turns.json carrying the exact
duration of every turn. Because we generate the audio, every utterance boundary
is known to the millisecond, which is what makes time-to-first-audio and
barge-in latency measurable without forced alignment.

Usage:
  python render_scenarios.py --scenarios scenarios_riverside.json \
      --out data/scenarios --tts say
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

SR = 16000

SAY_VOICES = {
    "en_US": "Samantha", "en_GB": "Daniel", "de_DE": "Anna", "fr_FR": "Thomas",
    "es_ES": "Mónica", "nl_NL": "Xander", "it_IT": "Alice", "sv_SE": "Alva",
    "da_DK": "Sara", "fi_FI": "Satu", "ru_RU": "Milena",
}

AZURE_VOICES = {
    "en_US": "en-US-AvaMultilingualNeural", "de_DE": "de-DE-SeraphinaMultilingualNeural",
    "fr_FR": "fr-FR-VivienneMultilingualNeural", "es_ES": "es-ES-XimenaNeural",
    "nl_NL": "nl-NL-FennaNeural", "it_IT": "it-IT-IsabellaNeural",
    "sv_SE": "sv-SE-SofieNeural", "da_DK": "da-DK-ChristelNeural",
    "fi_FI": "fi-FI-SelmaNeural", "ru_RU": "ru-RU-SvetlanaNeural",
}


def to_wav16k(src: Path, dst: Path) -> float:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-ac", "1", "-ar", str(SR), "-acodec", "pcm_s16le", str(dst)],
        check=True,
    )
    with wave.open(str(dst), "rb") as w:
        return w.getnframes() / w.getframerate()


def synth_say(text: str, lang: str, dst: Path) -> float:
    voice = SAY_VOICES.get(lang) or SAY_VOICES["en_US"]
    with tempfile.TemporaryDirectory() as td:
        aiff = Path(td) / "t.aiff"
        subprocess.run(["say", "-v", voice, "-r", "175", "-o", str(aiff), text], check=True)
        return to_wav16k(aiff, dst)


def synth_azure(text: str, lang: str, dst: Path) -> float:
    import urllib.request

    key, region = os.environ.get("AZURE_SPEECH_KEY"), os.environ.get("AZURE_SPEECH_REGION")
    if not (key and region):
        sys.exit("AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set")
    voice = AZURE_VOICES.get(lang, AZURE_VOICES["en_US"])
    ssml = (
        f"<speak version='1.0' xml:lang='{lang.replace('_','-')}'>"
        f"<voice name='{voice}'>{text}</voice></speak>"
    )
    req = urllib.request.Request(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode(),
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            # Ask for 16 kHz PCM directly so nothing is resampled twice.
            "X-Microsoft-OutputFormat": "riff-16khz-16bit-mono-pcm",
        },
    )
    with tempfile.TemporaryDirectory() as td:
        raw = Path(td) / "t.wav"
        with urllib.request.urlopen(req, timeout=60) as r:
            raw.write_bytes(r.read())
        return to_wav16k(raw, dst)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--scenarios", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--tts", choices=["say", "azure"], default="say")
    args = p.parse_args()

    spec = json.loads(Path(args.scenarios).read_text())
    synth = synth_say if args.tts == "say" else synth_azure
    out_root = Path(args.out)

    for sc in spec["scenarios"]:
        d = out_root / sc["id"]
        d.mkdir(parents=True, exist_ok=True)
        turns = []
        for i, turn in enumerate(sc["turns"]):
            wav = d / f"t{i:02d}.wav"
            dur = synth(turn["text"], sc["lang"], wav)
            turns.append({
                "index": i,
                "wav": wav.name,
                "text": turn["text"],
                "seconds": round(dur, 3),
                "barge_in_after_ms": turn.get("barge_in_after_ms"),
            })
        (d / "turns.json").write_text(json.dumps({
            "id": sc["id"], "lang": sc["lang"], "intent": sc["intent"],
            "description": sc["description"], "tts": args.tts,
            "expected": sc["expected"], "turns": turns,
        }, ensure_ascii=False, indent=2))
        print(f"{sc['id']}: {len(turns)} turns, "
              f"{sum(t['seconds'] for t in turns):.1f}s", file=sys.stderr)

    if "business" in spec:
        (out_root / "business.json").write_text(
            json.dumps(spec["business"], ensure_ascii=False, indent=2)
        )


if __name__ == "__main__":
    main()
