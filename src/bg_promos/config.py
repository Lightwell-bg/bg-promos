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
    # ---- web API (stage 2) ----
    site_url: str = "https://promos.centerai.eu"
    cors_origins: tuple[str, ...] = (
        "https://promos.centerai.eu",
        "capacitor://localhost",
        "https://localhost",
        "http://localhost:5173",
        "http://localhost:4173",
    )
    ga4_id: str = ""
    contact_email: str = "info@centerai.eu"
    operator: str = "CenterAI"
    report_hourly_per_ip: int = 5
    report_daily_per_ip: int = 20
    report_daily_global: int = 100
    trusted_proxies: tuple[str, ...] = (
        "127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    )
    brochure_urls: dict[str, str] = field(default_factory=dict)
    offers_urls: dict[str, str] = field(default_factory=dict)
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    # ---- public Telegram bot @promoseubot (separate from the technical telegram_bot_token) ----
    promos_bot_token: str = ""
    bot_webapp_url: str = "https://promos.centerai.eu"
    bot_username: str = ""
    # ---- internal analytics (docs/ANALYTICS.md) ----
    clarity_id: str = ""
    analytics_enabled: bool = True
    admin_cookie_secure: bool = True
    analytics_secret: str = ""
    admin_password: str = ""

    @property
    def analytics_db_path(self) -> Path:
        return self.data_dir / "analytics.sqlite3"

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

    w = cp["web"] if "web" in cp else {}
    defaults = Settings(data_dir=data_dir)

    def web_list(key: str, default: tuple[str, ...]) -> tuple[str, ...]:
        raw = w.get(key) if w else None
        if raw is None:
            return default
        return tuple(x.strip() for x in raw.split(",") if x.strip())

    def web_int(key: str, default: int) -> int:
        return int(w.get(key)) if w and w.get(key, "").strip() else default

    def web_str(key: str, default: str) -> str:
        return w.get(key, default).strip() if w else default

    def section(name: str) -> dict[str, str]:
        return {k: v.strip() for k, v in cp[name].items() if v.strip()} if name in cp else {}

    return Settings(
        data_dir=data_dir,
        site_url=web_str("site_url", defaults.site_url),
        cors_origins=web_list("cors_origins", defaults.cors_origins),
        ga4_id=web_str("ga4_id", ""),
        clarity_id=web_str("clarity_id", ""),
        analytics_enabled=web_str("analytics_enabled", "true").lower() not in ("false", "0", "no", "off"),
        # BG_PROMOS_ADMIN_COOKIE_SECURE=0 overrides config.ini (local http runs only)
        admin_cookie_secure=(
            os.environ.get("BG_PROMOS_ADMIN_COOKIE_SECURE") or web_str("admin_cookie_secure", "true")
        ).strip().lower() not in ("false", "0", "no", "off"),
        analytics_secret=(os.environ.get("ANALYTICS_SECRET") or "").strip(),
        admin_password=os.environ.get("ADMIN_PASSWORD") or "",
        contact_email=web_str("contact_email", defaults.contact_email),
        operator=web_str("operator", defaults.operator),
        report_hourly_per_ip=web_int("report_hourly_per_ip", defaults.report_hourly_per_ip),
        report_daily_per_ip=web_int("report_daily_per_ip", defaults.report_daily_per_ip),
        report_daily_global=web_int("report_daily_global", defaults.report_daily_global),
        trusted_proxies=web_list("trusted_proxies", defaults.trusted_proxies),
        brochure_urls=section("brochures"),
        offers_urls=section("offers_urls"),
        telegram_bot_token=(os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip(),
        telegram_chat_id=(os.environ.get("TELEGRAM_CHAT_ID") or "").strip(),
        promos_bot_token=(os.environ.get("PROMOS_BOT_TOKEN") or "").strip(),
        bot_webapp_url=(
            cp["bot"].get("webapp_url", "").strip() if "bot" in cp else ""
        ) or defaults.bot_webapp_url,
        bot_username=(cp["bot"].get("username", "").strip().lstrip("@") if "bot" in cp else ""),
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
