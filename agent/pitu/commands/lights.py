from __future__ import annotations

import json
import logging
import socket
import time
import tomllib
from typing import Annotated, Any, Literal

from ..config import LIGHTS_PATH
from . import Choices, CommandError, command

log = logging.getLogger(__name__)

YEELIGHT_PORT = 55443
DISCOVERY = ("239.255.255.250", 1982)
FADE_MS = 400

Color = Literal[
    "nemeniť", "teplá biela", "neutrálna biela", "studená biela",
    "červená", "oranžová", "žltá", "zelená", "tyrkysová", "modrá", "fialová", "ružová",
]
WHITES = {"teplá biela": 2700, "neutrálna biela": 4000, "studená biela": 6500}
COLORS = {
    "červená": 0xFF0000, "oranžová": 0xFF6000, "žltá": 0xFFC800, "zelená": 0x00FF00,
    "tyrkysová": 0x00E0D0, "modrá": 0x0000FF, "fialová": 0x8A2BE2, "ružová": 0xFF1493,
}

_cache: tuple[float, dict[str, dict[str, Any]]] = (-1.0, {})
# Where a Yeelight was last found, when DHCP moved it away from lights.toml's host.
_moved: dict[str, str] = {}


def lights() -> dict[str, dict[str, Any]]:
    """lights.toml, re-read when the file changes."""
    global _cache
    try:
        mtime = LIGHTS_PATH.stat().st_mtime
    except FileNotFoundError:
        return {}
    if mtime != _cache[0]:
        try:
            table = tomllib.loads(LIGHTS_PATH.read_text(encoding="utf-8")).get("lights", {})
            _cache = (mtime, {str(k): dict(v) for k, v in table.items() if isinstance(v, dict)})
        except (tomllib.TOMLDecodeError, OSError) as err:
            log.error("lights.toml unreadable, keeping the previous list: %s", err)
    return _cache[1]


def names() -> list[str]:
    # A strict enum can't be empty.
    return sorted(lights()) or ["-"]


def _discover(device_id: str, timeout: float = 1.5) -> str | None:
    msg = b'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1982\r\nMAN: "ssdp:discover"\r\nST: wifi_bulb\r\n\r\n'
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(0.3)
        s.bind(("", 0))
        s.sendto(msg, DISCOVERY)
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                data, addr = s.recvfrom(4096)
            except socket.timeout:
                continue
            headers = dict(line.split(": ", 1) for line in data.decode(errors="replace").split("\r\n") if ": " in line)
            if headers.get("id", "").lower() == device_id.lower():
                return addr[0]
    return None


class Yeelight:
    """Yeelight's LAN protocol: one JSON command per line over TCP."""

    def __init__(self, name: str, host: str, device_id: str) -> None:
        self._name = name
        self._host = _moved.get(device_id, host)
        self._id = device_id

    def run(self, calls: list[tuple[str, list[Any]]]) -> None:
        try:
            sock = socket.create_connection((self._host, YEELIGHT_PORT), timeout=1.5)
        except OSError:
            found = _discover(self._id) if self._id else None
            if not found:
                raise CommandError(f"Svetlo {self._name} nedosiahnem. Je zapnuté v zásuvke a má zapnuté LAN Control?")
            log.info("yeelight %s moved to %s", self._id, found)
            _moved[self._id] = self._host = found
            sock = socket.create_connection((found, YEELIGHT_PORT), timeout=1.5)
        with sock:
            sock.settimeout(2.0)
            stream = sock.makefile("rb")
            for n, (method, params) in enumerate(calls, start=1):
                sock.sendall((json.dumps({"id": n, "method": method, "params": params}) + "\r\n").encode())
                # The light also pushes unsolicited "props" notifications; skip to our reply.
                while True:
                    reply = json.loads(stream.readline() or b"{}")
                    if reply.get("id") == n or not reply:
                        break
                if "error" in reply:
                    raise CommandError("Svetlo ten príkaz odmietlo.") from RuntimeError(reply["error"])


def _calls(on: bool, brightness: int, color: str) -> list[tuple[str, list[Any]]]:
    if not on:
        return [("set_power", ["off", "smooth", FADE_MS])]
    calls: list[tuple[str, list[Any]]] = [("set_power", ["on", "smooth", FADE_MS])]
    if color in WHITES:
        calls.append(("set_ct_abx", [WHITES[color], "smooth", FADE_MS]))
    elif color in COLORS:
        calls.append(("set_rgb", [COLORS[color], "smooth", FADE_MS]))
    if brightness:
        calls.append(("set_bright", [max(1, min(100, brightness)), "smooth", FADE_MS]))
    return calls


@command(
    "Ovláda svetlá: zapne, vypne, nastaví jas alebo farbu. Rozumej aj voľným formuláciám "
    "(„rozsviet pri posteli“, „stlm posteľ na desať percent“, „daj tam niečo modré“)."
)
def light(
    name: Annotated[str, Choices(names)],
    on: Annotated[bool, "true zapne (aj pri zmene jasu či farby), false vypne"],
    brightness: Annotated[int, "jas 1 až 100; 0 = nemeniť"],
    color: Annotated[Color, "farba; „nemeniť“, ak o farbe nehovorí"],
) -> str:
    cfg = lights().get(name)
    if not cfg:
        raise CommandError("Také svetlo nepoznám.")
    if cfg.get("type") != "yeelight":
        raise CommandError("Tento druh svetla zatiaľ ovládať neviem.")
    Yeelight(name, str(cfg.get("host", "")), str(cfg.get("id", ""))).run(_calls(on, brightness, color))
    return f"{name}: {'on' if on else 'off'}" + (f", {brightness} %" if on and brightness else "") + (
        f", {color}" if on and color != "nemeniť" else "")
