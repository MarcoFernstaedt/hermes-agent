"""Append-only audit log of agent actions against external services.

Every write the agent performs through a module tool against an external
service (send an email, create a calendar event, add to a playlist, overwrite
a note) is recorded here: what happened, what it targeted, whether it was
auto-approved or explicitly approved, and how it turned out. The log is
append-only — there is no update or delete API — and reviewable, filterable
and exportable so I can always answer "what did the agent do on my behalf?".

Storage is a small SQLite database alongside the other ``~/.hermes`` state.
Rows never contain secrets; ``target`` and ``detail`` are human-readable
summaries the recording tool is responsible for keeping free of token
material.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from hermes_cli.config import get_hermes_home

_DB_FILENAME = "audit_log.db"
_lock = threading.RLock()


def _db_path() -> Path:
    home = Path(get_hermes_home())
    home.mkdir(parents=True, exist_ok=True)
    return home / _DB_FILENAME


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()))
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_log (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            ts       REAL NOT NULL,
            actor    TEXT NOT NULL,
            module   TEXT NOT NULL,
            tool     TEXT NOT NULL,
            action   TEXT NOT NULL,
            target   TEXT NOT NULL DEFAULT '',
            decision TEXT NOT NULL DEFAULT '',
            outcome  TEXT NOT NULL DEFAULT '',
            detail   TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_log(module, tool)"
    )
    return conn


def record(
    *,
    actor: str,
    module: str,
    tool: str,
    action: str,
    target: str = "",
    decision: str = "",
    outcome: str = "",
    detail: Optional[Dict[str, Any]] = None,
) -> int:
    """Append one audit entry. Returns the row id.

    ``actor`` is who initiated it (e.g. ``"agent"``). ``decision`` is how it
    was authorised (``auto`` / ``approved`` / ``denied``). ``outcome`` is the
    result (``ok`` / ``error`` / ``skipped``). ``detail`` is optional
    structured context (JSON-serialised); keep it secret-free.
    """
    with _lock, _connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO audit_log
                (ts, actor, module, tool, action, target, decision, outcome, detail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                time.time(),
                actor,
                module,
                tool,
                action,
                target,
                decision,
                outcome,
                json.dumps(detail) if detail is not None else None,
            ),
        )
        return int(cur.lastrowid)


def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    d = dict(row)
    if d.get("detail"):
        try:
            d["detail"] = json.loads(d["detail"])
        except (json.JSONDecodeError, TypeError):
            pass
    return d


def query(
    *,
    module: Optional[str] = None,
    tool: Optional[str] = None,
    actor: Optional[str] = None,
    since: Optional[float] = None,
    until: Optional[float] = None,
    limit: int = 200,
    offset: int = 0,
) -> List[Dict[str, Any]]:
    """Return matching entries, newest first. All filters are optional."""
    clauses: List[str] = []
    params: List[Any] = []
    if module:
        clauses.append("module = ?")
        params.append(module)
    if tool:
        clauses.append("tool = ?")
        params.append(tool)
    if actor:
        clauses.append("actor = ?")
        params.append(actor)
    if since is not None:
        clauses.append("ts >= ?")
        params.append(since)
    if until is not None:
        clauses.append("ts <= ?")
        params.append(until)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    safe_limit = max(1, min(int(limit), 1000))
    params.extend([safe_limit, max(0, int(offset))])
    with _lock, _connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM audit_log{where} ORDER BY id DESC LIMIT ? OFFSET ?",
            params,
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def export_jsonl() -> Iterator[str]:
    """Yield every entry as one JSON object per line, oldest first, for a
    streaming download."""
    with _lock, _connect() as conn:
        for row in conn.execute("SELECT * FROM audit_log ORDER BY id ASC"):
            yield json.dumps(_row_to_dict(row)) + "\n"


def count() -> int:
    with _lock, _connect() as conn:
        return int(conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0])
