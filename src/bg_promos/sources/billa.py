"""BILLA Bulgaria adapter.

Source: https://ssbbilla.site - the official text version of the weekly
brochure for visually impaired users (linked from billa.bg). Its robots.txt is
``Disallow: /``; the owner accepted using it politely (see docs/SOURCES.md).

Page shape: one server-rendered HTML page per brochure, a flat list of
``div.product`` rows. Each row has ``div.actualProduct`` (free text) and
fixed-width price columns: the 22%-wide one holds the old/regular price
(optionally followed by the discount percentage), the 21%-wide one holds the
offer price. The currency label after the percentage says "лв." - a site bug,
prices are in EUR. Multipack offers carry their prices only inside the text.
Rows without any price are headers, notes or marketing text and are skipped.
"""

from __future__ import annotations

import logging
import re
from datetime import date

import httpx
from bs4 import BeautifulSoup, Tag

from ..http import HttpBlockedError
from ..models import Offer, PriceCondition, pct_off, stable_hash, to_cents
from .base import RawDocument, SourceFormatError

log = logging.getLogger(__name__)

CHAIN = "billa"

DEFAULT_URLS = (
    "https://ssbbilla.site/catalog/sedmichna-broshura",
    "https://ssbbilla.site/catalog/predstoyashta-broshura",
)

_SEP = r"\s+[-–]\s+"
# Marketing tags that prefix the product text, e.g. "Кинг оферти - Сега в Billa - ...".
_TAGS = (
    "Кинг оферти",
    "Кешбек оферта",
    "Сега в Billa",
    "Само с Billa Card",
    "Само с Billa App",
    "Супер цена",
    "Ново в Billa",
    "Billa Ready",
)
_TAG_RE = re.compile(r"^(" + "|".join(re.escape(t) for t in _TAGS) + r")" + _SEP, re.I)
_LOYALTY_PROGRAMS = {"само с billa card": "billa_card", "само с billa app": "billa_app"}

_VALIDITY_RE = re.compile(
    r"Валидност:\s*от\s+\S+\s+(\d{1,2})\s*[.,]\s*(\d{1,2})\s*[.,]?\s+до\s+\S+\s+"
    r"(\d{1,2})\s*[.,]\s*(\d{1,2})\s*[.,]\s*(\d{4})"
)  # separators may be "." or "," ("от четвъртък 22,10, до сряда 28.10,2026 г.")
# Item-level period inside the text: "от 15.10 до 21.10.2026 г." / "от 15,10,2026 до 28,10,2026".
_ITEM_PERIOD_RE = re.compile(
    r"от\s+(\d{1,2})[.,](\d{1,2})(?:[.,](\d{4}))?[.,]?\s*(?:г\.)?\s*до\s+(\d{1,2})[.,](\d{1,2})[.,](\d{4})"
)
_ITEM_UNTIL_RE = re.compile(r"(?<!от )\bдо\s+(\d{1,2})\.(\d{1,2})\.(\d{4})")

_MULTI_HEAD_RE = re.compile(
    r"Мултипак оферта\s*(\d+\s*\+\s*\d+|за\s+\d+\s*бр\.)?(?:,\s*маркирана със синя звезда)?\s*",
    re.I,
)
_MULTI_UNIT_RE = re.compile(r"Цена за 1 бр\.\s*([\d.,]+)\s*€")
_MULTI_TOTAL_RE = re.compile(r"Цена за (\d+) бр\.\s*(с|без) отстъпка\s*([\d.,]+)\s*€")
_MULTI_PCT_RE = re.compile(r"Отстъпка\s*-?\s*(\d{1,2})\s*%")
_CASHBACK_RE = re.compile(r"\s*Кешбек в Billa Card\s*-\s*([\d.,]+)\s*€", re.I)
_ORIGIN_RE = re.compile(r"\s*Произход\s*-\s*(.+?)(?=\s+(?:Оферта|Продукт|Цена|До \d|1 изпиране)|$)")
_NOISE_RE = re.compile(
    r"\s*(?:(?:Продукт|Оферта),?\s+маркиран[аo]? със синя звезда\.?|Валидност на офертата|Billa Ready)",
    re.I,
)
_LIMIT_RE = re.compile(r"\s*(До \d+ бр\. на клиент(?: на ден)?)\*?", re.I)
_UNIT_RE = re.compile(
    r"(За 1 кг"
    r"|\d+(?:[.,]\d+)?\s*[xх]\s*\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?\s*(?:кг|г|мл|л)\b"
    r"|\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?\s*(?:кг|г|мл|л)(?![а-яa-z])"
    r"|\d+\s*бр\.(?:\s*в опаковка)?)",
    re.I,
)


class BillaSource:
    chain = CHAIN

    def __init__(self, urls: tuple[str, ...] | list[str] = DEFAULT_URLS) -> None:
        self.urls = tuple(urls)

    def fetch(self, http) -> list[RawDocument]:
        docs = []
        for i, url in enumerate(self.urls):
            try:
                resp = http.get(url)
            except HttpBlockedError:
                raise
            except httpx.HTTPStatusError as exc:
                # Only a 404 on a later url means "no upcoming brochure yet"; anything else
                # (5xx, timeouts, ...) fails the whole run so the previous snapshot stays.
                if i == 0 or exc.response.status_code != 404:
                    raise
                log.info("BILLA: %s not published yet (404), skipping", url)
                continue
            docs.append(RawDocument(f"brochure-{i}", url, resp.content, resp.headers.get("content-type", "")))
        return docs

    def parse(self, docs: list[RawDocument]) -> list[Offer]:
        offers: dict[tuple, Offer] = {}
        for idx, doc in enumerate(docs):
            for offer in parse_brochure(doc.text, doc.url, required=(idx == 0)):
                key = (offer.source_key, offer.valid_from, offer.valid_to)
                offers.setdefault(key, offer)  # same product listed twice -> keep first
        return list(offers.values())


def parse_brochure(html: str, url: str = "", *, required: bool = True) -> list[Offer]:
    """Parse one brochure page.

    ``required=False`` allows an empty page (the "upcoming" brochure is empty
    until BILLA publishes it). A page with product rows but no validity header
    is always a format error.
    """
    soup = BeautifulSoup(html, "html.parser")
    rows = soup.select("div.product")
    if not rows:
        if required:
            raise SourceFormatError(f"BILLA: no div.product rows at {url}")
        return []

    texts = [_row_text(r) for r in rows]
    period = None
    for t in texts:
        if m := _VALIDITY_RE.search(t):
            period = _period_from_header(m)
            break
    if period is None:
        raise SourceFormatError(f"BILLA: validity header not found at {url}")

    offers = []
    for row, text in zip(rows, texts):
        try:
            offer = _parse_row(row, text, period, url)
        except ValueError as exc:  # a single odd row must not kill the page
            log.warning("BILLA: skip row %r: %s", text[:80], exc)
            continue
        if offer:
            offers.append(offer)
    return offers


# The source sometimes glues two quantity fields without a space ("За 1 кг1 бр."): split a
# unit word from a directly following number so the unit regex sees two quantities.
_GLUED_UNIT_RE = re.compile(r"(?<![а-яa-z])(кг|гр|мл|бр\.|г|л)(?=\d)", re.I)


def _row_text(row: Tag) -> str:
    el = row.select_one("div.actualProduct")
    if not el:
        return ""
    return _GLUED_UNIT_RE.sub(r"\1 ", " ".join(el.get_text(" ").split()))


def _period_from_header(m: re.Match) -> tuple[date, date]:
    d1, m1, d2, m2, y2 = (int(x) for x in m.groups())
    end = date(y2, m2, d2)
    start_year = y2 - 1 if m1 > m2 else y2  # brochure crossing New Year
    return date(start_year, m1, d1), end


def _column_prices(row: Tag) -> tuple[list[str], list[str]]:
    """Return (spans of the 22% column, spans of the 21% column)."""
    old_col, new_col = [], []
    for div in row.find_all("div", recursive=False):
        style = (div.get("style") or "").replace(" ", "")
        spans = [s.get_text(strip=True) for s in div.select("span.price")]
        if "width:22%" in style:
            old_col = spans
        elif "width:21%" in style:
            new_col = spans
    return old_col, new_col


def _strip_tags(text: str) -> tuple[str, list[str]]:
    tags = []
    while m := _TAG_RE.match(text):
        tags.append(m.group(1))
        text = text[m.end():]
    return text.strip(), tags


def _parse_row(row: Tag, text: str, period: tuple[date, date], url: str) -> Offer | None:
    if not text:
        return None
    old_col, new_col = _column_prices(row)
    body, tags = _strip_tags(text)
    tag_keys = [t.lower() for t in tags]
    program = next((_LOYALTY_PROGRAMS[t] for t in tag_keys if t in _LOYALTY_PROGRAMS), None)

    notes: list[str] = []
    if m := _CASHBACK_RE.search(body):
        notes.append(f"Кешбек в Billa Card {m.group(1)} €")
        body = body[: m.start()] + body[m.end():]
    body = _NOISE_RE.sub("", body)
    if m := _LIMIT_RE.search(body):
        notes.append(m.group(1))
        body = body[: m.start()] + body[m.end():]
    origin = None
    if m := _ORIGIN_RE.search(body):
        origin = m.group(1).strip()
        body = body[: m.start()] + body[m.end():]

    # Dates may be printed after the prices, which the multipack branch cuts off the body.
    valid_from, valid_to = _item_period(body, period)
    prices: list[PriceCondition] = []
    multi = _MULTI_HEAD_RE.search(body)
    if old_col or new_col:
        prices = _column_conditions(old_col, new_col, program, notes)
    elif multi and _MULTI_TOTAL_RE.search(body):
        prices, body = _multipack_conditions(body, multi, notes, program)
        tags.append("Мултипак оферта")
    if not prices:
        return None  # header / note / marketing row

    body = _ITEM_PERIOD_RE.sub("", body)
    name = " ".join(body.split()).strip(" -–,")
    if not name:
        return None
    unit = None
    units = _UNIT_RE.findall(name)
    if units:
        unit = units[-1].strip()

    product_ref = stable_hash(_normalize_name(name))
    description = "; ".join(x for x in ([f"Произход: {origin}"] if origin else []) + notes) or None
    return Offer(
        chain=CHAIN,
        source_key=f"{product_ref}:{program}" if program else product_ref,
        product_ref=product_ref,
        name=name,
        valid_from=valid_from,
        valid_to=valid_to,
        prices=prices,
        description=description,
        unit_text=unit,
        offer_label=", ".join(tags) or None,
        product_url=None,
        raw={"text": text, "old_col": old_col, "new_col": new_col, "page": url},
    )


def _column_conditions(
    old_col: list[str], new_col: list[str], program: str | None, notes: list[str]
) -> list[PriceCondition]:
    regular = to_cents(old_col[0]) if old_col else None
    published_pct = None
    if len(old_col) > 1 and (m := re.match(r"(\d{1,3})\s*%", old_col[1])):
        published_pct = int(m.group(1))
    offer_price = to_cents(new_col[0]) if new_col else None

    out = []
    if regular is not None and offer_price is not None:
        out.append(PriceCondition("regular", regular))
    elif regular is not None:  # only the left column filled: treat it as the offer price
        offer_price, regular = regular, None
    if offer_price is not None:
        pct = published_pct if published_pct is not None else pct_off(regular, offer_price)
        kind = "loyalty" if program else "promo"
        cond_text = "; ".join(notes) or None
        out.append(PriceCondition(kind, offer_price, program=program, discount_pct=pct, condition_text=cond_text))
    return out


def _multipack_conditions(
    body: str, head: re.Match, notes: list[str], program: str | None = None
) -> tuple[list[PriceCondition], str]:
    deal = " ".join((head.group(1) or "").split()) or None
    unit_price = to_cents(m.group(1)) if (m := _MULTI_UNIT_RE.search(body)) else None
    totals = [(int(q), to_cents(v)) for q, _, v in _MULTI_TOTAL_RE.findall(body)]
    totals = [(q, v) for q, v in totals if v is not None and q > 1]
    if not totals:
        raise ValueError("multipack without totals")
    qty = max(q for q, _ in totals)
    values = [v for q, v in totals if q == qty]
    # The page sometimes labels both totals "без отстъпка"; the cheaper one is the deal.
    deal_total, full_total = min(values), max(values)
    if m := _MULTI_PCT_RE.search(body):
        pct = int(m.group(1))
    elif deal_total == full_total and unit_price is not None:  # a single total: compare with qty x unit price
        pct = pct_off(unit_price * qty, deal_total)
    else:
        pct = pct_off(full_total, deal_total)

    out = []
    if unit_price is not None:
        out.append(PriceCondition("regular", unit_price))
    text = f"{deal}: " if deal else ""
    text += f"{qty} бр. за " + f"{deal_total / 100:.2f}".replace(".", ",") + " €"
    if notes:
        text += "; " + "; ".join(notes)
    out.append(
        PriceCondition(
            "multibuy", deal_total, program=program, min_qty=qty, discount_pct=pct, condition_text=text
        )
    )

    # Product name = text between the multipack header and the first "Цена за".
    start = head.end()
    end = body.find("Цена за", start)
    name = body[start:end if end != -1 else None]
    name = _MULTI_PCT_RE.sub("", name)
    return out, name


def _item_period(text: str, period: tuple[date, date]) -> tuple[date, date]:
    start, end = period
    if m := _ITEM_PERIOD_RE.search(text):
        d1, m1, y1, d2, m2, y2 = m.groups()
        end = date(int(y2), int(m2), int(d2))
        y1i = int(y1) if y1 else (end.year - 1 if int(m1) > int(m2) else end.year)
        start = date(y1i, int(m1), int(d1))
    elif m := _ITEM_UNTIL_RE.search(text):
        end = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    return start, end


def _normalize_name(name: str) -> str:
    s = name.lower().replace("ё", "е")
    s = re.sub(r"\d+[.,]\d+\s*€", " ", s)  # prices inside text
    s = re.sub(r"[*\"'„“”.,]", " ", s)
    s = s.replace("х", "x")  # cyrillic х used as "times"
    return " ".join(s.split())
