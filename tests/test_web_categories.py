from __future__ import annotations

import pytest

from bg_promos.web.categories import CATEGORIES, CATEGORY_IDS, classify

LIDL = "Светове на нуждата/Храна и близки до нея храни/"


@pytest.mark.parametrize(
    "chain, chain_cat, name, expected",
    [
        ("billa", None, "Пилешко филе", "meat_fish"),
        ("billa", None, "Кашкавал", "dairy_eggs"),
        ("billa", None, "Соколово Варено-пушена свинска плешка", "deli"),
        ("billa", None, "Маслиново масло", "pantry"),
        ("billa", None, "Ariel Гел капсули", "household"),
        ("kaufland", "Дрогерия, храна за домашни любимци", "Garnier Мицеларна вода", "beauty"),
        ("kaufland", "Дрогерия, храна за домашни любимци", "Gourmet Gold Храна за котки", "pets"),
        ("lidl", LIDL + "Сирена, млечни продукти и яйца/Кисело мляко", "Кисело мляко", "dairy_eggs"),
        ("kaufland", "Супер уикенд  14.10.2026 - 17.10.2026", "Сьомга котлет", "meat_fish"),
        ("lidl", LIDL + "Хляб и тестени изделия/Хлебчета и багети", "Хлебчета", "bakery"),
        ("lidl", LIDL + "Хляб и тестени изделия/Солени закуски", "Солети", "sweets_snacks"),
        ("lidl", LIDL + "Хляб и тестени изделия/Сладки закуски", "Донат", "bakery"),
        ("lidl", "Светове на нуждата/Стоки за домашни любимци/Артикули за кучета/Храна за кучета/Суха храна", "X", "pets"),
        ("lidl", LIDL + "Охладени продукти/Готови ястия, съхранявани в хладилник", "Готово ястие", "deli"),
        ("kaufland", "Плодове и зеленчуци", "Домати", "produce"),
        ("kaufland", "Млечни продукти", "Сирене", "dairy_eggs"),
        ("kaufland", "Алкохолни и безалкохолни напитки", "Бира Загорка", "alcohol"),
        ("kaufland", "Алкохолни и безалкохолни напитки", "Натурален сок", "drinks"),
        ("kaufland", "Месо, птиче месо, колбаси", "Луканка", "deli"),
        ("kaufland", "Месо, птиче месо, колбаси", "Свинско бонфиле", "meat_fish"),
        ("kaufland", "Домашни потреби", "Препарат за съдове", "household"),
        ("billa", None, "Шоколад Милка", "sweets_snacks"),
        ("billa", None, "Кафе на зърна", "coffee_tea"),
        ("billa", None, "Бебешки пелени", "baby"),
        ("billa", None, "Паста за зъби Colgate", "beauty"),
        ("billa", None, "Четка за зъби", "beauty"),
        ("billa", None, "Масло за тяло Nivea", "beauty"),
        ("billa", None, "Масло за коса", "beauty"),
        ("billa", None, "Sensodyne Repair", "beauty"),
        ("billa", None, "Aquafresh Triple", "beauty"),
        ("billa", None, "Паста Барила спагети", "pantry"),
        ("billa", None, "Краве масло", "dairy_eggs"),
        ("billa", None, "Замразена пица Dr. Oetker", "frozen"),
        ("billa", None, "Пица замразена", "frozen"),
        ("billa", None, "Пица Маргарита", "bakery"),
        ("billa", None, "Червен пипер", "pantry"),
        ("billa", None, "Доматено пюре", "pantry"),
        ("billa", None, "Консерва зелен фасул", "pantry"),
        ("billa", None, "Праскови в сироп", "pantry"),
        ("billa", None, "Сладко от ягоди", "pantry"),
        ("billa", None, "Конфитюр от кайсии", "pantry"),
        ("billa", None, "Кисело зеле", "pantry"),
        ("billa", None, "Червено вино Мерло", "alcohol"),
        ("billa", None, "Грозде бяло", "produce"),
        ("billa", None, "Узо Пломари", "alcohol"),
        ("billa", None, "Gourmet Gold пастет", "pets"),
        ("billa", None, "Храна за птици", "pets"),
        ("billa", None, "Рибни пръчици", "meat_fish"),
        ("billa", None, "Риба тон", "meat_fish"),
        ("billa", None, "Нещо съвсем неясно", "other"),
    ],
)
def test_classify(chain, chain_cat, name, expected):
    assert classify(chain, chain_cat, name) == expected


def test_description_is_used_for_generic_names():
    assert classify("billa", None, "на 100 г", "Сьомга филе") == "meat_fish"
    assert classify("billa", None, "на 100 г") == "other"


def test_category_table_is_consistent():
    ids = [c[0] for c in CATEGORIES]
    assert len(ids) == len(set(ids)) and "other" in CATEGORY_IDS
    for _id, bg, ru, icon in CATEGORIES:
        assert bg and ru and icon
