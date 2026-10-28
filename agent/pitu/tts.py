from __future__ import annotations

import asyncio
import logging
import queue
import re
import threading
from typing import Callable

import azure.cognitiveservices.speech as speechsdk

from .config import Config

log = logging.getLogger(__name__)

_CLAUSE_END = re.compile(r"[.!?…:;](?:\s|$)|,\s")


class TtsError(Exception):
    pass


def _speech_config(cfg: Config, streaming: bool) -> speechsdk.SpeechConfig:
    if streaming:
        endpoint = f"wss://{cfg.azure_region}.tts.speech.microsoft.com/cognitiveservices/websocket/v2"
        sc = speechsdk.SpeechConfig(endpoint=endpoint, subscription=cfg.azure_key)
    else:
        sc = speechsdk.SpeechConfig(subscription=cfg.azure_key, region=cfg.azure_region)
    sc.speech_synthesis_voice_name = cfg.tts_voice
    sc.set_speech_synthesis_output_format(speechsdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm)
    return sc


def _ssml(voice: str, rate: float, text: str) -> str:
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="sk-SK">'
        f'<voice name="{voice}"><prosody rate="{rate:.2f}">{escaped}</prosody></voice></speak>'
    )


def _cancel_message(result: speechsdk.SpeechSynthesisResult) -> str:
    details = speechsdk.SpeechSynthesisCancellationDetails(result)
    return f"{details.reason}: {details.error_details}"


class Utterance:
    """One spoken reply. Text is written in as Claude streams it; audio comes
    out through `on_audio` as Azure synthesises it."""

    def write(self, text: str) -> None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError

    async def wait(self) -> None:
        raise NotImplementedError


class _StreamingUtterance(Utterance):
    """Azure's text-stream input: one request per reply, tokens go straight in,
    so synthesis starts on the first word rather than the first sentence."""

    def __init__(self, synth: speechsdk.SpeechSynthesizer, rate: float) -> None:
        self._request = speechsdk.SpeechSynthesisRequest(
            input_type=speechsdk.SpeechSynthesisRequestInputType.TextStream
        )
        if rate != 1.0:
            self._request.rate = rate
        self._future = synth.speak_async(self._request)
        self._closed = False

    def write(self, text: str) -> None:
        if text and not self._closed:
            self._request.input_stream.write(text)

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._request.input_stream.close()

    async def wait(self) -> None:
        result = await asyncio.to_thread(self._future.get)
        if result.reason == speechsdk.ResultReason.Canceled:
            raise TtsError(_cancel_message(result))


class _ChunkedUtterance(Utterance):
    """Fallback: speak the first clause as soon as it ends, then the rest in
    one request — two requests per reply keeps F0's 20/minute limit at bay."""

    def __init__(self, synth: speechsdk.SpeechSynthesizer, voice: str, rate: float) -> None:
        self._synth = synth
        self._voice = voice
        self._rate = rate
        self._pending = ""
        self._first_sent = False
        self._jobs: queue.Queue[str | None] = queue.Queue()
        self._error: str | None = None
        self._done = threading.Event()
        threading.Thread(target=self._worker, name="tts-chunks", daemon=True).start()

    def write(self, text: str) -> None:
        self._pending += text
        if not self._first_sent:
            match = _CLAUSE_END.search(self._pending)
            if match and match.end() >= 12:
                self._jobs.put(self._pending[: match.end()])
                self._pending = self._pending[match.end():]
                self._first_sent = True

    def close(self) -> None:
        if self._pending.strip():
            self._jobs.put(self._pending)
        self._pending = ""
        self._jobs.put(None)

    def _worker(self) -> None:
        while True:
            text = self._jobs.get()
            if text is None:
                break
            if self._error:
                continue
            result = self._synth.speak_ssml_async(_ssml(self._voice, self._rate, text.strip())).get()
            if result.reason == speechsdk.ResultReason.Canceled:
                self._error = _cancel_message(result)
        self._done.set()

    async def wait(self) -> None:
        await asyncio.to_thread(self._done.wait)
        if self._error:
            raise TtsError(self._error)


class TextToSpeech:
    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self._streaming = True
        self._synth: speechsdk.SpeechSynthesizer | None = None
        self._on_audio: Callable[[bytes], None] = lambda _b: None
        self.simulate_failure = False

    def _synthesizer(self) -> speechsdk.SpeechSynthesizer:
        if self._synth is None:
            synth = speechsdk.SpeechSynthesizer(
                speech_config=_speech_config(self._cfg, self._streaming), audio_config=None
            )
            synth.synthesizing.connect(lambda e: self._on_audio(e.result.audio_data))
            self._synth = synth
        return self._synth

    def prewarm(self) -> None:
        """Open the websocket while the user is still talking."""
        try:
            speechsdk.Connection.from_speech_synthesizer(self._synthesizer()).open(True)
        except Exception as err:
            log.debug("tts prewarm failed: %s", err)

    def begin(self, on_audio: Callable[[bytes], None]) -> Utterance:
        if self.simulate_failure:
            raise TtsError("simulated failure")
        self._on_audio = on_audio
        synth = self._synthesizer()
        if self._streaming:
            return _StreamingUtterance(synth, self._cfg.tts_rate)
        return _ChunkedUtterance(synth, self._cfg.tts_voice, self._cfg.tts_rate)

    def fall_back_to_chunks(self) -> None:
        if self._streaming:
            log.warning("text-stream TTS failed, switching to per-clause synthesis")
            self._streaming = False
            self._synth = None

    def reset(self) -> None:
        self._synth = None

    def synthesize(self, text: str) -> bytes:
        """Whole phrase in one call; used to build the offline cache."""
        sc = _speech_config(self._cfg, streaming=False)
        synth = speechsdk.SpeechSynthesizer(speech_config=sc, audio_config=None)
        result = synth.speak_ssml_async(_ssml(self._cfg.tts_voice, self._cfg.tts_rate, text)).get()
        if result.reason == speechsdk.ResultReason.Canceled:
            raise TtsError(_cancel_message(result))
        return bytes(result.audio_data)
