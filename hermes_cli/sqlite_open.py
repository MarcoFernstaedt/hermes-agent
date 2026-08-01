"""Opening a SQLite file that two processes might be opening at the same time.

Both the undo journal and the idempotency store had the same shape: connect,
set `journal_mode`, create tables. Under concurrent construction that produced
`database is locked` — measured at 3 of 200 rounds for the journal and 7 of 200
for the idempotency store. Rare enough to pass a casual test, common enough to
bite on a cold start where several workers come up together.

Three things fix it, and all three are needed:

**`busy_timeout`.** Without it SQLite raises immediately on a held lock rather
than waiting. `timeout=` on `sqlite3.connect` sets this for the Python driver,
but only for statements it runs — setting the pragma makes it apply to the
journal-mode switch too, which is the statement that was failing.

**`BEGIN IMMEDIATE` around migration.** `CREATE TABLE IF NOT EXISTS` from two
connections at once is a write-write race. Taking the write lock up front
serialises them, so the loser waits rather than failing.

**Bounded retry.** `journal_mode` changes need a moment when another connection
holds the file. A few short retries convert a startup collision into a
50-millisecond delay instead of an exception. Bounded, because retrying forever
turns a real lock problem into a hang, which is harder to diagnose than a
crash.
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Callable, Optional

from hermes_sqlite import force_delete_journal_if_wal_unsafe

#: How long SQLite waits for a held lock before raising. Generous: the
#: alternative to waiting is failing, and these writes are small.
DEFAULT_BUSY_TIMEOUT_MS = 10_000

#: Retries for the journal-mode switch and for migration. Small — this covers a
#: startup collision, not a sustained contention problem, and pretending
#: otherwise would turn a lock into a hang.
_MAX_ATTEMPTS = 6
_BACKOFF_SECONDS = 0.02


def connect(
    path: Path | str,
    *,
    db_label: str,
    busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
) -> sqlite3.Connection:
    """Open a connection with locking configured before anything else runs."""
    conn = sqlite3.connect(str(path), timeout=busy_timeout_ms / 1000)
    conn.row_factory = sqlite3.Row
    # First statement on the connection: everything after it, including the
    # journal-mode switch, then waits instead of raising.
    conn.execute(f"PRAGMA busy_timeout={int(busy_timeout_ms)}")
    _set_journal_mode(conn, db_label)
    return conn


def _set_journal_mode(conn: sqlite3.Connection, db_label: str) -> None:
    """Choose the journal mode, retrying while another connection holds it.

    `force_delete_journal_if_wal_unsafe` decides *which* mode is safe on this
    SQLite build; this only handles the contention around applying it.
    """
    last: Optional[Exception] = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            if not force_delete_journal_if_wal_unsafe(conn, db_label=db_label):
                conn.execute("PRAGMA journal_mode=WAL")
            return
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc).lower() and "busy" not in str(exc).lower():
                raise
            last = exc
            time.sleep(_BACKOFF_SECONDS * (attempt + 1))
    if last is not None:
        raise last


def migrate(
    conn: sqlite3.Connection,
    apply: Callable[[sqlite3.Connection], None],
) -> None:
    """Run schema creation under a write lock taken up front.

    `CREATE TABLE IF NOT EXISTS` from two connections at once is a write-write
    race; `BEGIN IMMEDIATE` makes the second one wait for the first rather than
    discover it mid-statement.
    """
    last: Optional[Exception] = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                apply(conn)
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
            return
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc).lower() and "busy" not in str(exc).lower():
                raise
            last = exc
            time.sleep(_BACKOFF_SECONDS * (attempt + 1))
    if last is not None:
        raise last
