from __future__ import annotations

import ctypes
import logging
import sys
import threading
import time
from collections import deque
from typing import Callable

import numpy as np
import sounddevice as sd

log = logging.getLogger(__name__)

MIC_RATE = 16_000
# openWakeWord's native hop; everything downstream counts in these frames.
FRAME = 1280
FRAME_S = FRAME / MIC_RATE
OUT_RATE = 24_000


def _wasapi_index() -> int | None:
    for i, api in enumerate(sd.query_hostapis()):
        if "WASAPI" in api["name"]:
            return i
    return None


def find_device(hint: str, kind: str) -> int | None:
    """WASAPI device whose name contains `hint`, else the WASAPI default.

    MME (PortAudio's default host on Windows) adds 100+ ms of buffering,
    which is a tenth of the whole latency budget.
    """
    api = _wasapi_index()
    channels_key = "max_input_channels" if kind == "input" else "max_output_channels"
    if api is None:
        return None
    if hint:
        for i, dev in enumerate(sd.query_devices()):
            if dev["hostapi"] == api and dev[channels_key] > 0 and hint.lower() in dev["name"].lower():
                return i
        log.warning("no %s device matching %r, using the default", kind, hint)
    default = sd.query_hostapis(api)["default_input_device" if kind == "input" else "default_output_device"]
    return default if default >= 0 else None


def ensure_com() -> None:
    # WASAPI streams opened on a thread without COM fail with a misleading
    # "Unanticipated host error ... WDM-KS"; CoInitializeEx is idempotent.
    if sys.platform == "win32":
        ctypes.windll.ole32.CoInitializeEx(None, 0)


def _wasapi_settings() -> sd.WasapiSettings | None:
    # auto_convert lets WASAPI shared mode resample to the device's mix rate.
    return sd.WasapiSettings(auto_convert=True) if _wasapi_index() is not None else None


class Mic:
    """Always-open capture into a ring buffer.

    The ring gives every consumer pre-roll: speech-to-text starts from the
    moment the wake word ended, not from when the cloud connection was ready.
    """

    def __init__(self, device_hint: str = "", ring_seconds: float = 6.0) -> None:
        self._hint = device_hint
        self._ring: deque[tuple[int, float, np.ndarray]] = deque(maxlen=int(ring_seconds / FRAME_S))
        self._lock = threading.Lock()
        self._consumers: list[Callable[[int, np.ndarray], None]] = []
        self._index = 0
        self._last_frame_at = 0.0
        self._stream: sd.InputStream | None = None
        self._stop = threading.Event()
        self.error: str | None = None
        self.on_error_change: Callable[[str | None], None] = lambda _e: None

    @property
    def index(self) -> int:
        return self._index

    def start(self) -> None:
        threading.Thread(target=self._supervise, name="mic", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        self._close()

    def subscribe(self, fn: Callable[[int, np.ndarray], None]) -> Callable[[], None]:
        with self._lock:
            self._consumers.append(fn)

        def unsubscribe() -> None:
            with self._lock:
                if fn in self._consumers:
                    self._consumers.remove(fn)

        return unsubscribe

    def frames_since(self, index: int) -> list[tuple[int, np.ndarray]]:
        with self._lock:
            return [(i, f) for i, _t, f in self._ring if i >= index]

    def time_of(self, index: int) -> float | None:
        """Monotonic capture time of a frame still in the ring."""
        with self._lock:
            for i, t, _f in self._ring:
                if i == index:
                    return t
        return None

    def _callback(self, indata, frames, _time, status) -> None:
        if status:
            log.debug("mic status: %s", status)
        frame = indata[:, 0].copy()
        now = time.monotonic()
        with self._lock:
            idx = self._index
            self._index += 1
            self._ring.append((idx, now, frame))
            self._last_frame_at = now
            consumers = list(self._consumers)
        for fn in consumers:
            try:
                fn(idx, frame)
            except Exception:
                log.exception("mic consumer failed")

    def _open(self) -> None:
        ensure_com()
        device = find_device(self._hint, "input")
        self._stream = sd.InputStream(
            samplerate=MIC_RATE,
            channels=1,
            dtype="int16",
            blocksize=FRAME,
            device=device,
            callback=self._callback,
            extra_settings=_wasapi_settings(),
        )
        self._stream.start()
        self._last_frame_at = time.monotonic()
        name = sd.query_devices(self._stream.device)["name"]
        log.info("mic open: %s", name)

    def _close(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.close()
            except Exception:
                pass

    def _set_error(self, error: str | None) -> None:
        if error != self.error:
            self.error = error
            self.on_error_change(error)

    def _supervise(self) -> None:
        # Unplugged devices don't always raise; a silent stream is the tell.
        failed = False
        while not self._stop.is_set():
            if self._stream is None:
                try:
                    if failed:
                        # PortAudio caches the device list; a replugged mic is invisible until re-init.
                        sd._terminate()
                        sd._initialize()
                    self._open()
                    failed = False
                    self._set_error(None)
                except Exception as err:
                    self._close()
                    failed = True
                    self._set_error(f"mikrofón nedostupný: {err}")
                    log.warning("mic unavailable, retrying in 5 s: %s", err)
                    self._stop.wait(5)
                    continue
            if time.monotonic() - self._last_frame_at > 3:
                log.warning("mic delivered nothing for 3 s, reopening")
                self._close()
                failed = True
                continue
            self._stop.wait(1)


class Playback:
    """One utterance on the speakers. The device is opened per utterance so an
    idle assistant holds no audio stream at all."""

    def __init__(self, device: int | None, volume: float = 1.0) -> None:
        self._device = device
        self._volume = volume
        self._buf = bytearray()
        self._lock = threading.Lock()
        self._finished = False
        self._drained = threading.Event()
        self._stream: sd.RawOutputStream | None = None
        self.started_at: float | None = None
        self.started_wall: float | None = None
        self.on_start: Callable[[float], None] = lambda _wall: None

    def feed(self, pcm: bytes) -> None:
        if not pcm:
            return
        if self._volume != 1.0:
            pcm = (np.frombuffer(pcm, dtype=np.int16) * self._volume).astype(np.int16).tobytes()
        with self._lock:
            self._buf.extend(pcm)
        if self._stream is None:
            self._open()

    def finish(self) -> None:
        with self._lock:
            self._finished = True
        if self._stream is None:
            self._drained.set()

    def stop(self) -> None:
        with self._lock:
            self._buf.clear()
            self._finished = True
        self._close()
        self._drained.set()

    def wait(self, timeout: float | None = None) -> bool:
        done = self._drained.wait(timeout)
        self._close()
        return done

    def _open(self) -> None:
        ensure_com()
        self._stream = sd.RawOutputStream(
            samplerate=OUT_RATE,
            channels=1,
            dtype="int16",
            device=self._device,
            latency="low",
            callback=self._callback,
            finished_callback=self._drained.set,
            extra_settings=_wasapi_settings(),
        )
        self._stream.start()

    def _close(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.close()
            except Exception:
                pass

    def _callback(self, outdata, frames, time_info, _status) -> None:
        need = frames * 2
        with self._lock:
            chunk = bytes(self._buf[:need])
            del self._buf[:need]
            finished = self._finished and not self._buf
        if chunk and self.started_at is None:
            latency = max(0.0, time_info.outputBufferDacTime - time_info.currentTime)
            self.started_at = time.monotonic() + latency
            self.started_wall = time.time() + latency
            try:
                self.on_start(self.started_wall)
            except Exception:
                log.exception("playback start hook failed")
        outdata[: len(chunk)] = chunk
        if len(chunk) < need:
            outdata[len(chunk):] = b"\x00" * (need - len(chunk))
        if finished:
            raise sd.CallbackStop


class Fanout:
    """One utterance on several outputs at once. The first one sets the
    timing the face's mouth follows."""

    def __init__(self, playbacks: list[Playback]) -> None:
        self._all = playbacks
        self._lead = playbacks[0]

    @property
    def on_start(self) -> Callable[[float], None]:
        return self._lead.on_start

    @on_start.setter
    def on_start(self, fn: Callable[[float], None]) -> None:
        self._lead.on_start = fn

    @property
    def started_at(self) -> float | None:
        return self._lead.started_at

    @property
    def started_wall(self) -> float | None:
        return self._lead.started_wall

    def feed(self, pcm: bytes) -> None:
        for pb in list(self._all):
            try:
                pb.feed(pcm)
            except Exception as err:
                # An unplugged USB output must not silence the others.
                if len(self._all) == 1:
                    raise
                log.warning("output dropped for this utterance: %s", err)
                self._all.remove(pb)
                if pb is self._lead:
                    self._all[0].on_start = pb.on_start
                    self._lead = self._all[0]

    def finish(self) -> None:
        for pb in self._all:
            pb.finish()

    def stop(self) -> None:
        for pb in self._all:
            pb.stop()

    def wait(self, timeout: float | None = None) -> bool:
        deadline = None if timeout is None else time.monotonic() + timeout
        done = True
        for pb in self._all:
            left = None if deadline is None else max(0.0, deadline - time.monotonic())
            done = pb.wait(left) and done
        return done


class Speakers:
    """`device_hint` may name several outputs, comma-separated; each utterance plays on all of them."""

    def __init__(self, device_hint: str = "", volume: float = 1.0) -> None:
        self._hints = [h.strip() for h in device_hint.split(",") if h.strip()] or [""]
        self.volume = volume

    def open(self) -> Playback | Fanout:
        devices = list(dict.fromkeys(find_device(h, "output") for h in self._hints))
        if len(devices) == 1:
            return Playback(devices[0], self.volume)
        return Fanout([Playback(d, self.volume) for d in devices])

    def play(self, pcm: bytes, on_start: Callable[[float], None] | None = None) -> Playback | Fanout:
        pb = self.open()
        if on_start:
            pb.on_start = on_start
        pb.feed(pcm)
        pb.finish()
        return pb


def tone(freqs: list[tuple[float, float]], gain: float = 0.25) -> bytes:
    """Concatenated sine blips with soft edges, as 24 kHz int16 PCM."""
    parts = []
    for freq, dur in freqs:
        n = int(OUT_RATE * dur)
        t = np.arange(n) / OUT_RATE
        env = np.minimum(1.0, np.minimum(t, dur - t) / 0.012)
        parts.append(np.sin(2 * np.pi * freq * t) * env * gain)
    return (np.concatenate(parts) * 32767).astype(np.int16).tobytes()


EARCON_WAKE = tone([(880, 0.07), (1318.5, 0.11)])
EARCON_ERROR = tone([(660, 0.12), (440, 0.18)], gain=0.2)
EARCON_ALARM = tone([(1046.5, 0.12), (0, 0.06), (1046.5, 0.12), (0, 0.06), (1318.5, 0.2)], gain=0.3)


def envelope(pcm: bytes, window: int = OUT_RATE // 50) -> bytes:
    """Speech loudness at 50 Hz as one byte per frame, for the face's mouth."""
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    n = len(samples) // window
    if n == 0:
        return b""
    rms = np.sqrt(np.mean(samples[: n * window].reshape(n, window) ** 2, axis=1))
    # Speech RMS sits around 1-6k; a soft knee keeps quiet syllables visible.
    level = np.clip(np.sqrt(rms / 5000.0), 0.0, 1.0)
    return (level * 255).astype(np.uint8).tobytes()
