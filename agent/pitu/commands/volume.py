from __future__ import annotations

from typing import Annotated, Any

from pycaw.pycaw import AudioUtilities

from ..ducking import DUCKER, process_name, sessions
from . import command


def _endpoint() -> Any:
    return AudioUtilities.GetSpeakers().EndpointVolume


def _scalar(percent: int) -> float:
    return max(0, min(100, percent)) / 100


def _percent(scalar: float) -> int:
    return round(scalar * 100)


@command("Nastaví celkovú hlasitosť počítača.")
def set_volume(level: Annotated[int, "0 až 100"]) -> str:
    ep = _endpoint()
    ep.SetMasterVolumeLevelScalar(_scalar(level), None)
    if level > 0:
        ep.SetMute(0, None)
    return f"volume {_percent(ep.GetMasterVolumeLevelScalar())}"


@command("Zvýši alebo zníži celkovú hlasitosť počítača o daný počet percentuálnych bodov.")
def change_volume(delta: Annotated[int, "kladné číslo zosilní, záporné stíši; „trochu“ je zhruba 10"]) -> str:
    ep = _endpoint()
    current = _percent(ep.GetMasterVolumeLevelScalar())
    ep.SetMasterVolumeLevelScalar(_scalar(current + delta), None)
    if delta > 0:
        ep.SetMute(0, None)
    return f"volume {current} -> {_percent(ep.GetMasterVolumeLevelScalar())}"


@command("Zistí celkovú hlasitosť a hlasitosť aplikácií, ktoré majú otvorený zvuk.", speaks=False)
def get_volume() -> dict[str, Any]:
    ep = _endpoint()
    apps: dict[str, int] = {}
    for s in sessions():
        name = process_name(s).removesuffix(".exe")
        if name and name not in apps:
            apps[name] = _percent(DUCKER.volume_of(s))
    return {"master": _percent(ep.GetMasterVolumeLevelScalar()), "muted": bool(ep.GetMute()), "apps": apps}
