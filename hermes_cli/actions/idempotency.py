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
import uuid
from pathlib import Path
from typing import Any, Optional

from hermes_cli import sqlite_open

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
        # One controlled path: busy_timeout before anything else, and the
        # journal-mode switch retried while another connection holds the file.
        return sqlite_open.connect(self.path, db_label="phase1-idempotency-store")

    def _migrate(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS idempotency (
                    key        TEXT PRIMARY KEY,
                    state      TEXT NOT NULL,
                    result     TEXT,
                    claimed_at REAL NOT NULL,
                    settled_at REAL,
                    -- Which attempt currently owns this key. Without it,
                    -- `settle` updated by key alone, so an expired claimant
                    -- returning late could write its outcome over the row a
                    -- *different* claimant now holds — recording someone
                    -- else's send as this one's success.
                    attempt    TEXT
                )
                """
            )
            existing = {
                r["name"] for r in conn.execute("PRAGMA table_info(idempotency)").fetchall()
            }
            if "attempt" not in existing:
                conn.execute("ALTER TABLE idempotency ADD COLUMN attempt TEXT")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_idem_claimed ON idempotency(claimed_at)"
            )

    @staticmethod
    def _record(row: sqlite3.Row) -> dict:
        keys = row.keys()
        return {
            "state": row["state"],
            "result": json.loads(row["result"]) if row["result"] else None,
            "claimed_at": row["claimed_at"],
            "settled_at": row["settled_at"],
            "attempt": row["attempt"] if "attempt" in keys else None,
        }

    def mark_dispatching(self, key: str, attempt: str) -> bool:
        """Record that the external request is *about to leave*.

        The state between "we decided to act" and "we know what happened" needs
        a name, because it is the only state in which a retry can duplicate a
        real-world effect. A send that raised after the provider accepted it is
        indistinguishable from one that never left — so once a key is
        ``dispatching``, an unexplained failure becomes ``ambiguous`` rather
        than ``failed``, and ``ambiguous`` is not retryable without
        reconciliation.

        Conditional on this attempt still owning the row.
        """
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE idempotency SET state = 'dispatching' "
                "WHERE key = ? AND attempt = ? AND state = 'in_flight'",
                (key, attempt),
            )
            return cur.rowcount == 1

    def claim(
        self, key: str, *, now: Optional[float] = None
    ) -> tuple[bool, Optional[dict], Optional[str]]:
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

        The third element is this claim's **attempt token**. Every subsequent
        write must present it. Without one, `settle` updated by key alone — so
        a claimant whose claim had expired could return late and write its
        outcome over the row a *different* claimant now held, recording someone
        else's send as this one's success. An adversarial probe demonstrated
        exactly that.

        Expiry is deliberately narrow. Only a pre-dispatch ``in_flight`` claim
        is reclaimable by age: a process that died before acting must not wedge
        the key forever, and nothing happened, so a fresh attempt is a first
        attempt. A ``dispatching`` row is **never** reclaimed by elapsed time —
        time is not evidence about an external system — it becomes
        ``ambiguous`` and stays blocked. Conclusive receipts (``succeeded``,
        ``ambiguous``) are retained independently of claim expiry, because
        forgetting a success is how a duplicate is authorised.
        """
        now = time.time() if now is None else now
        cutoff = now - self.ttl_seconds
        attempt = uuid.uuid4().hex
        with self._connect() as conn:
            # Only abandoned *pre-dispatch* claims are swept. A success or an
            # ambiguous outcome is a receipt, not a claim, and outlives the TTL.
            conn.execute(
                "DELETE FROM idempotency WHERE claimed_at < ? AND state = 'in_flight'",
                (cutoff,),
            )
            # An abandoned dispatch does not become retryable; it becomes a
            # question for a person.
            conn.execute(
                # `attempt = NULL` is the fence. Without it the worker this
                # just declared abandoned could return and still match its own
                # token, settling `succeeded` over an `ambiguous` that exists
                # precisely because nobody knows what happened.
                "UPDATE idempotency SET state = 'ambiguous', settled_at = ?, "
                "attempt = NULL "
                "WHERE claimed_at < ? AND state = 'dispatching'",
                (now, cutoff),
            )
            try:
                conn.execute(
                    "INSERT INTO idempotency (key, state, claimed_at, attempt) "
                    "VALUES (?, 'in_flight', ?, ?)",
                    (key, now, attempt),
                )
                return True, None, attempt
            except sqlite3.IntegrityError:
                row = conn.execute(
                    "SELECT * FROM idempotency WHERE key = ?", (key,)
                ).fetchone()
                if row is None:  # deleted between the delete and the select
                    return True, None, attempt

                if row["state"] == "failed":
                    # `failed` means *proven not to have happened* — see
                    # `settle`. Only that is reacquirable.
                    prior = self._record(row)
                    cur = conn.execute(
                        "UPDATE idempotency SET state = 'in_flight', result = NULL, "
                        "claimed_at = ?, settled_at = NULL, attempt = ? "
                        "WHERE key = ? AND state = 'failed' AND attempt IS ?",
                        (now, attempt, key, row["attempt"]),
                    )
                    if cur.rowcount == 1:
                        return True, prior, attempt
                    # Another retry got there first; report what it left rather
                    # than executing as well.
                    row = conn.execute(
                        "SELECT * FROM idempotency WHERE key = ?", (key,)
                    ).fetchone()
                    if row is None:
                        return True, prior, attempt

                return False, self._record(row), None

    def settle_pre_dispatch(
        self, key: str, attempt: str, *, result: Any = None
    ) -> bool:
        """Record that the request provably never left. Only from ``in_flight``.

        Separate from the post-dispatch settlement because the two carry
        different claims about the world, and a single `settle` that accepts
        any state let a stale owner assert either one. This says "nothing
        happened", which is only sayable before dispatch.
        """
        return self._settle(key, attempt, "failed", "in_flight", result)

    def settle_dispatched(
        self, key: str, attempt: str, *, state: str, result: Any = None
    ) -> bool:
        """Record what the provider did. Only from ``dispatching``.

        ``state`` is ``succeeded`` (the provider confirmed it) or ``ambiguous``
        (it may have landed and we cannot tell).
        """
        if state not in ("succeeded", "ambiguous"):
            raise ValueError(f"{state!r} is not a post-dispatch outcome")
        return self._settle(key, attempt, state, "dispatching", result)

    def settle_reconciled(
        self, key: str, attempt: str, *, state: str, result: Any = None
    ) -> bool:
        """Record what a *look at the provider* found. Only from ``dispatching``.

        This is the one path allowed to write ``failed`` after dispatch, and it
        earns that by having checked: reconciliation searched Sent for the
        deterministic Message-ID and did not find it. A post-dispatch exception
        may write only ``ambiguous``, because an exception is not a look.
        """
        if state not in ("succeeded", "failed", "ambiguous"):
            raise ValueError(f"{state!r} is not a reconciliation outcome")
        return self._settle(key, attempt, state, "dispatching", result)

    def _settle(
        self, key: str, attempt: str, state: str, expected: str, result: Any
    ) -> bool:
        """Compare-and-swap on key, owner **and** the state we expect to be in.

        Ownership alone was not enough. Reconciliation moved a stale
        ``dispatching`` row to ``ambiguous`` while leaving the attempt token in
        place, so the abandoned worker returned, matched its own token, and
        wrote ``succeeded`` over an outcome that existed because nobody knew
        what happened. Naming the expected state means a row that has moved on
        underneath a caller refuses the write instead of accepting it.
        """
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE idempotency SET state = ?, result = ?, settled_at = ? "
                "WHERE key = ? AND attempt = ? AND state = ?",
                (state, json.dumps(result, default=str) if result is not None else None,
                 time.time(), key, attempt, expected),
            )
            return cur.rowcount == 1

    def adopt_ambiguous(self, key: str) -> Optional[str]:
        """Take ownership of an ambiguous row so it can be reconciled.

        Returns a fresh attempt token, or None when the row is not ambiguous or
        somebody else got there first. Reconciliation has to claim before it
        writes for the same reason a send does: two reconcilers reaching a
        different conclusion and both recording it is worse than neither.
        """
        token = uuid.uuid4().hex
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE idempotency SET state = 'dispatching', attempt = ? "
                "WHERE key = ? AND state = 'ambiguous'",
                (token, key),
            )
            return token if cur.rowcount == 1 else None

    def release(self, key: str, attempt: str) -> bool:
        """Drop an unsettled claim so the action can be attempted again.

        Only from ``in_flight`` — before the request left. A ``dispatching``
        claim cannot be released, because releasing it would advertise as
        never-attempted something that may already have happened.
        """
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM idempotency WHERE key = ? AND attempt = ? AND state = 'in_flight'",
                (key, attempt),
            )
            return cur.rowcount == 1

    def lookup(self, key: str) -> Optional[dict]:
        """The current record, including which attempt owns it. No mutation."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM idempotency WHERE key = ?", (key,)
            ).fetchone()
        return None if row is None else self._record(row)
