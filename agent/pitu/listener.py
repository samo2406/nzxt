from __future__ import annotations

import logging
import queue
import threading
import time
from pathlib import Path
from typing import Callable

import numpy as np
from openwakeword.model import Model
from openwakeword.vad import VAD

from .audio import FRAME_S, Mic

log = logging.getLogger(__name__)

# Consecutive voiced frames before the follow-up window counts it as speech;
# a cough or a keyboard clack is one or two.
VAD_ONSET_FRAMES = 3
VAD_THRESHOLD = 0.6
# Talking over Piťu has to be clearly someone speaking: longer, surer and louder
# than what the echo canceller might leave of Piťu's own voice.
BARGE_FRAMES = 4
BARGE_MIN_DBFS = -45.0


class Listener:
    """Runs the local detectors on the mic stream in its own thread.

    Modes: "wake" looks for the wake phrase, "speech" looks for any voice
    (follow-up window), "barge" looks for either while the assistant talks
    over an echo-cancelled mic, "off" ignores the mic — the half-duplex guard
    when there is no echo cancellation.
    """

    def __init__(self, mic: Mic, wake_model: str, threshold: float, barge_vad: float = 0.8) -> None:
        self._mic = mic
        model_ref = str(Path(wake_model)) if wake_model.endswith(".onnx") else wake_model
        self._wake = Model(wakeword_models=[model_ref], inference_framework="onnx")
        self._wake_name = next(iter(self._wake.models))
        self._vad = VAD()
        self._threshold = threshold
        self._barge_vad = barge_vad
        self._barge_from = 0.0
        self._queue: queue.Queue[tuple[int, np.ndarray]] = queue.Queue(maxsize=200)
        self._mode = "off"
        self._mode_lock = threading.Lock()
        self._voiced = 0
        self.on_wake: Callable[[int, float], None] = lambda _i, _s: None
        self.on_speech: Callable[[int], None] = lambda _i: None
        self.on_barge: Callable[[int], None] = lambda _i: None
        self.on_score: Callable[[float], None] | None = None
        log.info("wake model: %s (threshold %.2f)", self._wake_name, threshold)

    @property
    def mode(self) -> str:
        return self._mode

    def start(self) -> None:
        self._mic.subscribe(self._enqueue)
        threading.Thread(target=self._run, name="listener", daemon=True).start()

    def set_mode(self, mode: str, holdoff: float = 0.0) -> None:
        """`holdoff` ignores the first seconds of a mode (the echo canceller converging)."""
        with self._mode_lock:
            if mode == self._mode:
                return
            self._mode = mode
            self._voiced = 0
            self._barge_from = time.monotonic() + holdoff
            if mode in ("wake", "barge"):
                # Stale features from our own voice must not complete a phrase.
                self._wake.reset()
            if mode in ("speech", "barge"):
                self._vad.reset_states()
            self._drain()

    def _drain(self) -> None:
        try:
            while True:
                self._queue.get_nowait()
        except queue.Empty:
            pass

    def _enqueue(self, index: int, frame: np.ndarray) -> None:
        try:
            self._queue.put_nowait((index, frame))
        except queue.Full:
            pass

    def _run(self) -> None:
        while True:
            index, frame = self._queue.get()
            with self._mode_lock:
                mode = self._mode
            try:
                if mode == "wake":
                    self._step_wake(index, frame)
                elif mode == "speech":
                    self._step_speech(index, frame)
                elif mode == "barge":
                    self._step_barge(index, frame)
            except Exception:
                log.exception("listener step failed")

    def _step_wake(self, index: int, frame: np.ndarray) -> None:
        score = float(self._wake.predict(frame)[self._wake_name])
        if self.on_score:
            self.on_score(score)
        if score >= self._threshold:
            log.info("wake word (score %.2f)", score)
            with self._mode_lock:
                self._mode = "off"
            self._wake.reset()
            self.on_wake(index, score)

    def _step_barge(self, index: int, frame: np.ndarray) -> None:
        score = float(self._wake.predict(frame)[self._wake_name])
        prob = float(self._vad.predict(frame, frame_size=640))
        if time.monotonic() < self._barge_from:
            return
        rms = float(np.sqrt(np.mean(frame.astype(np.float32) ** 2)))
        dbfs = 20 * np.log10(max(rms, 1.0) / 32768)
        loud = prob >= self._barge_vad and dbfs >= BARGE_MIN_DBFS
        self._voiced = self._voiced + 1 if loud else 0
        if prob >= 0.5:
            log.debug("barge vad %.2f at %.0f dBFS (%d)", prob, dbfs, self._voiced)
        if self._voiced >= BARGE_FRAMES or score >= self._threshold:
            with self._mode_lock:
                self._mode = "off"
            onset = index - (BARGE_FRAMES - 1 if self._voiced >= BARGE_FRAMES else 0)
            log.info("barge-in at frame %d (vad %.2f, %.0f dBFS, wake %.2f)", onset, prob, dbfs, score)
            self.on_barge(onset)

    def _step_speech(self, index: int, frame: np.ndarray) -> None:
        prob = float(self._vad.predict(frame, frame_size=640))
        self._voiced = self._voiced + 1 if prob >= VAD_THRESHOLD else 0
        if self._voiced >= VAD_ONSET_FRAMES:
            with self._mode_lock:
                self._mode = "off"
            onset = index - VAD_ONSET_FRAMES + 1
            log.info("follow-up speech at frame %d (%.1f s ago)", onset, VAD_ONSET_FRAMES * FRAME_S)
            self.on_speech(onset)
