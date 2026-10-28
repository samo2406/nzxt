from __future__ import annotations

import colorsys
import json
import logging
import os
import socket
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated, Any, Literal, get_args

import tinytuya

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
Effect = Literal["žiadny", "párty", "prelievanie", "sviečka", "zastaviť"]
NO_MOOD = "žiadna"
WHITES = {"teplá biela": 2700, "neutrálna biela": 4000, "studená biela": 6500}
COLORS = {
    "červená": 0xFF0000, "oranžová": 0xFF6000, "žltá": 0xFFC800, "zelená": 0x00FF00,
    "tyrkysová": 0x00E0D0, "modrá": 0x0000FF, "fialová": 0x8A2BE2, "ružová": 0xFF1493,
}
RAINBOW = [0xFF0000, 0xFFC800, 0x00FF00, 0x00E0D0, 0x0000FF, 0xFF00FF]

_cache: tuple[float, dict[str, dict[str, dict[str, Any]]]] = (-1.0, {})
# Where a Yeelight was last found, when DHCP moved it away from lights.toml's host.
_moved: dict[str, str] = {}


def _config() -> dict[str, dict[str, dict[str, Any]]]:
    """lights.toml, re-read when the file changes."""
    global _cache
    try:
        mtime = LIGHTS_PATH.stat().st_mtime
    except FileNotFoundError:
        return {}
    if mtime != _cache[0]:
        try:
            data = tomllib.loads(LIGHTS_PATH.read_text(encoding="utf-8"))
            _cache = (mtime, {
                section: {str(k): dict(v) for k, v in data.get(section, {}).items() if isinstance(v, dict)}
                for section in ("lights", "moods")
            })
        except (tomllib.TOMLDecodeError, OSError) as err:
            log.error("lights.toml unreadable, keeping the previous list: %s", err)
    return _cache[1]


def lights() -> dict[str, dict[str, Any]]:
    return _config().get("lights", {})


def moods() -> dict[str, dict[str, Any]]:
    return _config().get("moods", {})


def names() -> list[str]:
    # A strict enum can't be empty.
    return sorted(lights()) or ["-"]


def mood_names() -> list[str]:
    return [NO_MOOD, *sorted(moods())]


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

    def run(self, on: bool, brightness: int, color: str, effect: str) -> None:
        self._send(self._calls(on, brightness, color, effect))

    @staticmethod
    def _calls(on: bool, brightness: int, color: str, effect: str) -> list[tuple[str, list[Any]]]:
        if not on:
            return [("set_power", ["off", "smooth", FADE_MS])]
        calls: list[tuple[str, list[Any]]] = [("set_power", ["on", "smooth", FADE_MS])]
        if effect == "zastaviť":
            return calls + [("stop_cf", [])]
        if effect in ("párty", "prelievanie", "sviečka"):
            # Flow steps are "duration ms, mode (1 rgb, 2 ct, 7 pause), value, brightness".
            if effect == "párty":
                steps = [f"50,1,{c},100,450,7,0,0" for c in RAINBOW]
            elif effect == "prelievanie":
                steps = [f"4000,1,{c},80" for c in RAINBOW]
            else:
                steps = [f"{ms},2,2000,{b}" for ms, b in
                         ((800, 50), (800, 30), (1200, 80), (800, 60), (1200, 90), (2400, 50), (1200, 80), (800, 60), (400, 70))]
            # count 0 = forever; action 0 = back to the previous light when stopped.
            return calls + [("start_cf", [0, 0, ",".join(steps)])]
        if color in WHITES:
            calls.append(("set_ct_abx", [WHITES[color], "smooth", FADE_MS]))
        elif color in COLORS:
            calls.append(("set_rgb", [COLORS[color], "smooth", FADE_MS]))
        if brightness:
            calls.append(("set_bright", [max(1, min(100, brightness)), "smooth", FADE_MS]))
        return calls

    def _send(self, calls: list[tuple[str, list[Any]]]) -> None:
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


def _hsv(rgb: int, v: int = 1000) -> str:
    h, s, _ = colorsys.rgb_to_hsv(rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255)
    return f"{round(h * 360):04x}{round(s * 1000):04x}{v:04x}"


def _scene(number: int, speed: int, mode: int, colours: list[str]) -> str:
    # scene_data: scene number, then per step: interval, transition (0-100), mode (1 jump, 2 fade), HSV, white bright+temp.
    return f"{number:02x}" + "".join(f"{speed:02x}{speed:02x}{mode:02x}{c}00000000" for c in colours)


TUYA_EFFECTS = {
    "párty": _scene(5, 100, 1, [_hsv(c) for c in RAINBOW]),
    "prelievanie": _scene(7, 40, 2, [_hsv(c) for c in RAINBOW]),
    "sviečka": _scene(6, 75, 2, [_hsv(0xFF6000, v) for v in (1000, 450, 850, 350, 950, 600)]),
}


class Tuya:
    """Tuya Wi-Fi bulbs (Immax NEO, Smart Life) over the LAN with the device's local key."""

    def __init__(self, name: str, host: str, device_id: str, version: float) -> None:
        key = os.environ.get(f"TUYA_KEY_{device_id}", "")
        if not key:
            raise CommandError(f"Svetlu {name} chýba kľúč v nastaveniach.")
        self._name = name
        self._dev = tinytuya.BulbDevice(
            device_id, host, key, version=version,
            connection_timeout=1.5, connection_retry_limit=2, connection_retry_delay=0.2,
        )

    def _check(self, reply: Any) -> dict:
        if not isinstance(reply, dict) or "Error" in reply:
            log.warning("tuya %s: %s", self._name, reply)
            raise CommandError(f"Svetlo {self._name} nedosiahnem. Je zapnuté vo vypínači?")
        return reply

    def run(self, on: bool, brightness: int, color: str, effect: str) -> None:
        if not on:
            self._check(self._dev.set_value(20, False))
            return
        dps: dict[str, Any] = {"20": True}
        bright = max(10, min(1000, brightness * 10)) if brightness else 0
        if effect in TUYA_EFFECTS:
            dps.update({"21": "scene", "25": TUYA_EFFECTS[effect]})
        elif color in WHITES:
            # temp_value 0..1000 spans the bulb's 2700..6500 K.
            dps.update({"21": "white", "23": round((WHITES[color] - 2700) / 3800 * 1000)})
            if bright:
                dps["22"] = bright
        elif color in COLORS or bright:
            state = self._check(self._dev.status()).get("dps", {})
            colour_mode = state.get("21") == "colour"
            if color in COLORS:
                v = bright or (int(str(state.get("24", ""))[8:12] or "3e8", 16) if colour_mode else state.get("22", 1000))
                dps.update({"21": "colour", "24": _hsv(COLORS[color], v)})
            elif colour_mode:
                dps["24"] = str(state.get("24", "000003e803e8"))[:8] + f"{bright:04x}"
            else:
                dps.update({"21": "white", "22": bright})
        elif effect == "zastaviť":
            dps["21"] = "white"
        self._check(self._dev.set_multiple_values(dps))


def _run(name: str, on: bool, brightness: int, color: str, effect: str) -> None:
    cfg = lights().get(name)
    if not cfg:
        raise CommandError("Také svetlo nepoznám.")
    kind = cfg.get("type")
    if kind == "yeelight":
        Yeelight(name, str(cfg.get("host", "")), str(cfg.get("id", ""))).run(on, brightness, color, effect)
    elif kind == "tuya":
        Tuya(name, str(cfg.get("host", "")), str(cfg.get("id", "")), float(cfg.get("version", 3.3))).run(
            on, brightness, color, effect)
    elif kind == "group":
        members = [str(m) for m in cfg.get("members", [])]
        with ThreadPoolExecutor(len(members) or 1) as pool:
            futures = [pool.submit(_run, m, on, brightness, color, effect) for m in members]
        errors = [f.exception() for f in futures if f.exception()]
        if errors:
            raise errors[0]
    else:
        raise CommandError("Tento druh svetla zatiaľ ovládať neviem.")


@command(
    "Ovláda svetlá: zapne, vypne, nastaví jas, farbu, náladu alebo efekt. Rozumej aj voľným formuláciám "
    "(„rozsviet pri posteli“, „stlm posteľ na desať percent“, „daj tam niečo modré“, „svetlo na čítanie“, "
    "„urob párty“). Keď povie len „obývačka“ alebo „svetlo v obývačke“, myslí obe svetlá v obývačke. "
    "Keď nepovie ktoré svetlo a z rozhovoru to nevyplýva, použi „obývačka“. „Všetky“ len keď povie všetky svetlá alebo celý byt."
)
def light(
    name: Annotated[str, Choices(names)],
    on: Annotated[bool, "true zapne (aj pri zmene jasu, farby, nálady či efektu), false vypne"],
    brightness: Annotated[int, "jas 1 až 100; 0 = nemeniť"],
    color: Annotated[Color, "farba; „nemeniť“, ak o farbe nehovorí"],
    mood: Annotated[str, Choices(mood_names), "pomenovaná nálada, ak o nej hovorí (napr. „na čítanie“); inak „žiadna“"],
    effect: Annotated[Effect, "farebný efekt; „zastaviť“ vráti bežné svetlo; inak „žiadny“"],
) -> str:
    if mood != NO_MOOD:
        preset = moods().get(mood)
        if not preset:
            raise CommandError("Takú náladu nepoznám.")
        brightness = brightness or int(preset.get("brightness", 0))
        if color == "nemeniť" and preset.get("color") in get_args(Color):
            color = preset["color"]
    _run(name, on, brightness, color, effect)
    if not on:
        return f"{name}: off"
    return f"{name}: on" + "".join(f", {part}" for part in (
        f"{brightness} %" if brightness else "",
        color if color != "nemeniť" else "",
        f"nálada {mood}" if mood != NO_MOOD else "",
        f"efekt {effect}" if effect != "žiadny" else "",
    ) if part)
