"""Lean Google Calendar + Tasks client for the dashboard.

Talks to Calendar v3 and Tasks v1 directly over httpx with the unified Google
token — no google-api-python-client. Covers the surface the Calendar module
needs: list calendars, list/get/create/update/delete events, expand recurring
instances, free/busy, and Google Tasks (todos live there, not on Calendar).

Time zones: every timed event carries its IANA zone (never a numeric offset),
so recurring events don't drift across DST. Recurring edits are three distinct
operations the caller chooses between — single instance (patch the instance
id), whole series (patch the parent), or this-and-following (truncate the rule
with UNTIL + new series) — and only the first two are wired here; "this and
following" is deferred (it has no API shortcut).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from hermes_cli.google._http import GoogleApiError, google_request  # noqa: F401

_CAL_BASE = "https://www.googleapis.com/calendar/v3"
_TASKS_BASE = "https://tasks.googleapis.com/tasks/v1"


class GoogleCalendarClient:
    def __init__(self, account: str = "default"):
        self._account = account

    def _cal(self, method: str, path: str, **kw) -> Dict[str, Any]:
        return google_request(_CAL_BASE, method, path, account=self._account, **kw)

    def _tasks(self, method: str, path: str, **kw) -> Dict[str, Any]:
        return google_request(_TASKS_BASE, method, path, account=self._account, **kw)

    # -- calendars ---------------------------------------------------------
    def list_calendars(self) -> Dict[str, Any]:
        return self._cal("GET", "/users/me/calendarList")

    # -- events ------------------------------------------------------------
    def list_events(
        self,
        *,
        calendar_id: str = "primary",
        time_min: Optional[str] = None,
        time_max: Optional[str] = None,
        max_results: int = 250,
        sync_token: Optional[str] = None,
        page_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": max(1, min(int(max_results), 2500)),
        }
        # syncToken is mutually exclusive with time/orderBy filters.
        if sync_token:
            params = {"syncToken": sync_token, "maxResults": params["maxResults"]}
        else:
            if time_min:
                params["timeMin"] = time_min
            if time_max:
                params["timeMax"] = time_max
        if page_token:
            params["pageToken"] = page_token
        return self._cal(
            "GET", f"/calendars/{_enc(calendar_id)}/events", params=params
        )

    def get_event(self, event_id: str, *, calendar_id: str = "primary") -> Dict[str, Any]:
        return self._cal("GET", f"/calendars/{_enc(calendar_id)}/events/{_enc(event_id)}")

    def create_event(self, event: Dict[str, Any], *, calendar_id: str = "primary") -> Dict[str, Any]:
        return self._cal("POST", f"/calendars/{_enc(calendar_id)}/events", json=event)

    def update_event(
        self, event_id: str, patch: Dict[str, Any], *, calendar_id: str = "primary"
    ) -> Dict[str, Any]:
        return self._cal(
            "PATCH", f"/calendars/{_enc(calendar_id)}/events/{_enc(event_id)}", json=patch
        )

    def delete_event(self, event_id: str, *, calendar_id: str = "primary") -> Dict[str, Any]:
        return self._cal("DELETE", f"/calendars/{_enc(calendar_id)}/events/{_enc(event_id)}")

    def event_instances(self, event_id: str, *, calendar_id: str = "primary") -> Dict[str, Any]:
        return self._cal(
            "GET", f"/calendars/{_enc(calendar_id)}/events/{_enc(event_id)}/instances"
        )

    def respond_to_invite(
        self, event_id: str, response: str, *, calendar_id: str = "primary", self_email: Optional[str] = None
    ) -> Dict[str, Any]:
        """Set my attendee responseStatus (accepted/declined/tentative)."""
        event = self.get_event(event_id, calendar_id=calendar_id)
        attendees = event.get("attendees") or []
        for a in attendees:
            if a.get("self") or (self_email and a.get("email") == self_email):
                a["responseStatus"] = response
        return self.update_event(event_id, {"attendees": attendees}, calendar_id=calendar_id)

    def free_busy(self, *, time_min: str, time_max: str, calendar_ids: List[str]) -> Dict[str, Any]:
        return self._cal(
            "POST",
            "/freeBusy",
            json={
                "timeMin": time_min,
                "timeMax": time_max,
                "items": [{"id": cid} for cid in calendar_ids],
            },
        )

    # -- tasks -------------------------------------------------------------
    def list_task_lists(self) -> Dict[str, Any]:
        return self._tasks("GET", "/users/@me/lists")

    def list_tasks(self, *, tasklist: str = "@default", show_completed: bool = False) -> Dict[str, Any]:
        return self._tasks(
            "GET",
            f"/lists/{_enc(tasklist)}/tasks",
            params={"showCompleted": "true" if show_completed else "false"},
        )

    def create_task(self, task: Dict[str, Any], *, tasklist: str = "@default") -> Dict[str, Any]:
        return self._tasks("POST", f"/lists/{_enc(tasklist)}/tasks", json=task)

    def complete_task(self, task_id: str, *, tasklist: str = "@default") -> Dict[str, Any]:
        return self._tasks(
            "PATCH", f"/lists/{_enc(tasklist)}/tasks/{_enc(task_id)}", json={"status": "completed"}
        )

    def delete_task(self, task_id: str, *, tasklist: str = "@default") -> Dict[str, Any]:
        return self._tasks("DELETE", f"/lists/{_enc(tasklist)}/tasks/{_enc(task_id)}")


def _enc(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="@")


def build_event(
    *,
    summary: str,
    start: str,
    end: str,
    timezone: str = "UTC",
    all_day: bool = False,
    description: Optional[str] = None,
    location: Optional[str] = None,
    attendees: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Build a Calendar event body. Timed events store the IANA zone with each
    endpoint; all-day events use date-only fields."""
    if all_day:
        start_obj = {"date": start}
        end_obj = {"date": end}
    else:
        start_obj = {"dateTime": start, "timeZone": timezone}
        end_obj = {"dateTime": end, "timeZone": timezone}
    event: Dict[str, Any] = {"summary": summary, "start": start_obj, "end": end_obj}
    if description:
        event["description"] = description
    if location:
        event["location"] = location
    if attendees:
        event["attendees"] = [{"email": e} for e in attendees]
    return event
