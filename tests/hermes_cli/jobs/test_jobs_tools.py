"""Agent tools over the existing Jobs store — reads AUTO, advance APPROVAL."""
from __future__ import annotations

import json

import pytest


@pytest.fixture
def jobs_env(jobs_db, packet_root, monkeypatch):
    """Point the tools at the seeded temp store (same env the router reads). The
    dashboard migrates the db at startup (initialize_jobs); do the same so the
    fixture matches a production store (adds applied_at etc.)."""
    from hermes_cli.jobs.repository import JobRepository

    JobRepository(jobs_db).migrate()
    monkeypatch.setenv("HERMES_JOBS_DB_PATH", str(jobs_db))
    monkeypatch.setenv("HERMES_JOBS_PACKET_ROOT", str(packet_root))
    monkeypatch.setattr("hermes_cli.audit_log.record", lambda **kw: None, raising=False)
    import tools.jobs_tools as jt

    return jt


def test_available_only_when_db_present(jobs_env, monkeypatch):
    assert jobs_env._available() is True
    monkeypatch.setenv("HERMES_JOBS_DB_PATH", "/nonexistent/jobs.sqlite3")
    assert jobs_env._available() is False


def test_list_and_summary_and_history(jobs_env):
    listed = json.loads(jobs_env._handle_list({}))
    assert listed["total"] == 1
    job = listed["items"][0]
    assert job["company"] == "Example Co"
    assert job["status"] == "packet_ready_not_applied"

    summary = json.loads(jobs_env._handle_summary({}))
    assert isinstance(summary, dict)  # pipeline stats

    history = json.loads(jobs_env._handle_history({"id": job["id"]}))
    assert "history" in history


def test_advance_follows_allowed_transitions(jobs_env):
    # packet_ready_not_applied -> applied is legal.
    out = json.loads(jobs_env._handle_advance({"id": 1, "to": "applied"}))
    assert out["status"] == "applied"
    # It really wrote through to the shared store.
    assert json.loads(jobs_env._handle_list({}))["items"][0]["status"] == "applied"


def test_advance_rejects_illegal_transition(jobs_env):
    # packet_ready_not_applied -> offer_accepted is not an allowed edge.
    out = json.loads(jobs_env._handle_advance({"id": 1, "to": "offer_accepted"}))
    assert "error" in out
    assert "cannot move" in out["error"].lower()


def test_advance_requires_args(jobs_env):
    assert "error" in json.loads(jobs_env._handle_advance({"id": 1}))
    assert "error" in json.loads(jobs_env._handle_advance({"to": "applied"}))


def test_permission_tiers(jobs_env):
    from hermes_cli.module_permissions import Tier, get_tier

    assert get_tier("jobs_list") == Tier.AUTO
    assert get_tier("jobs_summary") == Tier.AUTO
    assert get_tier("jobs_history") == Tier.AUTO
    assert get_tier("jobs_advance") == Tier.APPROVAL
