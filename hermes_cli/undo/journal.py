"""The undo journal — inverse operations, not a log.

A log tells you what happened. This tells you how to take it back, which is a
different and much stronger claim, and it is why the registry refuses to accept
a mutating action that has not said which of the three it is.

The rule that shapes everything here:

**Undo is not claimed until it is verified.** For an internal inverse we control
the transaction, so success is knowable. For a *compensation* against an
external system — a calendar, a mail provider, Home Assistant — the reversal is
a second request that can itself fail, silently or partially. Reporting "undone"
because we sent the request would be the same class of lie as reporting "sent"
because a decision was approved. So a compensation goes through
``compensating → verify → compensated | compensation_failed``, and a failed
compensation stays visible and blocking, because the world is now in a state we
tried and failed to reverse and only a person can fix it.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from hermes_sqlite import force_delete_journal_if_wal_unsafe

from hermes_cli.actions.registry import Rollback

#: How long a reversible entry stays offerable. Past this the inverse may no
#: longer be valid — a soft-deleted row can be purged, a prior version pruned —
#: so continuing to offer undo would promise something we cannot deliver.
DEFAULT_RETENTION_SECONDS = 14 * 24 * 3600


class UndoNotPossible(RuntimeError):
    """Raised when an entry cannot be undone, with the reason in plain words."""


class JournalEntry(dict):
    """A recorded action, and how to take it back."""

    @property
    def reversible(self) -> bool:
        return self.get("rollback") in (Rollback.INVERSE.value, Rollback.COMPENSATION.value)

    @property
    def needs_repair(self) -> bool:
        return self.get("status") == "compensation_failed"


class UndoJournal:
    def __init__(
        self,
        path: Path | str,
        *,
        retention_seconds: int = DEFAULT_RETENTION_SECONDS,
    ) -> None:
        self._path = Path(path)
        self._retention = retention_seconds
        self._lock = threading.Lock()
        self.migrate()

    def _connect(self) -> sqlite3.Connection:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._path), timeout=10)
        conn.row_factory = sqlite3.Row
        if not force_delete_journal_if_wal_unsafe(conn, db_label="undo-journal"):
            conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def migrate(self) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS undo_journal (
                    id            TEXT PRIMARY KEY,
                    action_id     TEXT NOT NULL,
                    actor         TEXT NOT NULL DEFAULT 'agent',
                    session_id    TEXT NOT NULL DEFAULT '',
                    target        TEXT NOT NULL DEFAULT '',
                    rollback      TEXT NOT NULL,
                    -- The reversing action id, or the stated reason it cannot
                    -- be reversed. Never empty: the registry rejects that.
                    rollback_detail TEXT NOT NULL DEFAULT '',
                    -- Everything the inverse needs to run. For a restore this
                    -- is the prior state; for a create it is the new id.
                    inverse_payload TEXT NOT NULL DEFAULT '{}',
                    status        TEXT NOT NULL DEFAULT 'done',
                    outcome       TEXT NOT NULL DEFAULT '',
                    created_at    REAL NOT NULL,
                    undone_at     REAL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_undo_session ON undo_journal(session_id, created_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_undo_status ON undo_journal(status, created_at)"
            )

    @staticmethod
    def _row(r: sqlite3.Row) -> JournalEntry:
        d = dict(r)
        try:
            d["inverse_payload"] = json.loads(d["inverse_payload"] or "{}")
        except (json.JSONDecodeError, TypeError):
            d["inverse_payload"] = {}
        return JournalEntry(d)

    # -- recording ---------------------------------------------------------

    def record(
        self,
        *,
        action_id: str,
        rollback: str,
        rollback_detail: str,
        actor: str = "agent",
        session_id: str = "",
        target: str = "",
        inverse_payload: Optional[dict] = None,
        now: Optional[float] = None,
    ) -> JournalEntry:
        """Record a completed action and how to reverse it.

        An irreversible action is recorded too. Leaving it out would make the
        journal read as a list of everything that happened, which it is not —
        and the owner needs to see that the thing they cannot undo *did* happen.
        """
        if rollback not in {r.value for r in Rollback}:
            raise ValueError(f"unknown rollback kind {rollback!r}")
        if not rollback_detail.strip():
            raise ValueError("rollback_detail is required (an action id, or why not)")
        if rollback != Rollback.IRREVERSIBLE.value and not inverse_payload:
            # A reversible entry with nothing to reverse *with* is a promise
            # that breaks the moment someone tries to keep it.
            raise ValueError(
                f"{rollback} entry for {action_id!r} needs an inverse_payload"
            )

        entry_id = uuid.uuid4().hex
        ts = time.time() if now is None else now
        with self._lock, self._connect() as conn:
            conn.execute(
                """INSERT INTO undo_journal
                   (id, action_id, actor, session_id, target, rollback,
                    rollback_detail, inverse_payload, status, created_at)
                   VALUES (?,?,?,?,?,?,?,?, 'done', ?)""",
                (entry_id, action_id, actor, session_id, target, rollback,
                 rollback_detail, json.dumps(inverse_payload or {}), ts),
            )
        return self.get(entry_id)

    def get(self, entry_id: str) -> JournalEntry:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM undo_journal WHERE id = ?", (entry_id,)
            ).fetchone()
        if row is None:
            raise KeyError(entry_id)
        return self._row(row)

    # -- reading -----------------------------------------------------------

    def stack(
        self,
        *,
        session_id: str = "",
        limit: int = 50,
        now: Optional[float] = None,
    ) -> list[JournalEntry]:
        """The undo stack, newest first, scoped by session when asked.

        Only entries that can still be undone appear: reversible, not already
        undone, and inside retention.
        """
        ts = time.time() if now is None else now
        cutoff = ts - self._retention
        clauses = [
            "status = 'done'",
            "rollback != ?",
            "created_at >= ?",
        ]
        params: list[Any] = [Rollback.IRREVERSIBLE.value, cutoff]
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        params.append(max(1, min(limit, 200)))
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM undo_journal WHERE {' AND '.join(clauses)} "
                "ORDER BY created_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [self._row(r) for r in rows]

    def last_undoable(
        self, *, actor: str = "agent", session_id: str = "", now: Optional[float] = None
    ) -> Optional[JournalEntry]:
        """What "Undo last agent action" would actually undo."""
        for entry in self.stack(session_id=session_id, limit=200, now=now):
            if entry["actor"] == actor:
                return entry
        return None

    def needing_repair(self) -> list[JournalEntry]:
        """Failed compensations. These never age out of view.

        The world is in a state we tried and failed to reverse; retention is
        about whether an *undo is still possible*, not about whether a problem
        stops mattering.
        """
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM undo_journal WHERE status = 'compensation_failed' "
                "ORDER BY created_at DESC"
            ).fetchall()
        return [self._row(r) for r in rows]

    # -- undoing -----------------------------------------------------------

    def undo(
        self,
        entry_id: str,
        *,
        apply: Callable[[JournalEntry], Any],
        verify: Optional[Callable[[JournalEntry], bool]] = None,
        now: Optional[float] = None,
    ) -> JournalEntry:
        """Reverse an entry, and only claim success once it is verified.

        ``apply`` performs the reversal. ``verify`` re-reads the source of truth
        and returns whether the world actually changed — required for a
        compensation, where the reversal is a second request that can fail
        silently or partially. An inverse under our own transaction needs no
        separate verification, so ``verify`` may be omitted there.
        """
        entry = self.get(entry_id)
        ts = time.time() if now is None else now

        if entry["status"] != "done":
            raise UndoNotPossible(
                f"already {entry['status'].replace('_', ' ')}"
            )
        if entry["rollback"] == Rollback.IRREVERSIBLE.value:
            raise UndoNotPossible(
                f"this cannot be undone: {entry['rollback_detail']}"
            )
        if ts - entry["created_at"] > self._retention:
            raise UndoNotPossible(
                "past the undo window — the information needed to reverse this "
                "is no longer guaranteed to exist"
            )

        compensation = entry["rollback"] == Rollback.COMPENSATION.value
        if compensation and verify is None:
            # Refusing is the point. A compensation whose success is assumed is
            # exactly the "undone" that isn't.
            raise UndoNotPossible(
                "a compensation must be verified against the source; "
                "no verify function was supplied"
            )

        self._set_status(entry_id, "compensating" if compensation else "undoing")
        try:
            apply(entry)
        except Exception as exc:
            self._set_status(
                entry_id,
                "compensation_failed" if compensation else "done",
                outcome=f"reversal failed: {exc}",
            )
            raise

        if verify is not None:
            try:
                ok = bool(verify(entry))
            except Exception as exc:
                self._set_status(
                    entry_id, "compensation_failed",
                    outcome=f"could not verify the reversal: {exc}",
                )
                raise UndoNotPossible(
                    "the reversal was attempted but could not be verified"
                ) from exc
            if not ok:
                self._set_status(
                    entry_id, "compensation_failed",
                    outcome="the source still shows the original change",
                )
                raise UndoNotPossible(
                    "the reversal did not take effect at the source"
                )

        self._set_status(
            entry_id,
            "compensated" if compensation else "undone",
            outcome="verified" if verify is not None else "",
            undone_at=ts,
        )
        return self.get(entry_id)

    def _set_status(
        self,
        entry_id: str,
        status: str,
        *,
        outcome: str = "",
        undone_at: Optional[float] = None,
    ) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE undo_journal SET status = ?, outcome = ?, "
                "undone_at = COALESCE(?, undone_at) WHERE id = ?",
                (status, outcome, undone_at, entry_id),
            )


def permanence_sentence(rollback: str, detail: str = "") -> str:
    """The words shown at approval time. Must match what undo can deliver."""
    if rollback == Rollback.INVERSE.value:
        return "This can be undone."
    if rollback == Rollback.COMPENSATION.value:
        return (
            "This can be reversed afterwards, but not guaranteed — the reversal "
            "is a second request to an external system, and it can fail."
        )
    return f"This cannot be undone{f': {detail}' if detail else '.'}"
