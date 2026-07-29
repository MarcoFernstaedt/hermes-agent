"""The volatile context tier — what is true *right now*.

The locked architecture splits context in two. The static tier is byte-stable
and lives in the system prompt, so upstream prompt caches stay warm across a
whole day. Anything recency-ordered, timestamped, or per-turn must never touch
that prefix, because a single changed byte invalidates the cached KV for every
request behind it. This module is the other half: the volatile facts, pulled on
demand rather than pushed into the prompt.

Round-2 recon confirmed the gap this fills. The agent had made **zero**
`hub_context` calls in thirty days, for the plain reason that the tool did not
exist — the name appeared only in architecture documents. Asked what a personal
intelligence hub was still missing, the on-machine agent answered: an
income-first "now" surface backed by a real volatile-context tool — current
mission, best next action, deadline exceptions, blockers, and approval state in
one place.

Design rules this file holds to:

- **Read-only.** Assembling context never mutates anything, so the agent can
  call it freely at the start of any turn without a permission gate.
- **Local only.** Every section reads state the app already keeps. Nothing
  phones home, and no section may perform network I/O.
- **Fail soft, per section.** One unavailable subsystem (an unconfigured jobs
  vault, a missing capability store) degrades that section to a stated reason
  and never breaks the payload — a context tool that raises is a context tool
  the agent learns to stop calling.
- **Small.** This lands in a model's context window on demand. Sections are
  capped and summarised, not dumped; the agent follows up with the specific
  tool when it wants depth.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Callable

# Section caps. A context payload that grows without bound stops being context.
_MAX_ACTIONS = 5
_MAX_PENDING = 5
_MAX_DUE = 5

SECTION_NAMES = ("attention", "jobs", "review", "guardrails", "capabilities", "health")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _safe(name: str, fn: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """Run one section, converting any failure into a stated reason.

    Deliberately broad: the value of this tool is that it always answers. A
    section that cannot be read reports *why*, which is itself useful context —
    "the jobs vault is not configured" tells the agent not to promise job work.
    """
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 — see docstring
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}


def _jobs_section() -> dict[str, Any]:
    """The income surface: what is ready to send, and what is going stale."""
    from hermes_cli.jobs.router import _paths
    from hermes_cli.jobs.repository import JobRepository

    database, packet_root = _paths()
    if not database.is_file() or not packet_root.is_dir():
        return {"available": False, "reason": "jobs vault is not configured"}

    repo = JobRepository(database)
    summary = repo.summary()
    items = repo.list_jobs(status="packet_ready_not_applied")

    # Freshest, best-fitting packets first — the same ordering the daily command
    # surface uses, so the agent and the dashboard agree on "what's next".
    def rank(job: dict) -> tuple:
        freshness = {"active": 0, "unknown": 1, "stale": 2}.get(job.get("freshness"), 3)
        return (freshness, -(job.get("fit_score") or 0), job.get("date_found") or "")

    ready = sorted(items, key=rank)[:_MAX_ACTIONS]
    return {
        "available": True,
        "counts": summary.get("counts", {}),
        "next_actions": [
            {
                "id": job.get("id"),
                "company": job.get("company"),
                "role": job.get("role_title"),
                "fit_score": job.get("fit_score"),
                "freshness": job.get("freshness"),
                "apply_url": job.get("apply_url"),
            }
            for job in ready
        ],
    }


def _review_section() -> dict[str, Any]:
    """What is waiting on the owner's decision — the app's own blocked queue."""
    from hermes_cli.review.store import ReviewStore
    from hermes_constants import get_hermes_home

    store = ReviewStore(get_hermes_home() / "state" / "review.sqlite3")
    counts = store.counts()
    pending = store.list(status="pending")[:_MAX_PENDING]
    return {
        "available": True,
        "counts": counts,
        "pending": [
            {
                "id": p.get("id"),
                "kind": p.get("kind"),
                "title": p.get("title"),
                "risk": p.get("risk"),
                "source": p.get("source"),
            }
            for p in pending
        ],
    }


def _guardrails_section() -> dict[str, Any]:
    """Whether the agent is allowed to act at all, and under what scope."""
    from hermes_cli import agent_scopes

    halted = agent_scopes.is_agent_halted()
    return {
        "available": True,
        "halted": halted,
        "scope": agent_scopes.get_active_scope(),
        # Stated plainly because it changes what the agent should even attempt.
        "note": (
            "All tool activity is halted. Do not promise actions; tell the owner "
            "the global stop is engaged."
            if halted
            else "Tools are available, subject to per-tool approval."
        ),
    }


def _capabilities_section() -> dict[str, Any]:
    """Owner-defined areas, and anything in them with a date that has passed."""
    from hermes_cli.capabilities.declarations import load_capabilities

    caps = load_capabilities()
    now = _utcnow().date().isoformat()
    due: list[dict[str, Any]] = []

    for cap in caps:
        date_fields = [f["name"] for f in cap.get("fields", []) if f.get("type") == "date"]
        if not date_fields:
            continue
        lifecycle = cap.get("lifecycle") or {}
        terminal = set(lifecycle.get("states", [])[-1:])  # last state reads as "done"
        try:
            from hermes_cli.entities.router import default_database_path
            from hermes_cli.entities.store import EntityStore

            store = EntityStore(default_database_path())
            store.migrate()
            listing = store.list(cap.get("entity") or cap["id"], limit=200)
            records = [row.get("data", {}) for row in listing["items"]]
        except Exception:
            continue
        for record in records:
            if lifecycle and record.get(lifecycle.get("field")) in terminal:
                continue
            for field in date_fields:
                value = record.get(field)
                if isinstance(value, str) and value and value <= now:
                    due.append({
                        "capability": cap["id"],
                        "title": record.get(cap.get("title_field", "title")),
                        "field": field,
                        "date": value,
                    })
                    break
        if len(due) >= _MAX_DUE:
            break

    return {
        "available": True,
        "areas": [{"id": c["id"], "label": c.get("label")} for c in caps],
        "due_or_overdue": sorted(due, key=lambda d: d["date"])[:_MAX_DUE],
    }


def _health_section() -> dict[str, Any]:
    """The app's own condition, so the agent can mention a real problem."""
    from hermes_cli.health import collect_health

    health = collect_health()
    return {
        "available": True,
        "status": health.get("status"),
        "problems": [
            f"{name}: {section.get('status')}"
            for name, section in health.get("sections", {}).items()
            if section.get("status") in {"warn", "error"}
        ],
    }


def _attention(sections: dict[str, Any]) -> list[str]:
    """The one-line summary the agent should lead with.

    Ordered by what actually blocks the owner: a halted agent first (nothing
    else can happen), then decisions only they can make, then income work, then
    dates, then the app's own health. Everything here is derived from the
    sections above — this adds no new source of truth.
    """
    lines: list[str] = []

    guardrails = sections.get("guardrails", {})
    if guardrails.get("halted"):
        lines.append("The global stop is engaged — no tool will run until it is released.")

    review = sections.get("review", {})
    pending = (review.get("counts") or {}).get("pending", 0)
    if pending:
        lines.append(
            f"{pending} proposal{'s' if pending != 1 else ''} waiting on your approval."
        )

    jobs = sections.get("jobs", {})
    ready = len(jobs.get("next_actions") or [])
    if ready:
        first = jobs["next_actions"][0]
        lines.append(
            f"{(jobs.get('counts') or {}).get('packet_ready', ready)} packets ready to send — "
            f"best next: {first.get('role')} at {first.get('company')}."
        )

    due = sections.get("capabilities", {}).get("due_or_overdue") or []
    if due:
        lines.append(f"{len(due)} tracked item{'s' if len(due) != 1 else ''} due or overdue.")

    health = sections.get("health", {})
    if health.get("status") in {"warn", "error"}:
        lines.append(f"Platform health is {health['status']}: {', '.join(health.get('problems', []))}.")

    if not lines:
        lines.append("Nothing is waiting. No approvals pending, no overdue items.")
    return lines


_SECTION_FNS: dict[str, Callable[[], dict[str, Any]]] = {
    "jobs": _jobs_section,
    "review": _review_section,
    "guardrails": _guardrails_section,
    "capabilities": _capabilities_section,
    "health": _health_section,
}


def collect_hub_context(sections: list[str] | None = None) -> dict[str, Any]:
    """Assemble the volatile tier.

    ``sections`` narrows the payload; omitting it returns everything. Unknown
    names are ignored rather than raising, so a slightly-wrong tool call still
    returns useful context instead of an error.
    """
    wanted = [s for s in (sections or list(_SECTION_FNS)) if s in _SECTION_FNS]
    if not wanted:
        wanted = list(_SECTION_FNS)

    out: dict[str, Any] = {name: _safe(name, _SECTION_FNS[name]) for name in wanted}
    return {
        # Minute precision is fine here and nowhere near the system prompt —
        # that is the entire point of keeping this tier out of the prefix.
        "generated_at": _utcnow().isoformat(timespec="seconds"),
        "generated_at_epoch": time.time(),
        "attention": _attention(out),
        "sections": out,
    }
