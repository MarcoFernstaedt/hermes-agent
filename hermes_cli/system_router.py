"""HTTP surface for system/release provenance — read-only, behind the token."""
from __future__ import annotations

from collections.abc import Callable

from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import provenance

Authorize = Callable[[Request], None]


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


def create_system_router(authorize: Authorize) -> APIRouter:
    router = APIRouter(prefix="/api/system", tags=["system"])

    @router.get("/provenance")
    def read_provenance(request: Request) -> dict:
        authorize(request)
        return provenance.collect()

    @router.get("/health")
    def read_health(request: Request) -> dict:
        authorize(request)
        from hermes_cli import health

        return health.collect_health()

    @router.get("/chat-sessions")
    def read_chat_sessions(request: Request) -> dict:
        """Retained PTY/TUI session stats — the number that fills the cap."""
        authorize(request)
        try:
            from hermes_cli.web_server import PTY_REGISTRY

            return PTY_REGISTRY.stats()
        except Exception as exc:  # registry unavailable (headless serve)
            return {"available": False, "detail": str(exc)}

    @router.post("/chat-sessions/cleanup")
    async def cleanup_chat_sessions(request: Request) -> dict:
        """Close detached sessions. Never touches an attached client."""
        authorize(request)
        _require_same_origin(request)
        from hermes_cli.web_server import PTY_REGISTRY

        closed = await PTY_REGISTRY.close_retained()
        return {"closed": closed, **PTY_REGISTRY.stats()}

    return router
