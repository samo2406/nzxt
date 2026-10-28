from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Annotated

import psutil

from . import CommandError, command

DEFAULT_EXE = r"C:\MouseJiggler\MouseJiggler.exe"


def _running() -> list[psutil.Process]:
    return [p for p in psutil.process_iter(["name"]) if (p.info["name"] or "").lower() == "mousejiggler.exe"]


def _stop(procs: list[psutil.Process]) -> None:
    for p in procs:
        try:
            p.terminate()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(procs, timeout=3)


def _launch(exe: str) -> None:
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        # Outside the agent's job, so restarting the agent doesn't close it.
        subprocess.Popen([exe, "--jiggle"], creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, close_fds=True)
    except OSError:
        subprocess.Popen([exe, "--jiggle"], creationflags=flags, close_fds=True)


@command(
    "Zapne alebo vypne Mouse Jiggler, ktorý sám hýbe myšou, aby počítač nezaspal a v chate bol stále online. "
    "Použi aj na voľné formulácie: „zapni pohybovanie myšky“, „nech sa myš hýbe“, „vypni jiggler“, "
    "„prestaň hýbať myšou“."
)
def mouse_jiggler(on: Annotated[bool, "true zapne pohybovanie, false ho vypne"]) -> str:
    procs = _running()
    if not on:
        if not procs:
            raise CommandError("Mouse Jiggler ani nebeží.")
        _stop(procs)
        return "stopped"
    exe = os.environ.get("MOUSE_JIGGLER") or DEFAULT_EXE
    if not Path(exe).exists():
        raise CommandError("Mouse Jiggler nenájdem.")
    # A second instance just exits, and a running one may have jiggling off, so start it fresh.
    _stop(procs)
    _launch(exe)
    return "started with jiggling on"
