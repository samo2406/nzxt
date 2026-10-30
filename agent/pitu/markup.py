"""Face cues the model writes inline: `{happy}`, `{card:rain|12 °C|Nitra, zajtra}`.

They are cut out of the reply before it is spoken; each one keeps the
position in the spoken text where it stood, so it can be timed to the audio.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

EMOTIONS = frozenset(
    {"neutral", "happy", "laugh", "confused", "surprised", "sad", "annoyed", "thinking", "excited", "wink", "sleepy"}
)
ICONS = frozenset(
    {"sun", "cloud", "rain", "snow", "storm", "fog", "wind", "temp", "cpu", "gpu", "music", "timer", "clock", "check",
     "info", "warning"}
)
# An unclosed brace longer than this was never a tag; it is spoken as text.
MAX_TAG = 80


@dataclass
class Cue:
    at: int
    message: dict[str, Any]


def parse(tag: str) -> dict[str, Any] | None:
    tag = tag.strip()
    if tag.lower() in EMOTIONS:
        return {"type": "emotion", "name": tag.lower()}
    kind, _, rest = tag.partition(":")
    if kind.strip().lower() != "card":
        return None
    parts = [p.strip() for p in rest.split("|")]
    if len(parts) < 2 or not parts[1]:
        return None
    icon = parts[0].lower()
    return {
        "type": "card",
        "icon": icon if icon in ICONS else "info",
        "value": parts[1][:16],
        "label": (parts[2] if len(parts) > 2 else "")[:40],
    }


class MarkupFilter:
    """Fed the reply as it streams; tags may be split across chunks."""

    def __init__(self) -> None:
        self.spoken = ""
        self._open: str | None = None

    def feed(self, text: str) -> tuple[str, list[Cue]]:
        out: list[str] = []
        cues: list[Cue] = []
        for ch in text:
            if self._open is None:
                if ch == "{":
                    self._open = ""
                else:
                    out.append(ch)
                continue
            if ch == "}":
                message = parse(self._open)
                self._open = None
                if message:
                    cues.append(Cue(len(self.spoken) + len(out), message))
            elif len(self._open) >= MAX_TAG:
                out.append("{" + self._open + ch)
                self._open = None
            else:
                self._open += ch
        clean = "".join(out)
        self.spoken += clean
        return clean, cues
