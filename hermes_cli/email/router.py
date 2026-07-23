"""Gmail read + triage HTTP surface for the dashboard.

Read-first slice (Phase 2a): connection status, label list, message list
(ids + a batch metadata fetch for virtualized rows), single message/thread
read, and reversible triage writes (archive / mark read / star via label
modify, plus trash). These are the ME path — no approval gate; the agent's
send/trash tools are gated separately.

A 401→refresh, 429 backoff and token handling all live in the Gmail client.
Refresh failure surfaces as a clear "needs reauth" 409 the UI turns into a
reconnect prompt rather than a crash.
"""

from __future__ import annotations

from typing import Any, Callable, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from hermes_cli.google import GoogleAuthError, GoogleReauthRequired
from hermes_cli.google.gmail import GmailClient, GmailError, parse_metadata

Authorize = Callable[[Request], Any]


class ModifyBody(BaseModel):
    add: List[str] = []
    remove: List[str] = []


class MetadataBody(BaseModel):
    ids: List[str] = []


def _handle_google_errors(exc: Exception):
    if isinstance(exc, GoogleReauthRequired):
        raise HTTPException(status_code=409, detail="google_needs_reauth")
    if isinstance(exc, GoogleAuthError):
        raise HTTPException(status_code=409, detail="google_not_connected")
    if isinstance(exc, GmailError):
        raise HTTPException(status_code=502, detail=str(exc))
    raise exc


def create_email_router(
    authorize: Authorize,
    *,
    client_factory: Callable[[], GmailClient] = GmailClient,
) -> APIRouter:
    router = APIRouter(prefix="/api/email", tags=["email"])
    dep = [Depends(authorize)]

    @router.get("/connection", dependencies=dep)
    async def connection() -> dict[str, Any]:
        from hermes_cli.google import connection_status

        return connection_status()

    @router.get("/labels", dependencies=dep)
    async def labels() -> dict[str, Any]:
        try:
            return client_factory().list_labels()
        except Exception as exc:
            _handle_google_errors(exc)

    @router.get("/messages", dependencies=dep)
    async def list_messages(
        q: Optional[str] = Query(default=None),
        label: Optional[str] = Query(default=None),
        max_results: int = Query(default=25, ge=1, le=100),
        page_token: Optional[str] = Query(default=None),
    ) -> dict[str, Any]:
        """List message ids matching a Gmail query (cheap; ids only). The
        client fetches metadata for visible rows via /messages/metadata."""
        try:
            return client_factory().list_messages(
                q=q,
                label_ids=[label] if label else None,
                max_results=max_results,
                page_token=page_token,
            )
        except Exception as exc:
            _handle_google_errors(exc)

    @router.post("/messages/metadata", dependencies=dep)
    async def messages_metadata(body: MetadataBody = Body(...)) -> dict[str, Any]:
        """Batch metadata fetch for a set of ids — one client request instead
        of the virtualized list firing N. Gmail has no server-side batch
        metadata, so the server fans out; the local history cache (later slice)
        removes the repeat cost."""
        client = client_factory()
        rows = []
        try:
            for mid in body.ids[:50]:
                rows.append(parse_metadata(client.get_message(mid, fmt="metadata")))
        except Exception as exc:
            _handle_google_errors(exc)
        return {"messages": rows}

    @router.get("/messages/{message_id}", dependencies=dep)
    async def get_message(
        message_id: str, fmt: str = Query(default="full", pattern="^(full|metadata|minimal)$")
    ) -> dict[str, Any]:
        try:
            return client_factory().get_message(message_id, fmt=fmt)
        except Exception as exc:
            _handle_google_errors(exc)

    @router.get("/threads/{thread_id}", dependencies=dep)
    async def get_thread(
        thread_id: str, fmt: str = Query(default="full", pattern="^(full|metadata|minimal)$")
    ) -> dict[str, Any]:
        try:
            return client_factory().get_thread(thread_id, fmt=fmt)
        except Exception as exc:
            _handle_google_errors(exc)

    @router.post("/messages/{message_id}/modify", dependencies=dep)
    async def modify_message(message_id: str, body: ModifyBody = Body(...)) -> dict[str, Any]:
        """Reversible label change (archive, mark read/unread, star). ME path,
        no approval gate; fully undoable by reversing the label set."""
        try:
            return client_factory().modify_message(
                message_id, add=body.add, remove=body.remove
            )
        except Exception as exc:
            _handle_google_errors(exc)

    @router.post("/messages/{message_id}/trash", dependencies=dep)
    async def trash_message(message_id: str) -> dict[str, Any]:
        """Move to Trash (recoverable — not a permanent delete; that needs a
        scope we deliberately don't request)."""
        try:
            return client_factory().trash_message(message_id)
        except Exception as exc:
            _handle_google_errors(exc)

    return router
