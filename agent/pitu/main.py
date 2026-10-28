from __future__ import annotations

import argparse
import asyncio
import base64
import ctypes
import logging
import sys
import time
from dataclasses import dataclass, field
from logging.handlers import RotatingFileHandler

from .audio import EARCON_ALARM, EARCON_ERROR, EARCON_WAKE, Mic, Playback, Speakers, envelope
from .brain import Brain, BrainBusy, BrainConfigError, BrainError, BrainOffline, BrainSlow, FakeBrain
from .commands import Registry
from .commands.apps import apps
from .commands.timers import TIMERS, Timer
from .config import DATA_DIR, Config, load_config
from .ducking import DUCKER
from .events import Events
from .face_server import FaceServer
from .phrases import PhraseCache
from .stt import SpeechToText, SttError
from .tts import TextToSpeech, TtsError, Utterance

log = logging.getLogger("pitu")

# Speaker reverb and the room tail must die down before the mic is trusted again.
ECHO_TAIL_S = 0.3
# The STT stream starts this many frames before the follow-up onset VAD reported.
FOLLOW_UP_PREROLL = 4
STT_PHRASES = ["Piťu", "Spotify", "hlasitosť", "stlm", "minútka", "minútku", "časovač"]
ALARM_REPEATS = 2
# Long waits are cut into steps so a sleep/hibernate doesn't push a timer back.
TIMER_POLL_S = 30.0


@dataclass
class Timings:
    speech_end: float | None = None
    final: float | None = None
    marks: dict[str, float] = field(default_factory=dict)
    audio: float | None = None

    def report(self) -> str:
        def span(a: float | None, b: float | None) -> str:
            return f"{b - a:.2f}s" if a is not None and b is not None else "-"

        first_text = self.marks.get("first_text")
        return (
            f"latency: end-of-speech→transcript {span(self.speech_end, self.final)}, "
            f"transcript→first-token {span(self.final, first_text)}, "
            f"first-token→audio {span(first_text, self.audio)}, "
            f"TOTAL end-of-speech→audio {span(self.speech_end, self.audio)}"
        )


class TurnSpeaker:
    """Bridges one streamed reply to TTS, the speakers and the face's mouth."""

    def __init__(self, app: Assistant, timings: Timings) -> None:
        self._app = app
        self._timings = timings
        self._utt: Utterance | None = None
        self._playback: Playback | None = None
        self._text: list[str] = []
        self._env_carry = b""
        self._env_frames = 0
        self._heard_audio = False

    def mark(self, name: str) -> None:
        self._timings.marks.setdefault(name, time.monotonic())

    def speak(self, text: str) -> None:
        if not text:
            return
        self._text.append(text)
        if self._app.print_only:
            print(text, end="", flush=True)
            return
        if self._utt is None:
            self._playback = self._app.speakers.open()
            self._playback.on_start = self._on_playback_start
            self._utt = self._app.tts.begin(self._on_audio)
        self._utt.write(text)

    def _on_playback_start(self, wall: float) -> None:
        self._timings.audio = time.monotonic()
        self._app.events.set_state("speaking", at=int(wall * 1000))

    def _on_audio(self, pcm: bytes) -> None:
        if not pcm or self._playback is None:
            return
        self._heard_audio = True
        self._playback.feed(pcm)
        data = self._env_carry + pcm
        usable = len(data) - len(data) % 960
        self._env_carry = data[usable:]
        env = envelope(data[:usable])
        if env:
            self._app.events.emit(
                {"type": "mouth", "offset": self._env_frames, "env": base64.b64encode(env).decode()}
            )
            self._env_frames += len(env)

    async def finish(self) -> None:
        if self._app.print_only:
            if self._text:
                print()
            return
        if self._utt is None or self._playback is None:
            return
        self._utt.close()
        try:
            await self._utt.wait()
        except TtsError:
            if self._heard_audio:
                raise
            # Text streaming isn't available for every voice/region; retry this
            # reply clause by clause and stay on that path from now on.
            self._app.tts.fall_back_to_chunks()
            self._utt = self._app.tts.begin(self._on_audio)
            self._utt.write("".join(self._text))
            self._utt.close()
            await self._utt.wait()
        self._playback.finish()
        await asyncio.to_thread(self._playback.wait, 120)

    def abort(self) -> None:
        if self._utt is not None:
            try:
                self._utt.close()
            except Exception:
                pass
        if self._playback is not None:
            self._playback.stop()


class Assistant:
    def __init__(self, cfg: Config, args: argparse.Namespace) -> None:
        self.cfg = cfg
        self.args = args
        self.print_only = args.no_tts
        self.events = Events()
        self.speakers = Speakers(cfg.speaker_device)
        self.tts = TextToSpeech(cfg)
        self.stt = SpeechToText(cfg, STT_PHRASES + list(apps()))
        self.registry = Registry()
        self.brain: Brain | FakeBrain = FakeBrain() if args.fake_brain else Brain(cfg, self.registry)
        self.phrases = PhraseCache(cfg, self.tts)
        self.mic: Mic | None = None
        self.listener = None
        self.face: FaceServer | None = None
        self._wake_q: asyncio.Queue[int] = asyncio.Queue()
        self._speech_q: asyncio.Queue[int] = asyncio.Queue()
        # A conversation and a ringing timer never share the speakers.
        self._turn_lock = asyncio.Lock()
        DUCKER.level = cfg.duck_level

        sim = args.simulate
        if sim in ("offline", "claude-slow") and isinstance(self.brain, Brain):
            self.brain.simulate = sim
        if sim == "offline":
            self.tts.simulate_failure = True
            self.stt.simulate_failure = True
        if sim == "stt-fail":
            self.stt.simulate_failure = True

    async def _play(self, pcm: bytes, state: str | None = None) -> None:
        if self.print_only:
            return
        playback = self.speakers.open()
        if state:
            playback.on_start = lambda wall: self.events.set_state(state, at=int(wall * 1000))
            env = envelope(pcm[: len(pcm) - len(pcm) % 960])
            self.events.emit({"type": "mouth", "offset": 0, "env": base64.b64encode(env).decode()})
        playback.feed(pcm)
        playback.finish()
        await asyncio.to_thread(playback.wait, 30)

    async def say_phrase(self, key: str) -> None:
        offline = key in ("offline", "no_keys")
        self.events.set_state("offline" if offline else "error", reason=key)
        pcm = self.phrases.get(key)
        if self.print_only:
            print(f"[{key}]")
            return
        await self._play(pcm or EARCON_ERROR, state=None)
        await asyncio.sleep(1.2)

    async def reply(self, text: str, timings: Timings) -> bool:
        if not isinstance(self.brain, FakeBrain) and not self.cfg.has_anthropic:
            log.error("ANTHROPIC_API_KEY missing in agent/.env")
            await self.say_phrase("no_keys")
            return False
        if not self.print_only and not self.cfg.has_azure:
            log.error("AZURE_SPEECH_KEY / AZURE_SPEECH_REGION missing in agent/.env (use --no-tts to test without)")
            await self.say_phrase("no_keys")
            return False
        speaker = TurnSpeaker(self, timings)
        try:
            await self.brain.respond(text, speaker)
            await speaker.finish()
        except BrainError as err:
            speaker.abort()
            key = {BrainOffline: "offline", BrainBusy: "busy", BrainSlow: "slow"}.get(type(err), "broken")
            log.warning("brain failed (%s): %s", type(err).__name__, err)
            if isinstance(err, BrainConfigError):
                log.error("check ANTHROPIC_API_KEY / CLAUDE_MODEL in agent/.env")
            await self.say_phrase(key)
            return False
        except TtsError as err:
            speaker.abort()
            log.warning("tts failed: %s", err)
            self.tts.reset()
            await self.say_phrase("offline")
            return False
        log.info(timings.report())
        return True

    # ------------------------------------------------------------------ voice

    async def run_voice(self) -> None:
        from .listener import Listener

        loop = asyncio.get_running_loop()
        self.mic = Mic(self.cfg.mic_device)
        self.mic.on_error_change = lambda e: loop.call_soon_threadsafe(self.events.emit, {"type": "status", "mic": e})
        self.listener = Listener(self.mic, self.cfg.wake_model, self.cfg.wake_threshold)
        self.listener.on_wake = lambda i, _s: loop.call_soon_threadsafe(self._wake_q.put_nowait, i)
        self.listener.on_speech = lambda i: loop.call_soon_threadsafe(self._speech_q.put_nowait, i)
        if self.args.wake_test:
            self.listener.on_score = lambda s: print(f"\rscore {s:0.3f} " + "#" * int(s * 40), end="  ", flush=True)
        self.mic.start()
        self.listener.start()
        self.listener.set_mode("wake")
        self.phrases.fill_in_background()
        log.info("listening for the wake word")

        while True:
            index = await self._wake_q.get()
            async with self._turn_lock:
                duck = asyncio.ensure_future(asyncio.to_thread(DUCKER.duck))
                try:
                    await self._conversation(index)
                except Exception:
                    log.exception("turn failed")
                    await self.say_phrase("broken")
                finally:
                    self.events.set_state("sleeping")
                    await self._unduck(duck)
                    self.listener.set_mode("wake")

    async def _unduck(self, duck: asyncio.Future[None]) -> None:
        try:
            await duck
        except Exception:
            log.exception("ducking failed")
        try:
            await asyncio.to_thread(DUCKER.restore)
        except Exception:
            log.exception("restoring volumes failed")

    async def _conversation(self, start: int) -> None:
        assert self.mic is not None and self.listener is not None
        self.events.set_state("listening")
        asyncio.ensure_future(self._play(EARCON_WAKE))
        if not self.cfg.has_azure:
            log.error("AZURE_SPEECH_KEY / AZURE_SPEECH_REGION missing in agent/.env")
            await self.say_phrase("no_keys")
            return
        asyncio.ensure_future(self.brain.prewarm())
        asyncio.ensure_future(asyncio.to_thread(self.tts.prewarm))

        follow_up = False
        while True:
            timings = Timings()
            try:
                heard = await self.stt.listen(
                    self.mic,
                    start,
                    initial_silence_ms=2500 if follow_up else 5000,
                    on_partial=lambda t: log.debug("partial: %s", t),
                )
            except SttError as err:
                log.warning("stt failed: %s", err)
                await self.say_phrase("offline")
                return
            if heard is None:
                log.info("nothing heard")
                return
            timings.final = time.monotonic()
            timings.speech_end = heard.speech_end
            log.info("heard: %s", heard.text)
            self.events.set_state("thinking")
            if not await self.reply(heard.text, timings):
                return

            await asyncio.sleep(ECHO_TAIL_S)
            while not self._speech_q.empty():
                self._speech_q.get_nowait()
            self.events.set_state("listening", followUp=True)
            self.listener.set_mode("speech")
            try:
                onset = await asyncio.wait_for(self._speech_q.get(), self.cfg.follow_up_s)
            except TimeoutError:
                return
            finally:
                self.listener.set_mode("off")
            start = max(onset - FOLLOW_UP_PREROLL, 0)
            follow_up = True

    # ----------------------------------------------------------------- timers

    async def run_timers(self) -> None:
        loop = asyncio.get_running_loop()
        changed = asyncio.Event()
        TIMERS.on_change = lambda: loop.call_soon_threadsafe(changed.set)
        while True:
            changed.clear()
            due = TIMERS.next_due()
            if due is None:
                await changed.wait()
                continue
            delay = due - time.time()
            if delay > 0:
                try:
                    await asyncio.wait_for(changed.wait(), min(delay, TIMER_POLL_S))
                except TimeoutError:
                    pass
                continue
            for timer in TIMERS.pop_due():
                try:
                    await self.ring(timer)
                except Exception:
                    log.exception("timer ring failed")

    async def ring(self, timer: Timer) -> None:
        log.info("timer rings: %s", timer.label or "-")
        async with self._turn_lock:
            if self.listener is not None:
                self.listener.set_mode("off")
            duck = asyncio.ensure_future(asyncio.to_thread(DUCKER.duck))
            try:
                self.events.set_state("alarm")
                if self.print_only:
                    print(f"[minútka] {timer.label}")
                speech = asyncio.ensure_future(self._timer_speech(timer))
                for _ in range(ALARM_REPEATS):
                    await self._play(EARCON_ALARM)
                    await asyncio.sleep(0.25)
                pcm = await speech
                if pcm:
                    await self._play(pcm, state="speaking")
                await asyncio.sleep(ECHO_TAIL_S)
            finally:
                self.events.set_state("sleeping")
                await self._unduck(duck)
                if self.listener is not None:
                    self.listener.set_mode("wake")

    async def _timer_speech(self, timer: Timer) -> bytes | None:
        if timer.label and self.cfg.has_azure and not self.print_only:
            try:
                return await asyncio.wait_for(
                    asyncio.to_thread(self.tts.synthesize, f"Čas vypršal: {timer.label}."), 4.0
                )
            except Exception as err:
                log.info("timer speech unavailable, using the cached phrase: %s", err)
        return self.phrases.get("timer")

    # ------------------------------------------------------------------- text

    async def run_text(self) -> None:
        self.phrases.fill_in_background()
        print("Piťu (textový režim). Píš správy, prázdny riadok nič, Ctrl+C koniec.")
        while True:
            print("> ", end="", flush=True)
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                return
            text = line.strip()
            if not text:
                continue
            async with self._turn_lock:
                self.events.set_state("listening")
                await asyncio.sleep(0.15)
                self.events.set_state("thinking")
                timings = Timings(final=time.monotonic())
                await self.reply(text, timings)
                self.events.set_state("sleeping")


def _setup_logging(verbose: bool) -> None:
    logs = DATA_DIR / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [RotatingFileHandler(logs / "pitu.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")]
    if sys.stderr is not None:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
    )
    for noisy in ("httpx", "httpcore", "anthropic", "websockets"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _single_instance() -> bool:
    if sys.platform != "win32":
        return True
    ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\pitu-agent")
    return ctypes.windll.kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS


def _lower_priority() -> None:
    if sys.platform == "win32":
        BELOW_NORMAL_PRIORITY_CLASS = 0x4000
        # The pseudo-handle must go through as a pointer; a bare -1 is truncated to 32 bits.
        if not ctypes.windll.kernel32.SetPriorityClass(ctypes.c_void_p(-1), BELOW_NORMAL_PRIORITY_CLASS):
            log.warning("could not lower process priority")


def _list_devices() -> None:
    import sounddevice as sd

    for i, dev in enumerate(sd.query_devices()):
        api = sd.query_hostapis(dev["hostapi"])["name"]
        if "WASAPI" in api:
            io = ("in " if dev["max_input_channels"] else "") + ("out" if dev["max_output_channels"] else "")
            print(f"{i:3d}  {io:6s}  {dev['name']}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="pitu", description="Piťu — hlasový asistent")
    p.add_argument("--text", action="store_true", help="type instead of the mic and wake word")
    p.add_argument("--no-tts", action="store_true", help="print replies instead of speaking them")
    p.add_argument("--fake-brain", action="store_true", help="canned replies, no Claude API calls")
    p.add_argument("--simulate", choices=["offline", "stt-fail", "claude-slow"], help="exercise a failure path")
    p.add_argument("--wake-test", action="store_true", help="print live wake-word scores")
    p.add_argument("--list-devices", action="store_true", help="list WASAPI audio devices and exit")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


async def _amain(args: argparse.Namespace) -> None:
    cfg = load_config()
    app = Assistant(cfg, args)
    log.info(
        "starting: model=%s effort=%s voice=%s wake=%s",
        cfg.claude_model, cfg.claude_effort, cfg.tts_voice, cfg.wake_model,
    )
    app.face = FaceServer(app.events, cfg.face_port, cfg.allowed_origins)
    try:
        await app.face.start()
    except OSError as err:
        log.error("face server could not bind port %d: %s", cfg.face_port, err)
    try:
        await asyncio.to_thread(DUCKER.recover)
    except Exception:
        log.exception("could not restore volumes from the last run")
    timers = asyncio.ensure_future(app.run_timers())
    try:
        if args.text:
            await app.run_text()
        else:
            await app.run_voice()
    finally:
        timers.cancel()


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if args.list_devices:
        _list_devices()
        return
    _setup_logging(args.verbose)
    if not _single_instance():
        log.info("another instance is already running")
        return
    _lower_priority()
    try:
        asyncio.run(_amain(args))
    except KeyboardInterrupt:
        pass
