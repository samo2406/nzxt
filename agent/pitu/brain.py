from __future__ import annotations

import asyncio
import logging
import random
import time
from datetime import datetime
from typing import Any, Protocol

import anthropic

from .commands import Registry, memory
from .config import PERSONA_LOCAL_PATH, PERSONA_PATH, Config

log = logging.getLogger(__name__)

FIRST_TOKEN_TIMEOUT_S = 8.0
# The API compiles strict tool schemas on the first request that uses them (10-15 s,
# measured), and drops the compiled form after a while unused.
WARM_EVERY_S = 6 * 3600
WARM_CHECK_S = 60.0
# The cached prefix (persona, memory, tools) lives an hour; an idle refresh just
# before that costs one cache read instead of a full write on the next turn.
CACHE = {"type": "ephemeral", "ttl": "1h"}
REFRESH_EVERY_S = 50 * 60
MEMORY_S = 180.0
# Runs on Anthropic's side. No country: the API rejects "SK" as a location.
# Not web_search_20260209: its dynamic filtering adds ~3k tokens to every request
# and ~6k to each search, for no better answers on Haiku (measured).
WEB_SEARCH = {
    "type": "web_search_20250305",
    "name": "web_search",
    "max_uses": 3,
    "user_location": {"type": "approximate", "timezone": "Europe/Bratislava"},
}
# A search answer takes ~5-8 s; this fills the silence when the model said nothing first.
SEARCHING = ("Pozriem sa.", "Moment, pozriem.", "Hneď to zistím.")
MAX_ROUNDS = 4
# Thinking counts toward max_tokens; spoken replies themselves are a few dozen tokens.
MAX_TOKENS = 4096

_DAYS = ["pondelok", "utorok", "streda", "štvrtok", "piatok", "sobota", "nedeľa"]


class BrainError(Exception):
    """Base for failures the assistant should apologise for out loud."""


class BrainOffline(BrainError):
    pass


class BrainBusy(BrainError):
    pass


class BrainSlow(BrainError):
    pass


class BrainConfigError(BrainError):
    pass


class ReplySink(Protocol):
    def speak(self, text: str) -> None: ...

    def mark(self, name: str) -> None: ...


def _context_line() -> str:
    now = datetime.now()
    return f"[{_DAYS[now.weekday()]} {now.day}. {now.month}. {now.year}, {now:%H:%M}]"


class Persona:
    """persona.md, plus an optional gitignored persona.local.md for private
    details. Re-read whenever either file changes."""

    def __init__(self) -> None:
        self._sig: tuple[float, float] | None = None
        self.text = ""

    def refresh(self) -> bool:
        sig = tuple(p.stat().st_mtime if p.exists() else 0.0 for p in (PERSONA_PATH, PERSONA_LOCAL_PATH))
        if sig == self._sig:
            return False
        self._sig = sig  # type: ignore[assignment]
        parts = [PERSONA_PATH.read_text(encoding="utf-8")]
        if PERSONA_LOCAL_PATH.exists():
            parts.append(PERSONA_LOCAL_PATH.read_text(encoding="utf-8"))
        self.text = "\n\n".join(p.strip() for p in parts if p.strip())
        return True


class Brain:
    def __init__(self, cfg: Config, registry: Registry) -> None:
        self._cfg = cfg
        self._registry = registry
        self._client = anthropic.AsyncAnthropic(
            max_retries=1, timeout=anthropic.Timeout(30.0, connect=5.0)
        )
        self._tools = self._tool_defs()
        self._persona = Persona()
        self._system = ""
        self._messages: list[dict[str, Any]] = []
        self._pending_results: list[dict[str, Any]] = []
        self._last_turn = 0.0
        self._spoke = False
        self.simulate: str | None = None
        self.last_turn: dict[str, Any] = {"rounds": [], "tools": []}

    async def prewarm(self) -> None:
        """Opens the TLS connection while the user is still speaking."""
        try:
            await self._client.messages.count_tokens(
                model=self._cfg.claude_model, messages=[{"role": "user", "content": "ahoj"}]
            )
        except Exception as err:
            log.debug("brain prewarm failed: %s", err)

    async def keep_warm(self) -> None:
        """A throwaway request whenever the tool schemas change, so their
        compilation never lands on a real turn."""
        warmed: list[dict[str, Any]] | None = None
        compiled = refreshed = 0.0
        while True:
            tools = self._tool_defs()
            self._persona.refresh()
            started = time.monotonic()
            ping = [{"role": "user", "content": "ping"}]
            try:
                if tools != warmed or started - compiled > WARM_EVERY_S:
                    # max_tokens=0 skips sampling, so it can't be trusted to compile the schemas.
                    async with self._client.beta.messages.stream(
                        max_tokens=16, messages=ping, **self._params(self._system_text(), tools)
                    ) as stream:
                        message = await stream.get_final_message()
                    warmed, compiled = tools, time.monotonic()
                    refreshed = compiled
                    log.info(
                        "tool schemas warmed in %.1f s, cache written=%s",
                        compiled - started,
                        message.usage.cache_creation_input_tokens,
                    )
                elif started - max(refreshed, self._last_turn) > REFRESH_EVERY_S:
                    message = await self._client.beta.messages.create(
                        max_tokens=0, messages=ping, **self._params(self._system_text(), tools)
                    )
                    refreshed = time.monotonic()
                    log.info(
                        "prompt cache refreshed: read=%s written=%s",
                        message.usage.cache_read_input_tokens,
                        message.usage.cache_creation_input_tokens,
                    )
            except Exception as err:
                log.info("warming failed: %s", err)
            await asyncio.sleep(WARM_CHECK_S)

    def _params(self, system: str, tools: list[dict[str, Any]]) -> dict[str, Any]:
        """Everything that makes up the cached prefix, identical for real turns and warm-ups."""
        return {
            "model": self._cfg.claude_model,
            "system": [{"type": "text", "text": system, "cache_control": CACHE}],
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": self._cfg.claude_effort},
            "betas": ["server-side-fallback-2026-07-01"],
            "fallbacks": "default",
            "tools": tools,
        }

    def _tool_defs(self) -> list[dict[str, Any]]:
        return [*self._registry.tool_defs(), WEB_SEARCH]

    def _system_text(self) -> str:
        return "\n\n".join(p for p in (self._persona.text, memory.prompt()) if p)

    def _start_turn(self, text: str) -> None:
        # Editing the system prompt or tools invalidates earlier thinking
        # blocks, so a persona edit starts a fresh conversation instead.
        persona_changed = self._persona.refresh()
        expired = time.monotonic() - self._last_turn > MEMORY_S
        if persona_changed or expired or not self._system:
            self._messages = []
            self._pending_results = []
            self._tools = self._tool_defs()
            # Read once per conversation: a fact saved mid-conversation is already in its history.
            self._system = self._system_text()
        content = [*self._pending_results, {"type": "text", "text": f"{_context_line()} {text}"}]
        self._pending_results = []
        self._messages.append({"role": "user", "content": content})

    async def respond(self, text: str, sink: ReplySink) -> None:
        self.last_turn = {"rounds": [], "tools": []}
        self._spoke = False
        self._start_turn(text)
        try:
            for _ in range(MAX_ROUNDS):
                message = await self._round(sink)
                self._messages.append({"role": "assistant", "content": message.content})
                if message.stop_reason == "refusal":
                    sink.speak("Na toto ti neodpoviem.")
                    return
                for b in message.content:
                    if b.type == "server_tool_use" and b.name == "web_search":
                        self.last_turn["tools"].append(
                            {"name": b.name, "input": dict(b.input), "result": None, "error": False}
                        )
                if message.stop_reason == "pause_turn":
                    continue
                tool_uses = [b for b in message.content if b.type == "tool_use"]
                if not tool_uses:
                    return
                if message.stop_reason == "max_tokens":
                    self._pending_results = [
                        {"type": "tool_result", "tool_use_id": b.id, "content": "truncated", "is_error": True}
                        for b in tool_uses
                    ]
                    sink.speak("Trochu som sa zamotal, skús to znova.")
                    return
                outcomes = await asyncio.gather(
                    *(self._registry.run(b.id, b.name, dict(b.input)) for b in tool_uses)
                )
                sink.mark("tools_done")
                for block, outcome in zip(tool_uses, outcomes):
                    self.last_turn["tools"].append(
                        {
                            "name": block.name,
                            "input": dict(block.input),
                            "result": outcome.tool_result.get("content"),
                            "error": bool(outcome.tool_result.get("is_error")),
                        }
                    )
                for outcome in outcomes:
                    if outcome.spoken:
                        sink.speak(outcome.spoken + " ")
                results = [o.tool_result for o in outcomes]
                if not any(o.needs_reply for o in outcomes):
                    # The reply was already spoken from the tool input; the
                    # results ride along with the next user turn.
                    self._pending_results = results
                    return
                self._messages.append({"role": "user", "content": results})
        finally:
            self._last_turn = time.monotonic()

    async def _round(self, sink: ReplySink):
        if self.simulate == "claude-slow":
            await asyncio.sleep(FIRST_TOKEN_TIMEOUT_S + 2)
        if self.simulate == "offline":
            raise BrainOffline("simulated")
        try:
            async with asyncio.timeout(FIRST_TOKEN_TIMEOUT_S) as deadline:
                # The automatic 5-minute breakpoint caches the conversation so far, search results included.
                async with self._client.beta.messages.stream(
                    max_tokens=MAX_TOKENS,
                    messages=self._messages,
                    cache_control={"type": "ephemeral"},
                    **self._params(self._system, self._tools),
                ) as stream:
                    async for event in stream:
                        if event.type == "text":
                            if deadline.when() is not None:
                                deadline.reschedule(None)
                                sink.mark("first_text")
                            self._spoke = True
                            sink.speak(event.text)
                        elif event.type == "content_block_start":
                            block = event.content_block
                            if block.type in ("tool_use", "server_tool_use") and deadline.when() is not None:
                                deadline.reschedule(None)
                                sink.mark("first_text")
                            if block.type == "server_tool_use" and not self._spoke:
                                self._spoke = True
                                sink.speak(random.choice(SEARCHING) + " ")
                    message = await stream.get_final_message()
        except TimeoutError as err:
            raise BrainSlow("no first token in time") from err
        except anthropic.AuthenticationError as err:
            raise BrainConfigError(str(err)) from err
        except anthropic.PermissionDeniedError as err:
            raise BrainConfigError(str(err)) from err
        except anthropic.RateLimitError as err:
            raise BrainBusy(str(err)) from err
        except (anthropic.APIConnectionError, anthropic.APITimeoutError) as err:
            raise BrainOffline(str(err)) from err
        except anthropic.APIStatusError as err:
            if err.status_code >= 500:
                raise BrainBusy(f"{err.status_code}: {err.message}") from err
            raise BrainConfigError(f"{err.status_code}: {err.message}") from err
        usage = message.usage
        self.last_turn["rounds"].append(
            {
                "model": message.model,
                "stop": message.stop_reason,
                "in": usage.input_tokens,
                "cache_read": usage.cache_read_input_tokens,
                "out": usage.output_tokens,
            }
        )
        log.info(
            "claude: model=%s stop=%s in=%s cache_read=%s cache_write=%s out=%s",
            message.model,
            message.stop_reason,
            usage.input_tokens,
            usage.cache_read_input_tokens,
            usage.cache_creation_input_tokens,
            usage.output_tokens,
        )
        return message


class FakeBrain:
    """Canned replies streamed word by word: exercises TTS, the face and the
    turn flow without API cost."""

    _REPLIES = [
        "Jasné, som tu. Čo potrebuješ?",
        "Hm, to je dobrá otázka. Ale odpoveď ti nedám, som len skúšobná verzia.",
        "Hotovo. Teda, tváril by som sa, že je hotovo, keby som niečo vedel.",
    ]

    def __init__(self) -> None:
        self._i = 0
        self.last_turn: dict[str, Any] = {"rounds": [], "tools": []}

    async def prewarm(self) -> None:
        pass

    async def respond(self, text: str, sink: ReplySink) -> None:
        reply = self._REPLIES[self._i % len(self._REPLIES)]
        self._i += 1
        await asyncio.sleep(0.4)
        sink.mark("first_text")
        for word in reply.split(" "):
            sink.speak(word + " ")
            await asyncio.sleep(0.04)
