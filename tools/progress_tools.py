"""Agent tools over the Progress / habits tracker (the Life module).

Binds to the same local store the dashboard uses
(``~/.hermes/state/life-progress.sqlite3``). Reads (today / history) are AUTO;
logging a habit value for a day is APPROVAL and audited. There is no delete tool
— removing a habit stays a manual dashboard action, fail-safe.
"""
from __future__ import annotations

from typing import Any

from tools.registry import registry, tool_error, tool_result


def _db_path():
    from hermes_cli.life.router import default_database_path

    return default_database_path()


def _available() -> bool:
    try:
        return _db_path().is_file()
    except Exception:
        return False


def _repo():
    from hermes_cli.life.repository import LifeRepository

    return LifeRepository(_db_path())


def _audit(action: str, target: Any, detail: dict | None = None) -> None:
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor="agent", module="progress", tool="progress", action=action,
            target=str(target), decision="approval", outcome="ok", detail=detail,
        )
    except Exception:
        pass


def _handle_today(args: dict, **_kw) -> str:
    try:
        return tool_result(_repo().today(day=(args.get("day") or None)))
    except Exception as exc:
        return tool_error(f"progress today failed: {exc}")


def _handle_history(args: dict, **_kw) -> str:
    try:
        days = int(args.get("days", 14))
    except (TypeError, ValueError):
        days = 14
    days = max(1, min(days, 90))
    try:
        return tool_result({"history": _repo().history(
            end_day=(args.get("end_day") or None), days=days)})
    except Exception as exc:
        return tool_error(f"progress history failed: {exc}")


def _handle_log(args: dict, **_kw) -> str:
    habit_id = args.get("habit_id")
    value = args.get("value")
    if habit_id is None or value is None:
        return tool_error("habit_id and value are required")
    try:
        repo = _repo()
        # Default the day to today when unspecified.
        day = args.get("day") or repo.today().get("day")
        repo.set_entry(
            int(habit_id), day=str(day), value=float(value),
            note=str(args.get("note") or ""),
        )
        _audit("log", habit_id, {"day": day, "value": value})
        return tool_result({"habit_id": int(habit_id), "day": day, "value": float(value)})
    except LookupError:
        return tool_error("habit not found")
    except ValueError as exc:
        return tool_error(str(exc))
    except Exception as exc:
        return tool_error(f"progress log failed: {exc}")


_SCHEMAS = {
    "progress_today": {"name": "progress_today",
                       "description": "Today's habits with their target and current value. Optional 'day' (YYYY-MM-DD).",
                       "parameters": {"type": "object", "properties": {"day": {"type": "string"}}}},
    "progress_history": {"name": "progress_history",
                         "description": "Habit history over the last N days (default 14).",
                         "parameters": {"type": "object", "properties": {"days": {"type": "number"}, "end_day": {"type": "string"}}}},
    "progress_log": {"name": "progress_log",
                     "description": "Log a value for a habit on a day (defaults to today). Requires approval.",
                     "parameters": {"type": "object", "properties": {
                         "habit_id": {"type": "number"}, "value": {"type": "number"},
                         "day": {"type": "string"}, "note": {"type": "string"}},
                         "required": ["habit_id", "value"]}},
}

_TOOLS = (
    ("progress_today", "progress", _SCHEMAS["progress_today"], _handle_today),
    ("progress_history", "progress", _SCHEMAS["progress_history"], _handle_history),
    ("progress_log", "progress", _SCHEMAS["progress_log"], _handle_log),
)


def _register_permissions() -> None:
    try:
        from hermes_cli.module_permissions import Tier, register_tool_permission

        register_tool_permission("progress_today", Tier.AUTO)
        register_tool_permission("progress_history", Tier.AUTO)
        register_tool_permission("progress_log", Tier.APPROVAL)
    except Exception:
        pass


_register_permissions()

# Direct top-level registration so the registry's auto-discovery
# (_module_registers_tools requires a top-level registry.register call) imports
# this module. A loop-wrapped call is not detected and the module never loads.
registry.register(name="progress_today", toolset="progress", schema=_SCHEMAS["progress_today"],
                  handler=_handle_today, check_fn=_available, emoji="")
registry.register(name="progress_history", toolset="progress", schema=_SCHEMAS["progress_history"],
                  handler=_handle_history, check_fn=_available, emoji="")
registry.register(name="progress_log", toolset="progress", schema=_SCHEMAS["progress_log"],
                  handler=_handle_log, check_fn=_available, emoji="")
