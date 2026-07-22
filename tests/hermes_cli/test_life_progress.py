from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from hermes_cli.life.repository import DEFAULT_HABITS, LifeRepository
from hermes_cli.life.router import create_life_router


NOW = datetime(2026, 7, 22, 15, 30, tzinfo=timezone.utc)
JULY_20 = datetime(2026, 7, 20, 15, 30, tzinfo=timezone.utc)
JULY_21 = datetime(2026, 7, 21, 15, 30, tzinfo=timezone.utc)


def test_repository_seeds_income_first_habits_and_tracks_progress(tmp_path):
    database = tmp_path / "life.sqlite3"
    repository = LifeRepository(database)
    repository.migrate()

    today = repository.today(day="2026-07-22", now=NOW)
    assert database.stat().st_mode & 0o077 == 0
    assert today["income_gate"]["open"] is False
    assert today["totals"]["active"] >= 5
    income = next(habit for habit in today["habits"] if habit["category"] == "income")

    repository.set_entry(
        income["id"],
        day="2026-07-22",
        value=1,
        note="Submitted a high-fit application",
        now=NOW,
    )

    updated = repository.today(day="2026-07-22", now=NOW)
    assert updated["income_gate"]["open"] is True
    assert updated["totals"]["completed"] == 1
    assert updated["timeline"][0]["note"] == "Submitted a high-fit application"


def test_repository_supports_configurable_habits_reflection_and_history(tmp_path):
    repository = LifeRepository(tmp_path / "life.sqlite3")
    repository.migrate()
    habit = repository.create_habit(
        name="Drink water",
        category="health",
        target=4,
        unit="glasses",
        now=NOW,
    )
    repository.set_entry(habit["id"], day="2026-07-22", value=3, note="", now=NOW)
    repository.set_reflection(
        day="2026-07-22",
        wake_time="07:15",
        bedtime="",
        energy=4,
        mood="steady",
        win="Stayed on the income lane",
        obstacle="One inaccessible form",
        lesson="Use the direct employer site",
        tomorrow="Finish the priority packet",
        now=NOW,
    )

    today = repository.today(day="2026-07-22", now=NOW)
    water = next(item for item in today["habits"] if item["id"] == habit["id"])
    assert water["value"] == 3
    assert water["complete"] is False
    assert today["reflection"]["energy"] == 4
    assert today["reflection"]["obstacle"] == "One inaccessible form"

    history = repository.history(end_day="2026-07-22", days=7)
    assert history[-1]["day"] == "2026-07-22"
    assert history[-1]["completed"] == 0
    assert history[-1]["active"] >= 6


def test_migrate_is_safe_when_dashboard_workers_start_concurrently(tmp_path):
    for round_number in range(20):
        database = tmp_path / f"life-{round_number}.sqlite3"

        def migrate(_: int) -> None:
            LifeRepository(database).migrate()

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(migrate, range(8)))

        today = LifeRepository(database).today(day="2026-07-22")
        names = [habit["name"].casefold() for habit in today["habits"]]
        assert len(names) == len(set(names))


def test_history_keeps_the_target_and_active_state_for_each_day(tmp_path):
    repository = LifeRepository(tmp_path / "life.sqlite3")
    repository.migrate()
    habit = repository.create_habit(
        name="Practice answer",
        category="income",
        target=1,
        unit="answer",
        now=JULY_20,
    )
    repository.set_entry(habit["id"], day="2026-07-20", value=1, note="", now=JULY_20)
    repository.update_habit(habit["id"], target=2, now=JULY_21)
    repository.update_habit(habit["id"], active=False, now=NOW)

    history = repository.history(end_day="2026-07-22", days=3)

    assert history[0] == {"day": "2026-07-20", "completed": 1, "active": 1}
    assert history[1] == {"day": "2026-07-21", "completed": 0, "active": 1}
    assert history[2] == {"day": "2026-07-22", "completed": 0, "active": 6}


def test_migrate_does_not_recreate_a_renamed_seed_habit(tmp_path):
    repository = LifeRepository(tmp_path / "life.sqlite3")
    repository.migrate()
    before = repository.today(day="2026-07-22")
    move = next(habit for habit in before["habits"] if habit["name"] == "Move body")

    repository.update_habit(move["id"], name="Exercise", now=NOW)
    repository.migrate()

    names = [habit["name"] for habit in repository.today(day="2026-07-22")["habits"]]
    assert "Exercise" in names
    assert "Move body" not in names
    assert len(names) == len(DEFAULT_HABITS)


def test_history_rejects_a_range_that_underflows_the_calendar(tmp_path):
    repository = LifeRepository(tmp_path / "life.sqlite3")
    repository.migrate()

    with pytest.raises(ValueError, match="outside the supported calendar range"):
        repository.history(end_day="0001-01-01", days=14)


def test_concurrent_entries_keep_event_deltas_consistent(tmp_path):
    database = tmp_path / "life.sqlite3"
    repository = LifeRepository(database)
    repository.migrate()
    habit = repository.create_habit(
        name="Applications",
        category="income",
        target=1,
        unit="application",
        now=NOW,
    )

    def set_value(value: int) -> None:
        LifeRepository(database).set_entry(
            habit["id"], day="2026-07-22", value=value, note="", now=NOW
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(set_value, range(1, 9)))

    with sqlite3.connect(database) as connection:
        final_value = connection.execute(
            "SELECT value FROM habit_entries WHERE habit_id = ? AND day = ?",
            (habit["id"], "2026-07-22"),
        ).fetchone()[0]
        delta_total = connection.execute(
            "SELECT SUM(delta) FROM progress_events WHERE habit_id = ? AND day = ?",
            (habit["id"], "2026-07-22"),
        ).fetchone()[0]
    assert delta_total == final_value


def _app(database):
    app = FastAPI()
    app.state.auth_required = False

    def authorize(request: Request) -> None:
        if request.headers.get("x-test-auth") != "ok":
            raise HTTPException(status_code=401, detail="Unauthorized")

    app.include_router(create_life_router(authorize, database_path=database))
    return app


def test_life_router_authenticates_and_requires_same_origin_for_writes(tmp_path):
    client = TestClient(_app(tmp_path / "life.sqlite3"))

    assert client.get("/api/life/today").status_code == 401
    today = client.get(
        "/api/life/today?day=2026-07-22", headers={"x-test-auth": "ok"}
    )
    assert today.status_code == 200

    rejected = client.post(
        "/api/life/habits",
        headers={"x-test-auth": "ok", "origin": "https://wrong.example"},
        json={"name": "Practice interview answer", "category": "income", "target": 1, "unit": "check"},
    )
    assert rejected.status_code == 403

    created = client.post(
        "/api/life/habits",
        headers={"x-test-auth": "ok", "origin": "http://testserver"},
        json={"name": "Practice interview answer", "category": "income", "target": 1, "unit": "check"},
    )
    assert created.status_code == 200
    habit_id = created.json()["id"]

    logged = client.put(
        f"/api/life/entries/{habit_id}",
        headers={"x-test-auth": "ok", "origin": "http://testserver"},
        json={"day": "2026-07-22", "value": 1, "note": "Prepared one answer"},
    )
    assert logged.status_code == 200
    assert logged.json()["income_gate"]["open"] is True

    changed = client.patch(
        f"/api/life/habits/{habit_id}",
        headers={"x-test-auth": "ok", "origin": "http://testserver"},
        json={"name": "Practice two interview answers", "target": 2},
    )
    assert changed.status_code == 200
    assert changed.json()["target"] == 2

    invalid_history = client.get(
        "/api/life/history?end_day=0001-01-01&days=14",
        headers={"x-test-auth": "ok"},
    )
    assert invalid_history.status_code == 422
