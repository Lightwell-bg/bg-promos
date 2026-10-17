from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from bg_promos.config import ChainSettings, Settings
from bg_promos.models import Offer, PriceCondition
from bg_promos.sources.base import RawDocument

FIXTURES = Path(__file__).parent / "fixtures"


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def fixture_doc(name: str, url: str = "https://example.test/") -> RawDocument:
    return RawDocument(name.split(".")[0], url, fixture_bytes(name))


def make_offer(
    chain: str = "lidl",
    key: str = "1",
    name: str = "Test",
    valid_from: date | None = date(2026, 10, 12),
    valid_to: date | None = date(2026, 10, 18),
    prices: list[PriceCondition] | None = None,
    product_ref: str | None = None,
) -> Offer:
    if prices is None:
        prices = [PriceCondition("regular", 200), PriceCondition("promo", 150, discount_pct=25)]
    return Offer(
        chain=chain, source_key=key, product_ref=product_ref or key, name=name,
        valid_from=valid_from, valid_to=valid_to, prices=prices,
    )


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        contact="test@example.test",
        chains={
            "lidl": ChainSettings(True, min_expected_offers=2),
            "kaufland": ChainSettings(True, min_expected_offers=2),
            "billa": ChainSettings(True, min_expected_offers=2),
        },
    )
