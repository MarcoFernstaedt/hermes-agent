"""Tests for the append-only agent audit log."""

import importlib

import pytest


@pytest.fixture()
def audit(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_cli.audit_log as audit_log

    importlib.reload(audit_log)
    return audit_log


def test_record_and_query_newest_first(audit):
    audit.record(actor="agent", module="email", tool="email.send",
                 action="send", target="to: a@b.com", decision="approved",
                 outcome="ok")
    audit.record(actor="agent", module="calendar", tool="calendar.create_event",
                 action="create", target="Standup", decision="auto", outcome="ok")
    entries = audit.query()
    assert audit.count() == 2
    # Newest first.
    assert entries[0]["tool"] == "calendar.create_event"
    assert entries[1]["tool"] == "email.send"


def test_filters(audit):
    audit.record(actor="agent", module="email", tool="email.send",
                 action="send", outcome="ok")
    audit.record(actor="agent", module="media", tool="media.play",
                 action="play", outcome="ok")
    assert len(audit.query(module="email")) == 1
    assert audit.query(module="email")[0]["module"] == "email"
    assert len(audit.query(tool="media.play")) == 1
    assert len(audit.query(module="nope")) == 0


def test_detail_round_trips_as_json(audit):
    audit.record(actor="agent", module="notes", tool="notes.append",
                 action="append", detail={"path": "daily/2026-07-23.md", "chars": 42})
    entry = audit.query()[0]
    assert entry["detail"] == {"path": "daily/2026-07-23.md", "chars": 42}


def test_export_jsonl_oldest_first(audit):
    audit.record(actor="agent", module="a", tool="a.x", action="x")
    audit.record(actor="agent", module="b", tool="b.y", action="y")
    lines = list(audit.export_jsonl())
    assert len(lines) == 2
    import json

    first = json.loads(lines[0])
    second = json.loads(lines[1])
    assert first["module"] == "a"  # oldest first
    assert second["module"] == "b"
    assert all(line.endswith("\n") for line in lines)


def test_limit_is_clamped(audit):
    for i in range(5):
        audit.record(actor="agent", module="m", tool="t", action=str(i))
    assert len(audit.query(limit=2)) == 2
    assert len(audit.query(limit=10_000)) == 5  # clamp doesn't drop real rows
