"""Idempotency — a retry after a reconnect must not send twice.

The realtime path makes duplicate submission ordinary rather than exotic: a
socket drops mid-request, the client reconnects and resubmits, and without a
key the same email goes out twice or the same charge lands twice. So every
mutating request carries a key scoped to *actor, action, target and payload
hash*, and the outcome is persisted before the caller is told it succeeded.

The payload hash is part of the key on purpose. Two sends to the same recipient
with different bodies are different actions and must both run; the same send
retried after a timeout is one action and must run once. Keying on actor and
target alone would collapse the first case and lose a message.

Storage is SQLite with a UNIQUE key and an atomic claim, so two concurrent
callers race for one winner rather than both executing and one overwriting.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

from hermes_sqlite import force_delete_journal_if_wal_unsafe

#: How long a recorded outcome stays replayable. A retry days later is a new
#: intent, not the same one — keeping keys forever would silently swallow a
#: deliberate repeat of a legitimate action.
DEFAULT_TTL_SECONDS = 24 * 3600


def idempotency_key(
    *, actor: str, action_id: str, target: str, payload: Any
) -> str:
    """Derive the key. Stable for the same intent, different for a new one."""
    body = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]
    return f"{actor}:{action_id}:{target}:{digest}"


class IdempotencyStore:
    """Claim-then-record, so a duplicate observes the first result."""

    def __init__(self, path: Path | str, *, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
        self.path = Path(path)
        self.ttl_seconds = ttl_seconds
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._migrate()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        if not force_delete_journal_if_wal_unsafe(
            conn, db_label="phase1-idempotency-store"
        ):
            conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _migrate(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS idempotency (
                    key        TEXT PRIMARY KEY,
                    state      TEXT NOT NULL,
                    result     TEXT,
                    claimed_at REAL NOT NULL,
                    settled_at REAL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_idem_claimed ON idempotency(claimed_at)"
            )

    @staticmethod
    def _record(row: sqlite3.Row) -> dict:
        return {
            "state": row["state"],
            "result": json.loads(row["result"]) if row["result"] else None,
            "claimed_at": row["claimed_at"],
            "settled_at": row["settled_at"],
        }

    def claim(self, key: str, *, now: Optional[float] = None) -> tuple[bool, Optional[dict]]:
        """Try to become the one caller that executes.

        Returns ``(True, prior)`` when this caller won and should execute, or
        ``(False, record)`` when someone else holds it or it already succeeded —
        where ``record`` carries the earlier outcome if it has settled, and a
        ``state`` of ``"in_flight"`` if it has not.

        ``prior`` is ``None`` for a first attempt, and the earlier *failed*
        record when this claim is a retry. A failure is reacquirable on purpose:
        this store exists to stop something happening **twice**, and a failure
        means it did not happen once. Leaving the key settled would turn a
        transient provider error into a whole TTL in which that exact action can
        never be attempted again. The prior record is handed back rather than
        discarded so the caller can say what it is retrying — a send that failed
        without a confirmed outcome is not the same thing as a clean first
        attempt, and reporting it as one would hide a possible duplicate from
        the only person who can judge it.

        The reacquisition is itself conditional on the row still being
        ``failed``, so two retries arriving together do not both execute.

        An expired claim is reclaimable too: a process that died mid-action must
        not wedge the key forever.
        """
        now = time.time() if now is None else now
        cutoff = now - self.ttl_seconds
        with self._connect() as conn:
            conn.execute("DELETE FROM idempotency WHERE claimed_at < ?", (cutoff,))
            try:
                conn.execute(
                    "INSERT INTO idempotency (key, state, claimed_at) VALUES (?, 'in_flight', ?)",
                    (key, now),
                )
                return True, None
            except sqlite3.IntegrityError:
                row = conn.execute(
                    "SELECT key, state, result, claimed_at, settled_at "
                    "FROM idempotency WHERE key = ?",
                    (key,),
                ).fetchone()
                if row is None:  # deleted between the delete and the select
                    return True, None

                if row["state"] == "failed":
                    prior = self._record(row)
                    cur = conn.execute(
                        "UPDATE idempotency SET state = 'in_flight', result = NULL, "
                        "claimed_at = ?, settled_at = NULL "
                        "WHERE key = ? AND state = 'failed'",
                        (now, key),
                    )
                    if cur.rowcount == 1:
                        return True, prior
                    # Another retry got there first; fall through and report
                    # whatever it left behind rather than executing as well.
                    row = conn.execute(
                        "SELECT key, state, result, claimed_at, settled_at "
                        "FROM idempotency WHERE key = ?",
                        (key,),
                    ).fetchone()
                    if row is None:
                        return True, prior

                return False, self._record(row)

    def settle(self, key: str, *, state: str, result: Any = None) -> None:
        """Record the outcome so a later duplicate can replay it.

        ``state`` is ``"succeeded"`` or ``"failed"``. A failure is recorded too:
        a retry should be able to see that the first attempt failed rather than
        assuming it is the first attempt.
        """
        with self._connect() as conn:
            conn.execute(
                "UPDATE idempotency SET state = ?, result = ?, settled_at = ? WHERE key = ?",
                (state, json.dumps(result, default=str) if result is not None else None,
                 time.time(), key),
            )

    def release(self, key: str) -> None:
        """Drop an unsettled claim so the action can be attempted again.

        Used when execution never started — a validation failure before any side
        effect. Releasing after a side effect would be wrong; settle instead.
        """
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM idempotency WHERE key = ? AND state = 'in_flight'", (key,)
            )

    def lookup(self, key: str) -> Optional[dict]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT state, result, claimed_at, settled_at FROM idempotency WHERE key = ?",
                (key,),
            ).fetchone()
        if row is None:
            return None
        return {
            "state": row["state"],
            "result": json.loads(row["result"]) if row["result"] else None,
            "claimed_at": row["claimed_at"],
            "settled_at": row["settled_at"],
        }
