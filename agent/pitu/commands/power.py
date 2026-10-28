from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass
from typing import Annotated, Callable

from . import CommandError, command

DELAY_S = 30
# shutdown.exe exit codes.
ALREADY_SCHEDULED = 1190
NOTHING_SCHEDULED = 1116


@dataclass(frozen=True)
class Plan:
    due: float
    restart: bool


_plan: Plan | None = None
# The assistant hooks this to show the countdown on the face.
on_change: Callable[[], None] = lambda: None


def planned() -> Plan | None:
    """The shutdown this agent scheduled, until a little after it was due."""
    return _plan if _plan and _plan.due > time.time() - 10 else None


def _set(plan: Plan | None) -> None:
    global _plan
    _plan = plan
    on_change()


def _shutdown(*args: str) -> int:
    return subprocess.run(
        ["shutdown", *args], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW
    ).returncode


@command(
    f"Vypne alebo reštartuje počítač o {DELAY_S} sekúnd; dovtedy sa to dá zrušiť. "
    "Rozumej aj „vypni počítač“, „vypni pc“, „idem spať, vypni to“, „reštartuj počítač“."
)
def power_off(restart: Annotated[bool, "true reštartuje, false vypne"]) -> str:
    what = "Reštartujem" if restart else "Vypínam"
    code = _shutdown("/r" if restart else "/s", "/t", str(DELAY_S), "/c", f"Piťu: {what} počítač.")
    if code == ALREADY_SCHEDULED:
        raise CommandError("Vypnutie už beží. Ak ho chceš zrušiť, povedz zruš vypnutie.")
    if code:
        raise CommandError("Počítač sa vypnúť nepodarilo.") from RuntimeError(f"shutdown exit {code}")
    _set(Plan(time.time() + DELAY_S, restart))
    return f"{'restart' if restart else 'shutdown'} in {DELAY_S} s"


@command("Zruší naplánované vypnutie alebo reštart počítača („zruš vypnutie“, „nevypínaj“, „stop“ počas odpočtu).")
def cancel_power_off() -> str:
    code = _shutdown("/a")
    if code in (0, NOTHING_SCHEDULED):
        _set(None)
    if code == NOTHING_SCHEDULED:
        raise CommandError("Žiadne vypnutie nebeží.")
    if code:
        raise CommandError("Vypnutie sa zrušiť nepodarilo.") from RuntimeError(f"shutdown exit {code}")
    return "cancelled"
