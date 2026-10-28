from __future__ import annotations

import hashlib
import logging
import threading
import time

from .config import DATA_DIR, Config
from .tts import TextToSpeech

log = logging.getLogger(__name__)

# Spoken when the cloud is unreachable, so they have to exist on disk before
# they are needed.
PHRASES = {
    "offline": "Nejde mi internet. Skús to o chvíľu.",
    "busy": "Mám toho teraz trochu veľa. Skús to o minútku.",
    "slow": "Nejako mi to trvá. Skús to ešte raz.",
    "broken": "Niečo sa mi pokazilo. Pozri sa do logu.",
    "no_keys": "Chýbajú mi kľúče v súbore env.",
    "timer": "Čas vypršal.",
}

# F0 allows 20 synthesis requests per minute; the cache must not eat a burst.
_SPACING_S = 4.0


class PhraseCache:
    def __init__(self, cfg: Config, tts: TextToSpeech) -> None:
        self._cfg = cfg
        self._tts = tts
        self._dir = DATA_DIR / "phrases"
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str):
        text = PHRASES[key]
        digest = hashlib.sha1(f"{self._cfg.tts_voice}|{self._cfg.tts_rate}|{text}".encode()).hexdigest()[:10]
        return self._dir / f"{key}-{digest}.pcm"

    def get(self, key: str) -> bytes | None:
        path = self._path(key)
        return path.read_bytes() if path.exists() else None

    def fill_in_background(self) -> None:
        if not self._cfg.has_azure:
            return
        threading.Thread(target=self._fill, name="phrases", daemon=True).start()

    def _fill(self) -> None:
        for key in PHRASES:
            path = self._path(key)
            if path.exists():
                continue
            try:
                pcm = self._tts.synthesize(PHRASES[key])
            except Exception as err:
                log.info("phrase cache: %s not built yet (%s)", key, err)
                return
            path.write_bytes(pcm)
            log.info("phrase cache: built %s", key)
            time.sleep(_SPACING_S)
