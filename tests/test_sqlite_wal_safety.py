import sqlite3

import pytest

from hermes_sqlite import (
    UnsafeSQLiteWALRuntimeError,
    force_delete_journal_if_wal_unsafe,
)


def test_unsafe_sqlite_forces_delete_mode(tmp_path):
    conn = sqlite3.connect(tmp_path / "unsafe.db")
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"

        forced = force_delete_journal_if_wal_unsafe(
            conn,
            db_label="unsafe.db",
            version_info=(3, 50, 4),
        )

        assert forced is True
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "delete"
        assert conn.execute("PRAGMA synchronous").fetchone()[0] == 2
    finally:
        conn.close()


def test_patched_sqlite_leaves_journal_selection_to_caller(tmp_path):
    conn = sqlite3.connect(tmp_path / "safe.db")
    try:
        forced = force_delete_journal_if_wal_unsafe(
            conn,
            db_label="safe.db",
            version_info=(3, 53, 0),
        )
        assert forced is False
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "delete"
    finally:
        conn.close()


def test_unsafe_sqlite_fails_closed_when_delete_cannot_be_enabled(tmp_path):
    db_path = tmp_path / "locked.db"
    writer = sqlite3.connect(db_path)
    guarded = sqlite3.connect(db_path, timeout=0)
    try:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("CREATE TABLE t (value TEXT)")
        writer.execute("BEGIN IMMEDIATE")
        writer.execute("INSERT INTO t VALUES ('held')")

        with pytest.raises(UnsafeSQLiteWALRuntimeError, match="unsafe SQLite"):
            force_delete_journal_if_wal_unsafe(
                guarded,
                db_label="locked.db",
                version_info=(3, 50, 4),
            )

        assert guarded.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    finally:
        writer.rollback()
        guarded.close()
        writer.close()


def test_session_db_uses_delete_on_affected_runtime(tmp_path):
    from hermes_state import SessionDB

    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        assert db._conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    finally:
        db.close()


def test_every_direct_wal_site_invokes_runtime_guard():
    """Prevent a new or reverted unguarded WAL connection path."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    expected = {
        "agent/verification_evidence.py",
        "cron/executions.py",
        "gateway/delivery_ledger.py",
        "hermes_state.py",
        "plugins/platforms/discord/recovery.py",
        "tools/async_delegation.py",
    }
    guarded = set()
    for relative in expected:
        text = (root / relative).read_text(encoding="utf-8")
        assert "PRAGMA journal_mode=WAL" in text, relative
        assert "force_delete_journal_if_wal_unsafe" in text, relative
        guarded.add(relative)
    assert guarded == expected


def test_sqlite_guard_is_shipped_as_top_level_module():
    """Sealed/editable installs must resolve the guard outside the source cwd."""
    import tomllib
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    metadata = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    assert "hermes_sqlite" in metadata["tool"]["setuptools"]["py-modules"]
