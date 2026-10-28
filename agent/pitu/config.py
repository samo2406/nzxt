from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

AGENT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = AGENT_DIR / "data"
PERSONA_PATH = AGENT_DIR / "persona.md"
PERSONA_LOCAL_PATH = AGENT_DIR / "persona.local.md"
APPS_PATH = AGENT_DIR / "apps.toml"

PAGES_ORIGIN = ("https://samo2406.github.io",)
# Any local Vite project uses these ports, so they are trusted only on request.
DEV_ORIGINS = ("http://127.0.0.1:5173", "http://127.0.0.1:4173")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _wake_model(value: str) -> str:
    if not value.endswith(".onnx"):
        return value
    path = Path(value)
    return str(path if path.is_absolute() else AGENT_DIR / path)


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Config:
    azure_key: str
    azure_region: str
    claude_model: str
    claude_effort: str
    tts_voice: str
    tts_rate: float
    wake_model: str
    wake_threshold: float
    mic_device: str
    speaker_device: str
    volume: float
    follow_up_s: float
    end_silence_ms: int
    face_port: int
    duck_level: float
    allowed_origins: tuple[str, ...]

    @property
    def has_azure(self) -> bool:
        return bool(self.azure_key and self.azure_region)

    @property
    def has_anthropic(self) -> bool:
        return bool(_env("ANTHROPIC_API_KEY") or _env("ANTHROPIC_AUTH_TOKEN"))


def load_config() -> Config:
    load_dotenv(AGENT_DIR / ".env")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return Config(
        azure_key=_env("AZURE_SPEECH_KEY"),
        azure_region=_env("AZURE_SPEECH_REGION", "westeurope"),
        claude_model=_env("PITU_MODEL", "claude-haiku-5-5"),
        claude_effort=_env("PITU_EFFORT", "low"),
        tts_voice=_env("TTS_VOICE", "sk-SK-LukasNeural"),
        tts_rate=_env_float("TTS_RATE", 1.05),
        wake_model=_wake_model(_env("WAKE_MODEL", "models/hej_pitu.onnx")),
        wake_threshold=_env_float("WAKE_THRESHOLD", 0.5),
        mic_device=_env("MIC_DEVICE"),
        speaker_device=_env("SPEAKER_DEVICE"),
        volume=min(1.0, max(0.0, _env_float("VOLUME", 1.0))),
        follow_up_s=_env_float("FOLLOW_UP_SECONDS", 5.0),
        end_silence_ms=int(_env_float("END_SILENCE_MS", 450)),
        face_port=int(_env_float("FACE_PORT", 8765)),
        duck_level=min(1.0, max(0.0, _env_float("DUCK_LEVEL", 0.3))),
        allowed_origins=PAGES_ORIGIN + (DEV_ORIGINS if _env("FACE_DEV_ORIGINS") == "1" else ()),
    )
