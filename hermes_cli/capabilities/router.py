"""HTTP surface exposing capability declarations to the dashboard.

The canonical declarations live as JSON in ``definitions/`` and are consumed by
both the agent-tool generator (tools/capability_tools.py) and — via this
endpoint — the web UI, which fetches them at boot and derives its routes, nav
entries, boards, tables and forms from the same shape. Data-only and read-only:
there is nothing to mutate here, so the surface stays behind the session token
with no same-origin write gate.
"""
from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Request

from hermes_cli.capabilities.declarations import load_capabilities

Authorize = Callable[[Request], None]


def create_capabilities_router(authorize: Authorize) -> APIRouter:
    router = APIRouter(prefix="/api/capabilities", tags=["capabilities"])

    @router.get("")
    def list_capabilities(request: Request) -> dict:
        authorize(request)
        return {"capabilities": load_capabilities()}

    return router
