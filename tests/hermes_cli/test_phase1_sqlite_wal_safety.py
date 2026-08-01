"""Regression coverage for Phase 1 stores on WAL-unsafe SQLite runtimes.

The stores that go through `hermes_cli.sqlite_open` are patched *there* — one
seam rather than one per module, which is the point of consolidating the open
path. A store still holding its own copy of the helper is patched in its own
module; `test_stores_share_one_open_path` below is what notices the difference,
so a store quietly reverting to a private connect cannot pass by patching the
symbol it happens to own.
"""

import sqlite3

import pytest

from hermes_cli.actions.idempotency import IdempotencyStore
from hermes_cli.cost_attribution import CostLedger
from hermes_cli.undo.journal import UndoJournal
from hermes_sqlite import force_delete_journal_if_wal_unsafe

#: Where each store's journal-mode decision is actually made. The shared path
#: covers the stores that route through it; the rest still own theirs.
SHARED = "hermes_cli.sqlite_open"


@pytest.mark.parametrize(
    ("module_name", "store_type", "filename"),
    [
        (SHARED, IdempotencyStore, "idempotency.sqlite3"),
        (SHARED, UndoJournal, "undo.sqlite3"),
        ("hermes_cli.cost_attribution", CostLedger, "cost.sqlite3"),
    ],
)
def test_phase1_stores_use_delete_full_on_affected_runtime(
    tmp_path, monkeypatch, module_name, store_type, filename
):
    module = __import__(module_name, fromlist=["force_delete_journal_if_wal_unsafe"])

    def simulate_affected_runtime(conn, *, db_label):
        return force_delete_journal_if_wal_unsafe(
            conn, db_label=db_label, version_info=(3, 50, 4)
        )

    monkeypatch.setattr(
        module,
        "force_delete_journal_if_wal_unsafe",
        simulate_affected_runtime,
    )
    db_path = tmp_path / filename

    store_type(db_path)

    with sqlite3.connect(db_path) as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "delete"
        assert conn.execute("PRAGMA synchronous").fetchone()[0] == 2


@pytest.mark.parametrize(
    ("module_name", "store_type", "filename"),
    [
        (SHARED, IdempotencyStore, "idempotency.sqlite3"),
        (SHARED, UndoJournal, "undo.sqlite3"),
        ("hermes_cli.cost_attribution", CostLedger, "cost.sqlite3"),
    ],
)
def test_phase1_stores_keep_wal_policy_on_safe_runtime(
    tmp_path, monkeypatch, module_name, store_type, filename
):
    module = __import__(module_name, fromlist=["force_delete_journal_if_wal_unsafe"])

    def simulate_safe_runtime(conn, *, db_label):
        return force_delete_journal_if_wal_unsafe(
            conn, db_label=db_label, version_info=(3, 53, 0)
        )

    monkeypatch.setattr(
        module,
        "force_delete_journal_if_wal_unsafe",
        simulate_safe_runtime,
    )
    db_path = tmp_path / filename

    store_type(db_path)

    with sqlite3.connect(db_path) as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"


def test_stores_share_one_open_path():
    """The consolidation itself, asserted.

    Both stores were opening SQLite with their own copy of connect-and-set-
    journal-mode. That duplication is what let the same `database is locked`
    shape exist twice, and what would let a fix land in one and not the other.
    A store that reverts to a private connect stops honouring a patch on the
    shared module, which is exactly what the parametrised tests above would
    then catch.
    """
    import inspect

    from hermes_cli.actions import idempotency
    from hermes_cli.undo import journal

    for module, name in ((idempotency, "IdempotencyStore"), (journal, "UndoJournal")):
        source = inspect.getsource(getattr(module, name)._connect)
        assert "sqlite_open.connect" in source, f"{name} no longer shares the open path"
        assert "sqlite3.connect" not in source, f"{name} opens SQLite directly again"
