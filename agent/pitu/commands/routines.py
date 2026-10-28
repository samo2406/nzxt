from __future__ import annotations

import ctypes
import logging
import os
import time
import tomllib
import winreg
from typing import Annotated, Any

from ..config import ROUTINES_PATH
from . import Choices, CommandError, command
from .apps import apps
from .jiggler import mouse_jiggler

log = logging.getLogger(__name__)

VD_KEY = r"Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops"
VK_LCONTROL, VK_LWIN, VK_LEFT, VK_RIGHT, VK_D = 0xA2, 0x5B, 0x25, 0x27, 0x44
KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP = 0x1, 0x2
# Windows drops a desktop switch that arrives while the previous slide animation runs.
SWITCH_PAUSE_S = 0.4

_cache: tuple[float, dict[str, dict[str, Any]]] = (-1.0, {})


def routines() -> dict[str, dict[str, Any]]:
    """routines.toml, re-read when the file changes."""
    global _cache
    try:
        mtime = ROUTINES_PATH.stat().st_mtime
    except FileNotFoundError:
        return {}
    if mtime != _cache[0]:
        try:
            table = tomllib.loads(ROUTINES_PATH.read_text(encoding="utf-8")).get("routines", {})
            _cache = (mtime, {str(k): dict(v) for k, v in table.items() if isinstance(v, dict)})
        except (tomllib.TOMLDecodeError, OSError) as err:
            log.error("routines.toml unreadable, keeping the previous list: %s", err)
    return _cache[1]


def names() -> list[str]:
    # A strict enum can't be empty.
    return sorted(routines()) or ["-"]


def _desktops() -> tuple[list[bytes], int]:
    """Virtual desktop ids in order, and the index of the current one."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, VD_KEY) as key:
            raw, _ = winreg.QueryValueEx(key, "VirtualDesktopIDs")
            current, _ = winreg.QueryValueEx(key, "CurrentVirtualDesktop")
    except FileNotFoundError:
        return [], 0
    ids = [raw[i : i + 16] for i in range(0, len(raw), 16)]
    return ids, ids.index(current) if current in ids else 0


def _press(*keys: int) -> None:
    user32 = ctypes.windll.user32
    for key in keys:
        user32.keybd_event(key, 0, KEYEVENTF_EXTENDEDKEY if key in (VK_LEFT, VK_RIGHT) else 0, 0)
    for key in reversed(keys):
        user32.keybd_event(key, 0, KEYEVENTF_KEYUP | (KEYEVENTF_EXTENDEDKEY if key in (VK_LEFT, VK_RIGHT) else 0), 0)
    time.sleep(SWITCH_PAUSE_S)


def go_to_desktop(number: int) -> None:
    ids, index = _desktops()
    count = max(1, len(ids))
    while count < number:
        _press(VK_LCONTROL, VK_LWIN, VK_D)
        count += 1
        index = count - 1
    step = VK_RIGHT if number - 1 > index else VK_LEFT
    for _ in range(abs(number - 1 - index)):
        _press(VK_LCONTROL, VK_LWIN, step)
    if _desktops()[1] != number - 1:
        raise CommandError(f"Na plochu {number} sa prepnúť nepodarilo.")


@command(
    "Spustí pripravenú rutinu, viac krokov naraz. Rozumej aj voľným formuláciám: "
    "„nachystaj ma do roboty“, „idem robiť“, „pracovný režim“.",
    timeout=20,
)
def routine(name: Annotated[str, Choices(names)]) -> str:
    cfg = routines().get(name)
    if not cfg:
        raise CommandError("Takú rutinu nepoznám.")
    done = []
    if desktop := int(cfg.get("desktop", 0)):
        go_to_desktop(desktop)
        done.append(f"desktop {desktop}")
    for app in cfg.get("apps", []):
        target = apps().get(str(app))
        if not target:
            raise CommandError(f"{app} nemám v zozname aplikácií.")
        os.startfile(target)
        done.append(str(app))
    if cfg.get("mouse_jiggler"):
        mouse_jiggler(True)
        done.append("mouse jiggler on")
    return ", ".join(done) or "nothing to do"
