# "Hej Piťu" wake-word training

Produces `../models/hej_pitu.onnx`, an openWakeWord classifier on top of its shared speech embeddings. Everything here is one-off tooling with its own venv; the agent only needs the `.onnx`.

```powershell
& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

1. **Negative features** (openWakeWord's, into `work/features/`): the 185 MB validation set, and only the first 2 GB of the 17 GB ACAV100M file. It is a flat `.npy`, so a truncated download is still readable.

   ```powershell
   $base = "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main"
   curl.exe -L -o work/features/validation_set_features.npy "$base/validation_set_features.npy"
   curl.exe -L -r 0-2147483647 -o work/features/acav_partial.npy "$base/openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
   ```

2. **`python synth.py`** — Azure TTS (key from `../.env`): "Hej Piťu" from all ~60 voices that speak Slovak, near-misses ("Hej Peťo", "pi tu"…) and ordinary sentences. About 10 minutes, and roughly a quarter of the F0 monthly character quota. Raw responses are kept in `work/raw/`, so re-runs cost nothing.
3. **`python features.py`** — augmentation (speed, reverb, mic colouring, noise, speech before the phrase) and embeddings. Ten voices are held out for testing.
4. **`python train.py`** — trains, prints recall / false wakes per hour / near-miss rate at several thresholds, exports the model, and replays the held-out clips through openWakeWord's streaming `Model` the way the agent does.

## Your voice

```powershell
.\.venv\Scripts\python.exe record.py
```

The script runs about 10 minutes of guided blocks with the agent's own mic:
- **80 takes of "Hej Piťu":** normal, quiet, loud, fast, across the room, turned away, over music, over a game.
- **Things that must not wake it:** near-misses, a minute of you talking, and a minute of room, music or game audio.

It pauses the Piťu task while recording and starts it again at the end. Delete `work/recordings/<block>.*` to redo one block.

Then run `python features.py` and `python train.py` as above. Every fourth take stays out of training, and `train.py` reports how often those woke it. `python train.py --evaluate ..\models\hej_pitu.onnx` gives the same check for an existing model without training.

## Current model

Synthetic voices plus 64 of Samo's takes:

- **Your voice:** 16 of 16 held-out takes woke it, including across the room, turned away, and over music or a game. The synthetic-only model managed 7 of 16, and 48 of all 80 takes.
- **Other voices:** 99.6 % of held-out synthetic voices woke it through the streaming path.
- **False wakes:** 0 in the 4.3 h held-out part of the validation set (conversation, music, noise). Stock "Hey Jarvis" gets 0.47/h on the same audio.
- **Near-misses:** about 2 % of deliberately close phrases ("Hej Peťo") wake it, and 0 of 3 of your held-out ones.
- **Cut off mid-word:** your held-out takes stopped at 45 % ("Hej P…") wake it 0 of 16 times (before cut-off training: 10 of 16); stopped at 60 % ("Hej Pit…"), 2 of 16.

Sixteen takes is a small test, so the diagnostics page's wake score in daily use is the real verdict.
