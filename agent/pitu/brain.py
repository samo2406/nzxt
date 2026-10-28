from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Any, Protocol

import anthropic

from .commands import Registry
from .config import PERSONA_LOCAL_PATH, PERSONA_PATH, Config

log = logging.getLogger(__name__)

FIRST_TOKEN_TIMEOUT_S = 8.0
MEMORY_S = 180.0
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
        self._tools = registry.tool_defs()
        self._persona = Persona()
        self._messages: list[dict[str, Any]] = []
        self._pending_results: list[dict[str, Any]] = []
        self._last_turn = 0.0
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

    def _start_turn(self, text: str) -> None:
        # Editing the system prompt or tools invalidates earlier thinking
        # blocks, so a persona edit starts a fresh conversation instead.
        persona_changed = self._persona.refresh()
        expired = time.monotonic() - self._last_turn > MEMORY_S
        if persona_changed or expired:
            self._messages = []
            self._pending_results = []
            self._tools = self._registry.tool_defs()
        content = [*self._pending_results, {"type": "text", "text": f"{_context_line()} {text}"}]
        self._pending_results = []
        self._messages.append({"role": "user", "content": content})

    async def respond(self, text: str, sink: ReplySink) -> None:
        self.last_turn = {"rounds": [], "tools": []}
        self._start_turn(text)
        try:
            for _ in range(MAX_ROUNDS):
                message = await self._round(sink)
                self._messages.append({"role": "assistant", "content": message.content})
                if message.stop_reason == "refusal":
                    sink.speak("Na toto ti neodpoviem.")
                    return
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
        extra: dict[str, Any] = {"tools": self._tools} if self._tools else {}
        try:
            async with asyncio.timeout(FIRST_TOKEN_TIMEOUT_S) as deadline:
                async with self._client.beta.messages.stream(
                    model=self._cfg.claude_model,
                    max_tokens=MAX_TOKENS,
                    system=[{"type": "text", "text": self._persona.text, "cache_control": {"type": "ephemeral"}}],
                    messages=self._messages,
                    thinking={"type": "adaptive"},
                    output_config={"effort": self._cfg.claude_effort},
                    betas=["server-side-fallback-2026-07-01"],
                    fallbacks="default",
                    **extra,
                ) as stream:
                    async for event in stream:
                        if event.type == "text":
                            if deadline.when() is not None:
                                deadline.reschedule(None)
                                sink.mark("first_text")
                            sink.speak(event.text)
                        elif event.type == "content_block_start" and deadline.when() is not None:
                            if event.content_block.type == "tool_use":
                                deadline.reschedule(None)
                                sink.mark("first_text")
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
            "claude: model=%s stop=%s in=%s cache_read=%s out=%s",
            message.model,
            message.stop_reason,
            usage.input_tokens,
            usage.cache_read_input_tokens,
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
