"""Augments the generated clips and your recordings into 2 s windows and turns
them into openWakeWord embeddings (N, 16, 96). Positives from held-out voices,
and every fourth of your own takes, go to separate test files, so recall is
measured on audio the model never saw."""
from __future__ import annotations

import json
import random
import wave
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

import numpy as np
from openwakeword.utils import AudioFeatures
from scipy import signal

HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
CLIPS = WORK / "clips"
OUT = WORK / "features"
RECORDINGS = WORK / "recordings"
MODELS = HERE.parent / ".venv" / "Lib" / "site-packages" / "openwakeword" / "resources" / "models"
RATE = 16000
WINDOW = 2 * RATE
TEST_VOICES = 10
TEST_EVERY = 4

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


@dataclass
class Take:
    block: str
    kind: str
    index: int
    start: int
    """Sample where the voice in this take starts."""
    end: int
    """Sample where the voice in this take stops."""
    audio: np.ndarray
    """The whole recorded block the take is in."""

    @property
    def held_out(self) -> bool:
        return self.index % TEST_EVERY == TEST_EVERY - 1


def recorded_takes() -> list[Take]:
    from openwakeword.vad import VAD

    vad = VAD(model_path=str(MODELS / "silero_vad.onnx"))
    frame = 480
    takes = []
    for meta_path in sorted(RECORDINGS.glob("*.json")):
        meta = json.loads(meta_path.read_text())
        audio = load(meta_path.with_suffix(".wav"))
        pcm = (audio * 32767).astype(np.int16)
        slot = int(meta["slot_s"] * RATE)
        for i, start in enumerate(meta["slots"]):
            vad.reset_states()
            voiced = [k for k in range(slot // frame)
                      if vad.predict(pcm[start + k * frame : start + (k + 1) * frame], frame_size=frame) >= 0.5]
            if not voiced:
                print(f"  {meta_path.stem} take {i + 1}: no voice found, skipped", flush=True)
                continue
            first = len(voiced) - 1
            # Walk back over the short pause in "Hej, Piťu", but not to a previous take spilling into the slot.
            while first > 0 and voiced[first] - voiced[first - 1] <= 8:
                first -= 1
            takes.append(Take(meta_path.stem, meta["kind"], i, start + voiced[first] * frame,
                              start + (voiced[-1] + 1) * frame, audio))
    return takes


def real_window(audio: np.ndarray, end: int) -> np.ndarray:
    w = audio[max(0, end - WINDOW) : end]
    return np.pad(w, (WINDOW - len(w), 0), mode="reflect" if 0 < len(w) < WINDOW else "constant")


def light(window: np.ndarray, babble: np.ndarray | None) -> np.ndarray:
    """Your recordings already carry the real room, so they only get level changes and a little extra noise."""
    out = window * 10 ** (rng.uniform(-8, 6) / 20)
    if rng.random() < 0.4:
        out = out + set_level(noise(WINDOW), rms_db(out) - rng.uniform(10, 30))
    if babble is not None and rng.random() < 0.2:
        out = out + set_level(crop(babble), rms_db(out) - rng.uniform(10, 20))
    return np.clip(out, -0.99, 0.99)


def take_windows(takes: list[Take], copies: int, babble: np.ndarray | None) -> np.ndarray:
    windows = [light(real_window(t.audio, t.end + int(rng.uniform(0, 0.2) * RATE)), babble)
               for t in takes for _ in range(copies)]
    return np.stack(windows) if windows else np.zeros((0, WINDOW), dtype=np.float32)


def cut_point(start: int, end: int) -> int:
    """Somewhere in "Hej P…" to "Hej Pi…": the phrase begun but not finished."""
    return start + int((end - start) * rng.uniform(0.4, 0.65))


def partial_clip_windows(sources: list[np.ndarray], copies: int, babble: np.ndarray | None) -> np.ndarray:
    return np.stack([augment(place(clip[: cut_point(0, len(clip))], 0.45), babble)
                     for clip in sources for _ in range(copies)])


def room_tone(t: Take, length: int) -> np.ndarray:
    """The block's quiet lead-in, before the first prompt."""
    offset = rng.integers(0, max(1, RATE * 2 - length))
    return t.audio[offset : offset + length]


def stopped_window(t: Take, cut: int, silence: int) -> np.ndarray:
    """You stop at `cut` and the room goes quiet for `silence` samples."""
    return np.concatenate([real_window(t.audio, cut)[silence:], room_tone(t, silence)])


def partial_take_windows(takes: list[Take], copies: int, babble: np.ndarray | None) -> np.ndarray:
    windows = [light(stopped_window(t, cut_point(t.start, t.end), int(rng.uniform(0, 0.45) * RATE)), babble)
               for t in takes for _ in range(copies)]
    return np.stack(windows) if windows else np.zeros((0, WINDOW), dtype=np.float32)


def block_windows(audio: np.ndarray, babble: np.ndarray | None) -> np.ndarray:
    ends = range(WINDOW, len(audio), RATE // 4)
    return np.stack([light(real_window(audio, e), babble) for e in ends for _ in range(2)])


def embed(features: AudioFeatures, windows: np.ndarray, name: str) -> None:
    if not len(windows):
        (OUT / f"{name}.npy").unlink(missing_ok=True)
        return
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
    embed(features, partial_clip_windows(train_pos, 4, babble), "neg_partial")
    embed(features, partial_clip_windows(test_pos, 2, babble), "neg_partial_test")
    embed(features, phrase_windows([c for v in near.values() for c in v], 6, babble), "neg_near")
    if speech:
        per_voice = [np.concatenate(v) for v in speech.values()]
        embed(features, np.concatenate([stream_windows(s, 800, None) for s in per_voice]), "neg_speech")
        embed(features, np.concatenate([snippet_windows(s, 1200, babble) for s in per_voice]), "neg_snippets")
    embed(features, noise_windows(3000), "neg_noise")

    takes = recorded_takes()
    if takes:
        pos = [t for t in takes if t.kind == "pos"]
        print(f"your takes: {len(pos)} positive, {sum(t.held_out for t in pos)} held out", flush=True)
        embed(features, take_windows([t for t in pos if not t.held_out], 12, babble), "pos_rec_train")
        test = [real_window(t.audio, t.end + RATE // 10) for t in pos if t.held_out]
        embed(features, np.stack(test) if test else np.zeros((0, WINDOW)), "pos_rec_test")
        negatives = [take_windows([t for t in takes if t.kind == "near"], 6, babble)]
        for meta_path in sorted(RECORDINGS.glob("*.json")):
            if json.loads(meta_path.read_text())["kind"] in ("talk", "room"):
                negatives.append(block_windows(load(meta_path.with_suffix(".wav")), babble))
        embed(features, np.concatenate(negatives), "neg_rec")
        embed(features, partial_take_windows([t for t in pos if not t.held_out], 10, babble), "neg_rec_partial")


if __name__ == "__main__":
    main()
