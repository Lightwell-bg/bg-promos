"""Collection pipeline: lock, schedule check, fetch -> archive -> parse -> validate -> store -> export."""

from __future__ import annotations

import gzip
import hashlib
import logging
import os
import statistics
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from .config import Settings
from .control import ControlStore, effective_schedule
from .export import export_all
from .http import HttpClient
from .sources.base import RawDocument, Source
from .sources.billa import BillaSource
from .sources.kaufland import KauflandSource
from .sources.lidl import LidlSource
from .storage import Storage, count_active_on

log = logging.getLogger(__name__)

LOCK_NAME = ".collect.lock"
EXIT_OK, EXIT_PROBLEM, EXIT_BUSY = 0, 1, 2
CHAINS = ("lidl", "kaufland", "billa")


class LockBusyError(Exception):
    """Another collection run holds the lock."""


def _try_lock(fd: int) -> bool:
    """Non-blocking exclusive OS lock on the open file; False when someone else holds it."""
    try:
        if os.name == "nt":
            import msvcrt

            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    return True


def _unlock(fd: int) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass


@contextmanager
def collection_lock(path: Path) -> Iterator[None]:
    """Exclusive OS lock on ``path`` (flock / msvcrt.locking), released by the OS if the process dies.

    The file itself is kept: a leftover file of a dead process is not a lock. It only
    holds "pid timestamp" for information.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR)
    if not _try_lock(fd):
        os.close(fd)
        raise LockBusyError(f"lock {path} is held by another process")
    try:
        try:
            os.ftruncate(fd, 0)
            os.lseek(fd, 0, os.SEEK_SET)
            os.write(fd, f"{os.getpid()} {datetime.now(timezone.utc).isoformat(timespec='seconds')}\n".encode())
        except OSError:
            log.debug("cannot write lock info to %s", path)
        yield
    finally:
        _unlock(fd)
        os.close(fd)


def build_sources(settings: Settings) -> dict[str, Source]:
    """Instantiate enabled chain adapters from the settings."""
    sources: dict[str, Source] = {}
    for name in CHAINS:
        cs = settings.chain(name)
        if not cs.enabled:
            continue
        o = cs.options
        if name == "lidl":
            sources[name] = LidlSource(
                api_url=o.get("api_url", "https://www.lidl.bg/q/api/search"),
                page_size=int(o.get("page_size", 60)),
                max_pages=int(o.get("max_pages", 60)),
                tz=settings.tz,
            )
        elif name == "kaufland":
            sources[name] = KauflandSource(url=o["url"], tz=settings.tz) if "url" in o else KauflandSource(tz=settings.tz)
        elif name == "billa":
            urls = [u.strip() for u in o.get("urls", "").split(",") if u.strip()]
            sources[name] = BillaSource(urls) if urls else BillaSource()
    return sources


def _as_utc(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    return now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now.astimezone(timezone.utc)


def last_slot_instant(slots: Sequence[dtime], tz: ZoneInfo, now_utc: datetime) -> datetime | None:
    """Latest slot instant (UTC) that is <= now; looks at today and yesterday in ``tz``."""
    now_utc = _as_utc(now_utc)
    today = now_utc.astimezone(tz).date()
    candidates = []
    for day in (today - timedelta(days=1), today):
        for slot in slots:
            instant = datetime.combine(day, slot, tzinfo=tz).astimezone(timezone.utc)
            if instant <= now_utc:
                candidates.append(instant)
    return max(candidates) if candidates else None


def next_slot_instant(slots: Sequence[dtime], tz: ZoneInfo, now_utc: datetime) -> datetime | None:
    """Earliest slot instant (UTC) strictly after now; looks at today and tomorrow in ``tz``."""
    now_utc = _as_utc(now_utc)
    today = now_utc.astimezone(tz).date()
    candidates = []
    for day in (today, today + timedelta(days=1)):
        for slot in slots:
            instant = datetime.combine(day, slot, tzinfo=tz).astimezone(timezone.utc)
            if instant > now_utc:
                candidates.append(instant)
    return min(candidates) if candidates else None


def is_due(
    chain: str,
    storage: Storage,
    slots: Sequence[dtime],
    tz: ZoneInfo,
    now_utc: datetime,
    max_retries: int = 3,
) -> bool:
    """Due when the latest passed slot has no finished run of the chain, or all runs since it
    failed (fewer than ``max_retries``) and the latest one was not a 403 block."""
    slot = last_slot_instant(slots, tz, now_utc)
    if slot is None:
        return False
    since_slot = []
    for row in storage.recent_runs(chain, max(max_retries, 1) + 20):
        started = datetime.fromisoformat(row["started_at"])
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        if started.astimezone(timezone.utc) >= slot:
            since_slot.append(row)
    if not since_slot:
        return True
    if any(r["status"] == "ok" for r in since_slot):
        return False
    if len(since_slot) >= max_retries:
        return False
    return not (since_slot[0]["error"] or "").startswith("HttpBlockedError")  # a block waits for the next slot


def _content_hash(docs: Sequence[RawDocument]) -> str:
    h = hashlib.sha256()
    for d in docs:
        h.update(d.content)
    return h.hexdigest()


def _archive(docs: Sequence[RawDocument], raw_dir: Path, chain: str, now_utc: datetime) -> None:
    folder = raw_dir / chain
    folder.mkdir(parents=True, exist_ok=True)
    stamp = now_utc.strftime("%Y%m%dT%H%M%SZ")
    for d in docs:
        safe = "".join(c if c.isalnum() or c in "-." else "-" for c in d.name)
        with gzip.open(folder / f"{stamp}_{safe}.gz", "wb") as fh:
            fh.write(d.content)


def purge_raw(raw_dir: Path, retention_days: int, now_utc: datetime) -> int:
    """Delete archived raw files older than ``retention_days`` (by the timestamp in the name)."""
    if not raw_dir.exists():
        return 0
    cutoff = now_utc - timedelta(days=retention_days)
    removed = 0
    for f in raw_dir.glob("*/*.gz"):
        try:
            ts = datetime.strptime(f.name.split("_", 1)[0], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            ts = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)
        if ts < cutoff:
            f.unlink(missing_ok=True)
            removed += 1
    return removed


def run_chain(
    source: Source,
    storage: Storage,
    http: HttpClient,
    settings: Settings,
    scheduled: bool = False,
    now: datetime | None = None,
    accept_suspicious: bool = False,
) -> str:
    """Collect one chain. Never raises (except KeyboardInterrupt); returns the run status."""
    chain = source.chain
    now_utc = _as_utc(now)
    run_id = storage.start_run(chain, scheduled)
    content_hash: str | None = None
    try:
        docs = source.fetch(http)
        content_hash = _content_hash(docs)
        try:
            _archive(docs, settings.data_dir / "raw", chain, now_utc)
        except OSError:
            log.exception("%s: cannot archive raw documents", chain)
        offers = source.parse(docs)
        count = len(offers)

        # The guard counts offers ACTIVE on the run's Sofia date: chains list next week's
        # offers late in the week, so total counts swing weekly (Kaufland, 2026-10-19).
        run_day = now_utc.astimezone(settings.tz).date()
        active = count_active_on(offers, run_day)

        problem = None
        minimum = settings.chain(chain).min_expected_offers
        if active < minimum:
            problem = f"only {active} offers active on {run_day} (of {count} total), expected at least {minimum}"
        else:
            history = storage.recent_ok_active_counts(chain, settings.history_runs)
            if history:
                median = statistics.median(history)
                if active < settings.min_ratio * median:
                    problem = (
                        f"{active} active offers is below {settings.min_ratio:.0%} of the median "
                        f"{median:g} of the last {len(history)} good runs"
                    )
        if problem and accept_suspicious and count > 0:
            log.warning("%s: --accept-suspicious: saving %s offers despite: %s", chain, count, problem)
            problem = None
        if problem:
            log.warning("%s: suspicious result, offers not saved: %s", chain, problem)
            storage.finish_run(run_id, "suspicious", count, content_hash, problem)
            return "suspicious"

        stats = storage.save_offers_and_finish(run_id, chain, offers, content_hash, run_day)
        log.info("%s: ok, %s", chain, stats)
        return "ok"
    except Exception as exc:  # one chain's failure must not stop the others
        log.exception("%s: collection failed", chain)
        storage.finish_run(run_id, "failed", None, content_hash, f"{type(exc).__name__}: {exc}")
        return "failed"


def collect(
    settings: Settings,
    chains: Sequence[str] | None = None,
    scheduled: bool = False,
    export: bool = True,
    now: datetime | None = None,
    sources: Mapping[str, Source] | None = None,
    http: HttpClient | None = None,
    accept_suspicious: bool = False,
) -> int:
    """Run collection for the chosen chains. Exit code: 0 ok/skipped, 1 problem, 2 another run in progress."""
    now_utc = _as_utc(now)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    try:
        with collection_lock(settings.data_dir / LOCK_NAME):
            return _collect_locked(settings, chains, scheduled, export, now_utc, sources, http, accept_suspicious)
    except LockBusyError as exc:
        log.error("another run in progress: %s", exc)
        return EXIT_BUSY


def _collect_locked(
    settings: Settings,
    chains: Sequence[str] | None,
    scheduled: bool,
    export: bool,
    now_utc: datetime,
    sources: Mapping[str, Source] | None,
    http: HttpClient | None,
    accept_suspicious: bool = False,
) -> int:
    available = dict(sources) if sources is not None else build_sources(settings)
    selected = list(chains) if chains else list(available)
    code = EXIT_OK
    own_http = http is None
    client = http or HttpClient(
        settings.user_agent, settings.timeout, settings.delay_seconds, settings.retries, settings.backoff_seconds
    )
    control: ControlStore | None = None
    if scheduled:  # admin overrides and "collect now" requests only affect the cron run
        try:
            control = ControlStore(settings.control_db_path)
        except Exception:
            log.exception("control DB unavailable, using config.ini schedule")
            control = None
        if control is not None:
            try:  # we hold the exclusive collection lock, so an unfinished claim is a crashed run's orphan
                closed = control.close_orphaned_claims(now_utc)
                if closed:
                    log.warning("closed %d orphaned collect request(s) as interrupted", closed)
            except Exception:
                log.exception("cannot close orphaned collect requests")
    with Storage(settings.db_path) as storage:
        try:
            for name in selected:
                source = available.get(name)
                if source is None:
                    log.warning("%s: disabled or unknown, skipped", name)
                    continue
                req = None
                manual = False
                if scheduled:
                    sched_enabled, slots = True, settings.slots
                    if control is not None:
                        try:
                            sched = effective_schedule(settings, control, name)
                            sched_enabled, slots = sched.enabled, sched.slots
                        except Exception:
                            log.exception("%s: cannot read admin schedule, using config.ini", name)
                        try:
                            req = control.pending_request(name)
                            if req is not None and control.claim_request(req["id"], now_utc):
                                manual = True
                        except Exception:
                            log.exception("%s: cannot read collect requests", name)
                    due = sched_enabled and is_due(
                        name, storage, slots, settings.tz, now_utc, settings.max_retries_per_slot
                    )
                    if not due and not manual:
                        log.info("%s: %s, skipped", name, "disabled by admin" if not sched_enabled else "not due")
                        continue
                    if manual:
                        log.info("%s: manual run requested from admin", name)
                status = "failed"
                try:
                    status = run_chain(source, storage, client, settings, scheduled, now_utc, accept_suspicious)
                finally:
                    if manual and control is not None and req is not None:
                        try:
                            row = storage.conn.execute(
                                "SELECT id, finished_at FROM scrape_runs WHERE chain = ? ORDER BY id DESC LIMIT 1",
                                (name,),
                            ).fetchone()
                            run_id = row[0] if row else None
                            done_at = (row[1] if row and row[1] else None) or datetime.now(timezone.utc)
                            control.finish_request(req["id"], status, run_id, done_at)
                        except Exception:
                            log.exception("%s: cannot finish collect request", name)
                if status != "ok":
                    code = EXIT_PROBLEM
        finally:
            if own_http:
                client.close()
            if control is not None:
                control.close()
        try:
            purge_raw(settings.data_dir / "raw", settings.raw_retention_days, now_utc)
        except OSError:
            log.exception("raw retention cleanup failed")
        if export:  # always: refreshes stale flags even when every chain was skipped
            try:
                export_all(storage, settings, now_utc)
            except Exception:
                log.exception("export failed")
                code = EXIT_PROBLEM
    return code
