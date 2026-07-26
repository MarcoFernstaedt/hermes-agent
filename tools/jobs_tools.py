"""Agent tools over the Jobs / career tracker.

Gives Imperator eyes and hands on the job-application pipeline the dashboard
already manages, binding to the *same* store (``HERMES_JOBS_DB_PATH`` / the
Obsidian job-search db) — no separate data, no migration. Reads (list / summary
/ history) are AUTO; advancing a job's status is APPROVAL and audited, and the
lifecycle's own ``ALLOWED_TRANSITIONS`` gates it. There is deliberately no create
or delete tool: application records are authored through the dashboard's packet
flow, and a destructive op stays fail-safe.
"""
from __future__ import annotations

from typing import Any

from tools.registry import registry, tool_error, tool_result


def _db_path():
    from hermes_cli.jobs.router import _paths

    return _paths()[0]


def _available() -> bool:
    try:
        return _db_path().is_file()
    except Exception:
        return False


def _repo():
    from hermes_cli.jobs.repository import JobRepository

    return JobRepository(_db_path())


def _audit(action: str, target: Any, detail: dict | None = None) -> None:
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor="agent", module="jobs", tool="jobs", action=action,
            target=str(target), decision="approval", outcome="ok", detail=detail,
        )
    except Exception:
        pass


def _handle_list(args: dict, **_kw) -> str:
    try:
        jobs = _repo().list_jobs(
            status=(args.get("status") or None),
            freshness=(args.get("freshness") or None),
            query=(args.get("query") or None),
        )
    except ValueError as exc:
        return tool_error(str(exc))
    except Exception as exc:
        return tool_error(f"jobs list failed: {exc}")
    # Return the store's own job dicts, capped so a big pipeline can't blow the
    # context. The model gets whatever fields the tracker records.
    return tool_result({"items": jobs[:200], "total": len(jobs)})


def _handle_summary(_args: dict, **_kw) -> str:
    try:
        return tool_result(_repo().summary())
    except Exception as exc:
        return tool_error(f"jobs summary failed: {exc}")


def _handle_history(args: dict, **_kw) -> str:
    job_id = args.get("id")
    if job_id is None:
        return tool_error("id is required")
    try:
        return tool_result({"history": _repo().status_history(int(job_id))})
    except Exception as exc:
        return tool_error(f"jobs history failed: {exc}")


def _handle_advance(args: dict, **_kw) -> str:
    from hermes_cli.jobs.repository import (
        InvalidTransitionError,
        JobNotFoundError,
        StaleJobError,
    )

    job_id = args.get("id")
    target = args.get("to")
    if job_id is None or not target:
        return tool_error("id and to are required")
    try:
        repo = _repo()
        job = next((j for j in repo.list_jobs() if j.get("id") == int(job_id)), None)
        if job is None:
            return tool_error("job not found")
        current = job.get("status")
        updated_at = job.get("updated_at")
        if not current or not updated_at:
            return tool_error("job is missing status/updated_at; cannot advance safely")
        updated = repo.transition_status(
            int(job_id), str(target),
            expected_status=str(current), expected_updated_at=str(updated_at),
        )
        _audit("advance", job_id, {"from": current, "to": target})
        return tool_result({"id": updated.get("id"), "status": updated.get("status")})
    except InvalidTransitionError:
        return tool_error(f"cannot move to '{target}' from '{job.get('status')}'")
    except JobNotFoundError:
        return tool_error("job not found")
    except StaleJobError:
        return tool_error("job changed elsewhere; re-read and retry")
    except Exception as exc:
        return tool_error(f"jobs advance failed: {exc}")


_STR = {"type": "string"}
_SCHEMAS = {
    "jobs_list": {"name": "jobs_list",
                  "description": "List job applications with their status. Optional status/freshness/query filters.",
                  "parameters": {"type": "object", "properties": {"status": _STR, "freshness": _STR, "query": _STR}}},
    "jobs_summary": {"name": "jobs_summary",
                     "description": "Pipeline summary of the job search (counts by stage, actionable items).",
                     "parameters": {"type": "object", "properties": {}}},
    "jobs_history": {"name": "jobs_history",
                     "description": "Status history for one job application.",
                     "parameters": {"type": "object", "properties": {"id": {"type": "number"}}, "required": ["id"]}},
    "jobs_advance": {"name": "jobs_advance",
                     "description": "Advance a job to another status (gated by the allowed transitions). Requires approval.",
                     "parameters": {"type": "object", "properties": {"id": {"type": "number"}, "to": _STR}, "required": ["id", "to"]}},
}

_TOOLS = (
    ("jobs_list", "jobs", _SCHEMAS["jobs_list"], _handle_list),
    ("jobs_summary", "jobs", _SCHEMAS["jobs_summary"], _handle_summary),
    ("jobs_history", "jobs", _SCHEMAS["jobs_history"], _handle_history),
    ("jobs_advance", "jobs", _SCHEMAS["jobs_advance"], _handle_advance),
)


def _register_permissions() -> None:
    try:
        from hermes_cli.module_permissions import Tier, register_tool_permission

        for name in ("jobs_list", "jobs_summary", "jobs_history"):
            register_tool_permission(name, Tier.AUTO)
        register_tool_permission("jobs_advance", Tier.APPROVAL)
    except Exception:
        pass


_register_permissions()
for _name, _toolset, _schema, _handler in _TOOLS:
    try:
        registry.register(name=_name, toolset=_toolset, schema=_schema,
                          handler=_handler, check_fn=_available, emoji="")
    except Exception:
        pass
