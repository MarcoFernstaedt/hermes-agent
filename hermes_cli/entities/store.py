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
import re
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


def _search_text(data: Any) -> str:
    """Flatten a record's data to its text values (keys dropped) so full-text
    search matches what a person typed, not the field names."""
    parts: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, bool):
            return
        elif isinstance(value, (int, float)):
            parts.append(str(value))
        elif isinstance(value, dict):
            for v in value.values():
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)

    walk(data)
    return " ".join(parts)


def _fts_query(query: str) -> str:
    """Turn free text into an FTS5 MATCH expression: each word becomes a quoted
    prefix term (so "dun" hits "Dune"), AND-ed together. Quoting neutralises
    FTS5 operators (AND/OR/NEAR) a user might type as ordinary words. Returns ""
    when nothing searchable remains."""
    tokens = re.findall(r"\w+", query or "", flags=re.UNICODE)
    return " ".join(f'"{t}"*' for t in tokens)


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
            # Links between entities — the graph that ties records across
            # capabilities together (a task to a contact, a reading to a task).
            # Directed (source, target) with a relation, but treated as
            # undirected for "related": a link shows on both records and is
            # de-duplicated in either direction (see link()).
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS entity_links (
                    source TEXT NOT NULL,
                    target TEXT NOT NULL,
                    rel TEXT NOT NULL DEFAULT 'related',
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (source, target, rel)
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_links_target ON entity_links(target)"
            )
            # Full-text index for cross-entity search. Managed from this store's
            # write methods (not triggers) and tied to each entity's rowid, so a
            # record maps 1:1 to its FTS row. `type` is stored UNINDEXED so
            # searches can be scoped to a set of entity types cheaply.
            connection.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts "
                "USING fts5(text, type UNINDEXED)"
            )
            # Backfill any entity rows missing from the FTS index (first run
            # after this migration, or drift). Idempotent: only inserts gaps.
            missing = connection.execute(
                "SELECT e.rowid, e.type, e.data FROM entities e "
                "WHERE e.rowid NOT IN (SELECT rowid FROM entities_fts)"
            ).fetchall()
            for row in missing:
                connection.execute(
                    "INSERT INTO entities_fts(rowid, text, type) VALUES (?, ?, ?)",
                    (row["rowid"], _search_text(json.loads(row["data"])), row["type"]),
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
            cur = connection.execute(
                "INSERT INTO entities (id, type, data, version, created_at, updated_at) "
                "VALUES (?, ?, ?, 1, ?, ?)",
                (entity_id, entity_type, json.dumps(data), stamp, stamp),
            )
            connection.execute(
                "INSERT INTO entities_fts(rowid, text, type) VALUES (?, ?, ?)",
                (cur.lastrowid, _search_text(data), entity_type),
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
                "SELECT rowid, id, type, data, version, created_at, updated_at "
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
            connection.execute(
                "UPDATE entities_fts SET text = ? WHERE rowid = ?",
                (_search_text(data), row["rowid"]),
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
            row = connection.execute(
                "SELECT rowid FROM entities WHERE id = ?", (entity_id,)
            ).fetchone()
            if row is None:
                return False
            connection.execute(
                "DELETE FROM entities_fts WHERE rowid = ?", (row["rowid"],)
            )
            # Drop any links touching this record so no dangling edges remain.
            connection.execute(
                "DELETE FROM entity_links WHERE source = ? OR target = ?",
                (entity_id, entity_id),
            )
            connection.execute("DELETE FROM entities WHERE id = ?", (entity_id,))
            return True

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

    # -- links -------------------------------------------------------------
    def link(
        self,
        source_id: str,
        target_id: str,
        *,
        rel: str = "related",
        now: datetime | None = None,
    ) -> dict:
        """Relate two entities. Idempotent and undirected for de-duplication: a
        link already present in either direction (with this rel) is returned as
        is rather than duplicated. Raises if either entity is missing or the two
        ids are the same."""
        rel = (rel or "related").strip() or "related"
        if source_id == target_id:
            raise ValueError("cannot link an entity to itself")
        stamp = _stamp(now)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            present = {
                r["id"]
                for r in connection.execute(
                    "SELECT id FROM entities WHERE id IN (?, ?)",
                    (source_id, target_id),
                ).fetchall()
            }
            if source_id not in present or target_id not in present:
                raise EntityNotFoundError("both entities must exist to link them")
            existing = connection.execute(
                "SELECT source, target, rel, created_at FROM entity_links "
                "WHERE rel = ? AND ((source = ? AND target = ?) OR (source = ? AND target = ?))",
                (rel, source_id, target_id, target_id, source_id),
            ).fetchone()
            if existing is not None:
                return dict(existing)
            connection.execute(
                "INSERT INTO entity_links (source, target, rel, created_at) "
                "VALUES (?, ?, ?, ?)",
                (source_id, target_id, rel, stamp),
            )
        return {"source": source_id, "target": target_id, "rel": rel, "created_at": stamp}

    def unlink(self, a_id: str, b_id: str, *, rel: str = "related") -> bool:
        """Remove the link between two entities (either direction) for ``rel``.
        Returns True if a link was removed."""
        rel = (rel or "related").strip() or "related"
        with self._connect() as connection:
            cur = connection.execute(
                "DELETE FROM entity_links WHERE rel = ? "
                "AND ((source = ? AND target = ?) OR (source = ? AND target = ?))",
                (rel, a_id, b_id, b_id, a_id),
            )
            return cur.rowcount > 0

    def links_for(self, entity_id: str) -> list[dict]:
        """Every record linked to ``entity_id`` (either direction), each as
        ``{id, type, data, rel, created_at}`` for the *other* end. Dangling
        edges (other side deleted) are skipped."""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT source, target, rel, created_at FROM entity_links "
                "WHERE source = ? OR target = ? ORDER BY created_at DESC",
                (entity_id, entity_id),
            ).fetchall()
            out: list[dict] = []
            for row in rows:
                other_id = row["target"] if row["source"] == entity_id else row["source"]
                other = connection.execute(
                    "SELECT id, type, data FROM entities WHERE id = ?",
                    (other_id,),
                ).fetchone()
                if other is None:
                    continue
                out.append(
                    {
                        "id": other["id"],
                        "type": other["type"],
                        "data": json.loads(other["data"]),
                        "rel": row["rel"],
                        "created_at": row["created_at"],
                    }
                )
        return out

    def search(
        self,
        query: str,
        *,
        types: Optional[list[str]] = None,
        limit: int = 20,
    ) -> dict:
        """Full-text search across every entity, best matches first.

        ``types`` optionally scopes the search to a set of entity types. Returns
        ``{items, total}`` where items are full records ordered by relevance
        (bm25 rank). An empty/blank query returns no results (not everything)."""
        match = _fts_query(query)
        if not match:
            return {"items": [], "total": 0}
        limit = max(1, min(int(limit), 100))
        clauses = ["entities_fts MATCH ?"]
        params: list[Any] = [match]
        if types:
            valid = [_valid_type(t) for t in types]
            clauses.append("f.type IN (%s)" % ",".join("?" for _ in valid))
            params.extend(valid)
        where = " AND ".join(clauses)
        with self._connect() as connection:
            total = connection.execute(
                f"SELECT COUNT(*) FROM entities_fts f WHERE {where}", params
            ).fetchone()[0]
            rows = connection.execute(
                f"SELECT e.id, e.type, e.data, e.version, e.created_at, e.updated_at "
                f"FROM entities_fts f JOIN entities e ON e.rowid = f.rowid "
                f"WHERE {where} ORDER BY rank LIMIT ?",
                [*params, limit],
            ).fetchall()
        return {"items": [self._row(r) for r in rows], "total": total}
