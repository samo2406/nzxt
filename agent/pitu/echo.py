from __future__ import annotations

import logging
import threading
from collections import deque

import numpy as np

log = logging.getLogger(__name__)

APM_RATE = 16_000
APM_FRAME = 160
# 24 kHz → 16 kHz is up by 2, low-pass, down by 3. 48 taps at 48 kHz keep speech
# (< 7 kHz) intact, which is all the echo canceller needs to model the room.
_TAPS = 48
_FIR = np.sinc((np.arange(_TAPS) - (_TAPS - 1) / 2) * (2 * 7200 / 48_000)) * np.hamming(_TAPS)
_FIR = (_FIR / _FIR.sum() * 2).astype(np.float32)
# More than this much queued reference means the output stalled; drop the backlog.
MAX_BACKLOG = 50


class EchoCanceller:
    """WebRTC AEC3 between what Piťu plays and what the mic hears.

    The speakers' render callback hands over exactly what goes out; the mic
    callback runs each 80 ms block through the canceller in 10 ms steps,
    taking one reference frame per step, so both sides advance in real time
    and AEC3's own delay estimator only has to find the room's latency.
    """

    def __init__(self, delay_ms: int) -> None:
        from livekit import rtc

        self._rtc = rtc
        self._apm = rtc.AudioProcessingModule(echo_cancellation=True)
        self._delay_ms = delay_ms
        self._lock = threading.Lock()
        self._ref: deque[bytes] = deque()
        self._hist = np.zeros(_TAPS - 1, dtype=np.float32)
        self._phase = 0
        self._pending = np.zeros(0, dtype=np.int16)
        self._silence = bytes(APM_FRAME * 2)

    def reference(self, pcm24: bytes) -> None:
        """Called from the output callback with the 24 kHz audio being rendered."""
        x = np.frombuffer(pcm24, dtype=np.int16).astype(np.float32)
        if not len(x):
            return
        up = np.zeros(len(x) * 2, dtype=np.float32)
        up[::2] = x
        padded = np.concatenate([self._hist, up])
        self._hist = padded[-(_TAPS - 1):]
        filtered = np.convolve(padded, _FIR, mode="valid")
        down = filtered[self._phase::3]
        self._phase = (self._phase - len(filtered)) % 3
        samples = np.concatenate([self._pending, np.clip(down, -32768, 32767).astype(np.int16)])
        whole = len(samples) - len(samples) % APM_FRAME
        self._pending = samples[whole:]
        with self._lock:
            for i in range(0, whole, APM_FRAME):
                self._ref.append(samples[i:i + APM_FRAME].tobytes())
            while len(self._ref) > MAX_BACKLOG:
                self._ref.popleft()

    def process(self, frame: np.ndarray) -> np.ndarray:
        """Called from the mic callback; returns the frame with the echo removed."""
        out = np.empty_like(frame)
        rtc = self._rtc
        for i in range(0, len(frame), APM_FRAME):
            with self._lock:
                ref = self._ref.popleft() if self._ref else self._silence
            self._apm.process_reverse_stream(rtc.AudioFrame(ref, APM_RATE, 1, APM_FRAME))
            self._apm.set_stream_delay_ms(self._delay_ms)
            near = rtc.AudioFrame(frame[i:i + APM_FRAME].tobytes(), APM_RATE, 1, APM_FRAME)
            self._apm.process_stream(near)
            out[i:i + APM_FRAME] = np.frombuffer(bytes(near.data), dtype=np.int16)
        return out


def make_canceller(delay_ms: int) -> EchoCanceller | None:
    try:
        return EchoCanceller(delay_ms)
    except Exception as err:
        log.warning("echo cancellation unavailable, Piťu can't be interrupted by voice: %s", err)
        return None
