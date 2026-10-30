"""Command registry.

A command is a plain function in a module of this package, decorated with
`@command`. Its signature becomes the tool's JSON Schema, so adding a command
means adding one function — nothing else needs to know about it:

    @command("Nastaví hlasitosť systému.")
    def set_volume(level: Annotated[int, "0 až 100"]) -> str:
        ...

Action commands (`speaks=True`, the default) get an extra `say` argument: the
sentence Claude wants spoken once the action has run. That keeps actions to a
single model call — the reply is spoken straight from the tool input. Query
commands (`speaks=False`) return data instead, and Claude phrases the answer
in a second call.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import logging
import pkgutil
import typing
from dataclasses import dataclass
from typing import Any, Callable, Literal, get_args, get_origin

from ..audio import ensure_com

log = logging.getLogger(__name__)

TIMEOUT_S = 5.0


class CommandError(Exception):
    """Raised by a command with a Slovak sentence to say to the user."""


@dataclass(frozen=True)
class Choices:
    """Annotated marker for a string argument whose allowed values are only
    known at runtime (e.g. the app whitelist)."""

    values: Callable[[], list[str]]


@dataclass
class Command:
    name: str
    description: str
    fn: Callable[..., Any]
    speaks: bool
    timeout: float

    def schema(self) -> dict[str, Any]:
        hints = typing.get_type_hints(self.fn, include_extras=True)
        props: dict[str, Any] = {}
        for pname in inspect.signature(self.fn).parameters:
            props[pname] = _param_schema(hints[pname])
        if self.speaks:
            props["say"] = {
                "type": "string",
                "description": "Krátka veta po slovensky, ktorú povieš používateľovi po vykonaní akcie.",
            }
        return {
            "type": "object",
            "properties": props,
            "required": list(props),
            "additionalProperties": False,
        }


_REGISTRY: dict[str, Command] = {}


def command(
    description: str, *, speaks: bool = True, timeout: float = TIMEOUT_S
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    def register(fn: Callable[..., Any]) -> Callable[..., Any]:
        _REGISTRY[fn.__name__] = Command(fn.__name__, description, fn, speaks, timeout)
        return fn

    return register


def _param_schema(hint: Any) -> dict[str, Any]:
    description = None
    choices: Choices | None = None
    if get_origin(hint) is typing.Annotated:
        base, *extras = get_args(hint)
        for extra in extras:
            if isinstance(extra, str):
                description = extra
            elif isinstance(extra, Choices):
                choices = extra
        hint = base
    if get_origin(hint) is Literal:
        schema: dict[str, Any] = {"type": "string", "enum": [str(v) for v in get_args(hint)]}
    elif hint is bool:
        schema = {"type": "boolean"}
    elif hint is int:
        schema = {"type": "integer"}
    elif hint is float:
        schema = {"type": "number"}
    elif hint is str:
        schema = {"type": "string"}
    else:
        raise TypeError(f"unsupported command parameter type: {hint!r}")
    if choices is not None:
        schema["enum"] = choices.values()
    if description:
        schema["description"] = description
    return schema


def _valid(value: Any, schema: dict[str, Any]) -> bool:
    kind = schema["type"]
    if kind == "string" and not isinstance(value, str):
        return False
    if kind == "boolean" and not isinstance(value, bool):
        return False
    if kind == "integer" and (isinstance(value, bool) or not isinstance(value, int)):
        return False
    if kind == "number" and (isinstance(value, bool) or not isinstance(value, (int, float))):
        return False
    return "enum" not in schema or value in schema["enum"]


@dataclass
class Outcome:
    tool_result: dict[str, Any]
    spoken: str | None
    needs_reply: bool


class Registry:
    def __init__(self) -> None:
        for mod in pkgutil.iter_modules(__path__):
            importlib.import_module(f"{__name__}.{mod.name}")
        self.commands = dict(sorted(_REGISTRY.items()))
        log.info("commands: %s", ", ".join(self.commands) or "none")

    def tool_defs(self) -> list[dict[str, Any]]:
        # Sorted and rebuilt identically every time: the tool list is part of
        # the cached prompt prefix. The API allows at most 20 strict tools, and
        # one without arguments gains nothing from it.
        return [
            {
                "name": cmd.name,
                "description": cmd.description,
                "input_schema": schema,
                "strict": bool(schema["properties"]),
                "eager_input_streaming": True,
            }
            for cmd in self.commands.values()
            for schema in (cmd.schema(),)
        ]

    async def run(self, tool_id: str, name: str, args: Any) -> Outcome:
        cmd = self.commands.get(name)
        if cmd is None:
            return _error(tool_id, f"unknown command {name}", "Toto neviem.")
        schema = cmd.schema()
        if not isinstance(args, dict) or set(args) != set(schema["properties"]) or not all(
            _valid(args[k], s) for k, s in schema["properties"].items()
        ):
            return _error(tool_id, "INVALID_INPUT " + json.dumps(args, ensure_ascii=False), None, needs_reply=True)

        say = args.pop("say", None) if cmd.speaks else None
        try:
            result = await asyncio.wait_for(asyncio.to_thread(_call, cmd.fn, args), cmd.timeout)
        except CommandError as err:
            return _error(tool_id, str(err), str(err))
        except asyncio.TimeoutError:
            return _error(tool_id, "timed out", "Nejako sa to zaseklo.")
        except Exception as err:
            log.exception("command %s failed", name)
            return _error(tool_id, f"{type(err).__name__}: {err}", "Toto sa mi nepodarilo.")

        content = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
        return Outcome(
            {"type": "tool_result", "tool_use_id": tool_id, "content": content or "ok"},
            spoken=say,
            needs_reply=not cmd.speaks,
        )


def _call(fn: Callable[..., Any], args: dict[str, Any]) -> Any:
    # Volume and media APIs are COM/WinRT; pool threads start uninitialised.
    ensure_com()
    return fn(**args)


def _error(tool_id: str, detail: str, spoken: str | None, needs_reply: bool = False) -> Outcome:
    return Outcome(
        {"type": "tool_result", "tool_use_id": tool_id, "content": detail, "is_error": True},
        spoken=spoken,
        needs_reply=needs_reply,
    )
