"""HTTP surface for agent guardrails — session scopes and the global stop.

Reads (list scopes, read halt state, read a session's scope) sit behind the
session token. Writes (engage/release the global stop, set a session's scope)
additionally require a same-origin request, matching the entities/jobs writers.

The global stop is deliberately reachable with a *minimal* dependency surface so
it stays a reliable brake: engaging it sets a persisted flag that
``agent_scopes.enforce_dispatch`` consults at the one chokepoint every tool call
passes through.
"""
from __future__ import annotations

from collections.abc import Callable
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from hermes_cli import agent_scopes as sc

Authorize = Callable[[Request], None]


class HaltRequest(BaseModel):
    halted: bool


class ScopeRequest(BaseModel):
    scope: str


def _require_same_origin(request: Request) -> None:
    supplied = request.headers.get("origin") or request.headers.get("referer")
    if not supplied:
        if getattr(request.app.state, "auth_required", False):
            raise HTTPException(status_code=403, detail="Same-origin request required")
        return
    source = urlsplit(supplied)
    expected = urlsplit(str(request.base_url))
    if (source.scheme.lower(), source.netloc.lower()) != (
        expected.scheme.lower(),
        expected.netloc.lower(),
    ):
        raise HTTPException(status_code=403, detail="Same-origin request required")


def create_agent_scopes_router(authorize: Authorize) -> APIRouter:
    router = APIRouter(prefix="/api/agent/guardrails", tags=["agent-guardrails"])

    @router.get("")
    def read_guardrails(request: Request) -> dict:
        authorize(request)
        try:
            from hermes_cli import approval_integrity

            integrity_mode = approval_integrity.mode()
        except Exception:
            integrity_mode = "observe"
        return {
            "scopes": sc.list_scopes(),
            "default_scope": sc.DEFAULT_SCOPE,
            "halted": sc.is_agent_halted(),
            "approval_integrity": integrity_mode,
        }

    @router.post("/stop")
    def set_stop(payload: HaltRequest, request: Request) -> dict:
        authorize(request)
        _require_same_origin(request)
        halted = sc.set_agent_halt(payload.halted)
        return {"halted": halted}

    @router.get("/session/{session_id}")
    def read_session_scope(session_id: str, request: Request) -> dict:
        authorize(request)
        return {"session_id": session_id, "scope": sc.get_session_scope(session_id)}

    @router.put("/session/{session_id}")
    def set_session_scope(session_id: str, payload: ScopeRequest, request: Request) -> dict:
        authorize(request)
        _require_same_origin(request)
        try:
            scope = sc.set_session_scope(session_id, payload.scope)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"session_id": session_id, "scope": scope}

    return router
