from __future__ import annotations

import threading
from typing import Annotated

from ..config import DATA_DIR
from . import CommandError, command

PATH = DATA_DIR / "memory.md"
MAX_FACTS = 100

_lock = threading.Lock()


def facts() -> list[str]:
    """data/memory.md, one "- fact" per line; editable by hand."""
    try:
        lines = PATH.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    return [line[2:].strip() for line in lines if line.startswith("- ") and line[2:].strip()]


def prompt() -> str:
    items = facts()
    if not items:
        return ""
    return (
        "Čo si si zapamätal z predošlých rozhovorov. Sú to poznámky o majiteľovi a domácnosti v tretej osobe; "
        "keď z nich odpovedáš, hovor mu „ty“ („Voláš sa Samo.“):\n" + "\n".join(f"- {f}" for f in items)
    )


def _save(items: list[str]) -> None:
    PATH.parent.mkdir(parents=True, exist_ok=True)
    PATH.write_text("".join(f"- {f}\n" for f in items), encoding="utf-8")


@command(
    "Natrvalo si zapamätá fakt pre ďalšie rozhovory: keď o to požiada („zapamätaj si…“) alebo keď sa "
    "dozvieš niečo trvalé o ňom či domácnosti (meno, narodeniny, čo má rád, kto je kto). "
    "Nie jednorazové príkazy ani veci len na teraz."
)
def remember(fact: Annotated[str, "krátka veta v tretej osobe, napr. „Volá sa Samo.“"]) -> str:
    fact = " ".join(fact.split())
    if not fact:
        raise CommandError("Čo si mám zapamätať?")
    with _lock:
        items = facts()
        if fact.lower() in (f.lower() for f in items):
            return "already remembered"
        if len(items) >= MAX_FACTS:
            raise CommandError("Pamäť mám plnú, najprv mi niečo vymaž.")
        _save([*items, fact])
    return "remembered"


@command(
    "Zabudne zapamätaný fakt, keď o to požiada („zabudni…“, „to už neplatí“). "
    "Keď sa fakt zmenil, zabudni starý a zapamätaj si nový."
)
def forget(fact: Annotated[str, "znenie faktu tak, ako si ho pamätáš"]) -> str:
    needle = " ".join(fact.split()).lower()
    with _lock:
        items = facts()
        matches = [f for f in items if f.lower() == needle] or [f for f in items if needle and needle in f.lower()]
        if not matches:
            raise CommandError("Také niečo si nepamätám.")
        if len(matches) > 1:
            raise CommandError("Pamätám si viac takých vecí, povedz presnejšie, ktorú.")
        _save([f for f in items if f != matches[0]])
    return f"forgot: {matches[0]}"
