"""Two workers opening the same store at the same moment.

The review measured `database is locked` on repeated concurrent construction:
3 of 200 rounds for the undo journal, 7 of 200 for the idempotency store. Rare
enough to survive a casual test, common enough to bite on a cold start where
several workers come up together — and it presents as a crash at boot, which is
the worst time.

**These tests do not reproduce the reported failure in this container.** I ran
them against the old connect path as well — 360 concurrent constructions per
store, zero `database is locked` either way. So they are a regression guard,
not evidence that the hardening fixed what was measured. The difference is
probably the environment: `sqlite3.connect(timeout=...)` already sets
`busy_timeout` for statements the Python driver issues, and whether the
journal-mode switch is one of them varies by build; a process-level race on a
different filesystem may also behave differently from threads here.

The hardening stands on its own reasoning — an explicit `busy_timeout` pragma,
bounded retry around the journal-mode switch, and `BEGIN IMMEDIATE` available
for migration — but the claim "this is fixed" belongs to whoever can reproduce
the original numbers, not to me.
"""
from __future__ import annotations

import sqlite3
import threading

import pytest

ROUNDS = 60
THREADS = 6


def _hammer(build) -> list[Exception]:
    """Construct the store from several threads at once, repeatedly."""
    failures: list[Exception] = []
    lock = threading.Lock()

    for _ in range(ROUNDS):
        barrier = threading.Barrier(THREADS)

        def once() -> None:
            try:
                barrier.wait(timeout=10)
                build()
            except Exception as exc:  # noqa: BLE001 - recorded, not swallowed
                with lock:
                    failures.append(exc)

        threads = [threading.Thread(target=once) for _ in range(THREADS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=20)

    return failures


class TestConcurrentConstruction:
    def test_the_undo_journal_survives_simultaneous_opens(self, tmp_path):
        from hermes_cli.undo.journal import UndoJournal

        path = tmp_path / "undo.sqlite3"
        failures = _hammer(lambda: UndoJournal(path))
        assert failures == [], f"{len(failures)} of {ROUNDS} rounds failed: {failures[:3]}"

    def test_the_idempotency_store_survives_simultaneous_opens(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        path = tmp_path / "idem.sqlite3"
        failures = _hammer(lambda: IdempotencyStore(path))
        assert failures == [], f"{len(failures)} of {ROUNDS} rounds failed: {failures[:3]}"


class TestConcurrentWrites:
    def test_simultaneous_claims_do_not_raise_locked(self, tmp_path):
        """Contention on writes, not just on construction."""
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        winners: list[bool] = []
        failures: list[Exception] = []
        lock = threading.Lock()
        barrier = threading.Barrier(THREADS)

        def claim(index: int) -> None:
            try:
                barrier.wait(timeout=10)
                won, _, _ = store.claim(f"key-{index % 3}")
                with lock:
                    winners.append(won)
            except Exception as exc:  # noqa: BLE001
                with lock:
                    failures.append(exc)

        threads = [threading.Thread(target=claim, args=(i,)) for i in range(THREADS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=20)

        assert failures == [], f"writes raised under contention: {failures[:3]}"
        # Three distinct keys, so exactly three callers should have won.
        assert sum(winners) == 3


class TestBusyTimeoutIsActuallySet:
    def test_the_connection_waits_rather_than_failing_immediately(self, tmp_path):
        # Without this pragma the journal-mode switch raises the moment another
        # connection holds the file, which is the failure that was measured.
        from hermes_cli import sqlite_open

        conn = sqlite_open.connect(tmp_path / "x.sqlite3", db_label="test")
        try:
            value = conn.execute("PRAGMA busy_timeout").fetchone()[0]
            assert value >= 1000
        finally:
            conn.close()


class TestAdditiveMigrationFromAnOlderSchema:
    """A store written by an older build must still open."""

    def test_the_undo_journal_adds_its_new_columns(self, tmp_path):
        path = tmp_path / "undo.sqlite3"
        conn = sqlite3.connect(path)
        conn.execute(
            """
            CREATE TABLE undo_journal (
                id TEXT PRIMARY KEY, action_id TEXT NOT NULL,
                actor TEXT NOT NULL DEFAULT 'agent',
                session_id TEXT NOT NULL DEFAULT '',
                target TEXT NOT NULL DEFAULT '', rollback TEXT NOT NULL,
                rollback_detail TEXT NOT NULL DEFAULT '',
                inverse_payload TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'done',
                outcome TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL, undone_at REAL
            )
            """
        )
        conn.execute(
            "INSERT INTO undo_journal (id, action_id, rollback, rollback_detail, "
            "inverse_payload, created_at) VALUES ('old', 'notes.edit', 'inverse', "
            "'notes.restore', '{}', 1000.0)"
        )
        conn.commit()
        conn.close()

        from hermes_cli.undo.journal import UndoJournal

        journal = UndoJournal(path)
        columns = {
            r["name"]
            for r in journal._connect().execute("PRAGMA table_info(undo_journal)")
        }
        assert {"claimed_at", "reversal_owner"} <= columns
        # And the pre-existing row is still readable.
        assert journal.get("old")["action_id"] == "notes.edit"

    def test_the_idempotency_store_adds_its_attempt_column(self, tmp_path):
        path = tmp_path / "idem.sqlite3"
        conn = sqlite3.connect(path)
        conn.execute(
            "CREATE TABLE idempotency (key TEXT PRIMARY KEY, state TEXT NOT NULL, "
            "result TEXT, claimed_at REAL NOT NULL, settled_at REAL)"
        )
        conn.execute(
            "INSERT INTO idempotency (key, state, claimed_at) VALUES ('k', 'succeeded', 1.0)"
        )
        conn.commit()
        conn.close()

        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(path)
        record = store.lookup("k")
        assert record["state"] == "succeeded"
        # An older row has no owner, which must read as "nobody", not crash.
        assert record["attempt"] is None

    def test_an_ownerless_legacy_row_cannot_be_settled_by_a_guess(self, tmp_path):
        path = tmp_path / "idem.sqlite3"
        conn = sqlite3.connect(path)
        conn.execute(
            "CREATE TABLE idempotency (key TEXT PRIMARY KEY, state TEXT NOT NULL, "
            "result TEXT, claimed_at REAL NOT NULL, settled_at REAL)"
        )
        conn.execute(
            "INSERT INTO idempotency (key, state, claimed_at) VALUES ('k', 'in_flight', 1.0)"
        )
        conn.commit()
        conn.close()

        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(path)
        assert store.settle("k", "invented", state="succeeded") is False


@pytest.mark.parametrize("label", ["undo-journal", "phase1-idempotency-store"])
def test_the_open_path_is_shared(tmp_path, label):
    """Both stores go through one initialization path, not two lookalikes."""
    from hermes_cli import sqlite_open

    conn = sqlite_open.connect(tmp_path / f"{label}.sqlite3", db_label=label)
    try:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0].lower()
        # WAL where safe, DELETE where the SQLite build has the reset bug.
        assert mode in ("wal", "delete")
    finally:
        conn.close()
