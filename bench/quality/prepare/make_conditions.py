"""Derive the noise / reverb / telephony condition set from clean 16 kHz WAVs.

Every condition is a deterministic function of (utterance id, condition name),
so a rerun reproduces byte-identical audio and the two engines are always
compared on exactly the same signal.

Conditions
  clean                     pass-through
  <scene>_snr<N>            additive DEMAND noise at N dB SNR (active-speech SNR)
  rev<RT60>                 pyroomacoustics shoebox reverb, target RT60 in ms
  tel                       G.711 mu-law, 8 kHz, band-limited, back to 16 kHz
  tel_<scene>_snr<N>        noise first, then the telephony chain
  tel_loss<P>               telephony chain + P% bursty 20 ms frame loss

Usage:
  python make_conditions.py --clean data/fleurs/de_de --noise data/noise-demand \
      --out data/conditions --conditions clean,cafe_snr10,tel,tel_cafe_snr10
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 16000
FRAME_MS = 20

# DEMAND scene -> the short name we use in condition strings.
SCENES = {
    "cafe": "PCAFETER",     # public cafeteria: clatter + babble
    "babble": "SPSQUARE",   # public square: dense multi-talker babble
    "street": "STRAFFIC",   # street traffic
    "car": "TCAR",          # in-car, dominated by low-frequency road noise
    "office": "OMEETING",   # office meeting room
}


def _rng(*parts: str) -> np.random.Generator:
    """Deterministic per-(utterance, condition) RNG."""
    h = hashlib.sha256("|".join(parts).encode()).digest()
    return np.random.default_rng(int.from_bytes(h[:8], "big"))


def read_wav(path: Path) -> np.ndarray:
    x, sr = sf.read(str(path), dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    assert sr == SR, f"{path}: expected {SR} Hz, got {sr}"
    return x


def write_wav(path: Path, x: np.ndarray) -> None:
    pcm = (np.clip(x, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)


def active_rms(x: np.ndarray) -> float:
    """RMS over speech-active frames only (ITU P.56-style, simplified).

    Plain full-signal RMS lets leading/trailing silence deflate the level, which
    would make the requested SNR wrong by several dB on utterances that start
    with a long pause. Gating at -30 dB relative to the loudest frame is close
    enough to P.56 for a controlled sweep.
    """
    n = int(SR * FRAME_MS / 1000)
    frames = x[: len(x) // n * n].reshape(-1, n)
    e = np.sqrt((frames**2).mean(axis=1) + 1e-12)
    active = e[e > e.max() * 10 ** (-30 / 20)]
    return float(active.mean()) if active.size else float(np.sqrt((x**2).mean()))


def mix_noise(x: np.ndarray, noise: np.ndarray, snr_db: float, rng) -> np.ndarray:
    """Add a random slice of `noise` at the requested active-speech SNR."""
    if len(noise) < len(x):
        noise = np.tile(noise, int(np.ceil(len(x) / len(noise))))
    start = int(rng.integers(0, len(noise) - len(x) + 1))
    n = noise[start : start + len(x)].astype(np.float32)
    n_rms = float(np.sqrt((n**2).mean()) + 1e-12)
    gain = active_rms(x) / n_rms * 10 ** (-snr_db / 20)
    y = x + gain * n
    peak = float(np.abs(y).max())
    return y / peak * 0.95 if peak > 0.95 else y  # avoid clipping, keep relative levels


def reverb(x: np.ndarray, rt60_ms: int, rng) -> np.ndarray:
    import pyroomacoustics as pra

    rt60 = rt60_ms / 1000.0
    room_dim = [4.5, 3.8, 2.7]
    absorption, max_order = pra.inverse_sabine(rt60, room_dim)
    room = pra.ShoeBox(
        room_dim, fs=SR, materials=pra.Material(absorption), max_order=max_order
    )
    room.add_source([1.2, 1.5, 1.5], signal=x)
    room.add_microphone([3.0, 2.4, 1.2])
    room.simulate()
    y = room.mic_array.signals[0].astype(np.float32)
    # Match the dry level so reverb does not double as a gain change.
    y *= active_rms(x) / (active_rms(y) + 1e-12)
    peak = float(np.abs(y).max())
    return y / peak * 0.95 if peak > 0.95 else y


def telephony(x: np.ndarray) -> np.ndarray:
    """16 kHz -> 300-3400 Hz band -> 8 kHz G.711 mu-law -> back to 16 kHz.

    This is the exact chain a Twilio PSTN leg imposes, so it is the single most
    production-relevant degradation in the suite.
    """
    with tempfile.TemporaryDirectory() as td:
        src, dst = Path(td) / "in.wav", Path(td) / "out.wav"
        write_wav(src, x)
        # Two-step so the mu-law quantisation actually happens at 8 kHz.
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                "-af", "highpass=f=300,lowpass=f=3400",
                "-ar", "8000", "-acodec", "pcm_mulaw", "-f", "wav", str(dst),
            ],
            check=True,
        )
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(dst),
             "-ar", "16000", "-acodec", "pcm_s16le", "-f", "wav", str(Path(td) / "up.wav")],
            check=True,
        )
        return read_wav(Path(td) / "up.wav")


def packet_loss(x: np.ndarray, pct: float, rng) -> np.ndarray:
    """Gilbert-Elliott bursty loss over 20 ms frames, lost frames -> silence.

    Bursty rather than i.i.d. loss because real RTP loss arrives in runs, and a
    run of 3 consecutive lost frames hurts an ASR far more than 3 scattered ones.
    """
    n = int(SR * FRAME_MS / 1000)
    nf = len(x) // n
    y = x.copy()
    p_bad = pct / 100.0
    mean_burst = 3.0
    p_recover = 1.0 / mean_burst
    p_fail = p_recover * p_bad / max(1e-9, 1 - p_bad)
    bad = False
    lost = 0
    for i in range(nf):
        bad = (rng.random() > p_recover) if bad else (rng.random() < p_fail)
        if bad:
            y[i * n : (i + 1) * n] = 0.0
            lost += 1
    return y


def load_noise(noise_dir: Path, scene: str) -> np.ndarray:
    """Concatenate channel-1 recordings for a DEMAND scene."""
    d = noise_dir / SCENES[scene]
    wavs = sorted(d.glob("ch01.wav")) or sorted(d.glob("*.wav"))[:1]
    if not wavs:
        sys.exit(f"no wav under {d}")
    parts = []
    for w in wavs:
        a, sr = sf.read(str(w), dtype="float32")
        if a.ndim > 1:
            a = a[:, 0]
        if sr != SR:
            from scipy.signal import resample_poly

            a = resample_poly(a, SR, sr).astype(np.float32)
        parts.append(a)
    return np.concatenate(parts)


def apply_condition(x: np.ndarray, cond: str, uid: str, noises: dict) -> np.ndarray:
    rng = _rng(uid, cond)
    if cond == "clean":
        return x
    if cond == "tel":
        return telephony(x)
    m = re.fullmatch(r"rev(\d+)", cond)
    if m:
        return reverb(x, int(m.group(1)), rng)
    m = re.fullmatch(r"tel_loss([\d.]+)", cond)
    if m:
        return packet_loss(telephony(x), float(m.group(1)), rng)
    m = re.fullmatch(r"(tel_)?(\w+?)_snr(-?\d+)", cond)
    if m:
        tel, scene, snr = m.group(1), m.group(2), int(m.group(3))
        y = mix_noise(x, noises[scene], snr, rng)
        return telephony(y) if tel else y
    sys.exit(f"unknown condition: {cond}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--clean", required=True, help="dir of <id>.wav + manifest.jsonl")
    p.add_argument("--noise", required=True, help="dir holding unpacked DEMAND scenes")
    p.add_argument("--out", required=True)
    p.add_argument("--conditions", required=True, help="comma-separated")
    args = p.parse_args()

    clean = Path(args.clean)
    conds = [c.strip() for c in args.conditions.split(",") if c.strip()]
    manifest = [json.loads(l) for l in (clean / "manifest.jsonl").read_text().splitlines()]

    needed = {m.group(2) for c in conds if (m := re.fullmatch(r"(tel_)?(\w+?)_snr(-?\d+)", c))}
    noises = {s: load_noise(Path(args.noise), s) for s in needed}

    for cond in conds:
        d = Path(args.out) / cond / clean.name
        d.mkdir(parents=True, exist_ok=True)
        for rec in manifest:
            x = read_wav(clean / rec["wav"])
            write_wav(d / rec["wav"], apply_condition(x, cond, rec["id"], noises))
            shutil.copyfile(clean / f"{rec['id']}.txt", d / f"{rec['id']}.txt")
        shutil.copyfile(clean / "manifest.jsonl", d / "manifest.jsonl")
        print(f"{cond}/{clean.name}: {len(manifest)} files", file=sys.stderr)


if __name__ == "__main__":
    main()
