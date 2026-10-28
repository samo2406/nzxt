from __future__ import annotations

import logging
from typing import Any, Callable

log = logging.getLogger(__name__)

Listener = Callable[[dict[str, Any]], None]


class Events:
    """What the face (and the config page) needs to know, as JSON-ready dicts.

    The latest `state` message is kept so a display that connects mid-turn
    shows the right face immediately.
    """

    def __init__(self) -> None:
        self._listeners: list[Listener] = []
        self.state: dict[str, Any] = {"type": "state", "state": "sleeping"}
        self.status: dict[str, Any] = {"type": "status", "mic": None, "online": True}

    def subscribe(self, fn: Listener) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn) if fn in self._listeners else None

    def emit(self, message: dict[str, Any]) -> None:
        if message["type"] == "state":
            self.state = message
        elif message["type"] == "status":
            self.status = {**self.status, **message}
            message = self.status
        for fn in list(self._listeners):
            try:
                fn(message)
            except Exception:
                log.exception("event listener failed")

    def set_state(self, state: str, **extra: Any) -> None:
        log.debug("face: %s", state)
        self.emit({"type": "state", "state": state, **extra})
