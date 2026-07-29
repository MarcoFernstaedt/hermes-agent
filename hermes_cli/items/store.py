"""The item store — one table, one writer, many projections.

This *extends the existing review table in place* rather than standing up a
second store. That is the whole architectural rule: the notification stream,
the review queue, the shell glance and chat's reference chips are all queries
against these rows. A second store is how two surfaces come to disagree about
whether something was approved.

Two properties do the load-bearing work:

**Compare-and-set on the expected state.** Every transition names the state it
believes the item is in, and the UPDATE carries that in its WHERE clause. Two
tabs resolving the same item race for one winner; the loser is told what the
winning state is instead of silently clobbering it. This is the pattern the
review store already used, kept and generalised.

**A monotonic version and sequence.** `version` increments on every transition
so a client can discard a frame older than what it already rendered, and `seq`
orders changes across items for replay after a reconnect.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from hermes_sqlite import force_delete_journal_if_wal_unsafe

from hermes_cli.items.lifecycle import (
    CLASS_RANK,
    NotificationClass,
    State,
    assert_transition,
)


class ItemNotFound(LookupError):
    def __init__(self, item_id: str) -> None:
        super().__init__(f"no item {item_id!r}")
        self.item_id = item_id


class ItemConflict(RuntimeError):
    """Someone else moved this item first. Carries the state that won."""

    def __init__(self, item_id: str, expected: str, actual: str) -> None:
        super().__init__(
            f"item {item_id!r} is {actual!r}, expected {expected!r} — "
            "it was decided elsewhere"
        )
        self.item_id = item_id
        self.expected = expected
        self.actual = actual


_JSON_COLUMNS = ("payload", "preview", "provenance")


class ItemStore:
    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)
        self._lock = threading.Lock()
        self.migrate()

    def _connect(self) -> sqlite3.Connection:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._path))
        conn.row_factory = sqlite3.Row
        # SQLite before 3.53.0 carries the WAL-reset corruption bug, so the
        # shared guard forces rollback-journal mode there and we only apply the
        # WAL default when it reports the runtime is safe. Hardcoding
        # `journal_mode=WAL` — which this store originally did — risks the
        # corruption on an affected runtime.
        if not force_delete_journal_if_wal_unsafe(conn, db_label="item-store"):
            conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def migrate(self) -> None:
        """Create or upgrade the table.

        Additive only: an existing review database keeps its rows and gains the
        new columns with defaults that describe what those rows already meant.
        A pending proposal is an actionable item awaiting a decision, so that is
        what it becomes — no data migration, no reinterpretation.
        """
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS proposals (
                    id          TEXT PRIMARY KEY,
                    kind        TEXT NOT NULL,
                    title       TEXT NOT NULL,
                    summary     TEXT NOT NULL DEFAULT '',
                    source      TEXT NOT NULL DEFAULT 'agent',
                    risk        TEXT NOT NULL DEFAULT 'low',
                    status      TEXT NOT NULL DEFAULT 'pending',
                    payload     TEXT NOT NULL DEFAULT '{}',
                    preview     TEXT NOT NULL DEFAULT '{}',
                    outcome     TEXT NOT NULL DEFAULT '',
                    created_at  REAL NOT NULL,
                    decided_at  REAL,
                    applied_at  REAL
                )
                """
            )
            existing = {r["name"] for r in conn.execute("PRAGMA table_info(proposals)")}
            additions = {
                # The ambient-layer columns. `state` is kept separate from the
                # legacy `status` so nothing reading the old column breaks
                # mid-deploy; `state` is authoritative for new code.
                "state": f"TEXT NOT NULL DEFAULT '{State.AWAITING_DECISION.value}'",
                "klass": f"TEXT NOT NULL DEFAULT '{NotificationClass.ACTIONABLE.value}'",
                "version": "INTEGER NOT NULL DEFAULT 1",
                "seq": "INTEGER NOT NULL DEFAULT 0",
                "origin_turn_id": "TEXT NOT NULL DEFAULT ''",
                "rule_id": "TEXT NOT NULL DEFAULT ''",
                "provenance": "TEXT NOT NULL DEFAULT '{}'",
                "reason": "TEXT NOT NULL DEFAULT ''",
                "snoozed_until": "REAL",
                "snooze_condition": "TEXT NOT NULL DEFAULT ''",
                "artifact_version": "INTEGER NOT NULL DEFAULT 1",
                "payload_hash": "TEXT NOT NULL DEFAULT ''",
                "idempotency_key": "TEXT NOT NULL DEFAULT ''",
                "attempt": "INTEGER NOT NULL DEFAULT 0",
                "action_id": "TEXT NOT NULL DEFAULT ''",
                "updated_at": "REAL",
            }
            for column, ddl in additions.items():
                if column not in existing:
                    conn.execute(f"ALTER TABLE proposals ADD COLUMN {column} {ddl}")

            conn.execute("CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created_at)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_items_state ON proposals(state, created_at)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_items_seq ON proposals(seq)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_items_klass ON proposals(klass, created_at)")

            # Backfill rows written before `state` existed. Their legacy status
            # already says what they were; map it rather than guessing.
            conn.execute(
                "UPDATE proposals SET state = CASE status "
                "  WHEN 'pending'  THEN ? WHEN 'approved' THEN ? "
                "  WHEN 'rejected' THEN ? WHEN 'applied'  THEN ? "
                "  WHEN 'failed'   THEN ? ELSE state END "
                "WHERE state = ? AND status <> 'pending'",
                (State.AWAITING_DECISION.value, State.APPROVED.value,
                 State.DENIED.value, State.SUCCEEDED.value, State.FAILED.value,
                 State.AWAITING_DECISION.value),
            )

    # -- reads -------------------------------------------------------------

    @staticmethod
    def _row(r: sqlite3.Row) -> dict[str, Any]:
        d = dict(r)
        for key in _JSON_COLUMNS:
            raw = d.get(key)
            try:
                d[key] = json.loads(raw) if raw else {}
            except (json.JSONDecodeError, TypeError):
                d[key] = {}
        return d

    def get(self, item_id: str) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM proposals WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise ItemNotFound(item_id)
        return self._row(row)

    def stream(
        self,
        *,
        states: Optional[list[str]] = None,
        klasses: Optional[list[str]] = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """The canonical projection: class rank first, then oldest within class.

        Ordering is done in SQL via the class rank so the stream and any
        paginated slice of it agree — sorting client-side would make page two
        disagree with page one.
        """
        clauses, params = [], []
        if states:
            clauses.append(f"state IN ({','.join('?' * len(states))})")
            params += states
        if klasses:
            clauses.append(f"klass IN ({','.join('?' * len(klasses))})")
            params += klasses
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rank_case = " ".join(
            f"WHEN '{k}' THEN {v}" for k, v in CLASS_RANK.items()
        )
        params.append(max(1, min(limit, 500)))
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM proposals {where} "
                f"ORDER BY (CASE klass {rank_case} ELSE 99 END), created_at ASC LIMIT ?",
                params,
            ).fetchall()
        return [self._row(r) for r in rows]

    def counts_by_state(self) -> dict[str, int]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT state, COUNT(*) c FROM proposals GROUP BY state"
            ).fetchall()
        return {r["state"]: r["c"] for r in rows}

    def since(self, seq: int, *, limit: int = 200) -> list[dict[str, Any]]:
        """Everything changed after `seq` — the reconnect replay."""
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM proposals WHERE seq > ? ORDER BY seq ASC LIMIT ?",
                (seq, max(1, min(limit, 500))),
            ).fetchall()
        return [self._row(r) for r in rows]

    # -- writes ------------------------------------------------------------

    def _next_seq(self, conn: sqlite3.Connection) -> int:
        row = conn.execute("SELECT COALESCE(MAX(seq), 0) AS s FROM proposals").fetchone()
        return int(row["s"]) + 1

    def create(
        self,
        *,
        kind: str,
        title: str,
        klass: str = NotificationClass.ACTIONABLE.value,
        summary: str = "",
        source: str = "agent",
        risk: str = "low",
        action_id: str = "",
        origin_turn_id: str = "",
        rule_id: str = "",
        provenance: Optional[dict] = None,
        payload: Optional[dict] = None,
        preview: Optional[dict] = None,
        state: str = State.AWAITING_DECISION.value,
    ) -> dict[str, Any]:
        if not title.strip():
            raise ValueError("title is required")
        if klass not in CLASS_RANK:
            raise ValueError(f"unknown notification class {klass!r}")
        State(state)  # reject an unknown state at the door

        item_id = uuid.uuid4().hex
        now = time.time()
        with self._lock, self._connect() as conn:
            conn.execute(
                """INSERT INTO proposals
                   (id, kind, title, summary, source, risk, status, state, klass,
                    payload, preview, provenance, action_id, origin_turn_id,
                    rule_id, created_at, updated_at, version, seq)
                   VALUES (?,?,?,?,?,?, 'pending', ?,?,?,?,?,?,?,?,?,?,1,?)""",
                (item_id, kind, title.strip(), summary, source, risk, state, klass,
                 json.dumps(payload or {}), json.dumps(preview or {}),
                 json.dumps(provenance or {}), action_id, origin_turn_id, rule_id,
                 now, now, self._next_seq(conn)),
            )
        return self.get(item_id)

    def transition(
        self,
        item_id: str,
        *,
        expect: str,
        to: str,
        **fields: Any,
    ) -> dict[str, Any]:
        """Move the item, but only if it is still where the caller thinks.

        Raises `ItemConflict` naming the winning state when it is not — which
        is what lets a card render "decided elsewhere" instead of overwriting
        someone else's decision.
        """
        assert_transition(expect, to)  # illegal moves fail before touching the db

        for json_col in _JSON_COLUMNS:
            if json_col in fields and not isinstance(fields[json_col], str):
                fields[json_col] = json.dumps(fields[json_col])

        assignments = ", ".join(f"{k} = ?" for k in fields)
        sql = (
            "UPDATE proposals SET state = ?, version = version + 1, "
            f"seq = ?, updated_at = ?{', ' + assignments if assignments else ''} "
            "WHERE id = ? AND state = ?"
        )
        with self._lock, self._connect() as conn:
            params = [to, self._next_seq(conn), time.time(), *fields.values(),
                      item_id, expect]
            cur = conn.execute(sql, params)
            if cur.rowcount == 0:
                row = conn.execute(
                    "SELECT state FROM proposals WHERE id = ?", (item_id,)
                ).fetchone()
                if row is None:
                    raise ItemNotFound(item_id)
                raise ItemConflict(item_id, expect, row["state"])
        return self.get(item_id)

    # -- convenience transitions -------------------------------------------

    def acknowledge(self, item_id: str, *, expect: str = State.OPEN.value) -> dict[str, Any]:
        return self.transition(item_id, expect=expect, to=State.ACKNOWLEDGED.value)

    def approve(
        self, item_id: str, *, expect: str = State.AWAITING_DECISION.value
    ) -> dict[str, Any]:
        return self.transition(
            item_id, expect=expect, to=State.APPROVED.value, decided_at=time.time()
        )

    def deny(
        self, item_id: str, *, reason: str = "",
        expect: str = State.AWAITING_DECISION.value,
    ) -> dict[str, Any]:
        # A denial with a reason is feedback for that category; a bare rejection
        # is noise. The reason is stored on the item, not inferred later.
        return self.transition(
            item_id, expect=expect, to=State.DENIED.value,
            reason=reason.strip(), decided_at=time.time(),
        )

    def snooze(
        self,
        item_id: str,
        *,
        until: Optional[float] = None,
        condition: str = "",
        expect: str = State.AWAITING_DECISION.value,
    ) -> dict[str, Any]:
        if until is None and not condition.strip():
            raise ValueError("snooze needs a time or a condition")
        return self.transition(
            item_id, expect=expect, to=State.SNOOZED.value,
            snoozed_until=until, snooze_condition=condition.strip(),
        )

    def wake(self, item_id: str, *, to: str = State.AWAITING_DECISION.value) -> dict[str, Any]:
        return self.transition(
            item_id, expect=State.SNOOZED.value, to=to,
            snoozed_until=None, snooze_condition="",
        )

    def due_snoozes(self, *, now: Optional[float] = None) -> list[dict[str, Any]]:
        """Time-snoozed items whose moment has come. Deterministic and idempotent:
        waking one that is already awake raises `ItemConflict` rather than
        double-firing."""
        now = time.time() if now is None else now
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM proposals WHERE state = ? AND snoozed_until IS NOT NULL "
                "AND snoozed_until <= ? ORDER BY snoozed_until ASC",
                (State.SNOOZED.value, now),
            ).fetchall()
        return [self._row(r) for r in rows]

    def record_execution(
        self,
        item_id: str,
        *,
        expect: str,
        to: str,
        outcome: str = "",
        idempotency_key: str = "",
    ) -> dict[str, Any]:
        """Execution progress. `succeeded` is only reachable from `executing`,
        enforced by the lifecycle, so nothing can claim success without running."""
        fields: dict[str, Any] = {"outcome": outcome}
        if idempotency_key:
            fields["idempotency_key"] = idempotency_key
        if to == State.EXECUTING.value:
            fields["attempt"] = self.get(item_id).get("attempt", 0) + 1
        if to in (State.SUCCEEDED.value, State.FAILED.value):
            fields["applied_at"] = time.time()
        return self.transition(item_id, expect=expect, to=to, **fields)
