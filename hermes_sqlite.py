"""SQLite runtime safety guards shared by Hermes state stores.

SQLite versions before 3.53.0 contain the WAL-reset corruption bug documented
at https://sqlite.org/wal.html#walresetbug. Hermes must not open or retain a
write-ahead journal with an affected runtime. Rollback-journal DELETE mode is
slower but safe and remains fully supported.
"""

from __future__ import annotations

import logging
import sqlite3
from typing import Optional, Tuple

SQLITE_WAL_RESET_FIXED_VERSION: Tuple[int, int, int] = (3, 53, 0)

logger = logging.getLogger(__name__)
_warned_labels: set[str] = set()


class UnsafeSQLiteWALRuntimeError(RuntimeError):
    """Raised when an affected SQLite runtime cannot be moved out of WAL."""


def sqlite_wal_reset_is_fixed(
    version_info: Optional[Tuple[int, ...]] = None,
) -> bool:
    """Return whether the active SQLite contains the WAL-reset fix."""
    version = tuple(version_info or sqlite3.sqlite_version_info)
    return version >= SQLITE_WAL_RESET_FIXED_VERSION


def force_delete_journal_if_wal_unsafe(
    conn: sqlite3.Connection,
    *,
    db_label: str,
    version_info: Optional[Tuple[int, ...]] = None,
) -> bool:
    """Force rollback-journal mode on SQLite versions affected by WAL reset.

    Returns ``True`` when DELETE mode was required, otherwise ``False`` so the
    caller may apply its normal WAL policy. Any inability to prove DELETE mode
    raises instead of allowing the connection to continue in unsafe WAL mode.
    """
    version = tuple(version_info or sqlite3.sqlite_version_info)
    if sqlite_wal_reset_is_fixed(version):
        return False

    try:
        row = conn.execute("PRAGMA journal_mode=DELETE").fetchone()
        mode = str(row[0]).lower() if row else ""
        if mode != "delete":
            raise sqlite3.OperationalError(
                f"SQLite returned journal_mode={mode or 'unknown'}"
            )
        conn.execute("PRAGMA synchronous=FULL")
    except (sqlite3.OperationalError, OSError) as exc:
        raise UnsafeSQLiteWALRuntimeError(
            f"{db_label}: unsafe SQLite {'.'.join(map(str, version))} cannot "
            "be moved from WAL to DELETE journal mode"
        ) from exc

    if db_label not in _warned_labels:
        _warned_labels.add(db_label)
        logger.warning(
            "%s: SQLite %s is affected by the WAL-reset corruption bug; "
            "using journal_mode=DELETE with synchronous=FULL until SQLite >= %s",
            db_label,
            ".".join(map(str, version)),
            ".".join(map(str, SQLITE_WAL_RESET_FIXED_VERSION)),
        )
    return True
