"""Tests for native Google Calendar agent tools."""

import importlib
import json

import pytest


@pytest.fixture()
def cal_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_cli.audit_log as audit_log
    import tools.calendar_tools as ct

    importlib.reload(audit_log)

    class _Fake:
        def list_events(self, **kw):
            return {"items": [{"id": "e1", "summary": "Standup"}]}

        def free_busy(self, **kw):
            return {"calendars": {"primary": {"busy": []}}}

        def create_event(self, event, calendar_id="primary"):
            self.event = event
            return {"id": "e2", "htmlLink": "http://x"}

        def create_task(self, task, tasklist="@default"):
            return {"id": "t2", "title": task["title"]}

    monkeypatch.setattr(ct, "_client", lambda: _Fake())
    return ct, audit_log


def test_list_and_freebusy_are_reads(cal_tools):
    ct, audit_log = cal_tools
    assert "Standup" in json.dumps(json.loads(ct._handle_list({})))
    assert "busy" in json.dumps(json.loads(ct._handle_freebusy({"time_min": "A", "time_max": "B"})))
    assert audit_log.query(module="calendar") == []  # reads not audited


def test_create_event_audits(cal_tools):
    ct, audit_log = cal_tools
    out = json.dumps(json.loads(ct._handle_create_event(
        {"summary": "Sync", "start": "2026-07-24T09:00:00", "end": "2026-07-24T09:30:00"}
    )))
    assert "e2" in out
    entries = audit_log.query(module="calendar")
    assert entries[0]["action"] == "event.create"
    assert entries[0]["target"] == "Sync"


def test_create_event_requires_fields(cal_tools):
    ct, _ = cal_tools
    out = json.dumps(json.loads(ct._handle_create_event({"summary": "x"})))
    assert "required" in out.lower()


def test_permission_tiers():
    import tools.calendar_tools  # noqa: F401
    from hermes_cli.module_permissions import Tier, get_tier

    assert get_tier("calendar_list_events") is Tier.AUTO
    assert get_tier("calendar_find_free_time") is Tier.AUTO
    assert get_tier("calendar_create_event") is Tier.APPROVAL
    # No delete tool -> fail safe.
    assert get_tier("calendar_delete_event") is Tier.ALWAYS_APPROVAL
