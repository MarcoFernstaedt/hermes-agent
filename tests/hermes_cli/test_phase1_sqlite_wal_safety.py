"""Regression coverage for Phase 1 stores on WAL-unsafe SQLite runtimes."""

import sqlite3

import pytest

from hermes_cli.actions.idempotency import IdempotencyStore
from hermes_cli.cost_attribution import CostLedger
from hermes_sqlite import force_delete_journal_if_wal_unsafe


@pytest.mark.parametrize(
    ("module_name", "store_type", "filename"),
    [
        ("hermes_cli.actions.idempotency", IdempotencyStore, "idempotency.sqlite3"),
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
        ("hermes_cli.actions.idempotency", IdempotencyStore, "idempotency.sqlite3"),
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
