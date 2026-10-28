from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from .events import Events

log = logging.getLogger(__name__)

MAX_INBOUND = 4096


class FaceServer:
    """Pushes assistant events to the Kraken page over a loopback WebSocket.

    Browsers don't apply CORS to WebSockets, so any page the user opens could
    connect here; the Origin allowlist is what keeps them out. Inbound messages
    are limited to harmless telemetry — nothing a page sends can make the
    agent act.
    """

    def __init__(self, events: Events, port: int, origins: tuple[str, ...]) -> None:
        self._events = events
        self._port = port
        self._origins = list(origins)
        self._clients: set[ServerConnection] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self.telemetry: dict[str, Any] = {}

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._events.subscribe(self._on_event)
        await serve(
            self._handle,
            "127.0.0.1",
            self._port,
            origins=self._origins,
            max_size=MAX_INBOUND,
            compression=None,
        )
        log.info("face server on ws://127.0.0.1:%d", self._port)

    def _on_event(self, message: dict[str, Any]) -> None:
        # Events fire from Azure and audio threads as well as the loop.
        if self._loop is not None and self._clients:
            data = json.dumps(message, ensure_ascii=False)
            self._loop.call_soon_threadsafe(self._broadcast, data)

    def _broadcast(self, data: str) -> None:
        for ws in list(self._clients):
            asyncio.ensure_future(self._send(ws, data))

    async def _send(self, ws: ServerConnection, data: str) -> None:
        try:
            await ws.send(data)
        except ConnectionClosed:
            self._clients.discard(ws)

    async def _handle(self, ws: ServerConnection) -> None:
        self._clients.add(ws)
        log.info("face connected (%d)", len(self._clients))
        try:
            await ws.send(json.dumps(self._events.status, ensure_ascii=False))
            await ws.send(json.dumps(self._events.state, ensure_ascii=False))
            async for raw in ws:
                self._receive(raw)
        except ConnectionClosed:
            pass
        finally:
            self._clients.discard(ws)
            log.info("face disconnected (%d)", len(self._clients))

    def _receive(self, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        if isinstance(msg, dict) and msg.get("type") == "telemetry":
            self.telemetry = {
                k: v for k, v in msg.items() if k != "type" and isinstance(v, (int, float)) and not isinstance(v, bool)
            }
