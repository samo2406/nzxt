from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote

from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

from .config import AGENT_DIR
from .events import Events

log = logging.getLogger(__name__)

MAX_INBOUND = 4096
STATS_INTERVAL_S = 1.0
DASHBOARD_PATH = Path(__file__).with_name("dashboard.html")
DIST_DIR = AGENT_DIR.parent / "dist"
DEBUG_PATH = "/debug"
_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}


def _file(connection: ServerConnection, path: Path) -> Response:
    try:
        body = path.read_bytes()
    except OSError:
        return connection.respond(404, "Not found\n")
    headers = Headers(
        [
            ("Content-Type", _TYPES.get(path.suffix.lower(), "application/octet-stream")),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
            ("Connection", "close"),
        ]
    )
    return Response(200, "OK", headers, body)


class FaceServer:
    """Pushes assistant events to the Kraken page over a loopback WebSocket.
    On the same port it serves the diagnostics page (/) and a local copy of
    the LCD page (/display/).

    Browsers don't apply CORS to WebSockets, so any page the user opens could
    connect here; the Origin allowlist is what keeps them out. The detailed
    `debug` stream (transcripts, logs) only goes to /debug connections from
    pages this server served itself. Inbound messages are limited to harmless
    telemetry — nothing a page sends can make the agent act.
    """

    def __init__(
        self,
        events: Events,
        port: int,
        origins: tuple[str, ...],
        info: Callable[[], dict[str, Any]] = dict,
        stats: Callable[[], dict[str, Any]] = dict,
    ) -> None:
        self._events = events
        self._port = port
        self._own_origins = (f"http://127.0.0.1:{port}", f"http://localhost:{port}")
        self._origins = [*origins, *self._own_origins]
        self._info = info
        self._stats = stats
        self._faces: set[ServerConnection] = set()
        self._debug: set[ServerConnection] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stats_task: asyncio.Task[None] | None = None
        self.telemetry: dict[str, Any] = {}

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._events.subscribe(self._on_event)
        await serve(
            self._handle,
            "127.0.0.1",
            self._port,
            origins=self._origins,
            process_request=self._http,
            max_size=MAX_INBOUND,
            compression=None,
        )
        self._stats_task = asyncio.ensure_future(self._stats_loop())
        log.info("face server on ws://127.0.0.1:%d, diagnostics at http://127.0.0.1:%d/", self._port, self._port)

    def _http(self, connection: ServerConnection, request: Request) -> Response | None:
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return None
        path = unquote(request.path.split("?", 1)[0])
        if path in ("/", "/index.html"):
            return _file(connection, DASHBOARD_PATH)
        if path == "/display":
            response = connection.respond(301, "")
            response.headers["Location"] = "/display/"
            return response
        if path.startswith("/display/"):
            # The LCD page from the local build: same-origin with this server, so
            # browsers that gate public sites from reaching localhost still connect.
            if not DIST_DIR.is_dir():
                return connection.respond(404, "No local build: run `npm run build` in the repo root.\n")
            root = DIST_DIR.resolve()
            target = (root / (path[len("/display/"):] or "index.html")).resolve()
            if root not in target.parents or not target.is_file():
                return connection.respond(404, "Not found\n")
            return _file(connection, target)
        return connection.respond(404, "Not found\n")

    def _on_event(self, message: dict[str, Any]) -> None:
        # Events fire from Azure and audio threads as well as the loop.
        if self._loop is None:
            return
        debug = message["type"] == "debug"
        if not self._debug and (debug or not self._faces):
            return
        data = json.dumps(message, ensure_ascii=False, default=str)
        self._loop.call_soon_threadsafe(self._broadcast, data, debug)

    def _broadcast(self, data: str, debug_only: bool) -> None:
        targets = self._debug if debug_only else self._faces | self._debug
        for ws in list(targets):
            asyncio.ensure_future(self._send(ws, data))

    async def _send(self, ws: ServerConnection, data: str) -> None:
        try:
            await ws.send(data)
        except ConnectionClosed:
            self._drop(ws)

    def _drop(self, ws: ServerConnection) -> None:
        self._faces.discard(ws)
        self._debug.discard(ws)
        self._events.debug_clients = len(self._debug)

    async def _handle(self, ws: ServerConnection) -> None:
        request = ws.request
        is_debug = (
            request is not None
            and request.path.split("?", 1)[0] == DEBUG_PATH
            and request.headers.get("Origin") in self._own_origins
        )
        (self._debug if is_debug else self._faces).add(ws)
        self._events.debug_clients = len(self._debug)
        log.info("%s connected (faces %d, diagnostics %d)", "diagnostics" if is_debug else "face",
                 len(self._faces), len(self._debug))
        try:
            await ws.send(json.dumps(self._events.status, ensure_ascii=False))
            await ws.send(json.dumps(self._events.state, ensure_ascii=False))
            if is_debug:
                await ws.send(json.dumps(self._snapshot(), ensure_ascii=False, default=str))
            async for raw in ws:
                self._receive(raw)
        except ConnectionClosed:
            pass
        finally:
            self._drop(ws)
            log.info("%s disconnected", "diagnostics" if is_debug else "face")

    def _snapshot(self) -> dict[str, Any]:
        return {
            "type": "debug",
            "kind": "snapshot",
            "info": self._info(),
            "history": {k: list(v) for k, v in self._events.history.items()},
        }

    async def _stats_loop(self) -> None:
        while True:
            await asyncio.sleep(STATS_INTERVAL_S)
            if not self._debug:
                continue
            try:
                stats = self._stats()
            except Exception:
                log.exception("stats failed")
                continue
            self._events.debug("stats", faces=len(self._faces), telemetry=self.telemetry, **stats)

    def _receive(self, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        if isinstance(msg, dict) and msg.get("type") == "telemetry":
            self.telemetry = {
                k: v for k, v in msg.items() if k != "type" and isinstance(v, (int, float)) and not isinstance(v, bool)
            }
