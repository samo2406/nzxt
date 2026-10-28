"""Records your own "Hej Piťu" takes, and things that must not wake it, with
the mic and settings the agent uses. Each block is one WAV in
work/recordings/ plus the moments you were prompted; delete a block's files
to record it again."""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np
import sounddevice as sd
from dotenv import dotenv_values

HERE = Path(__file__).resolve().parent
OUT = HERE / "work" / "recordings"
RATE = 16000
TASK = "Pitu voice assistant"
AGENT_PORT = 8765
LEAD_IN_S = 3.0

# (name, kind, instruction, takes or seconds, seconds per take)
BLOCKS = [
    ("normal", "pos", "Normálne, sedíš pri počítači.", 10, 3.0),
    ("quiet", "pos", "Potichu, skoro polohlasom.", 10, 3.0),
    ("loud", "pos", "Nahlas, ako keby si volal z vedľajšej izby.", 10, 3.0),
    ("fast", "pos", "Rýchlo a ležérne, jedným dychom.", 10, 3.0),
    ("far", "pos", "Z druhého konca izby (2–3 m od mikrofónu).", 10, 4.0),
    ("away", "pos", "Otočený chrbtom alebo bokom k mikrofónu.", 10, 3.0),
    ("music", "pos", "Pusti hudbu tak nahlas, ako ju bežne počúvaš.", 10, 3.0),
    ("game", "pos", "Pusti hru alebo YouTube so zvukom.", 10, 3.0),
    ("near", "near", "Čítaj nahlas podobne znejúce frázy, ktoré sa ukážu (Hej Peťo, Hej ty…), nie „Hej Piťu“.", 12, 3.0),
    ("talk", "talk", "Rozprávaj 60 s normálne, napr. čítaj nahlas správy. Len nie „Hej Piťu“.", 60, 0),
    ("room", "room", "Pusti hudbu alebo hru a 60 s nehovor.", 60, 0),
]

NEAR_MISS = ["Hej Peťo", "Hej ty", "Hej Paťo", "Hej, počuj", "Pi tu", "Hej Miťu",
             "Hej, pivo", "Ahoj Peťo", "Hej Piko", "Hej Viťo", "Hej, poď sem", "Pišta"]


def mic_device(hint: str) -> int | None:
    api = next((i for i, a in enumerate(sd.query_hostapis()) if "WASAPI" in a["name"]), None)
    if api is None:
        return None
    if hint:
        for i, dev in enumerate(sd.query_devices()):
            if dev["hostapi"] == api and dev["max_input_channels"] > 0 and hint.lower() in dev["name"].lower():
                return i
    default = sd.query_hostapis(api)["default_input_device"]
    return default if default >= 0 else None


def agent_running() -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", AGENT_PORT)) == 0


def stop_agent() -> bool:
    """Piťu would wake on every take. Returns whether it has to be started again afterwards."""
    if not agent_running():
        return False
    subprocess.run(["schtasks", "/End", "/TN", TASK], capture_output=True)
    for _ in range(20):
        if not agent_running():
            print("Piťu je počas nahrávania vypnutý, na konci ho zapnem.\n")
            return True
        time.sleep(0.25)
    sys.exit("Piťu stále beží (asi spustený ručne). Zavri ho a spusti nahrávanie znova.")


class Recorder:
    def __init__(self, device: int | None) -> None:
        self._chunks: list[np.ndarray] = []
        self._stream = sd.InputStream(
            samplerate=RATE, channels=1, dtype="int16", blocksize=1280, device=device,
            callback=lambda data, *_: self._chunks.append(data[:, 0].copy()),
            extra_settings=sd.WasapiSettings(auto_convert=True),
        )

    def __enter__(self) -> "Recorder":
        self._stream.start()
        return self

    def __exit__(self, *_) -> None:
        self._stream.stop()
        self._stream.close()

    @property
    def position(self) -> int:
        return sum(len(c) for c in self._chunks)

    def audio(self) -> np.ndarray:
        return np.concatenate(self._chunks)


def countdown() -> None:
    for n in (3, 2, 1):
        print(f"  {n}…", end="\r", flush=True)
        time.sleep(LEAD_IN_S / 3)


def record_block(device: int | None, name: str, kind: str, count: int, slot_s: float) -> None:
    slots: list[int] = []
    with Recorder(device) as rec:
        countdown()
        if kind in ("talk", "room"):
            end = time.monotonic() + count
            while (left := end - time.monotonic()) > 0:
                print(f"  ● nahrávam, ešte {left:4.0f} s ", end="\r", flush=True)
                time.sleep(0.2)
        else:
            for i in range(count):
                text = NEAR_MISS[i % len(NEAR_MISS)] if kind == "near" else "Hej Piťu"
                slots.append(rec.position)
                print(f"  ▶ {i + 1:2d}/{count}   TERAZ:  {text.upper():<14}", end="\r", flush=True)
                time.sleep(slot_s * 0.6)
                print(f"    {i + 1:2d}/{count}           {'':<14}", end="\r", flush=True)
                time.sleep(slot_s * 0.4)
            time.sleep(0.8)
        audio = rec.audio()
    print(" " * 50, end="\r")

    OUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(audio.tobytes())
    (OUT / f"{name}.json").write_text(json.dumps({"kind": kind, "slots": slots, "slot_s": slot_s}))
    level = 20 * np.log10(np.abs(audio).max() / 32768 + 1e-9)
    print(f"  uložené ({len(audio) / RATE:.0f} s, špička {level:.0f} dBFS)\n")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    env = dotenv_values(HERE.parent / ".env")
    device = mic_device(env.get("MIC_DEVICE") or "")
    restart = stop_agent()
    try:
        print(f"Mikrofón: {sd.query_devices(device, 'input')['name']}")
        print("Pri každom bloku stlač Enter, potom hovor, keď sa ukáže ▶. s + Enter blok preskočí.\n")
        for name, kind, instruction, count, slot_s in BLOCKS:
            if (OUT / f"{name}.json").exists():
                print(f"[{name}] už nahraté, preskakujem")
                continue
            what = f"{count} s" if kind in ("talk", "room") else f"{count}×"
            if input(f"[{name}] {instruction} ({what})  Enter = začať: ").strip().lower() == "s":
                continue
            record_block(device, name, kind, count, slot_s)
        print("Hotovo. Ďalší krok: python features.py a python train.py")
    finally:
        if restart:
            subprocess.run(["schtasks", "/Run", "/TN", TASK], capture_output=True)
            print("Piťu znova beží.")


if __name__ == "__main__":
    main()
