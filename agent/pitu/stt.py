from __future__ import annotations

import asyncio
import logging
import queue
import re
import threading
import time
from dataclasses import dataclass
from typing import Callable

import azure.cognitiveservices.speech as speechsdk
import numpy as np

from .audio import FRAME_S, MIC_RATE, Mic
from .config import Config

log = logging.getLogger(__name__)

MAX_UTTERANCE_S = 15.0

_WAKE_PREFIX = re.compile(r"^\s*(?:(?:hej|hey|ahoj|haló)[\s,]+)?(?:pi[tťcč][uú]|jarvis)\b[\s,.!?]*", re.IGNORECASE)


class SttError(Exception):
    """The service could not be reached or rejected the request."""


@dataclass
class Heard:
    text: str
    speech_end: float | None
    """Monotonic time the speaker stopped talking, from Azure's word timings."""


def strip_wake_phrase(text: str) -> str:
    return _WAKE_PREFIX.sub("", text, count=1).strip()


class SpeechToText:
    def __init__(self, cfg: Config, phrases: list[str]) -> None:
        self._cfg = cfg
        self._phrases = phrases
        self.simulate_failure = False

    def _speech_config(self, initial_silence_ms: int) -> speechsdk.SpeechConfig:
        sc = speechsdk.SpeechConfig(subscription=self._cfg.azure_key, region=self._cfg.azure_region)
        sc.speech_recognition_language = "sk-SK"
        sc.set_property(speechsdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, str(initial_silence_ms))
        sc.set_property(speechsdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, str(self._cfg.end_silence_ms))
        sc.set_property(speechsdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, str(self._cfg.end_silence_ms))
        return sc

    async def listen(
        self,
        mic: Mic,
        start_index: int,
        initial_silence_ms: int = 5000,
        on_partial: Callable[[str], None] | None = None,
    ) -> Heard | None:
        if self.simulate_failure:
            raise SttError("simulated failure")
        return await asyncio.to_thread(self._listen_blocking, mic, start_index, initial_silence_ms, on_partial)

    def _listen_blocking(
        self,
        mic: Mic,
        start_index: int,
        initial_silence_ms: int,
        on_partial: Callable[[str], None] | None,
    ) -> Heard | None:
        live: queue.Queue[tuple[int, np.ndarray]] = queue.Queue()
        unsubscribe = mic.subscribe(lambda i, f: live.put((i, f)))
        stream_start = mic.time_of(start_index) or time.monotonic()

        fmt = speechsdk.audio.AudioStreamFormat(samples_per_second=MIC_RATE, bits_per_sample=16, channels=1)
        push = speechsdk.audio.PushAudioInputStream(stream_format=fmt)
        recognizer = speechsdk.SpeechRecognizer(
            speech_config=self._speech_config(initial_silence_ms),
            audio_config=speechsdk.audio.AudioConfig(stream=push),
        )
        if self._phrases:
            grammar = speechsdk.PhraseListGrammar.from_recognizer(recognizer)
            for phrase in self._phrases:
                grammar.addPhrase(phrase)

        done = threading.Event()
        recognizer.recognized.connect(lambda _e: done.set())
        recognizer.canceled.connect(lambda _e: done.set())
        recognizer.session_stopped.connect(lambda _e: done.set())
        if on_partial:
            recognizer.recognizing.connect(lambda e: on_partial(strip_wake_phrase(e.result.text)))

        try:
            speechsdk.Connection.from_recognizer(recognizer).open(True)
            future = recognizer.recognize_once_async()

            last = start_index - 1
            for i, frame in mic.frames_since(start_index):
                push.write(frame.tobytes())
                last = i
            deadline = time.monotonic() + MAX_UTTERANCE_S
            while not done.is_set() and time.monotonic() < deadline:
                try:
                    i, frame = live.get(timeout=FRAME_S * 2)
                except queue.Empty:
                    continue
                if i <= last:
                    continue
                push.write(frame.tobytes())
                last = i
            push.close()
            result = future.get()
        finally:
            unsubscribe()

        if result.reason == speechsdk.ResultReason.RecognizedSpeech:
            text = strip_wake_phrase(result.text)
            end = stream_start + (result.offset + result.duration) / 1e7
            return Heard(text, end) if text else None
        if result.reason == speechsdk.ResultReason.Canceled:
            details = result.cancellation_details
            if details.reason == speechsdk.CancellationReason.Error:
                raise SttError(f"{details.error_code}: {details.error_details}")
        return None
