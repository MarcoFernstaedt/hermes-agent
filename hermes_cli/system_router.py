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

    @router.get("/context")
    def read_hub_context(request: Request) -> dict:
        """The same volatile-tier payload the agent's `hub_context` tool returns.

        One assembler, two consumers: the agent pulls it as a tool, the Now
        surface renders it. That is deliberate — if the dashboard and the agent
        computed "what needs attention" separately they would drift, and the
        owner would get two different answers to the same question.
        """
        authorize(request)
        from hermes_cli.hub_context import collect_hub_context

        return collect_hub_context()

    @router.get("/chat-readiness")
    def read_chat_readiness(request: Request) -> dict:
        """Whether opening chat will reach a prompt, or trigger a build first.

        The UI polls this before connecting so a cold checkout shows an
        actionable message instead of a terminal that hangs for five minutes.
        """
        authorize(request)
        from hermes_cli.chat_readiness import chat_backend_status

        return chat_backend_status()

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
