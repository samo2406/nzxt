from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any

from pycaw.pycaw import AudioUtilities

from .audio import ensure_com
from .config import DATA_DIR

log = logging.getLogger(__name__)

STATE_PATH = DATA_DIR / "ducking.json"
# A level the user dragged in the mixer while ducked is theirs; don't undo it.
MOVED_TOLERANCE = 0.02


def sessions() -> list[Any]:
    """Other processes' audio sessions on the default output device."""
    me = os.getpid()
    return [s for s in AudioUtilities.GetAllSessions() if s.ProcessId and s.ProcessId != me]


def process_name(session: Any) -> str:
    try:
        return session.Process.name() if session.Process else ""
    except Exception:
        return ""


class Ducker:
    """Turns other apps down while Piťu listens and talks.

    The original levels are written to disk before anything is changed, so a
    crash mid-turn can't leave Spotify or a game stuck at a third of its
    volume: the next start puts them back.
    """

    def __init__(self) -> None:
        self.level = 0.3
        self._lock = threading.Lock()
        # pid -> (process name, original level, level we set)
        self._saved: dict[int, tuple[str, float, float]] = {}

    @property
    def active(self) -> bool:
        return bool(self._saved)

    def duck(self) -> None:
        if self.level >= 1.0:
            return
        ensure_com()
        with self._lock:
            if self._saved:
                return
            plan = []
            for s in sessions():
                if s.ProcessId not in self._saved:
                    try:
                        original = s.SimpleAudioVolume.GetMasterVolume()
                    except Exception:
                        continue
                    self._saved[s.ProcessId] = (process_name(s), original, original * self.level)
                plan.append(s)
            self._persist()
            for s in plan:
                try:
                    s.SimpleAudioVolume.SetMasterVolume(self._saved[s.ProcessId][2], None)
                except Exception as err:
                    log.debug("duck %s failed: %s", s.ProcessId, err)

    def restore(self) -> None:
        ensure_com()
        with self._lock:
            if not self._saved:
                return
            self._apply_saved(self._saved)
            self._saved.clear()
            STATE_PATH.unlink(missing_ok=True)

    def recover(self) -> None:
        """Undo a duck left behind by a crash."""
        if not STATE_PATH.exists():
            return
        ensure_com()
        try:
            raw = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            saved = {int(pid): (name, float(orig), float(set_)) for pid, (name, orig, set_) in raw.items()}
        except Exception as err:
            log.warning("ducking state unreadable, dropping it: %s", err)
            STATE_PATH.unlink(missing_ok=True)
            return
        with self._lock:
            self._apply_saved(saved, match_name=True)
            STATE_PATH.unlink(missing_ok=True)
        log.info("restored volumes left ducked by the previous run")

    def set_volume(self, session: Any, level: float) -> None:
        """Set an app's level; while ducked it becomes the level restored afterwards."""
        with self._lock:
            saved = self._saved.get(session.ProcessId)
            if saved is None:
                session.SimpleAudioVolume.SetMasterVolume(level, None)
                return
            ducked = level * self.level
            self._saved[session.ProcessId] = (saved[0], level, ducked)
            self._persist()
            session.SimpleAudioVolume.SetMasterVolume(ducked, None)

    def volume_of(self, session: Any) -> float:
        saved = self._saved.get(session.ProcessId)
        return saved[1] if saved else session.SimpleAudioVolume.GetMasterVolume()

    def _apply_saved(self, saved: dict[int, tuple[str, float, float]], match_name: bool = False) -> None:
        for s in sessions():
            entry = saved.get(s.ProcessId)
            if entry is None or (match_name and entry[0] != process_name(s)):
                continue
            name, original, ducked = entry
            try:
                vol = s.SimpleAudioVolume
                if abs(vol.GetMasterVolume() - ducked) <= MOVED_TOLERANCE:
                    vol.SetMasterVolume(original, None)
            except Exception as err:
                log.debug("restore %s failed: %s", name, err)

    def _persist(self) -> None:
        if not self._saved:
            STATE_PATH.unlink(missing_ok=True)
            return
        STATE_PATH.write_text(
            json.dumps({str(pid): list(v) for pid, v in self._saved.items()}), encoding="utf-8"
        )


DUCKER = Ducker()
