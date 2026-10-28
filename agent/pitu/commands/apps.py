from __future__ import annotations

import logging
import os
import tomllib
import webbrowser
from typing import Annotated
from urllib.parse import quote_plus, urlparse

from ..config import APPS_PATH
from . import Choices, CommandError, command

log = logging.getLogger(__name__)

_cache: tuple[float, dict[str, str]] = (-1.0, {})


def apps() -> dict[str, str]:
    """The apps.toml whitelist, re-read when the file changes."""
    global _cache
    try:
        mtime = APPS_PATH.stat().st_mtime
    except FileNotFoundError:
        return {}
    if mtime != _cache[0]:
        try:
            table = tomllib.loads(APPS_PATH.read_text(encoding="utf-8")).get("apps", {})
            _cache = (mtime, {str(k): str(v) for k, v in table.items() if str(v).strip()})
        except (tomllib.TOMLDecodeError, OSError) as err:
            log.error("apps.toml unreadable, keeping the previous list: %s", err)
    return _cache[1]


def names() -> list[str]:
    # A strict enum can't be empty.
    return sorted(apps()) or ["-"]


@command("Otvorí aplikáciu alebo stránku zo zoznamu povolených.")
def open_app(name: Annotated[str, Choices(names)]) -> str:
    target = apps().get(name)
    if not target:
        raise CommandError("To v zozname nemám.")
    os.startfile(target)
    return f"opened {name}"


@command("Otvorí webovú stránku v prehliadači, keď povie konkrétnu adresu alebo známy web, ktorý nie je v zozname aplikácií.")
def open_website(url: Annotated[str, "celá adresa, napr. https://www.sme.sk"]) -> str:
    parsed = urlparse(url if "://" in url else f"https://{url}")
    if parsed.scheme not in ("http", "https") or not parsed.hostname or "." not in parsed.hostname:
        raise CommandError("Tú adresu neviem otvoriť.")
    webbrowser.open(parsed.geturl())
    return f"opened {parsed.hostname}"


@command(
    "Otvorí vyhľadávanie na Google v prehliadači. Len keď chce výsledky vidieť v prehliadači "
    "(„vygoogli mi…“, „otvor na Googli…“); inak hľadaj sám cez web_search a odpovedz."
)
def google_search(query: Annotated[str, "čo hľadať"]) -> str:
    if not query.strip():
        raise CommandError("Čo mám hľadať?")
    webbrowser.open(f"https://www.google.com/search?q={quote_plus(query)}")
    return "search opened"
