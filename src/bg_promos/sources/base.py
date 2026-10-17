"""Contract every chain adapter implements.

An adapter is split into two pure-ish steps so parsing can be unit-tested on
saved fixtures without network:

    docs = source.fetch(http)     # network only, returns raw documents
    offers = source.parse(docs)   # no network, raises SourceFormatError on drift
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..http import HttpClient
    from ..models import Offer


class SourceFormatError(Exception):
    """The source answered, but its structure is not what the parser expects."""


@dataclass(frozen=True, slots=True)
class RawDocument:
    name: str  # short label used for the raw archive file, e.g. "page-0003"
    url: str
    content: bytes
    content_type: str = ""

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")


class Source(Protocol):
    chain: str

    def fetch(self, http: HttpClient) -> list[RawDocument]: ...

    def parse(self, docs: list[RawDocument]) -> list[Offer]: ...
