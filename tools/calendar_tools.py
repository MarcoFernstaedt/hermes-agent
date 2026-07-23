"""Native Google Calendar agent tools — the SAFE surface.

Share the exact service the dashboard UI uses (hermes_cli.google.calendar).
Reads (list events, free/busy) are AUTO; create event / create task are
APPROVAL and audited. No delete tool is exposed, so calendar_delete_event
resolves to ALWAYS_APPROVAL (fail-safe) — the agent cannot remove events.
"""

from __future__ import annotations

from typing import Any, List

from tools.registry import registry, tool_error, tool_result


def _available() -> bool:
    try:
        from hermes_cli import secure_store

        tok = secure_store.load_token("google", "default")
        if tok is None:
            return False
        return secure_store.get_status("google", "default") != secure_store.STATUS_NEEDS_REAUTH
    except Exception:
        return False


def _client():
    from hermes_cli.google.calendar import GoogleCalendarClient

    return GoogleCalendarClient()


def _err(exc: Exception) -> str:
    from hermes_cli.google import GoogleReauthRequired

    if isinstance(exc, GoogleReauthRequired):
        return tool_error("Calendar needs reauthorization; reconnect Google on the server.")
    return tool_error(f"Calendar tool failed: {type(exc).__name__}: {exc}")


def _as_list(raw: Any) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        return [p.strip() for p in raw.split(",") if p.strip()]
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    return []


def _audit(action: str, target: str = "", detail: dict | None = None) -> None:
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor="agent", module="calendar", tool="calendar",
            action=action, target=target, decision="auto", outcome="ok", detail=detail,
        )
    except Exception:
        pass


def _handle_list(args: dict, **kw) -> str:
    try:
        return tool_result(
            _client().list_events(
                calendar_id=str(args.get("calendar_id") or "primary"),
                time_min=args.get("time_min"),
                time_max=args.get("time_max"),
                max_results=int(args.get("max_results") or 50),
            )
        )
    except Exception as exc:
        return _err(exc)


def _handle_freebusy(args: dict, **kw) -> str:
    tmin, tmax = args.get("time_min"), args.get("time_max")
    if not (tmin and tmax):
        return tool_error("time_min and time_max are required (RFC3339)")
    try:
        return tool_result(
            _client().free_busy(
                time_min=tmin, time_max=tmax,
                calendar_ids=_as_list(args.get("calendar_ids")) or ["primary"],
            )
        )
    except Exception as exc:
        return _err(exc)


def _handle_create_event(args: dict, **kw) -> str:
    from hermes_cli.google.calendar import build_event

    summary = str(args.get("summary") or "").strip()
    start, end = args.get("start"), args.get("end")
    if not (summary and start and end):
        return tool_error("summary, start and end are required")
    try:
        event = build_event(
            summary=summary, start=str(start), end=str(end),
            timezone=str(args.get("timezone") or "UTC"),
            all_day=bool(args.get("all_day")),
            description=args.get("description"),
            location=args.get("location"),
            attendees=_as_list(args.get("attendees")) or None,
        )
        result = _client().create_event(event, calendar_id=str(args.get("calendar_id") or "primary"))
        _audit("event.create", target=summary, detail={"start": start})
        return tool_result({"id": result.get("id"), "htmlLink": result.get("htmlLink")})
    except Exception as exc:
        return _err(exc)


def _handle_create_task(args: dict, **kw) -> str:
    title = str(args.get("title") or "").strip()
    if not title:
        return tool_error("title is required")
    try:
        task: dict = {"title": title}
        if args.get("notes"):
            task["notes"] = args["notes"]
        if args.get("due"):
            task["due"] = args["due"]
        result = _client().create_task(task, tasklist=str(args.get("tasklist") or "@default"))
        _audit("task.create", target=title)
        return tool_result({"id": result.get("id"), "title": result.get("title")})
    except Exception as exc:
        return _err(exc)


_STR = {"type": "string"}

_SCHEMAS = {
    "calendar_list_events": {
        "name": "calendar_list_events",
        "description": "List Google Calendar events in a time range (RFC3339 time_min/time_max).",
        "parameters": {"type": "object", "properties": {
            "time_min": _STR, "time_max": _STR, "calendar_id": _STR,
            "max_results": {"type": "integer"}}},
    },
    "calendar_find_free_time": {
        "name": "calendar_find_free_time",
        "description": "Query free/busy across calendars in a window to find open slots.",
        "parameters": {"type": "object", "properties": {
            "time_min": _STR, "time_max": _STR,
            "calendar_ids": {"type": "array", "items": _STR}},
            "required": ["time_min", "time_max"]},
    },
    "calendar_create_event": {
        "name": "calendar_create_event",
        "description": "Create a calendar event. Requires approval.",
        "parameters": {"type": "object", "properties": {
            "summary": _STR, "start": _STR, "end": _STR, "timezone": _STR,
            "all_day": {"type": "boolean"}, "description": _STR, "location": _STR,
            "attendees": {"type": "array", "items": _STR}, "calendar_id": _STR},
            "required": ["summary", "start", "end"]},
    },
    "calendar_create_task": {
        "name": "calendar_create_task",
        "description": "Create a Google Task (todo). Requires approval.",
        "parameters": {"type": "object", "properties": {
            "title": _STR, "notes": _STR, "due": _STR, "tasklist": _STR},
            "required": ["title"]},
    },
}

_TOOLS = (
    ("calendar_list_events", _SCHEMAS["calendar_list_events"], _handle_list),
    ("calendar_find_free_time", _SCHEMAS["calendar_find_free_time"], _handle_freebusy),
    ("calendar_create_event", _SCHEMAS["calendar_create_event"], _handle_create_event),
    ("calendar_create_task", _SCHEMAS["calendar_create_task"], _handle_create_task),
)


def _register_permissions() -> None:
    try:
        from hermes_cli.module_permissions import Tier, register_tool_permission

        register_tool_permission("calendar_list_events", Tier.AUTO)
        register_tool_permission("calendar_find_free_time", Tier.AUTO)
        register_tool_permission("calendar_create_event", Tier.APPROVAL)
        register_tool_permission("calendar_create_task", Tier.APPROVAL)
    except Exception:
        pass


_register_permissions()
for _name, _schema, _handler in _TOOLS:
    try:
        registry.register(
            name=_name, toolset="calendar", schema=_schema,
            handler=_handler, check_fn=_available, emoji="",
        )
    except Exception:
        pass
