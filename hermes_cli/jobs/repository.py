from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from hermes_cli.jobs.models import ALLOWED_TRANSITIONS, JOB_STATUSES


ACTIONABLE_STATUSES = {
    "packet_ready_not_applied",
    "applied",
    "pending",
    "interviewing",
    "offer_received",
}
READ_TIMEOUT_SECONDS = 0.2


class JobNotFoundError(LookupError):
    pass


class InvalidTransitionError(ValueError):
    pass


class StaleJobError(RuntimeError):
    def __init__(self, current: dict) -> None:
        super().__init__("job changed since it was loaded")
        self.current = current


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
            timezone.utc
        )
    except (ValueError, TypeError):
        return None


def _json_list(value: str | None) -> list[str]:
    try:
        parsed = json.loads(value or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str)]


def _external_url(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return None
    return value


class JobRepository:
    def __init__(self, database_path: Path | str) -> None:
        self.database_path = Path(database_path)

    def _connect(self, *, read_only: bool = False) -> sqlite3.Connection:
        if not self.database_path.is_file():
            raise FileNotFoundError("jobs database is not configured")
        if read_only:
            connection = sqlite3.connect(
                f"{self.database_path.resolve().as_uri()}?mode=ro",
                uri=True,
                timeout=READ_TIMEOUT_SECONDS,
            )
            connection.execute("PRAGMA query_only = ON")
        else:
            connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def migrate(self) -> None:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
            if "applied_at" not in columns:
                connection.execute("ALTER TABLE jobs ADD COLUMN applied_at TEXT")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS status_events (
                    id INTEGER PRIMARY KEY,
                    job_id INTEGER NOT NULL REFERENCES jobs(id),
                    from_status TEXT NOT NULL,
                    to_status TEXT NOT NULL,
                    changed_at TEXT NOT NULL,
                    actor TEXT NOT NULL DEFAULT 'dashboard'
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_status_events_job_changed
                ON status_events(job_id, changed_at DESC)
                """
            )

    def list_jobs(
        self,
        *,
        status: str | None = None,
        lane: str | None = None,
        freshness: str | None = None,
        query: str | None = None,
        now: datetime | None = None,
    ) -> list[dict]:
        if status is not None and status not in JOB_STATUSES:
            with self._connect(read_only=True) as connection:
                known = connection.execute(
                    "SELECT 1 FROM jobs WHERE status = ? LIMIT 1", (status,)
                ).fetchone()
            if known is None:
                raise ValueError("invalid status")
        if freshness is not None and freshness not in {"active", "stale", "unknown"}:
            raise ValueError("invalid freshness")
        current = _utc(now or datetime.now(timezone.utc))
        sql = """
            SELECT j.*, v.checked_at, v.success AS validation_success,
                   v.details AS validation_details
            FROM jobs AS j
            LEFT JOIN validation_events AS v ON v.id = (
                SELECT newest.id FROM validation_events AS newest
                WHERE newest.job_id = j.id
                ORDER BY newest.checked_at DESC, newest.id DESC LIMIT 1
            )
        """
        clauses: list[str] = []
        parameters: list[object] = []
        if status:
            clauses.append("j.status = ?")
            parameters.append(status)
        if lane:
            clauses.append("j.lane = ?")
            parameters.append(lane)
        if query and query.strip():
            clauses.append(
                "LOWER(j.company || ' ' || j.role_title || ' ' || j.location || ' ' || j.lane || ' ' || COALESCE(j.requisition_id, '')) LIKE ?"
            )
            parameters.append(f"%{query.strip().lower()}%")
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)

        with self._connect(read_only=True) as connection:
            rows = connection.execute(sql, parameters).fetchall()

        jobs: list[dict] = []
        for row in rows:
            checked = _parse_timestamp(row["checked_at"])
            details = (row["validation_details"] or "").lower()
            if checked is None:
                derived_freshness = "unknown"
            elif not row["validation_success"] or any(
                word in details for word in ("closed", "expired", "removed")
            ):
                derived_freshness = "stale"
            elif current - checked <= timedelta(days=7):
                derived_freshness = "active"
            else:
                derived_freshness = "stale"
            if freshness and derived_freshness != freshness:
                continue
            jobs.append({
                "id": row["id"],
                "company": row["company"],
                "role_title": row["role_title"],
                "lane": row["lane"],
                "location": row["location"],
                "work_mode": row["work_mode"],
                "pay": row["pay"],
                "source_url": _external_url(row["source_url"]),
                "apply_url": _external_url(row["canonical_apply_url"]),
                "requisition_id": row["requisition_id"],
                "date_found": row["date_found"],
                "fit_score": row["fit_score"],
                "verdict": row["verdict"],
                "fit_rationale": row["fit_rationale"],
                "gaps": _json_list(row["gaps_json"]),
                "blockers": _json_list(row["blockers_json"]),
                "recommended_action": row["recommended_action"],
                "status": row["status"],
                "updated_at": row["updated_at"],
                "applied_at": row["applied_at"],
                "checked_at": row["checked_at"],
                "freshness": derived_freshness,
            })
        freshness_rank = {"active": 0, "unknown": 1, "stale": 2}

        def ordering_timestamp(job: dict) -> float:
            value = _parse_timestamp(job["checked_at"]) or _parse_timestamp(
                job["date_found"]
            )
            return -value.timestamp() if value is not None else float("inf")

        jobs.sort(
            key=lambda job: (
                0 if job["status"] in ACTIONABLE_STATUSES else 1,
                -job["fit_score"],
                freshness_rank[job["freshness"]],
                ordering_timestamp(job),
                job["id"],
            )
        )
        return jobs

    def summary(self, *, now: datetime | None = None) -> dict:
        current = _utc(now or datetime.now(timezone.utc))
        monday = (current - timedelta(days=current.weekday())).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        next_monday = monday + timedelta(days=7)
        with self._connect(read_only=True) as connection:
            status_counts = dict(
                connection.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status")
            )
            qualified = connection.execute(
                """
                SELECT COUNT(DISTINCT j.id)
                FROM jobs AS j JOIN packets AS p ON p.job_id = j.id
                WHERE j.status = 'packet_ready_not_applied'
                  AND j.verdict IN ('apply', 'stretch')
                """
            ).fetchone()[0]
            prepared = connection.execute(
                """
                SELECT COUNT(DISTINCT j.id)
                FROM jobs AS j JOIN packets AS p ON p.job_id = j.id
                WHERE j.date_found = ?
                """,
                (current.date().isoformat(),),
            ).fetchone()[0]
            week_applied = connection.execute(
                "SELECT COUNT(*) FROM jobs WHERE applied_at >= ? AND applied_at < ?",
                (
                    monday.isoformat().replace("+00:00", "Z"),
                    next_monday.isoformat().replace("+00:00", "Z"),
                ),
            ).fetchone()[0]
        counts = {
            "qualified_packet_ready": qualified,
            "applied": status_counts.get("applied", 0),
            "pending": status_counts.get("pending", 0),
            "interviewing": status_counts.get("interviewing", 0),
            "rejected": status_counts.get("rejected", 0),
            "expired": status_counts.get("expired", 0) + status_counts.get("closed", 0),
            "offer_received": status_counts.get("offer_received", 0),
            "offer_accepted": status_counts.get("offer_accepted", 0),
        }
        return {
            "counts": counts,
            "today_prepared": {"current": prepared, "target": 300},
            "week_applied": {"current": week_applied, "target": 1500},
            "campaign_stop": counts["offer_accepted"] > 0,
            "as_of": current.isoformat().replace("+00:00", "Z"),
        }

    def transition_status(
        self,
        job_id: int,
        target_status: str,
        *,
        expected_status: str,
        expected_updated_at: str,
        changed_at: datetime | None = None,
    ) -> dict:
        if target_status not in JOB_STATUSES:
            raise InvalidTransitionError("invalid status transition")
        timestamp = (
            _utc(changed_at or datetime.now(timezone.utc))
            .isoformat()
            .replace("+00:00", "Z")
        )
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT id, status, updated_at, applied_at FROM jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
            if row is None:
                raise JobNotFoundError("job not found")
            if (
                row["status"] != expected_status
                or row["updated_at"] != expected_updated_at
            ):
                raise StaleJobError(dict(row))
            source_status = row["status"]
            if target_status not in ALLOWED_TRANSITIONS.get(source_status, frozenset()):
                raise InvalidTransitionError("invalid status transition")
            applied_at = row["applied_at"]
            if target_status == "applied" and applied_at is None:
                applied_at = timestamp
            updated = connection.execute(
                """
                UPDATE jobs
                SET status = ?, updated_at = ?, applied_at = ?
                WHERE id = ? AND status = ? AND updated_at = ?
                """,
                (
                    target_status,
                    timestamp,
                    applied_at,
                    job_id,
                    expected_status,
                    expected_updated_at,
                ),
            )
            if updated.rowcount != 1:
                current = connection.execute(
                    "SELECT id, status, updated_at, applied_at FROM jobs WHERE id = ?",
                    (job_id,),
                ).fetchone()
                if current is None:
                    raise JobNotFoundError("job not found")
                raise StaleJobError(dict(current))
            connection.execute(
                """
                INSERT INTO status_events
                    (job_id, from_status, to_status, changed_at, actor)
                VALUES (?, ?, ?, ?, 'dashboard')
                """,
                (job_id, source_status, target_status, timestamp),
            )
        return {
            "job_id": job_id,
            "from_status": source_status,
            "status": target_status,
            "updated_at": timestamp,
            "applied_at": applied_at,
            "campaign_stop": target_status == "offer_accepted",
        }
