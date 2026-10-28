from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Annotated, Any, Callable

from ..config import DATA_DIR
from . import CommandError, command

log = logging.getLogger(__name__)

PATH = DATA_DIR / "timers.json"
MAX_SECONDS = 24 * 3600
MAX_TIMERS = 20
# A timer that came due while the agent was down still rings if it is this fresh.
LATE_GRACE_S = 120


@dataclass
class Timer:
    id: str
    label: str
    due: float


class TimerStore:
    """Countdown timers that survive a restart. Ringing is the assistant's
    job; it is woken through `on_change` whenever the next due time moves."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._timers: list[Timer] = []
        self.on_change: Callable[[], None] = lambda: None
        self._load()

    def add(self, seconds: int, label: str) -> Timer:
        with self._lock:
            if len(self._timers) >= MAX_TIMERS:
                raise CommandError("Minútok je už priveľa.")
            timer = Timer(uuid.uuid4().hex[:8], label.strip(), time.time() + seconds)
            self._timers.append(timer)
            self._save()
        self.on_change()
        return timer

    def cancel(self, label: str) -> list[Timer]:
        needle = label.strip().lower()
        with self._lock:
            gone = [t for t in self._timers if not needle or needle in t.label.lower()]
            self._timers = [t for t in self._timers if t not in gone]
            self._save()
        self.on_change()
        return gone

    def active(self) -> list[Timer]:
        with self._lock:
            return sorted(self._timers, key=lambda t: t.due)

    def next_due(self) -> float | None:
        with self._lock:
            return min((t.due for t in self._timers), default=None)

    def pop_due(self) -> list[Timer]:
        now = time.time()
        with self._lock:
            due = [t for t in self._timers if t.due <= now]
            if due:
                self._timers = [t for t in self._timers if t.due > now]
                self._save()
        return due

    def _load(self) -> None:
        try:
            raw = json.loads(PATH.read_text(encoding="utf-8"))
            timers = [Timer(str(t["id"]), str(t["label"]), float(t["due"])) for t in raw]
        except FileNotFoundError:
            return
        except Exception as err:
            log.warning("timers file unreadable, starting empty: %s", err)
            return
        cutoff = time.time() - LATE_GRACE_S
        self._timers = [t for t in timers if t.due >= cutoff]

    def _save(self) -> None:
        PATH.parent.mkdir(parents=True, exist_ok=True)
        PATH.write_text(json.dumps([asdict(t) for t in self._timers], ensure_ascii=False), encoding="utf-8")


TIMERS = TimerStore()


def _clock(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).strftime("%H:%M")


@command(
    "Nastaví minútku (odpočet). Na budík o konkrétnom čase dopočítaj sekundy z aktuálneho času. "
    "Funguje aj bez internetu; keď vyprší, zazvoní a povie názov."
)
def set_timer(
    seconds: Annotated[int, "dĺžka v sekundách, najviac 24 hodín"],
    label: Annotated[str, "krátky názov po slovensky, napr. „cestoviny“; prázdny reťazec, ak žiadny"],
) -> str:
    if seconds < 1:
        raise CommandError("Na koľko ju mám nastaviť?")
    if seconds > MAX_SECONDS:
        raise CommandError("Toľko neodpočítam, najviac deň.")
    timer = TIMERS.add(seconds, label)
    return f"timer {timer.id} set, rings at {_clock(timer.due)}"


@command("Zruší minútku podľa názvu; prázdny názov zruší všetky.")
def cancel_timer(label: Annotated[str, "názov minútky alebo prázdny reťazec"]) -> str:
    gone = TIMERS.cancel(label)
    if not gone:
        raise CommandError("Takú minútku nemám.")
    return f"cancelled {len(gone)}"


@command("Zistí, aké minútky bežia a koľko im zostáva.", speaks=False)
def list_timers() -> list[dict[str, Any]] | str:
    now = time.time()
    timers = TIMERS.active()
    if not timers:
        return "žiadne minútky nebežia"
    return [
        {"label": t.label, "remaining_s": max(0, round(t.due - now)), "rings_at": _clock(t.due)} for t in timers
    ]
