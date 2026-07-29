"""Google Calendar + Tasks HTTP surface for the dashboard (me-path).

Read the calendar list and events, create/update/delete events, query
free/busy, and manage Google Tasks. These are the ME path — I act from the UI;
the agent's create/delete tools are gated separately (create = approval,
delete = always-approval fail-safe).
"""

from __future__ import annotations

from typing import Any, Callable, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from hermes_cli.google import GoogleAuthError, GoogleReauthRequired
from hermes_cli.google._http import GoogleApiError
from hermes_cli.google.calendar import GoogleCalendarClient, build_event

Authorize = Callable[[Request], Any]


class EventBody(BaseModel):
    summary: str
    start: str
    end: str
    timezone: str = "UTC"
    all_day: bool = False
    description: Optional[str] = None
    location: Optional[str] = None
    attendees: List[str] = []
    calendar_id: str = "primary"


class EventPatch(BaseModel):
    patch: dict
    calendar_id: str = "primary"


class FreeBusyBody(BaseModel):
    time_min: str
    time_max: str
    calendar_ids: List[str] = ["primary"]


class TaskBody(BaseModel):
    title: str
    notes: Optional[str] = None
    due: Optional[str] = None
    tasklist: str = "@default"


def _handle(exc: Exception):
    if isinstance(exc, GoogleReauthRequired):
        raise HTTPException(status_code=409, detail="google_needs_reauth")
    if isinstance(exc, GoogleAuthError):
        raise HTTPException(status_code=409, detail="google_not_connected")
    if isinstance(exc, GoogleApiError):
        raise HTTPException(status_code=502, detail=str(exc))
    raise exc


def create_calendar_router(
    authorize: Authorize,
    *,
    client_factory: Callable[[], GoogleCalendarClient] = GoogleCalendarClient,
) -> APIRouter:
    router = APIRouter(prefix="/api/calendar", tags=["calendar"])
    dep = [Depends(authorize)]

    @router.get("/connection", dependencies=dep)
    async def connection() -> dict[str, Any]:
        from hermes_cli.google import connection_status

        return connection_status()

    @router.get("/calendars", dependencies=dep)
    async def calendars() -> dict[str, Any]:
        try:
            return client_factory().list_calendars()
        except Exception as exc:
            _handle(exc)

    @router.get("/events", dependencies=dep)
    async def events(
        calendar_id: str = Query(default="primary"),
        time_min: Optional[str] = Query(default=None),
        time_max: Optional[str] = Query(default=None),
        max_results: int = Query(default=250, ge=1, le=2500),
    ) -> dict[str, Any]:
        try:
            return client_factory().list_events(
                calendar_id=calendar_id, time_min=time_min, time_max=time_max,
                max_results=max_results,
            )
        except Exception as exc:
            _handle(exc)

    @router.post("/events", dependencies=dep)
    async def create_event(body: EventBody = Body(...)) -> dict[str, Any]:
        try:
            event = build_event(
                summary=body.summary, start=body.start, end=body.end,
                timezone=body.timezone, all_day=body.all_day,
                description=body.description, location=body.location,
                attendees=body.attendees or None,
            )
            return client_factory().create_event(event, calendar_id=body.calendar_id)
        except Exception as exc:
            _handle(exc)

    @router.patch("/events/{event_id}", dependencies=dep)
    async def update_event(event_id: str, body: EventPatch = Body(...)) -> dict[str, Any]:
        try:
            return client_factory().update_event(event_id, body.patch, calendar_id=body.calendar_id)
        except Exception as exc:
            _handle(exc)

    @router.delete("/events/{event_id}", dependencies=dep)
    async def delete_event(event_id: str, calendar_id: str = Query(default="primary")) -> dict[str, Any]:
        try:
            client_factory().delete_event(event_id, calendar_id=calendar_id)
            return {"ok": True}
        except Exception as exc:
            _handle(exc)

    @router.post("/freebusy", dependencies=dep)
    async def freebusy(body: FreeBusyBody = Body(...)) -> dict[str, Any]:
        try:
            return client_factory().free_busy(
                time_min=body.time_min, time_max=body.time_max, calendar_ids=body.calendar_ids
            )
        except Exception as exc:
            _handle(exc)

    @router.get("/tasks", dependencies=dep)
    async def tasks(
        tasklist: str = Query(default="@default"),
        show_completed: bool = Query(default=False),
    ) -> dict[str, Any]:
        try:
            return client_factory().list_tasks(tasklist=tasklist, show_completed=show_completed)
        except Exception as exc:
            _handle(exc)

    @router.post("/tasks", dependencies=dep)
    async def create_task(body: TaskBody = Body(...)) -> dict[str, Any]:
        try:
            task: dict[str, Any] = {"title": body.title}
            if body.notes:
                task["notes"] = body.notes
            if body.due:
                task["due"] = body.due
            return client_factory().create_task(task, tasklist=body.tasklist)
        except Exception as exc:
            _handle(exc)

    @router.post("/tasks/{task_id}/complete", dependencies=dep)
    async def complete_task(task_id: str, tasklist: str = Query(default="@default")) -> dict[str, Any]:
        try:
            return client_factory().complete_task(task_id, tasklist=tasklist)
        except Exception as exc:
            _handle(exc)

    return router
