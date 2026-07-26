"""Agent tools over the Progress/habits store — reads AUTO, log APPROVAL."""
from __future__ import annotations

import json

import pytest


@pytest.fixture
def progress_env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / "state").mkdir(parents=True)
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: home)
    monkeypatch.setattr("hermes_cli.audit_log.record", lambda **kw: None, raising=False)

    # Migrate + seed the store the way the dashboard does at startup.
    from hermes_cli.life.repository import LifeRepository
    from hermes_cli.life.router import default_database_path

    LifeRepository(default_database_path()).migrate()

    import tools.progress_tools as pt

    return pt


def _a_habit_id(pt) -> int:
    today = json.loads(pt._handle_today({}))
    habits = today.get("habits") or []
    assert habits, "migrate() should seed default habits"
    return int(habits[0]["id"])


def test_available_only_when_store_present(progress_env, monkeypatch):
    assert progress_env._available() is True
    monkeypatch.setattr(progress_env, "_db_path", lambda: __import__("pathlib").Path("/nope.sqlite3"))
    assert progress_env._available() is False


def test_today_and_history(progress_env):
    today = json.loads(progress_env._handle_today({}))
    assert "habits" in today
    hist = json.loads(progress_env._handle_history({"days": 7}))
    assert "history" in hist


def test_log_writes_through(progress_env):
    hid = _a_habit_id(progress_env)
    out = json.loads(progress_env._handle_log({"habit_id": hid, "value": 1}))
    assert out["habit_id"] == hid
    assert out["value"] == 1.0
    # The value is reflected in today().
    today = json.loads(progress_env._handle_today({}))
    logged = next(h for h in today["habits"] if h["id"] == hid)
    assert logged["value"] == 1.0


def test_log_requires_args(progress_env):
    assert "error" in json.loads(progress_env._handle_log({"habit_id": 1}))
    assert "error" in json.loads(progress_env._handle_log({"value": 1}))


def test_log_unknown_habit(progress_env):
    out = json.loads(progress_env._handle_log({"habit_id": 99999, "value": 1}))
    assert "error" in out and "not found" in out["error"].lower()


def test_permission_tiers(progress_env):
    from hermes_cli.module_permissions import Tier, get_tier

    assert get_tier("progress_today") == Tier.AUTO
    assert get_tier("progress_history") == Tier.AUTO
    assert get_tier("progress_log") == Tier.APPROVAL
