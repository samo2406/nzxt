from __future__ import annotations

import logging
import time
from collections import deque
from typing import Any, Callable

log = logging.getLogger(__name__)

Listener = Callable[[dict[str, Any]], None]

# What a diagnostics page gets when it connects: enough recent history to be
# useful immediately, small enough to keep in memory forever.
HISTORY = {"turn": 30, "state": 120, "log": 400}


class Events:
    """What the face (and the config page) needs to know, as JSON-ready dicts.

    The latest `state` message is kept so a display that connects mid-turn
    shows the right face immediately. `debug` messages are only for the
    agent's own diagnostics page; they are recorded but not sent anywhere
    unless such a page is connected.
    """

    def __init__(self) -> None:
        self._listeners: list[Listener] = []
        self.state: dict[str, Any] = {"type": "state", "state": "sleeping"}
        self.status: dict[str, Any] = {"type": "status", "mic": None, "online": True}
        self.history: dict[str, deque[dict[str, Any]]] = {k: deque(maxlen=n) for k, n in HISTORY.items()}
        self.debug_clients = 0

    def subscribe(self, fn: Listener) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn) if fn in self._listeners else None

    def emit(self, message: dict[str, Any]) -> None:
        if message["type"] == "state":
            self.state = message
            self.debug("state", state=message["state"], reason=message.get("reason"))
        elif message["type"] == "status":
            self.status = {**self.status, **message}
            message = self.status
        self._send(message)

    def set_state(self, state: str, **extra: Any) -> None:
        log.debug("face: %s", state)
        self.emit({"type": "state", "state": state, **extra})

    def debug(self, kind: str, **data: Any) -> None:
        message = {"type": "debug", "kind": kind, "t": time.time(), **data}
        if kind in self.history:
            self.history[kind].append(message)
        if self.debug_clients:
            self._send(message)

    def _send(self, message: dict[str, Any]) -> None:
        for fn in list(self._listeners):
            try:
                fn(message)
            except Exception:
                log.exception("event listener failed")


class DebugLogHandler(logging.Handler):
    """Mirrors log records into the diagnostics stream."""

    def __init__(self, events: Events) -> None:
        super().__init__(logging.INFO)
        self._events = events

    def emit(self, record: logging.LogRecord) -> None:
        try:
            text = record.getMessage()
            if record.exc_info:
                text += "\n" + logging.Formatter().formatException(record.exc_info)
            self._events.debug("log", level=record.levelname, name=record.name, msg=text)
        except Exception:
            self.handleError(record)
