"""Augments the generated clips into 2 s windows and turns them into
openWakeWord embeddings (N, 16, 96). Positives from a held-out set of voices
go to separate test files, so recall is measured on voices the model never saw."""
from __future__ import annotations

import json
import random
import wave
from fractions import Fraction
from pathlib import Path

import numpy as np
from openwakeword.utils import AudioFeatures
from scipy import signal

HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
CLIPS = WORK / "clips"
OUT = WORK / "features"
MODELS = HERE.parent / ".venv" / "Lib" / "site-packages" / "openwakeword" / "resources" / "models"
RATE = 16000
WINDOW = 2 * RATE
TEST_VOICES = 10

rng = np.random.default_rng(11)


def load(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def clips(kind: str) -> dict[str, list[np.ndarray]]:
    root = CLIPS / kind
    if not root.exists():
        return {}
    return {d.name: [load(p) for p in sorted(d.glob("*.wav"))] for d in sorted(root.iterdir()) if d.is_dir()}


def rms_db(x: np.ndarray) -> float:
    return 10 * np.log10(np.mean(x.astype(np.float64) ** 2) + 1e-12)


def set_level(x: np.ndarray, db: float) -> np.ndarray:
    return x * 10 ** ((db - rms_db(x)) / 20)


def speed(x: np.ndarray, factor: float) -> np.ndarray:
    f = Fraction(factor).limit_denominator(40)
    return signal.resample_poly(x, f.denominator, f.numerator).astype(np.float32)


def reverb(x: np.ndarray) -> np.ndarray:
    rt60 = rng.uniform(0.12, 0.7)
    t = np.arange(int(rt60 * RATE)) / RATE
    h = rng.standard_normal(len(t)) * np.exp(-6.9 * t / rt60) * rng.uniform(0.1, 0.6)
    h[0] = 1.0
    wet = signal.fftconvolve(x, h)[: len(x)]
    return (wet * np.sqrt(np.sum(x**2) / (np.sum(wet**2) + 1e-12))).astype(np.float32)


def noise(n: int) -> np.ndarray:
    white = rng.standard_normal(n)
    kind = rng.integers(3)
    if kind == 1:
        spectrum = np.fft.rfft(white)
        spectrum /= np.sqrt(np.maximum(np.arange(len(spectrum)), 1))
        white = np.fft.irfft(spectrum, n)
    elif kind == 2:
        white = signal.lfilter([1], [1, -0.98], white)
    return white.astype(np.float32)


def mic_colour(x: np.ndarray) -> np.ndarray:
    low = rng.uniform(50, 220)
    high = rng.uniform(3500, 7600)
    sos = signal.butter(2, [low, high], btype="bandpass", fs=RATE, output="sos")
    return signal.sosfilt(sos, x).astype(np.float32)


def place(x: np.ndarray, end_jitter_s: float) -> np.ndarray:
    out = np.zeros(WINDOW, dtype=np.float32)
    end = WINDOW - int(rng.uniform(0, end_jitter_s) * RATE)
    x = x[-end:]
    out[end - len(x) : end] = x
    return out


def crop(stream: np.ndarray) -> np.ndarray:
    if len(stream) <= WINDOW:
        return place(stream, 0.5)
    start = rng.integers(0, len(stream) - WINDOW)
    return stream[start : start + WINDOW].copy()


def augment(window: np.ndarray, babble: np.ndarray | None) -> np.ndarray:
    speech = window
    if rng.random() < 0.5:
        speech = reverb(speech)
    if rng.random() < 0.5:
        speech = mic_colour(speech)
    speech = set_level(speech, rng.uniform(-40, -14))
    level = rms_db(speech)
    background = set_level(noise(WINDOW), level - rng.uniform(3, 35))
    if babble is not None and rng.random() < 0.3:
        background += set_level(crop(babble), level - rng.uniform(6, 20))
    floor = set_level(noise(WINDOW), rng.uniform(-75, -55))
    mixed = speech + background + floor
    peak = np.abs(mixed).max()
    if peak > 0.99:
        mixed *= 0.99 / peak
    return mixed


def lead_in(x: np.ndarray, babble: np.ndarray) -> np.ndarray:
    """Some other speech, then a pause, then the clip: people talk right before they call it."""
    words = babble[(start := rng.integers(0, len(babble) - RATE)) : start + rng.integers(RATE // 4, RATE)]
    pause = np.zeros(int(rng.uniform(0.1, 0.6) * RATE), dtype=np.float32)
    return np.concatenate([words, pause, x])


def phrase_windows(sources: list[np.ndarray], copies: int, babble: np.ndarray | None) -> np.ndarray:
    out = []
    for clip in sources:
        for _ in range(copies):
            x = speed(clip, rng.uniform(0.88, 1.12)) if rng.random() < 0.7 else clip
            if babble is not None and rng.random() < 0.3:
                x = lead_in(x, babble)
            out.append(augment(place(x, 0.2), babble))
    return np.stack(out)


def snippet_windows(stream: np.ndarray, count: int, babble: np.ndarray | None) -> np.ndarray:
    out = []
    for _ in range(count):
        length = int(rng.uniform(0.35, 1.3) * RATE)
        start = rng.integers(0, len(stream) - length)
        out.append(augment(place(stream[start : start + length], 0.3), babble))
    return np.stack(out)


def stream_windows(stream: np.ndarray, count: int, babble: np.ndarray | None) -> np.ndarray:
    return np.stack([augment(crop(stream), babble) for _ in range(count)])


def noise_windows(count: int) -> np.ndarray:
    return np.stack([
        set_level(noise(WINDOW), rng.uniform(-80, -30)) + set_level(noise(WINDOW), -75) for _ in range(count)
    ])


def embed(features: AudioFeatures, windows: np.ndarray, name: str) -> None:
    x = (np.clip(windows, -1, 1) * 32767).astype(np.int16)
    emb = features.embed_clips(x, batch_size=256, ncpu=8)[:, -16:, :].astype(np.float32)
    np.save(OUT / f"{name}.npy", emb)
    print(f"{name}: {emb.shape}", flush=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    positive = clips("positive")
    near = clips("near_miss")
    speech = clips("speech")
    babble = np.concatenate([c for v in speech.values() for c in v]) if speech else None

    voices = sorted(positive)
    test_voices = random.Random(5).sample(voices, TEST_VOICES)
    (OUT / "split.json").write_text(json.dumps({"test_voices": test_voices}, indent=1))
    train_pos = [c for v in voices if v not in test_voices for c in positive[v]]
    test_pos = [c for v in test_voices for c in positive[v]]
    print(f"positives: {len(train_pos)} train clips, {len(test_pos)} test clips ({len(voices)} voices)", flush=True)

    features = AudioFeatures(
        melspec_model_path=str(MODELS / "melspectrogram.onnx"),
        embedding_model_path=str(MODELS / "embedding_model.onnx"),
        ncpu=8,
    )
    embed(features, phrase_windows(train_pos, 10, babble), "pos_train")
    embed(features, phrase_windows(test_pos, 4, babble), "pos_test")
    embed(features, phrase_windows([c for v in near.values() for c in v], 6, babble), "neg_near")
    if speech:
        per_voice = [np.concatenate(v) for v in speech.values()]
        embed(features, np.concatenate([stream_windows(s, 800, None) for s in per_voice]), "neg_speech")
        embed(features, np.concatenate([snippet_windows(s, 1200, babble) for s in per_voice]), "neg_snippets")
    embed(features, noise_windows(3000), "neg_noise")


if __name__ == "__main__":
    main()
