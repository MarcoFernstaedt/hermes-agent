"""Generic, capability-agnostic entity store on SQLite.

One ``entities`` table holds records of any type as JSON, keyed by a stable
uuid, with an integer ``version`` for optimistic concurrency. This is the
foundation the Capability API (Phase C) renders working areas over: a new
entity type needs a declaration, not a migration.

Raw sqlite3 is used deliberately — it matches the existing lean stores
(jobs/life/audit) and avoids pulling SQLAlchemy/Alembic in before the schema
complexity warrants it. The migrate() method is the (versioned) migration path;
if the entity schema ever grows joins/constraints, this is where an ORM would
slot in.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


class EntityNotFoundError(LookupError):
    pass


class EntityConflictError(RuntimeError):
    """Optimistic-concurrency failure: the caller's expected_version is stale."""

    def __init__(self, current: dict) -> None:
        super().__init__("entity version conflict")
        self.current = current


def _stamp(now: datetime | None = None) -> str:
    value = now or datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _valid_type(entity_type: str) -> str:
    t = (entity_type or "").strip()
    if not t or not all(c.isalnum() or c in "_-" for c in t):
        raise ValueError("invalid entity type")
    return t


class EntityStore:
    def __init__(self, database_path: Path | str) -> None:
        self.database_path = Path(database_path)

    def _connect(self) -> sqlite3.Connection:
        self.database_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def migrate(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS entities (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    data TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_entities_type_updated "
                "ON entities(type, updated_at DESC)"
            )

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _row(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "type": row["type"],
            "data": json.loads(row["data"]),
            "version": row["version"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # -- writes ------------------------------------------------------------
    def create(
        self, entity_type: str, data: dict[str, Any], *, now: datetime | None = None
    ) -> dict:
        entity_type = _valid_type(entity_type)
        if not isinstance(data, dict):
            raise ValueError("entity data must be an object")
        entity_id = uuid.uuid4().hex
        stamp = _stamp(now)
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO entities (id, type, data, version, created_at, updated_at) "
                "VALUES (?, ?, ?, 1, ?, ?)",
                (entity_id, entity_type, json.dumps(data), stamp, stamp),
            )
        return {
            "id": entity_id,
            "type": entity_type,
            "data": data,
            "version": 1,
            "created_at": stamp,
            "updated_at": stamp,
        }

    def update(
        self,
        entity_id: str,
        data: dict[str, Any],
        *,
        expected_version: int,
        now: datetime | None = None,
    ) -> dict:
        if not isinstance(data, dict):
            raise ValueError("entity data must be an object")
        stamp = _stamp(now)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT id, type, data, version, created_at, updated_at "
                "FROM entities WHERE id = ?",
                (entity_id,),
            ).fetchone()
            if row is None:
                raise EntityNotFoundError("entity not found")
            if row["version"] != expected_version:
                raise EntityConflictError(self._row(row))
            new_version = row["version"] + 1
            connection.execute(
                "UPDATE entities SET data = ?, version = ?, updated_at = ? "
                "WHERE id = ? AND version = ?",
                (json.dumps(data), new_version, stamp, entity_id, expected_version),
            )
            return {
                "id": entity_id,
                "type": row["type"],
                "data": data,
                "version": new_version,
                "created_at": row["created_at"],
                "updated_at": stamp,
            }

    def delete(self, entity_id: str) -> bool:
        with self._connect() as connection:
            cur = connection.execute("DELETE FROM entities WHERE id = ?", (entity_id,))
            return cur.rowcount > 0

    # -- reads -------------------------------------------------------------
    def get(self, entity_id: str) -> Optional[dict]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, type, data, version, created_at, updated_at "
                "FROM entities WHERE id = ?",
                (entity_id,),
            ).fetchone()
        return self._row(row) if row else None

    def list(
        self,
        entity_type: str,
        *,
        filters: Optional[dict[str, Any]] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict:
        """List entities of a type, newest first. ``filters`` matches top-level
        data fields for equality (via json_extract). Returns ``{items, total}``."""
        entity_type = _valid_type(entity_type)
        limit = max(1, min(int(limit), 500))
        offset = max(0, int(offset))
        clauses = ["type = ?"]
        params: list[Any] = [entity_type]
        for key, value in (filters or {}).items():
            if not all(c.isalnum() or c in "_-" for c in str(key)):
                raise ValueError("invalid filter field")
            clauses.append(f"json_extract(data, '$.{key}') = ?")
            params.append(value)
        where = " AND ".join(clauses)
        with self._connect() as connection:
            total = connection.execute(
                f"SELECT COUNT(*) FROM entities WHERE {where}", params
            ).fetchone()[0]
            rows = connection.execute(
                f"SELECT id, type, data, version, created_at, updated_at "
                f"FROM entities WHERE {where} ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ).fetchall()
        return {"items": [self._row(r) for r in rows], "total": total}
