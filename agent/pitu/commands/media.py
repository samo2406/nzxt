from __future__ import annotations

import asyncio
import ctypes
import os
from typing import Any, Literal

from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
)

from . import CommandError, command

SPOTIFY_START_S = 8.0
_MEDIA_KEYS = {"play": 0xB3, "pause": 0xB3, "next": 0xB0, "previous": 0xB1}


def _is_spotify(session: Any) -> bool:
    return "spotify" in session.source_app_user_model_id.lower()


def _playing(session: Any) -> bool:
    return session.get_playback_info().playback_status == Status.PLAYING


async def _pick(action: str) -> Any:
    manager = await SessionManager.request_async()
    found = list(manager.get_sessions())
    spotify = next((s for s in found if _is_spotify(s)), None)
    if action == "pause":
        # Pause whatever is actually making noise, Spotify first.
        playing = [s for s in found if _playing(s)]
        return next((s for s in playing if _is_spotify(s)), playing[0] if playing else None)
    return spotify or manager.get_current_session()


async def _launch_spotify() -> Any:
    os.startfile("spotify:")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + SPOTIFY_START_S
    while loop.time() < deadline:
        await asyncio.sleep(0.5)
        manager = await SessionManager.request_async()
        session = next((s for s in manager.get_sessions() if _is_spotify(s)), None)
        if session is not None:
            return session
    return None


async def _control(action: str) -> str:
    session = await _pick(action)
    if session is None:
        if action != "play":
            raise CommandError("Momentálne nič nehrá.")
        session = await _launch_spotify()
        if session is None:
            raise CommandError("Spotify sa mi nepodarilo spustiť.")
        # A freshly started Spotify ignores play until its player is ready.
        for _ in range(6):
            if await session.try_play_async():
                return "spotify started and playing"
            await asyncio.sleep(0.5)
        raise CommandError("Spotify som otvoril, ale hrať nechce.")

    method = {
        "play": session.try_play_async,
        "pause": session.try_pause_async,
        "next": session.try_skip_next_async,
        "previous": session.try_skip_previous_async,
    }[action]
    if await method():
        return f"{action} ok ({session.source_app_user_model_id})"
    _media_key(_MEDIA_KEYS[action])
    return f"{action} sent as a media key"


def _media_key(vk: int) -> None:
    extended, key_up = 0x1, 0x2
    ctypes.windll.user32.keybd_event(vk, 0, extended, 0)
    ctypes.windll.user32.keybd_event(vk, 0, extended | key_up, 0)


@command(
    "Ovláda prehrávanie hudby (Spotify, inak to, čo práve hrá): pustiť, pauza, ďalšia, predošlá skladba. "
    "Ak Spotify nebeží a má hrať, spustí ho. Konkrétnu skladbu ani interpreta vybrať nevie.",
    timeout=15.0,
)
def media(action: Literal["play", "pause", "next", "previous"]) -> str:
    return asyncio.run(_control(action))


async def _now_playing() -> dict[str, Any]:
    manager = await SessionManager.request_async()
    found = list(manager.get_sessions())
    if not found:
        return {"status": "nič nehrá"}
    session = next((s for s in found if _playing(s)), None) or next(
        (s for s in found if _is_spotify(s)), found[0]
    )
    props = await session.try_get_media_properties_async()
    app = "Spotify" if _is_spotify(session) else session.source_app_user_model_id.removesuffix(".exe")
    return {
        "app": app,
        "artist": props.artist,
        "title": props.title,
        "status": "hrá" if _playing(session) else "pozastavené",
    }


@command("Zistí, čo práve hrá (interpret, názov skladby, či hrá alebo je pozastavené).", speaks=False)
def now_playing() -> dict[str, Any]:
    return asyncio.run(_now_playing())
