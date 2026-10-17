"""Command line: collect / export / stats."""

from __future__ import annotations

import argparse
import logging
import sys
from collections.abc import Sequence

from . import config
from .pipeline import CHAINS, collect
from .storage import Storage

log = logging.getLogger("bg_promos")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bg-promos", description="Collect promo offers of Lidl, Kaufland, BILLA")
    parser.add_argument("--config", help="path to config.ini (default: BG_PROMOS_CONFIG or project config.ini)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_collect = sub.add_parser("collect", help="fetch, parse, store and export")
    p_collect.add_argument("--chain", action="append", choices=CHAINS, help="limit to a chain (repeatable)")
    p_collect.add_argument("--scheduled", action="store_true", help="only chains that are due in the current slot")
    p_collect.add_argument("--no-export", action="store_true", help="do not refresh the JSON files")
    p_collect.add_argument(
        "--accept-suspicious", action="store_true",
        help="save offers even when the completeness thresholds fail (count must be > 0)",
    )

    sub.add_parser("export", help="regenerate the JSON files from the database")
    sub.add_parser("stats", help="show last runs per chain")
    return parser


def _stats(settings: config.Settings) -> int:
    out = sys.stdout
    with Storage(settings.db_path) as storage:
        for chain, cs in settings.chains.items():
            last = storage.last_run(chain)
            ok = storage.last_run(chain, "ok")
            state = "" if cs.enabled else " (disabled)"
            out.write(f"{chain}{state}\n")
            if last is None:
                out.write("  last run: never\n")
                continue
            out.write(f"  last run: {last['status']} at {last['finished_at']}, offers: {last['offers_count']}\n")
            if last["error"]:
                out.write(f"  error: {last['error']}\n")
            if ok is not None:
                n = storage.conn.execute(
                    "SELECT COUNT(*) FROM offers WHERE chain = ? AND last_seen_run = ?", (chain, ok["id"])
                ).fetchone()[0]
                out.write(f"  last success: {ok['finished_at']}, offers in it: {n}\n")
            else:
                out.write("  last success: never\n")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    settings = config.load(args.config)
    logging.basicConfig(
        level=getattr(logging, settings.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    for noisy in ("httpx", "httpcore"):  # per-request INFO lines add nothing over our own logs
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if args.command == "collect":
        return collect(
            settings, chains=args.chain, scheduled=args.scheduled, export=not args.no_export,
            accept_suspicious=args.accept_suspicious,
        )
    if args.command == "export":
        from .export import export_all

        with Storage(settings.db_path) as storage:
            export_all(storage, settings)
        return 0
    if args.command == "stats":
        return _stats(settings)
    return 2
