"""HTTP surface for the review queue — /api/review.

Reads sit behind the session token; every state change (create, approve, reject)
additionally requires a same-origin request. Approving a proposal applies it
through its registered handler in the same call, recording the outcome — so the
reviewer sees immediately whether it landed. Every decision is audited.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Body, HTTPException, Query, Request
from pydantic import BaseModel, Field

from hermes_cli.review.handlers import ApplyError, apply_payload, has_handler
from hermes_cli.review.store import (
    KINDS,
    ProposalConflict,
    ProposalNotFound,
    ReviewStore,
)

Authorize = Callable[[Request], None]


class ProposalCreate(BaseModel):
    kind: str
    title: str = Field(min_length=1)
    summary: str = ""
    source: str = "human"
    risk: str = "low"
    payload: dict[str, Any] = Field(default_factory=dict)
    preview: dict[str, Any] = Field(default_factory=dict)


def _default_store_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "state" / "review.sqlite3"


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


def _audit(action: str, proposal: dict, outcome: str) -> None:
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor="user", module="review", tool=proposal.get("kind", ""),
            action=action, target=proposal.get("id", ""), decision=action,
            outcome=outcome,
            detail={"title": proposal.get("title", ""), "source": proposal.get("source", "")},
        )
    except Exception:
        pass


def create_review_router(
    authorize: Authorize,
    *,
    store_factory: Optional[Callable[[], ReviewStore]] = None,
    publish: Optional[Callable[[str, dict], Awaitable[None]]] = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/review", tags=["review"])
    _store: dict[str, ReviewStore] = {}

    def store() -> ReviewStore:
        if store_factory is not None:
            return store_factory()
        if "s" not in _store:
            _store["s"] = ReviewStore(_default_store_path())
        return _store["s"]

    async def _emit(action: str, proposal: dict) -> None:
        if publish is None:
            return
        try:
            await publish("review", {"kind": "review", "action": action,
                                     "id": proposal.get("id"), "status": proposal.get("status")})
        except Exception:
            pass

    @router.get("")
    def list_proposals(request: Request, status: Optional[str] = Query(None)) -> dict:
        authorize(request)
        s = store()
        return {"proposals": s.list(status=status), "counts": s.counts()}

    @router.get("/{pid}")
    def get_proposal(pid: str, request: Request) -> dict:
        authorize(request)
        try:
            return store().get(pid)
        except ProposalNotFound as exc:
            raise HTTPException(status_code=404, detail="Proposal not found") from exc

    @router.post("")
    async def create_proposal(request: Request, body: ProposalCreate) -> dict:
        authorize(request)
        _require_same_origin(request)
        if body.kind not in KINDS:
            raise HTTPException(status_code=422, detail=f"unknown kind '{body.kind}'")
        proposal = store().create(
            kind=body.kind, title=body.title, summary=body.summary,
            source=body.source, risk=body.risk, payload=body.payload, preview=body.preview,
        )
        _audit("proposed", proposal, "pending")
        await _emit("created", proposal)
        return proposal

    @router.post("/{pid}/approve")
    async def approve_proposal(pid: str, request: Request) -> dict:
        authorize(request)
        _require_same_origin(request)
        s = store()
        try:
            proposal = s.approve(pid)
        except ProposalNotFound as exc:
            raise HTTPException(status_code=404, detail="Proposal not found") from exc
        except ProposalConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        _audit("approved", proposal, "approved")
        # Apply immediately through the kind's handler; record the outcome.
        if not has_handler(proposal["kind"]):
            final = s.mark_failed(pid, outcome=f"no handler for kind '{proposal['kind']}'")
            _audit("apply_failed", final, "failed")
            await _emit("failed", final)
            return final
        try:
            outcome = apply_payload(proposal["kind"], proposal["payload"])
            final = s.mark_applied(pid, outcome=outcome)
            _audit("applied", final, "ok")
            await _emit("applied", final)
            return final
        except (ApplyError, Exception) as exc:  # noqa: BLE001 — record any apply failure
            final = s.mark_failed(pid, outcome=str(exc))
            _audit("apply_failed", final, "error")
            await _emit("failed", final)
            return final

    @router.post("/{pid}/reject")
    async def reject_proposal(pid: str, request: Request) -> dict:
        authorize(request)
        _require_same_origin(request)
        try:
            proposal = store().reject(pid)
        except ProposalNotFound as exc:
            raise HTTPException(status_code=404, detail="Proposal not found") from exc
        except ProposalConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        _audit("rejected", proposal, "rejected")
        await _emit("rejected", proposal)
        return proposal

    return router
