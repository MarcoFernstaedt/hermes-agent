"""Tests for the Calendar + Tasks router with a fake client."""

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402


class _FakeCal:
    def __init__(self):
        self.calls = []

    def list_calendars(self):
        return {"items": [{"id": "primary", "summary": "Me"}]}

    def list_events(self, **kw):
        self.calls.append(("list_events", kw))
        return {"items": [{"id": "e1", "summary": "Standup"}]}

    def create_event(self, event, calendar_id="primary"):
        self.calls.append(("create_event", event, calendar_id))
        return {"id": "e2", **event}

    def delete_event(self, event_id, calendar_id="primary"):
        self.calls.append(("delete_event", event_id))
        return {}

    def free_busy(self, **kw):
        return {"calendars": {"primary": {"busy": []}}}

    def list_tasks(self, **kw):
        return {"items": [{"id": "t1", "title": "Do thing"}]}

    def complete_task(self, task_id, tasklist="@default"):
        self.calls.append(("complete", task_id))
        return {"id": task_id, "status": "completed"}


def _client(fake):
    from hermes_cli.calendar.router import create_calendar_router

    app = FastAPI()
    app.include_router(create_calendar_router(lambda: None, client_factory=lambda: fake))
    return TestClient(app)


def test_events_list_and_create():
    fake = _FakeCal()
    c = _client(fake)
    assert c.get("/api/calendar/events?time_min=A&time_max=B").json()["items"][0]["id"] == "e1"

    resp = c.post(
        "/api/calendar/events",
        json={"summary": "Sync", "start": "2026-07-24T09:00:00", "end": "2026-07-24T09:30:00", "timezone": "UTC"},
    )
    assert resp.status_code == 200
    created = next(c for c in fake.calls if c[0] == "create_event")
    assert created[1]["start"] == {"dateTime": "2026-07-24T09:00:00", "timeZone": "UTC"}


def test_delete_and_tasks_and_freebusy():
    fake = _FakeCal()
    c = _client(fake)
    assert c.request("DELETE", "/api/calendar/events/e1").json()["ok"] is True
    assert c.post("/api/calendar/freebusy", json={"time_min": "A", "time_max": "B"}).status_code == 200
    assert c.get("/api/calendar/tasks").json()["items"][0]["title"] == "Do thing"
    assert c.post("/api/calendar/tasks/t1/complete").json()["status"] == "completed"


def test_reauth_maps_to_409():
    from hermes_cli.google import GoogleReauthRequired

    class _Dead:
        def list_calendars(self):
            raise GoogleReauthRequired("dead")

    c = _client(_Dead())
    assert c.get("/api/calendar/calendars").status_code == 409
