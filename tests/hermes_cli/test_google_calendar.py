"""Tests for the Google Calendar + Tasks client."""

import importlib

import pytest


@pytest.fixture()
def cal(monkeypatch):
    import hermes_cli.google.calendar as calmod

    importlib.reload(calmod)
    calls = []

    def fake_request(base, method, path, account="default", params=None, json=None, **kw):
        calls.append({"base": base, "method": method, "path": path, "params": params, "json": json})
        return {"ok": True}

    monkeypatch.setattr(calmod, "google_request", fake_request)
    return calmod, calls


def test_list_events_uses_single_events_and_time_window(cal):
    calmod, calls = cal
    calmod.GoogleCalendarClient().list_events(time_min="A", time_max="B")
    p = calls[0]["params"]
    assert p["singleEvents"] == "true"
    assert p["orderBy"] == "startTime"
    assert p["timeMin"] == "A" and p["timeMax"] == "B"
    assert calls[0]["path"] == "/calendars/primary/events"


def test_sync_token_excludes_time_filters(cal):
    calmod, calls = cal
    calmod.GoogleCalendarClient().list_events(sync_token="TOK", time_min="A")
    p = calls[0]["params"]
    assert p["syncToken"] == "TOK"
    assert "timeMin" not in p and "orderBy" not in p  # mutually exclusive


def test_freebusy_body(cal):
    calmod, calls = cal
    calmod.GoogleCalendarClient().free_busy(time_min="A", time_max="B", calendar_ids=["primary", "x@y"])
    body = calls[0]["json"]
    assert body["items"] == [{"id": "primary"}, {"id": "x@y"}]
    assert calls[0]["path"] == "/freeBusy"


def test_tasks_endpoints(cal):
    calmod, calls = cal
    c = calmod.GoogleCalendarClient()
    c.list_tasks()
    c.complete_task("t1")
    assert calls[0]["path"] == "/lists/@default/tasks"
    assert calls[1]["json"] == {"status": "completed"}


def test_build_event_timed_and_all_day():
    from hermes_cli.google.calendar import build_event

    timed = build_event(summary="Standup", start="2026-07-24T09:00:00", end="2026-07-24T09:15:00", timezone="America/Los_Angeles")
    assert timed["start"] == {"dateTime": "2026-07-24T09:00:00", "timeZone": "America/Los_Angeles"}

    allday = build_event(summary="Holiday", start="2026-07-24", end="2026-07-25", all_day=True)
    assert allday["start"] == {"date": "2026-07-24"}
    assert "timeZone" not in allday["start"]
