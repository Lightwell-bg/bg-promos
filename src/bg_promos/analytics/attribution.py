"""Traffic source attribution (no guessing).

Formats (owner decision 2026-10-18):
- Site: UTM parameters utm_source / utm_medium / utm_campaign / utm_content (placement).
- Bot deep link:   https://t.me/<bot>?start=s_<campaign>[-<placement>]
- Mini App link:   https://t.me/<bot>?startapp=s_<campaign>[-<placement>]
                   with a cart: startapp=s_<campaign>[-<placement>]__c1_<items>   (old c1_… stay valid)
  <campaign> = [a-z0-9]{1,32}, <placement> = [a-z0-9_]{1,40} (lowercased).
- Otherwise an external referrer host (never our own domain, never Telegram's own pages
  without a label - a click from a channel carries no reliable channel identity).
- Nothing reliable -> kind "unknown" ("Источник неизвестен"). Never attributed to a channel
  without data.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

_LABEL_RE = re.compile(r"^s_([a-z0-9]{1,32})(?:-([a-z0-9_]{1,40}))?$")
_UTM_VALUE_RE = re.compile(r"[^a-z0-9._\-]")
# hosts that never identify a concrete source on their own
_OPAQUE_REFERRERS = ("t.me", "telegram.org", "web.telegram.org", "telegram.me")


@dataclass(frozen=True, slots=True)
class Source:
    kind: str  # utm | start | startapp | referrer | unknown
    source: str | None = None  # utm_source / "telegram" / referrer host
    medium: str | None = None
    campaign: str | None = None
    placement: str | None = None

    @property
    def key(self) -> tuple:
        return (self.kind, self.source, self.medium, self.campaign, self.placement)


UNKNOWN = Source("unknown")

# Old shared-cart links (bare startapp=c1_…) carried no label: tagged as campaign share / placement legacy.
LEGACY_SHARE = Source("startapp", source="telegram", medium="miniapp", campaign="share", placement="legacy")


def split_start_param(param: str | None) -> tuple[str | None, str | None]:
    """'s_x-y__c1_…' -> ('s_x-y', 'c1_…'); 'c1_…' -> (None, 'c1_…'); 's_x' -> ('s_x', None)."""
    if not param:
        return None, None
    if param.startswith("c1_"):
        return None, param
    label, sep, cart = param.partition("__")
    if not label.startswith("s_"):
        return None, None
    return label, (cart if sep and cart.startswith("c1_") else None)


def parse_label(label: str | None, kind: str) -> Source:
    """Parse 's_<campaign>[-<placement>]' from start/startapp; anything else -> unknown."""
    if not label:
        return UNKNOWN
    m = _LABEL_RE.match(label.strip().lower())
    if not m:
        return UNKNOWN
    return Source(kind=kind, source="telegram", medium="bot" if kind == "start" else "miniapp",
                  campaign=m.group(1), placement=m.group(2))


def _utm(v: object) -> str | None:
    if not isinstance(v, str):
        return None
    clean = _UTM_VALUE_RE.sub("", v.strip().lower())[:64]
    return clean or None


def from_utm(params: dict[str, object]) -> Source | None:
    src = _utm(params.get("utm_source"))
    camp = _utm(params.get("utm_campaign"))
    if not src and not camp:
        return None
    return Source("utm", source=src, medium=_utm(params.get("utm_medium")), campaign=camp,
                  placement=_utm(params.get("utm_content")))


def from_referrer(referrer: object, own_hosts: tuple[str, ...]) -> Source | None:
    if not isinstance(referrer, str) or not referrer:
        return None
    try:
        host = (urlsplit(referrer).hostname or "").lower()
    except ValueError:
        return None
    if not host or host in own_hosts or any(host == h or host.endswith("." + h) for h in own_hosts):
        return None
    if any(host == h or host.endswith("." + h) for h in _OPAQUE_REFERRERS):
        return None
    host = host[4:] if host.startswith("www.") else host
    return Source("referrer", source=host[:64])


def resolve_site_source(params: dict[str, object], referrer: object, own_hosts: tuple[str, ...]) -> Source:
    """Site session: UTM first, then an external referrer, else unknown."""
    return from_utm(params) or from_referrer(referrer, own_hosts) or UNKNOWN
