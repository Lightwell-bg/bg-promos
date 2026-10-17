from __future__ import annotations

import pytest

from bg_promos.models import to_cents


@pytest.mark.parametrize(
    "value, expected",
    [
        ("1,99", 199),
        ("1.99", 199),
        (1.99, 199),
        ("1,99 €", 199),
        ("1.299,00", 129900),
        ("1,299.00", 129900),
        ("1 299,00", 129900),
        ("1\xa0299,00 €", 129900),
        ("", None),
        (None, None),
        ("abc", None),
    ],
)
def test_to_cents(value, expected):
    assert to_cents(value) == expected
