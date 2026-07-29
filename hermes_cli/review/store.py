"""Persisted review-queue store (sqlite under HERMES_HOME/state).

A proposal is an immutable description of a change plus a mutable decision. It is
never mutated except to record the human's decision and the outcome of applying
it, so the audit trail — who proposed what, when it was approved, whether it
applied — is intact. Raw sqlite3 to match the other lean stores.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

# Proposal kinds. Kept open (a string) but these are the known ones; a handler
# must be registered for a kind before a proposal of it can be applied.
KINDS = {"capability", "skill", "mcp", "plugin", "tool", "automation", "improvement"}
STATUSES = {"pending", "approved", "rejected", "applied", "failed"}
RISKS = {"low", "medium", "high"}


class ProposalNotFound(LookupError):
    pass


class ProposalConflict(RuntimeError):
    """Raised when a proposal is not in the state the caller expected."""


class ReviewStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()
        self.migrate()

    def _connect(self) -> sqlite3.Connection:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._path))
        conn.row_factory = sqlite3.Row
        return conn

    def migrate(self) -> None:
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
            conn.execute("CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created_at)")

    @staticmethod
    def _row(r: sqlite3.Row) -> dict[str, Any]:
        d = dict(r)
        for key in ("payload", "preview"):
            try:
                d[key] = json.loads(d[key]) if d[key] else {}
            except (json.JSONDecodeError, TypeError):
                d[key] = {}
        return d

    def create(
        self,
        *,
        kind: str,
        title: str,
        summary: str = "",
        source: str = "agent",
        risk: str = "low",
        payload: Optional[dict] = None,
        preview: Optional[dict] = None,
    ) -> dict[str, Any]:
        if not title.strip():
            raise ValueError("title is required")
        if risk not in RISKS:
            risk = "low"
        pid = uuid.uuid4().hex
        now = time.time()
        with self._lock, self._connect() as conn:
            conn.execute(
                """INSERT INTO proposals
                   (id, kind, title, summary, source, risk, status, payload, preview, created_at)
                   VALUES (?,?,?,?,?,?, 'pending', ?,?,?)""",
                (pid, kind, title.strip(), summary, source, risk,
                 json.dumps(payload or {}), json.dumps(preview or {}), now),
            )
        return self.get(pid)

    def get(self, pid: str) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM proposals WHERE id = ?", (pid,)).fetchone()
        if row is None:
            raise ProposalNotFound(pid)
        return self._row(row)

    def list(self, *, status: Optional[str] = None, limit: int = 100) -> list[dict[str, Any]]:
        clause = "WHERE status = ?" if status else ""
        params: list[Any] = [status] if status else []
        params.append(max(1, min(limit, 500)))
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM proposals {clause} ORDER BY created_at DESC LIMIT ?", params
            ).fetchall()
        return [self._row(r) for r in rows]

    def counts(self) -> dict[str, int]:
        with self._lock, self._connect() as conn:
            rows = conn.execute("SELECT status, COUNT(*) c FROM proposals GROUP BY status").fetchall()
        return {r["status"]: r["c"] for r in rows}

    def _transition(self, pid: str, expect: str, to: str, **fields: Any) -> dict[str, Any]:
        sets = ", ".join(f"{k} = ?" for k in fields)
        sets = f"status = ?{', ' + sets if sets else ''}"
        params = [to, *fields.values(), pid, expect]
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                f"UPDATE proposals SET {sets} WHERE id = ? AND status = ?", params
            )
            if cur.rowcount == 0:
                existing = conn.execute("SELECT status FROM proposals WHERE id = ?", (pid,)).fetchone()
                if existing is None:
                    raise ProposalNotFound(pid)
                raise ProposalConflict(f"proposal is '{existing['status']}', expected '{expect}'")
        return self.get(pid)

    def approve(self, pid: str) -> dict[str, Any]:
        return self._transition(pid, "pending", "approved", decided_at=time.time())

    def reject(self, pid: str) -> dict[str, Any]:
        return self._transition(pid, "pending", "rejected", decided_at=time.time())

    def mark_applied(self, pid: str, outcome: str = "") -> dict[str, Any]:
        return self._transition(pid, "approved", "applied", applied_at=time.time(), outcome=outcome)

    def mark_failed(self, pid: str, outcome: str = "") -> dict[str, Any]:
        return self._transition(pid, "approved", "failed", applied_at=time.time(), outcome=outcome)
