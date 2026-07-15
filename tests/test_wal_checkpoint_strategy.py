"""Regression tests for safe SessionDB WAL checkpointing (issue #45383)."""

import logging
import sqlite3
import threading
from typing import Any, cast

from hermes_state import SessionDB


class _Cursor:
    def __init__(self, row=(0, 0, 0)):
        self._row = row

    def fetchone(self):
        return self._row


class _RecordingConnection:
    def __init__(self, *, failure: Exception | None = None):
        self.calls: list[str] = []
        self.failure = failure
        self.closed = False

    def execute(self, sql: str):
        self.calls.append(sql)
        if self.failure is not None:
            raise self.failure
        return _Cursor()

    def close(self):
        self.closed = True


def _checkpoint_db(connection: _RecordingConnection) -> SessionDB:
    db = cast(Any, SessionDB.__new__(SessionDB))
    db._lock = threading.RLock()
    db._conn = connection
    return db


def test_periodic_checkpoint_uses_passive_not_truncate():
    connection = _RecordingConnection()
    db = _checkpoint_db(connection)

    db._try_wal_checkpoint()

    assert connection.calls == ["PRAGMA wal_checkpoint(PASSIVE)"]


def test_periodic_checkpoint_failure_is_logged(caplog):
    connection = _RecordingConnection(
        failure=sqlite3.OperationalError("disk I/O error"),
    )
    db = _checkpoint_db(connection)

    with caplog.at_level(logging.WARNING):
        db._try_wal_checkpoint()

    assert "WAL checkpoint (PASSIVE) failed: disk I/O error" in caplog.text


def test_close_retains_controlled_truncate_checkpoint():
    connection = _RecordingConnection()
    db = _checkpoint_db(connection)

    db.close()

    assert connection.calls == ["PRAGMA wal_checkpoint(TRUNCATE)"]
    assert connection.closed is True
    assert db._conn is None


def test_close_checkpoint_failure_is_logged_and_connection_still_closes(caplog):
    connection = _RecordingConnection(
        failure=sqlite3.OperationalError("database is locked"),
    )
    db = _checkpoint_db(connection)

    with caplog.at_level(logging.DEBUG):
        db.close()

    assert "WAL checkpoint (TRUNCATE) at close failed" in caplog.text
    assert connection.closed is True
    assert db._conn is None
