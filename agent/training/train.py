"""Trains the "Hej Piťu" classifier on the embeddings from features.py and
exports it as an openWakeWord-compatible ONNX model.

Reported numbers: recall on voices held out of training, false wakes per
hour on the held-out 4 h of openWakeWord's validation set (speech, music, noise), and how
often near-miss phrases ("Hej Peťo") would wake it. With recordings from
record.py it also reports recall on your own held-out takes.

`python train.py --evaluate PATH` only runs the streaming checks on an existing model."""
from __future__ import annotations

import argparse
import wave
from pathlib import Path

import numpy as np
import torch
from numpy.lib import format as npformat
from torch import nn

HERE = Path(__file__).resolve().parent
FEATURES = HERE / "work" / "features"
MODELS = HERE.parent / ".venv" / "Lib" / "site-packages" / "openwakeword" / "resources" / "models"
DEFAULT_OUT = HERE.parent / "models" / "hej_pitu.onnx"
FRAME_S = 0.08
# The listener goes deaf for a whole turn after a wake, so nearby hits are one event.
REFRACTORY_FRAMES = 25
VAL_TRAIN_SHARE = 0.6


class Net(nn.Module):
    def __init__(self, dim: int, blocks: int, dropout: float) -> None:
        super().__init__()
        layers: list[nn.Module] = [nn.Flatten(), nn.Dropout(dropout), nn.Linear(16 * 96, dim), nn.LayerNorm(dim), nn.ReLU()]
        for _ in range(blocks):
            layers += [nn.Dropout(dropout), nn.Linear(dim, dim), nn.LayerNorm(dim), nn.ReLU()]
        layers += [nn.Linear(dim, 1), nn.Sigmoid()]
        self.layers = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.layers(x)


def load_acav() -> np.ndarray:
    path = FEATURES / "acav_partial.npy"
    with open(path, "rb") as f:
        npformat.read_magic(f)
        shape, _, dtype = npformat.read_array_header_1_0(f)
        offset = f.tell()
    rows = (path.stat().st_size - offset) // (int(np.prod(shape[1:])) * dtype.itemsize)
    return np.array(np.memmap(path, dtype=dtype, mode="r", offset=offset, shape=(rows, *shape[1:])))


def validation_windows() -> tuple[np.ndarray, np.ndarray]:
    """Far-field conversation, the closest thing to a room with people in it. The first part is
    trained on; false wakes are only ever counted on the untouched rest."""
    frames = np.load(FEATURES / "validation_set_features.npy")
    cut = int(len(frames) * VAL_TRAIN_SHARE)
    windows = lambda f: np.lib.stride_tricks.sliding_window_view(f, 16, axis=0).transpose(0, 2, 1)
    return windows(frames[:cut]), windows(frames[cut:])


def predict(model: nn.Module, x: np.ndarray, batch: int = 65536) -> np.ndarray:
    model.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(x), batch):
            out.append(model(torch.from_numpy(np.ascontiguousarray(x[i : i + batch], dtype=np.float32))).numpy()[:, 0])
    model.train()
    return np.concatenate(out)


def events(scores: np.ndarray, threshold: float) -> int:
    count, quiet_until = 0, -1
    for i in np.flatnonzero(scores >= threshold):
        if i > quiet_until:
            count += 1
            quiet_until = i + REFRACTORY_FRAMES
    return count


def evaluate(model: nn.Module, data: dict, threshold: float) -> dict:
    val = predict(model, data["val"])
    return {
        "recall": float(np.mean(predict(model, data["pos_test"]) >= threshold)),
        "fp_per_h": events(val, threshold) / data["val_hours"],
        "near_miss": float(np.mean(predict(model, data["near_test"]) >= threshold)),
        **({"you": float(np.mean(predict(model, data["rec_test"]) >= threshold))} if "rec_test" in data else {}),
    }


def describe(m: dict) -> str:
    you = f"  your voice {m['you']:.3f}" if "you" in m else ""
    return f"recall {m['recall']:.3f}{you}  false wakes/h {m['fp_per_h']:.2f}  near-miss {m['near_miss']:.3f}"


MINE_EVERY = 2000
HARD_POOL = 20000


def batches(data: dict, rng: np.random.Generator):
    positive = {"pos": 192} | ({"rec": 96} if "rec" in data else {})
    negative = {"near": 64, "speech": 64, "snippets": 96, "noise": 32, "room": 128, "acav": 256, "hard": 256}
    if "rec_neg" in data:
        negative["rec_neg"] = 96
    sizes = positive | negative
    while True:
        x = [data[k][rng.integers(0, len(data[k]), n)] for k, n in sizes.items()]
        y = np.zeros(sum(sizes.values()), dtype=np.float32)
        y[: sum(positive.values())] = 1
        yield torch.from_numpy(np.concatenate(x).astype(np.float32)), torch.from_numpy(y)


def train(data: dict, steps: int, dim: int, blocks: int, dropout: float, max_neg_weight: float, threshold: float,
          seed: int):
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    model = Net(dim, blocks, dropout)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=1e-3, total_steps=steps, pct_start=0.1)
    best, best_state = None, None
    data["hard"] = data["acav"][rng.integers(0, len(data["acav"]), HARD_POOL)]
    gen = batches(data, rng)
    for step in range(1, steps + 1):
        if step % MINE_EVERY == 0:
            scores = predict(model, data["acav"])
            data["hard"] = data["acav"][np.argpartition(scores, -HARD_POOL)[-HARD_POOL:]]
        x, y = next(gen)
        p = model(x)[:, 0]
        neg_weight = 1 + (max_neg_weight - 1) * min(1.0, step / (steps * 0.6))
        w = torch.where(y > 0, torch.ones_like(y), torch.full_like(y, neg_weight))
        loss = nn.functional.binary_cross_entropy(p.clamp(1e-6, 1 - 1e-6), y, weight=w)
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if step % 1000 == 0 or step == steps:
            m = evaluate(model, data, threshold)
            print(f"step {step:6d}  loss {loss.item():.4f}  {describe(m)}", flush=True)
            # Only checkpoints past the halfway mark compete; early ones haven't seen the full negative weight.
            score = m["recall"] + m.get("you", 0) - 0.15 * m["fp_per_h"] - 0.5 * m["near_miss"]
            if step >= steps // 2 and (best is None or score > best[0]):
                best = (score, step, m)
                best_state = {k: v.clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    return model, best


def export(model: nn.Module, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    model.eval()
    torch.onnx.export(model, torch.zeros(1, 16, 96), str(path), input_names=["input"], output_names=["output"],
                      dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}}, opset_version=13, dynamo=False)


def stream_check(path: Path, threshold: float) -> None:
    """Runs held-out audio through openWakeWord's streaming Model the way the agent does."""
    import json

    from openwakeword.model import Model

    import features

    oww = Model(wakeword_models=[str(path)], inference_framework="onnx",
                melspec_model_path=str(MODELS / "melspectrogram.onnx"),
                embedding_model_path=str(MODELS / "embedding_model.onnx"))
    name = next(iter(oww.models))

    def peak(audio: np.ndarray) -> float:
        oww.reset()
        audio = np.clip(audio, -32768, 32767).astype(np.int16)
        return max(float(oww.predict(audio[i : i + 1280])[name]) for i in range(0, len(audio) - 1280, 1280))

    def report(label: str, peaks: list[float]) -> None:
        if peaks:
            hits = sum(p >= threshold for p in peaks)
            print(f"streaming check, {label}: {hits}/{len(peaks)} woke it ({hits / len(peaks):.1%})", flush=True)

    test_voices = json.loads((FEATURES / "split.json").read_text())["test_voices"]
    rng = np.random.default_rng(3)
    synthetic = []
    for voice in test_voices:
        for p in sorted((HERE / "work" / "clips" / "positive" / voice).glob("*.wav")):
            with wave.open(str(p), "rb") as w:
                clip = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64)
            audio = np.concatenate([np.zeros(16000 * 2), clip, np.zeros(16000)])
            synthetic.append(peak(audio + rng.normal(0, 30, len(audio))))
    report("held-out synthetic voices", synthetic)

    takes = features.recorded_takes()
    held_out = [t for t in takes if t.held_out]
    for kind, label in (("pos", "your held-out takes"), ("near", "your held-out near-misses")):
        report(label, [peak(t.audio[max(0, t.end - 3 * 16000) : t.end + 8000] * 32767)
                       for t in held_out if t.kind == kind])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=15000)
    ap.add_argument("--dim", type=int, default=48)
    ap.add_argument("--blocks", type=int, default=1)
    ap.add_argument("--dropout", type=float, default=0.2)
    ap.add_argument("--neg-weight", type=float, default=60.0)
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--evaluate", type=Path, metavar="ONNX")
    args = ap.parse_args()
    if args.evaluate:
        stream_check(args.evaluate, args.threshold)
        return

    load = lambda name: np.load(FEATURES / f"{name}.npy")
    near = load("neg_near")
    split = np.random.default_rng(0).permutation(len(near))
    cut = int(len(near) * 0.85)
    room, val = validation_windows()
    data = {
        "pos": load("pos_train"), "pos_test": load("pos_test"),
        "near": near[split[:cut]], "near_test": near[split[cut:]],
        "speech": load("neg_speech"), "snippets": load("neg_snippets"), "noise": load("neg_noise"),
        "room": room, "acav": load_acav(),
        "val": val, "val_hours": len(val) * FRAME_S / 3600,
    }
    for key, name in (("rec", "pos_rec_train"), ("rec_test", "pos_rec_test"), ("rec_neg", "neg_rec")):
        if (FEATURES / f"{name}.npy").exists():
            data[key] = load(name)
    print({k: (v.shape if hasattr(v, "shape") else round(v, 2)) for k, v in data.items()}, flush=True)

    model, (_, step, m) = train(data, args.steps, args.dim, args.blocks, args.dropout, args.neg_weight,
                                  args.threshold, args.seed)
    print(f"best step {step}: {describe(m)}", flush=True)
    for t in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8):
        print(f"  threshold {t:.1f}: {describe(evaluate(model, data, t))}", flush=True)
    export(model, args.out)
    print(f"exported {args.out} ({args.out.stat().st_size // 1024} KB)", flush=True)
    stream_check(args.out, args.threshold)


if __name__ == "__main__":
    main()
