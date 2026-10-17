"""Settings loaded from config.ini (non-secret) plus .env overrides."""

from __future__ import annotations

import configparser
import os
from dataclasses import dataclass, field
from datetime import time
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[2]


@dataclass(slots=True)
class ChainSettings:
    enabled: bool = True
    min_expected_offers: int = 0
    options: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class Settings:
    data_dir: Path
    timezone: str = "Europe/Sofia"
    contact: str = ""
    raw_retention_days: int = 14
    timeout: float = 30.0
    delay_seconds: float = 1.0
    retries: int = 3
    backoff_seconds: float = 2.0
    slots: tuple[time, ...] = (time(6, 30), time(12, 30), time(18, 30))
    history_runs: int = 5
    min_ratio: float = 0.6
    stale_after_hours: float = 36.0
    max_retries_per_slot: int = 3
    chains: dict[str, ChainSettings] = field(default_factory=dict)
    log_level: str = "INFO"

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @property
    def user_agent(self) -> str:
        return f"BGPromosBot/0.1 (+contact: {self.contact})"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "bg_promos.sqlite3"

    def chain(self, name: str) -> ChainSettings:
        return self.chains.get(name) or ChainSettings(enabled=False)


def _parse_slots(value: str) -> tuple[time, ...]:
    slots = []
    for part in value.split(","):
        part = part.strip()
        if part:
            h, m = part.split(":")
            slots.append(time(int(h), int(m)))
    return tuple(sorted(slots))


def load(path: str | os.PathLike[str] | None = None) -> Settings:
    """Load settings. Config path: argument > BG_PROMOS_CONFIG > <project root>/config.ini."""
    load_dotenv(PROJECT_ROOT / ".env")
    cfg_path = Path(path or os.environ.get("BG_PROMOS_CONFIG") or PROJECT_ROOT / "config.ini")
    cp = configparser.ConfigParser()
    if not cp.read(cfg_path, encoding="utf-8"):
        raise FileNotFoundError(f"config file not found: {cfg_path}")

    g, h, s, c = cp["general"], cp["http"], cp["schedule"], cp["completeness"]
    data_dir = Path(os.environ.get("BG_PROMOS_DATA_DIR") or g.get("data_dir", "data"))
    if not data_dir.is_absolute():
        data_dir = cfg_path.resolve().parent / data_dir

    chains = {}
    for name in ("lidl", "kaufland", "billa"):
        if name in cp:
            sec = cp[name]
            chains[name] = ChainSettings(
                enabled=sec.getboolean("enabled", fallback=True),
                min_expected_offers=sec.getint("min_expected_offers", fallback=0),
                options={k: v for k, v in sec.items() if k not in ("enabled", "min_expected_offers")},
            )

    return Settings(
        data_dir=data_dir,
        timezone=g.get("timezone", "Europe/Sofia"),
        contact=g.get("contact", ""),
        raw_retention_days=g.getint("raw_retention_days", fallback=14),
        timeout=h.getfloat("timeout", fallback=30.0),
        delay_seconds=h.getfloat("delay_seconds", fallback=1.0),
        retries=h.getint("retries", fallback=3),
        backoff_seconds=h.getfloat("backoff_seconds", fallback=2.0),
        slots=_parse_slots(s.get("slots", "06:30,12:30,18:30")),
        history_runs=c.getint("history_runs", fallback=5),
        min_ratio=c.getfloat("min_ratio", fallback=0.6),
        stale_after_hours=c.getfloat("stale_after_hours", fallback=36.0),
        max_retries_per_slot=c.getint("max_retries_per_slot", fallback=3),
        chains=chains,
        log_level=(os.environ.get("LOG_LEVEL") or "INFO").upper(),
    )
