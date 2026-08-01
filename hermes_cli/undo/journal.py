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

Two consequences of that rule shape the rest of the module.

**The claim to reverse is a write, not a read.** "Undo" is reachable from the
item card, a keyboard shortcut and a second tab at once. Checking the status and
then writing it lets two callers both pass the check, and the reversal runs
twice — two restore requests to a provider, or an event moved back and then
moved back again. The claim is a conditional ``UPDATE`` and only the caller that
changed exactly one row proceeds.

**An abandoned reversal is worse than a failed one.** A process killed between
the claim and the outcome leaves the entry ``undoing`` or ``compensating``: no
longer ``done``, so it is gone from the stack, and not ``compensation_failed``,
so it is absent from the repair list too. Nothing surfaces a possibly
half-reversed external change. So in-flight entries carry a ``claimed_at``, are
readable while fresh, and are reconciled into an explicit
``reversal_unknown`` — a state whose whole content is that we do not know —
once they are too old to still be running.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from hermes_cli import sqlite_open

from hermes_cli.actions.registry import Rollback

#: How long a reversible entry stays offerable. Past this the inverse may no
#: longer be valid — a soft-deleted row can be purged, a prior version pruned —
#: so continuing to offer undo would promise something we cannot deliver.
DEFAULT_RETENTION_SECONDS = 14 * 24 * 3600

#: How long a claimed reversal may stay in flight before we stop assuming it is
#: still running. Generous on purpose: reconciling a *live* reversal would
#: declare an outcome unknown while the process that knows it is still working.
DEFAULT_IN_FLIGHT_TIMEOUT_SECONDS = 15 * 60

#: Claimed, running, outcome not yet written.
IN_FLIGHT_STATUSES = ("undoing", "compensating")

#: The world may not match what the owner was told. Each needs a person.
REPAIR_STATUSES = ("compensation_failed", "undo_failed", "reversal_unknown")


class UndoNotPossible(RuntimeError):
    """Raised when an entry cannot be undone, with the reason in plain words."""


class JournalEntry(dict):
    """A recorded action, and how to take it back."""

    @property
    def reversible(self) -> bool:
        return self.get("rollback") in (Rollback.INVERSE.value, Rollback.COMPENSATION.value)

    @property
    def needs_repair(self) -> bool:
        return self.get("status") in REPAIR_STATUSES

    @property
    def in_flight(self) -> bool:
        return self.get("status") in IN_FLIGHT_STATUSES


class UndoJournal:
    def __init__(
        self,
        path: Path | str,
        *,
        retention_seconds: int = DEFAULT_RETENTION_SECONDS,
        in_flight_timeout_seconds: int = DEFAULT_IN_FLIGHT_TIMEOUT_SECONDS,
    ) -> None:
        self._path = Path(path)
        self._retention = retention_seconds
        self._in_flight_timeout = in_flight_timeout_seconds
        self._lock = threading.Lock()
        self.migrate()

    def _connect(self) -> sqlite3.Connection:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # One controlled path, shared with the idempotency store: busy_timeout
        # first, journal-mode switch retried under contention. Concurrent
        # construction used to raise "database is locked" in 3 of 200 rounds.
        return sqlite_open.connect(self._path, db_label="undo-journal")

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
                    -- When a reversal was claimed. An in-flight entry without
                    -- this could never be told apart from one abandoned by a
                    -- process that died, so reconciliation would have to guess.
                    claimed_at    REAL,
                    -- Which reversal attempt owns this entry. Terminal writes
                    -- compare-and-swap on it, so a stale worker returning
                    -- after reconciliation cannot overwrite `reversal_unknown`
                    -- with "undone".
                    reversal_owner TEXT,
                    undone_at     REAL
                )
                """
            )
            existing = {
                r["name"]
                for r in conn.execute("PRAGMA table_info(undo_journal)").fetchall()
            }
            if "claimed_at" not in existing:
                conn.execute("ALTER TABLE undo_journal ADD COLUMN claimed_at REAL")
            if "reversal_owner" not in existing:
                conn.execute("ALTER TABLE undo_journal ADD COLUMN reversal_owner TEXT")
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

    def needing_repair(self, *, now: Optional[float] = None) -> list[JournalEntry]:
        """Everything a person has to look at. These never age out of view.

        The world is in a state we tried and failed to reverse — or one we
        cannot describe at all; retention is about whether an *undo is still
        possible*, not about whether a problem stops mattering.

        Reconciling first is what makes an abandoned reversal reachable. The
        repair list is the screen this surfaces on, and an entry left behind by
        a killed process has no other way to arrive here.
        """
        self.reconcile(now=now)
        placeholders = ",".join("?" for _ in REPAIR_STATUSES)
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM undo_journal WHERE status IN ({placeholders}) "
                "ORDER BY created_at DESC",
                list(REPAIR_STATUSES),
            ).fetchall()
        return [self._row(r) for r in rows]

    def in_flight(self, *, now: Optional[float] = None) -> list[JournalEntry]:
        """Reversals claimed and still plausibly running.

        Fresh ones belong here rather than in the repair list: a reversal is
        allowed to take a moment, and calling it unknown while it is working
        would be its own false report.
        """
        ts = time.time() if now is None else now
        cutoff = ts - self._in_flight_timeout
        placeholders = ",".join("?" for _ in IN_FLIGHT_STATUSES)
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM undo_journal WHERE status IN ({placeholders}) "
                "AND COALESCE(claimed_at, created_at) >= ? ORDER BY claimed_at DESC",
                [*IN_FLIGHT_STATUSES, cutoff],
            ).fetchall()
        return [self._row(r) for r in rows]

    def reconcile(self, *, now: Optional[float] = None) -> list[JournalEntry]:
        """Resolve reversals abandoned by a process that never came back.

        This is the crash path. Everything else in this module writes an
        outcome; a killed process writes nothing, so the entry sits claimed
        forever — out of the stack because it is not ``done``, out of the repair
        list because it never failed. It gets moved to ``reversal_unknown``,
        which is not a failure and not a success: for a compensation the
        external system may be half-reversed, and saying anything more definite
        than "we do not know" would be a guess dressed as a fact.

        Returns the entries it changed, so a caller can log or notify.
        """
        ts = time.time() if now is None else now
        cutoff = ts - self._in_flight_timeout
        placeholders = ",".join("?" for _ in IN_FLIGHT_STATUSES)
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM undo_journal WHERE status IN ({placeholders}) "
                "AND COALESCE(claimed_at, created_at) < ?",
                [*IN_FLIGHT_STATUSES, cutoff],
            ).fetchall()
            stale = [self._row(r) for r in rows]
            for entry in stale:
                conn.execute(
                    # Clearing `reversal_owner` is the fence. Without it the
                    # worker we just declared abandoned could return and match
                    # its own owner on a terminal write, overwriting this
                    # honest "we do not know" with "undone".
                    "UPDATE undo_journal SET status = 'reversal_unknown', outcome = ?, "
                    "reversal_owner = NULL "
                    "WHERE id = ? AND status = ?",
                    (
                        "the reversal was started and never finished — we do not "
                        "know whether it took effect",
                        entry["id"],
                        entry["status"],
                    ),
                )
        return [self.get(e["id"]) for e in stale]

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

        # From here the claim is the authority, not the status read above. Two
        # callers can both reach this line believing the entry is `done`; only
        # the one that changes a row is allowed to touch the world.
        owner = self._claim(entry_id, "compensating" if compensation else "undoing", ts)
        if owner is None:
            raise UndoNotPossible(
                f"already {self.get(entry_id)['status'].replace('_', ' ')}"
            )

        try:
            apply(entry)
        except Exception as exc:
            # An exception says the callback raised. It does *not* say nothing
            # happened: `apply` runs outside this journal's transaction, so a
            # partially applied inverse raises exactly the same way a
            # never-started one does. Treating that as "still offerable" would
            # invite a second inverse over a half-applied first — so it is
            # unknown, which is the honest state and a blocking one.
            self._set_status(
                entry_id,
                "compensation_failed" if compensation else "reversal_unknown",
                outcome=f"reversal failed: {exc}",
                owner=owner,
            )
            raise

        if verify is not None:
            try:
                ok = bool(verify(entry))
            except Exception as exc:
                self._set_status(
                    entry_id,
                    # We could not look. For a compensation the provider is the
                    # source of truth and it stays blocking either way; for an
                    # inverse, unreachable is not the same as failed.
                    "compensation_failed" if compensation else "reversal_unknown",
                    outcome=f"could not verify the reversal: {exc}",
                    owner=owner,
                )
                raise UndoNotPossible(
                    "the reversal was attempted but could not be verified"
                ) from exc
            if not ok:
                self._set_status(
                    entry_id,
                    # We looked, and the change is still there. Filing an
                    # internal restore under `compensation_failed` would send
                    # the owner to a provider that was never involved.
                    "compensation_failed" if compensation else "undo_failed",
                    outcome="the source still shows the original change",
                    owner=owner,
                )
                raise UndoNotPossible(
                    "the reversal did not take effect at the source"
                )

        if not self._set_status(
            entry_id,
            "compensated" if compensation else "undone",
            outcome="verified" if verify is not None else "",
            undone_at=ts,
            owner=owner,
        ):
            # Reconciliation decided this reversal was abandoned and moved it
            # on. Claiming success now would overwrite an honest "we do not
            # know" with a claim nobody can check.
            raise UndoNotPossible(
                "this reversal was reconciled as abandoned while it was running; "
                "its outcome is recorded as unknown and needs a person"
            )
        return self.get(entry_id)

    def _claim(self, entry_id: str, status: str, now: float) -> Optional[str]:
        """Take exclusive ownership of a reversal. True only for the winner.

        Conditional on the entry still being ``done``, so of any number of
        concurrent callers exactly one can change a row, and the rest learn they
        lost by being told nothing changed rather than by discovering it after
        the reversal has already run twice.
        """
        owner = uuid.uuid4().hex
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "UPDATE undo_journal SET status = ?, claimed_at = ?, reversal_owner = ? "
                "WHERE id = ? AND status = 'done'",
                (status, now, owner, entry_id),
            )
            return owner if cur.rowcount == 1 else None

    def _set_status(
        self,
        entry_id: str,
        status: str,
        *,
        outcome: str = "",
        undone_at: Optional[float] = None,
        owner: Optional[str] = None,
    ) -> bool:
        """Write a terminal status. With ``owner``, only if it still holds the entry.

        Unfenced writes were the defect: reconciliation could move a stale
        entry to ``reversal_unknown``, and then the worker everyone assumed was
        dead could return and overwrite it with ``undone``. The owner check
        makes a late write lose instead of win. Returns whether it landed.
        """
        with self._lock, self._connect() as conn:
            if owner is None:
                # Unfenced writes remain available for reconciliation itself,
                # which is acting *because* no owner is coming back.
                cur = conn.execute(
                    "UPDATE undo_journal SET status = ?, outcome = ?, "
                    "undone_at = COALESCE(?, undone_at) WHERE id = ?",
                    (status, outcome, undone_at, entry_id),
                )
            else:
                cur = conn.execute(
                    "UPDATE undo_journal SET status = ?, outcome = ?, "
                    "undone_at = COALESCE(?, undone_at) "
                    "WHERE id = ? AND reversal_owner = ?",
                    (status, outcome, undone_at, entry_id, owner),
                )
            return cur.rowcount == 1


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
