from __future__ import annotations

import asyncio
import ctypes
import json
import os
import random
import threading
import time
import unicodedata
from typing import Annotated, Any, Literal

from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
)

from .. import spotify
from ..config import DATA_DIR
from . import CommandError, command

SPOTIFY_START_S = 8.0
DEVICE_WAIT_S = 12.0
LIKED_BATCH = 50
PLAYLISTS_PATH = DATA_DIR / "spotify_playlists.json"
PLAYLISTS_EVERY_S = 3600.0
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
    "Ak Spotify nebeží a má hrať, spustí ho. Na konkrétneho interpreta, album, skladbu či playlist je play_music.",
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


def _plain(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c)).strip()


def _liked() -> list[str]:
    # The API can't start Liked Songs as a context, so play a random window of it, shuffled.
    total = spotify.api("GET", "/me/tracks", {"limit": 1})["total"]
    if not total:
        raise CommandError("Nemáš žiadne obľúbené skladby.")
    offset = random.randrange(max(1, total - LIKED_BATCH + 1))
    page = spotify.api("GET", "/me/tracks", {"limit": LIKED_BATCH, "offset": offset})["items"]
    uris = [i["track"]["uri"] for i in page if i.get("track")]
    random.shuffle(uris)
    return uris


def _fetch_playlists() -> list[dict[str, Any]]:
    own = [p for p in spotify.api("GET", "/me/playlists", {"limit": 50})["items"] if p]
    PLAYLISTS_PATH.write_text(json.dumps([p["name"] for p in own], ensure_ascii=False), encoding="utf-8")
    return own


_refreshing = threading.Lock()


def _refresh_playlists() -> None:
    if not _refreshing.acquire(blocking=False):
        return
    try:
        _fetch_playlists()
    except (spotify.SpotifyError, spotify.NotLoggedIn, OSError):
        pass
    finally:
        _refreshing.release()


def playlist_names() -> list[str]:
    """Cached names; a stale cache is refreshed in the background for next time."""
    if not spotify.logged_in():
        return []
    try:
        stale = time.time() - PLAYLISTS_PATH.stat().st_mtime > PLAYLISTS_EVERY_S
        names = json.loads(PLAYLISTS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        stale, names = True, []
    if stale:
        threading.Thread(target=_refresh_playlists, daemon=True).start()
    return names


def playlist_phrases() -> list[str]:
    """Names without emoji, as Azure recognition hints."""
    spoken = ("".join(c for c in n if c.isalnum() or c in " '-").strip() for n in playlist_names())
    return [n for n in spoken if n]


def playlists_prompt() -> str:
    names = playlist_names()
    if not names:
        return ""
    return (
        "Jeho playlisty na Spotify (do play_music daj presný názov, aj s emoji; názov len z emoji priraď "
        "podľa významu, napríklad 📻 je rádio): " + ", ".join(f"„{n}“" for n in names)
    )


def _find(query: str, kind: str) -> tuple[str, dict[str, Any]]:
    if kind == "playlist":
        # Own and followed playlists first: search ranks public ones above them.
        own = _fetch_playlists()
        wanted = _plain(query)
        match = next((p for p in own if p and _plain(p["name"]) == wanted), None) or next(
            (p for p in own if p and wanted in _plain(p["name"])), None
        )
        if match:
            return match["name"], {"context_uri": match["uri"]}
    found = spotify.api("GET", "/search", {"q": query, "type": kind, "limit": 1})
    items = [i for i in found[kind + "s"]["items"] if i]
    if not items:
        raise CommandError("Na Spotify som to nenašiel.")
    item = items[0]
    by = ", ".join(a["name"] for a in item.get("artists", [])[:2])
    name = f"{item['name']} ({by})" if by else item["name"]
    if kind == "track":
        # The desktop app silently ignores a bare track URI; inside its album it plays.
        return name, {"context_uri": item["album"]["uri"], "offset": {"uri": item["uri"]}}
    return name, {"context_uri": item["uri"]}


def _device() -> str:
    deadline = time.monotonic() + DEVICE_WAIT_S
    launched = False
    while True:
        devices = [d for d in spotify.api("GET", "/me/player/devices")["devices"] if not d["is_restricted"]]
        device = next((d for d in devices if d["is_active"]), None) or next(
            (d for d in devices if d["type"] == "Computer"), devices[0] if devices else None
        )
        if device is not None:
            return device["id"]
        if time.monotonic() > deadline:
            raise CommandError("Spotify som otvoril, ale nepripojil sa.")
        if not launched:
            os.startfile("spotify:")
            launched = True
        time.sleep(1.0)


@command(
    "Pustí na Spotify konkrétneho interpreta, album, skladbu, playlist alebo obľúbené skladby "
    "(„pusti mi Elán“, „pusti Kaskadéra od Elánu“, „pusti môj playlist Na behanie“). Spotify spustí, ak nebeží.",
    timeout=25.0,
)
def play_music(
    query: Annotated[str, "čo hľadať, ako to povedal; pri skladbe aj interpret, ak ho povedal; pri liked prázdne"],
    kind: Literal["artist", "album", "track", "playlist", "liked"],
) -> str:
    if not spotify.logged_in():
        raise CommandError("Spotify ešte nemám prihlásený.")
    try:
        if kind == "liked":
            name, body = "obľúbené skladby", {"uris": _liked()}
        else:
            name, body = _find(query, kind)
        device = _device()
        for attempt in range(3):
            try:
                spotify.api("PUT", "/me/player/play", {"device_id": device}, body)
                break
            except spotify.SpotifyError as err:
                # A just-started desktop app is listed before it accepts commands.
                if err.status not in (404, 502) or attempt == 2:
                    raise
                time.sleep(1.5)
    except spotify.NotLoggedIn:
        raise CommandError("Spotify ešte nemám prihlásený.") from None
    except spotify.SpotifyError as err:
        if err.status == 403:
            raise CommandError("Spotify mi to nedovolil, vyberať hudbu ide len s Premium.") from err
        raise CommandError("Spotify mi neodpovedá.") from err
    except OSError as err:
        raise CommandError("Spotify mi neodpovedá.") from err
    return f"playing {kind}: {name}"
