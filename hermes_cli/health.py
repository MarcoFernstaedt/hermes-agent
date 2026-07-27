"""Platform self-observation — one honest read of the app's own condition.

Aggregates signals the platform already produces — rejected capability
declarations, guardrail refusals and failures, the review backlog, and release
drift — into a single health payload the System surface renders. Local and
read-only: it observes what the app has already recorded (the audit log, the
capability loader, the review queue, provenance), and never phones home.

The intent from the mission: the app should be able to tell the owner how it is
doing without them guessing, and turn a recurring failure into a visible,
gated proposal rather than noise absorbed repeatedly.
"""
from __future__ import annotations

import time
from typing import Any

# Guardrail/self-modification modules whose failures matter to platform health.
_WATCHED_MODULES = ("approval_integrity", "agent_guards", "review", "capabilities")
_WINDOW_SECONDS = 7 * 24 * 3600  # last 7 days


def _capability_health() -> dict[str, Any]:
    try:
        from hermes_cli.capabilities.declarations import load_capabilities, LOAD_ERRORS

        caps = load_capabilities()
        return {
            "loaded": len(caps),
            "rejected": len(LOAD_ERRORS),
            "errors": LOAD_ERRORS[:20],
            "status": "error" if LOAD_ERRORS else "ok",
        }
    except Exception as exc:
        return {"loaded": 0, "rejected": 0, "errors": [], "status": "unknown", "detail": str(exc)}


def _review_health() -> dict[str, Any]:
    try:
        from hermes_cli.review.store import ReviewStore
        from hermes_constants import get_hermes_home

        counts = ReviewStore(get_hermes_home() / "state" / "review.sqlite3").counts()
        pending = counts.get("pending", 0)
        failed = counts.get("failed", 0)
        return {
            "counts": counts,
            # A big pending pile or any failed application is worth surfacing.
            "status": "error" if failed else ("warn" if pending > 10 else "ok"),
        }
    except Exception as exc:
        return {"counts": {}, "status": "unknown", "detail": str(exc)}


def _guardrail_health() -> dict[str, Any]:
    """Cluster recent refusals/failures from the audit log by module+action."""
    try:
        from hermes_cli import audit_log

        since = time.time() - _WINDOW_SECONDS
        clusters: dict[str, int] = {}
        total_refused = 0
        for module in _WATCHED_MODULES:
            for row in audit_log.query(module=module, since=since, limit=500):
                outcome = row.get("outcome", "")
                if outcome in {"refused", "failed", "error"}:
                    total_refused += 1
                    key = f"{module}:{row.get('action', '')}"
                    clusters[key] = clusters.get(key, 0) + 1
        top = sorted(clusters.items(), key=lambda kv: kv[1], reverse=True)[:10]
        return {
            "window_days": 7,
            "refused_or_failed": total_refused,
            "clusters": [{"key": k, "count": c} for k, c in top],
            "status": "warn" if total_refused else "ok",
        }
    except Exception as exc:
        return {"refused_or_failed": 0, "clusters": [], "status": "unknown", "detail": str(exc)}


def _build_health() -> dict[str, Any]:
    try:
        from hermes_cli import provenance

        p = provenance.collect()
        return {
            "backend": p["backend"]["commit_short"],
            "frontend": p["frontend"]["commit_short"],
            "commit_drift": p["commit_drift"],
            "status": "warn" if p["commit_drift"] else "ok",
        }
    except Exception as exc:
        return {"status": "unknown", "detail": str(exc)}


_RANK = {"error": 3, "warn": 2, "ok": 1, "unknown": 0}


def collect_health() -> dict[str, Any]:
    """The full health payload plus a single overall status (worst of the parts,
    treating 'unknown' as non-fatal)."""
    sections = {
        "build": _build_health(),
        "capabilities": _capability_health(),
        "review": _review_health(),
        "guardrails": _guardrail_health(),
    }
    worst = "ok"
    for sec in sections.values():
        st = sec.get("status", "ok")
        if st == "unknown":
            continue
        if _RANK.get(st, 0) > _RANK.get(worst, 0):
            worst = st
    return {"status": worst, "generated_at": time.time(), "sections": sections}
