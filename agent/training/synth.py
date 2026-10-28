"""Generates the synthetic dataset with Azure TTS: "Hej Piťu" from every voice
that can speak Slovak, plus near-miss phrases and ordinary sentences as
negatives. Resumable; clips land in work/clips/<kind>/<voice>/."""
from __future__ import annotations

import random
import sys
import time
import wave
from pathlib import Path

import azure.cognitiveservices.speech as speechsdk
import numpy as np
from dotenv import dotenv_values

HERE = Path(__file__).resolve().parent
CLIPS = HERE / "work" / "clips"
RAW = HERE / "work" / "raw"
RATE = 16000
# F0 allows 20 synthesis requests per 60 s.
REQUEST_GAP_S = 3.2

NATIVE = ["sk-SK-LukasNeural", "sk-SK-ViktoriaNeural", "cs-CZ-AntoninNeural", "cs-CZ-VlastaNeural"]

POSITIVE = ["Hej Piťu.", "Hej, Piťu!", "Hej Piťu?", "Hej, Piťu."]

NEAR_MISS = [
    "Hej Peťo.", "Hej Paťo!", "Hej Piko.", "Hej Miťu!", "Hej Viťo.", "Hej Pišta!", "Hej ty!", "Pi tu.",
    "Hej, pivo!", "Hej, piť!", "Hej, počuj.", "Hej Pipo!", "Ahoj Peťo.", "Hej, Ťuťu!", "Hej!",
]

SENTENCES = [
    "Dnes je pekné počasie, pôjdeme von?", "Pusti mi nejakú hudbu, prosím.", "Daj hlasitosť na tridsať percent.",
    "Koľko je hodín?", "Nastav minútku na desať minút.", "Peťo, poď sem na chvíľu.", "Hej, kde máš tú pizzu?",
    "Pitie vody je dôležité aj v zime.", "Toto je úplne zbytočná debata.", "Ty si ale poriadny lenivec.",
    "Zajtra ráno idem do práce skôr.", "Mama volala, že príde neskôr.", "Otvor mi prehliadač.",
    "Čo hrá teraz v rádiu?", "Piť kávu večer nie je dobrý nápad.", "Petra, počuješ ma?", "Hej, počkaj na mňa!",
    "Pipeta je v laboratóriu na stole.", "Tichšie, prosím ťa, dieťa spí.", "Hráme ešte jednu hru a končíme.",
    "Tento level je fakt ťažký.", "Kúpil som si novú klávesnicu.", "Kde je ovládač od televízora?",
    "Pitva ukázala zaujímavé výsledky.", "Ďakujem, to stačí.", "Vypni to, už ma to nebaví.", "Hej, ty, poď sem!",
    "Piatok je najlepší deň v týždni.", "Čítal som knihu o vesmíre.", "Pozri sa na tú obrazovku.",
    "Spravíme si večer pizzu?", "Zavri okno, je tu zima.", "Hej Peťo, ideš na pivo?", "Ten film bol celkom dobrý.",
    "Treba nakúpiť mlieko a chlieb.", "Kto vyhral včerajší zápas?", "Počítač sa zase reštartoval.",
    "Daj mi pokoj, pracujem.", "Aké bude zajtra počasie?", "Ide to, ale pomaly.",
]


def voices(env: dict) -> list[str]:
    import json
    import urllib.request

    req = urllib.request.Request(
        f"https://{env['AZURE_SPEECH_REGION']}.tts.speech.microsoft.com/cognitiveservices/voices/list",
        headers={"Ocp-Apim-Subscription-Key": env["AZURE_SPEECH_KEY"]},
    )
    found = [
        v["ShortName"]
        for v in json.load(urllib.request.urlopen(req))
        if "sk-SK" in (v.get("SecondaryLocaleList") or [])
    ]
    return NATIVE + sorted(found)


def ssml(voice: str, groups: list[tuple[str | None, str | None, list[str]]], gap_ms: int) -> str:
    parts = []
    for rate, pitch, texts in groups:
        body = "".join(f'{t}<break time="{gap_ms}ms"/>' for t in texts)
        if rate or pitch:
            attrs = (f' rate="{rate}"' if rate else "") + (f' pitch="{pitch}"' if pitch else "")
            body = f"<prosody{attrs}>{body}</prosody>"
        parts.append(body)
    body = "".join(parts)
    if voice not in NATIVE:
        body = f'<lang xml:lang="sk-SK">{body}</lang>'
    return (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="sk-SK">'
        f'<voice name="{voice}">{body}</voice></speak>'
    )


def split(audio: np.ndarray, min_gap_s: float) -> list[np.ndarray]:
    frame = RATE // 100
    n = len(audio) // frame
    rms = np.sqrt(np.mean(audio[: n * frame].reshape(n, frame).astype(np.float64) ** 2, axis=1))
    voiced = rms > rms.max() * 0.02
    segments, start, silent = [], None, 0
    for i, v in enumerate(voiced):
        if v:
            if start is None:
                start = i
            silent = 0
        elif start is not None:
            silent += 1
            if silent * 0.01 >= min_gap_s:
                segments.append((start, i - silent + 1))
                start, silent = None, 0
    if start is not None:
        segments.append((start, n))
    pad = 5
    return [
        audio[max(0, (a - pad) * frame) : min(len(audio), (b + pad) * frame)]
        for a, b in segments
        if (b - a) * 0.01 >= 0.15
    ]


def save(path: Path, audio: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(audio.astype(np.int16).tobytes())


def load_raw(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


class Synth:
    def __init__(self, env: dict) -> None:
        cfg = speechsdk.SpeechConfig(subscription=env["AZURE_SPEECH_KEY"], region=env["AZURE_SPEECH_REGION"])
        cfg.set_speech_synthesis_output_format(speechsdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm)
        self._synth = speechsdk.SpeechSynthesizer(speech_config=cfg, audio_config=None)
        self._last = 0.0
        self.chars = 0

    def __call__(self, text: str) -> np.ndarray | None:
        for attempt in range(4):
            wait = self._last + REQUEST_GAP_S - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            result = self._synth.speak_ssml_async(text).get()
            if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
                self.chars += len(text)
                return np.frombuffer(result.audio_data, dtype=np.int16)
            details = result.cancellation_details
            print(f"  synthesis failed ({details.error_details[:120]}), retry {attempt + 1}", flush=True)
            time.sleep(20 * (attempt + 1))
        return None


def run_kind(synth: Synth, kind: str, voice: str, requests: list[tuple[str, int, float]]) -> None:
    folder = CLIPS / kind / voice
    if (folder / ".done").exists():
        return
    count = 0
    for n, (ssml_text, expected, min_gap) in enumerate(requests):
        raw = RAW / kind / f"{voice}_{n}.wav"
        audio = load_raw(raw) if raw.exists() else synth(ssml_text)
        if audio is None:
            print(f"  {kind}/{voice}: request dropped", flush=True)
            continue
        if not raw.exists():
            save(raw, audio)
        clips = split(audio, min_gap)
        for wider in (0.55, 0.65):
            if expected and len(clips) != expected:
                clips = split(audio, wider)
        if expected and len(clips) != expected:
            print(f"  {kind}/{voice}: got {len(clips)} clips, expected {expected}; skipped", flush=True)
            continue
        for clip in clips:
            save(folder / f"{count:03d}.wav", clip)
            count += 1
    folder.mkdir(parents=True, exist_ok=True)
    (folder / ".done").write_text(str(count))
    print(f"{kind}/{voice}: {count} clips  ({synth.chars} chars so far)", flush=True)


def main() -> None:
    env = dotenv_values(HERE.parent / ".env")
    all_voices = voices(env)
    synth = Synth(env)
    rng = random.Random(7)
    print(f"{len(all_voices)} voices", flush=True)

    for voice in all_voices:
        requests = []
        for _ in range(2):
            groups = [
                (f"{rng.randint(-20, 22):+d}%", f"{rng.randint(-10, 8):+d}%", rng.sample(POSITIVE, len(POSITIVE)))
                for _ in range(3)
            ]
            requests.append((ssml(voice, groups, 800), 12, 0.45))
        run_kind(synth, "positive", voice, requests)

    near_voices = NATIVE + rng.sample(all_voices[len(NATIVE) :], 26)
    for voice in near_voices:
        groups = [(f"{rng.randint(-15, 15):+d}%", None, rng.sample(NEAR_MISS, len(NEAR_MISS)))]
        run_kind(synth, "near_miss", voice, [(ssml(voice, groups, 800), 0, 0.45)])

    sentence_voices = NATIVE + rng.sample(all_voices[len(NATIVE) :], 6)
    for voice in sentence_voices:
        half = len(SENTENCES) // 2
        requests = [(ssml(voice, [(None, None, SENTENCES[:half])], 600), 0, 0.5),
                    (ssml(voice, [(None, None, SENTENCES[half:])], 600), 0, 0.5)]
        run_kind(synth, "speech", voice, requests)

    print(f"done, {synth.chars} characters billed this run", flush=True)


if __name__ == "__main__":
    sys.exit(main())
