from __future__ import annotations

import pytest

from bg_promos.web.units import unit_price


@pytest.mark.parametrize("unit_text", ["За 1 кг", "за kg", "кг"])
def test_published_per_kg(unit_text):
    assert unit_price(499, unit_text, "Домати") == {"cents": 499, "per": "kg", "source": "published"}


def test_published_per_litre():
    assert unit_price(120, "за 1 л", "Мляко") == {"cents": 120, "per": "l", "source": "published"}


@pytest.mark.parametrize(
    "unit_text, per_item, expected",
    [
        ("400 г", 200, {"cents": 500, "per": "kg", "source": "computed"}),
        ("0.7 l/опаковка", 700, {"cents": 1000, "per": "l", "source": "computed"}),
        ("1,5 л PET", 150, {"cents": 100, "per": "l", "source": "computed"}),
        ("500 мл", 250, {"cents": 500, "per": "l", "source": "computed"}),
        ("2 kg", 800, {"cents": 400, "per": "kg", "source": "computed"}),
    ],
)
def test_computed_from_single_quantity(unit_text, per_item, expected):
    assert unit_price(per_item, unit_text, "Продукт") == expected


@pytest.mark.parametrize("unit_text", ["50 - 150 мл", "2 х 400 г", "2 x 400 g", "32 + 8 бр.", "бр.", "", None, "голяма опаковка"])
def test_rejected_unit_texts(unit_text):
    assert unit_price(300, unit_text, "Продукт") is None


def test_name_with_other_size_is_rejected():
    assert unit_price(300, "400 мл", "Шампоан 400 мл или Спрей 200 мл") is None
    assert unit_price(300, "400 г", "Сирене 500 г") is None


@pytest.mark.parametrize(
    "name",
    [
        "Комплект 2 x 400 г",
        "Комплект 2х400г",
        "Кисело мляко 3 бр. x 400 г",
        "Сирене 400 г + 100 г подарък",
        "Бисквити 200–400 г",
        "Бисквити 200-400 г",
        "Бисквити 200 - 400г",
    ],
)
def test_name_with_multiplier_or_range_is_rejected(name):
    assert unit_price(300, "400 г", name) is None


def test_name_with_same_size_is_accepted():
    assert unit_price(300, "400 г", "Сирене 400 г")["cents"] == 750


@pytest.mark.parametrize("per_item, unit_text", [(1, "5 кг"), (0, "400 г"), (-5, "400 г"), (10_000_000, "100 г")])
def test_sanity_bounds(per_item, unit_text):
    assert unit_price(per_item, unit_text, "Продукт") is None
