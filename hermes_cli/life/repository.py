from __future__ import annotations

import os
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

PHOENIX = ZoneInfo("America/Phoenix")
DEFAULT_HABITS = (
    ("Direct income action", "income", 1.0, "check"),
    ("Choose today's one outcome", "focus", 1.0, "check"),
    ("Personal care", "health", 1.0, "check"),
    ("Eat and hydrate", "health", 1.0, "check"),
    ("Move body", "health", 1.0, "check"),
    ("Evening review", "reflection", 1.0, "check"),
)


def _stamp(now: datetime | None = None) -> str:
    value = now or datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _valid_day(value: str) -> str:
    parsed = date.fromisoformat(value)
    return parsed.isoformat()


def _today(now: datetime | None = None) -> str:
    value = now or datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(PHOENIX).date().isoformat()


def _text(value: str, *, limit: int, field: str, required: bool = False) -> str:
    result = (value or "").strip()
    if required and not result:
        raise ValueError(f"{field} is required")
    if len(result) > limit:
        raise ValueError(f"{field} must be at most {limit} characters")
    return result


class LifeRepository:
    def __init__(self, database_path: Path | str) -> None:
        self.database_path = Path(database_path)

    def _connect(self) -> sqlite3.Connection:
        self.database_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def migrate(self, *, now: datetime | None = None) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS habits (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    category TEXT NOT NULL,
                    target REAL NOT NULL DEFAULT 1 CHECK (target > 0),
                    unit TEXT NOT NULL DEFAULT 'check',
                    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS habit_entries (
                    habit_id INTEGER NOT NULL REFERENCES habits(id),
                    day TEXT NOT NULL,
                    value REAL NOT NULL DEFAULT 0 CHECK (value >= 0),
                    note TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (habit_id, day)
                );
                CREATE TABLE IF NOT EXISTS habit_versions (
                    habit_id INTEGER NOT NULL REFERENCES habits(id),
                    effective_day TEXT NOT NULL,
                    target REAL NOT NULL CHECK (target > 0),
                    active INTEGER NOT NULL CHECK (active IN (0, 1)),
                    PRIMARY KEY (habit_id, effective_day)
                );
                CREATE TABLE IF NOT EXISTS progress_events (
                    id INTEGER PRIMARY KEY,
                    habit_id INTEGER NOT NULL REFERENCES habits(id),
                    day TEXT NOT NULL,
                    value REAL NOT NULL,
                    delta REAL NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    occurred_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_progress_events_day_time
                    ON progress_events(day, occurred_at DESC, id DESC);
                CREATE TABLE IF NOT EXISTS daily_reflections (
                    day TEXT PRIMARY KEY,
                    wake_time TEXT NOT NULL DEFAULT '',
                    bedtime TEXT NOT NULL DEFAULT '',
                    energy INTEGER,
                    mood TEXT NOT NULL DEFAULT '',
                    win TEXT NOT NULL DEFAULT '',
                    obstacle TEXT NOT NULL DEFAULT '',
                    lesson TEXT NOT NULL DEFAULT '',
                    tomorrow TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL,
                    CHECK (energy IS NULL OR (energy >= 1 AND energy <= 5))
                );
                """
            )
            stamp = _stamp(now)
            has_habits = connection.execute("SELECT EXISTS(SELECT 1 FROM habits)").fetchone()[0]
            if not has_habits:
                connection.executemany(
                    """
                    INSERT OR IGNORE INTO habits
                        (name, category, target, unit, active, sort_order, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
                    """,
                    [
                        (name, category, target, unit, index, stamp, stamp)
                        for index, (name, category, target, unit) in enumerate(DEFAULT_HABITS)
                    ],
                )
            rows = connection.execute(
                """
                SELECT h.id, h.target, h.active, h.created_at, MIN(e.day) AS first_entry_day
                FROM habits AS h
                LEFT JOIN habit_entries AS e ON e.habit_id = h.id
                GROUP BY h.id
                """
            ).fetchall()
            for row in rows:
                created = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
                effective_day = row["first_entry_day"] or _today(created)
                connection.execute(
                    """
                    INSERT OR IGNORE INTO habit_versions (habit_id, effective_day, target, active)
                    VALUES (?, ?, ?, ?)
                    """,
                    (row["id"], effective_day, row["target"], row["active"]),
                )
        os.chmod(self.database_path, 0o600)

    def create_habit(
        self,
        *,
        name: str,
        category: str,
        target: float,
        unit: str,
        now: datetime | None = None,
    ) -> dict:
        name = _text(name, limit=100, field="name", required=True)
        category = _text(category, limit=40, field="category", required=True).lower()
        unit = _text(unit, limit=30, field="unit", required=True).lower()
        if not 0 < float(target) <= 10000:
            raise ValueError("target must be between 0 and 10000")
        stamp = _stamp(now)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            order = connection.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM habits"
            ).fetchone()[0]
            try:
                cursor = connection.execute(
                    """
                    INSERT INTO habits
                        (name, category, target, unit, active, sort_order, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
                    """,
                    (name, category, float(target), unit, order, stamp, stamp),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError("a habit with that name already exists") from exc
            row = connection.execute(
                "SELECT * FROM habits WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            connection.execute(
                """
                INSERT INTO habit_versions (habit_id, effective_day, target, active)
                VALUES (?, ?, ?, 1)
                """,
                (cursor.lastrowid, _today(now), float(target)),
            )
        return self._habit_dict(row)

    def update_habit(
        self,
        habit_id: int,
        *,
        active: bool | None = None,
        name: str | None = None,
        category: str | None = None,
        target: float | None = None,
        unit: str | None = None,
        now: datetime | None = None,
    ) -> dict:
        updates: list[str] = []
        values: list[object] = []
        if active is not None:
            updates.append("active = ?")
            values.append(int(active))
        if name is not None:
            updates.append("name = ?")
            values.append(_text(name, limit=100, field="name", required=True))
        if category is not None:
            updates.append("category = ?")
            values.append(_text(category, limit=40, field="category", required=True).lower())
        if target is not None:
            if not 0 < float(target) <= 10000:
                raise ValueError("target must be between 0 and 10000")
            updates.append("target = ?")
            values.append(float(target))
        if unit is not None:
            updates.append("unit = ?")
            values.append(_text(unit, limit=30, field="unit", required=True).lower())
        if not updates:
            raise ValueError("no habit changes supplied")
        updates.append("updated_at = ?")
        values.append(_stamp(now))
        values.append(habit_id)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                changed = connection.execute(
                    f"UPDATE habits SET {', '.join(updates)} WHERE id = ?", values
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError("a habit with that name already exists") from exc
            if changed.rowcount != 1:
                raise LookupError("habit not found")
            row = connection.execute(
                "SELECT * FROM habits WHERE id = ?", (habit_id,)
            ).fetchone()
            connection.execute(
                """
                INSERT INTO habit_versions (habit_id, effective_day, target, active)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(habit_id, effective_day) DO UPDATE SET
                    target = excluded.target,
                    active = excluded.active
                """,
                (habit_id, _today(now), row["target"], row["active"]),
            )
        return self._habit_dict(row)

    def set_entry(
        self,
        habit_id: int,
        *,
        day: str,
        value: float,
        note: str,
        now: datetime | None = None,
    ) -> None:
        day = _valid_day(day)
        value = float(value)
        if not 0 <= value <= 100000:
            raise ValueError("value must be between 0 and 100000")
        note = _text(note, limit=300, field="note")
        stamp = _stamp(now)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            habit = connection.execute(
                "SELECT id FROM habits WHERE id = ?", (habit_id,)
            ).fetchone()
            if habit is None:
                raise LookupError("habit not found")
            existing = connection.execute(
                "SELECT value, note FROM habit_entries WHERE habit_id = ? AND day = ?",
                (habit_id, day),
            ).fetchone()
            previous = float(existing["value"]) if existing else 0.0
            connection.execute(
                """
                INSERT INTO habit_entries (habit_id, day, value, note, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(habit_id, day) DO UPDATE SET
                    value = excluded.value,
                    note = excluded.note,
                    updated_at = excluded.updated_at
                """,
                (habit_id, day, value, note, stamp),
            )
            if value != previous or (existing is not None and note != existing["note"]):
                connection.execute(
                    """
                    INSERT INTO progress_events
                        (habit_id, day, value, delta, note, occurred_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (habit_id, day, value, value - previous, note, stamp),
                )

    def set_reflection(
        self,
        *,
        day: str,
        wake_time: str,
        bedtime: str,
        energy: int | None,
        mood: str,
        win: str,
        obstacle: str,
        lesson: str,
        tomorrow: str,
        now: datetime | None = None,
    ) -> None:
        day = _valid_day(day)
        wake_time = _text(wake_time, limit=5, field="wake_time")
        bedtime = _text(bedtime, limit=5, field="bedtime")
        for field, value in (("wake_time", wake_time), ("bedtime", bedtime)):
            if value:
                try:
                    datetime.strptime(value, "%H:%M")
                except ValueError as exc:
                    raise ValueError(f"{field} must use HH:MM") from exc
        if energy is not None and energy not in range(1, 6):
            raise ValueError("energy must be between 1 and 5")
        values = {
            "mood": _text(mood, limit=40, field="mood"),
            "win": _text(win, limit=500, field="win"),
            "obstacle": _text(obstacle, limit=500, field="obstacle"),
            "lesson": _text(lesson, limit=500, field="lesson"),
            "tomorrow": _text(tomorrow, limit=500, field="tomorrow"),
        }
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO daily_reflections
                    (day, wake_time, bedtime, energy, mood, win, obstacle, lesson, tomorrow, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(day) DO UPDATE SET
                    wake_time = excluded.wake_time,
                    bedtime = excluded.bedtime,
                    energy = excluded.energy,
                    mood = excluded.mood,
                    win = excluded.win,
                    obstacle = excluded.obstacle,
                    lesson = excluded.lesson,
                    tomorrow = excluded.tomorrow,
                    updated_at = excluded.updated_at
                """,
                (
                    day,
                    wake_time,
                    bedtime,
                    energy,
                    values["mood"],
                    values["win"],
                    values["obstacle"],
                    values["lesson"],
                    values["tomorrow"],
                    _stamp(now),
                ),
            )

    def today(self, *, day: str | None = None, now: datetime | None = None) -> dict:
        selected_day = _valid_day(day) if day else _today(now)
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT h.id, h.name, h.category, v.target, h.unit, v.active,
                       COALESCE(e.value, 0) AS value, COALESCE(e.note, '') AS note
                FROM habits AS h
                JOIN habit_versions AS v
                  ON v.habit_id = h.id
                 AND v.effective_day = (
                     SELECT MAX(v2.effective_day)
                     FROM habit_versions AS v2
                     WHERE v2.habit_id = h.id AND v2.effective_day <= ?
                 )
                LEFT JOIN habit_entries AS e ON e.habit_id = h.id AND e.day = ?
                WHERE v.active = 1
                ORDER BY h.sort_order, h.id
                """,
                (selected_day, selected_day),
            ).fetchall()
            reflection = connection.execute(
                "SELECT * FROM daily_reflections WHERE day = ?", (selected_day,)
            ).fetchone()
            timeline = connection.execute(
                """
                SELECT e.id, e.habit_id, h.name AS habit_name, h.category,
                       e.value, e.delta, e.note, e.occurred_at
                FROM progress_events AS e
                JOIN habits AS h ON h.id = e.habit_id
                WHERE e.day = ?
                ORDER BY e.occurred_at DESC, e.id DESC
                LIMIT 100
                """,
                (selected_day,),
            ).fetchall()
        habits = []
        for row in rows:
            habit = self._habit_dict(row)
            habit.update(
                value=float(row["value"]),
                note=row["note"],
                complete=float(row["value"]) >= float(row["target"]),
            )
            habits.append(habit)
        completed = sum(1 for item in habits if item["complete"])
        income = [item for item in habits if item["category"] == "income"]
        income_open = any(item["complete"] for item in income)
        return {
            "day": selected_day,
            "income_gate": {
                "open": income_open,
                "message": (
                    "Income gate open. Optional building can follow today's direct income work."
                    if income_open
                    else "Income gate closed. Complete one direct income action before optional building."
                ),
            },
            "totals": {"active": len(habits), "completed": completed},
            "habits": habits,
            "reflection": dict(reflection) if reflection else None,
            "timeline": [dict(item) for item in timeline],
        }

    def history(self, *, end_day: str | None = None, days: int = 14) -> list[dict]:
        if not 1 <= days <= 90:
            raise ValueError("days must be between 1 and 90")
        end = date.fromisoformat(_valid_day(end_day)) if end_day else date.fromisoformat(_today())
        if end.toordinal() < days:
            raise ValueError("history range is outside the supported calendar range")
        start = end - timedelta(days=days - 1)
        with self._connect() as connection:
            result = []
            for offset in range(days):
                selected_day = (start + timedelta(days=offset)).isoformat()
                rows = connection.execute(
                    """
                    SELECT v.target, COALESCE(e.value, 0) AS value
                    FROM habits AS h
                    JOIN habit_versions AS v
                      ON v.habit_id = h.id
                     AND v.effective_day = (
                         SELECT MAX(v2.effective_day)
                         FROM habit_versions AS v2
                         WHERE v2.habit_id = h.id AND v2.effective_day <= ?
                     )
                    LEFT JOIN habit_entries AS e
                      ON e.habit_id = h.id AND e.day = ?
                    WHERE v.active = 1
                    """,
                    (selected_day, selected_day),
                ).fetchall()
                result.append(
                    {
                        "day": selected_day,
                        "completed": sum(
                            1 for row in rows if float(row["value"]) >= float(row["target"])
                        ),
                        "active": len(rows),
                    }
                )
        return result

    @staticmethod
    def _habit_dict(row: sqlite3.Row) -> dict:
        return {
            "id": int(row["id"]),
            "name": row["name"],
            "category": row["category"],
            "target": float(row["target"]),
            "unit": row["unit"],
            "active": bool(row["active"]),
        }
