"""HTTP surface exposing capability declarations to the dashboard.

The canonical declarations live as JSON in ``definitions/`` and are consumed by
both the agent-tool generator (tools/capability_tools.py) and — via this
endpoint — the web UI, which fetches them at boot and derives its routes, nav
entries, boards, tables and forms from the same shape. Reads are behind the
session token; the ``/validate`` write-shaped check additionally requires a
same-origin request (it takes a body but has no side effects).
"""
from __future__ import annotations

from collections.abc import Callable
from urllib.parse import urlsplit

from fastapi import APIRouter, Body, HTTPException, Request

from hermes_cli.capabilities.declarations import LOAD_ERRORS, load_capabilities
from hermes_cli.capabilities.schema import declaration_json_schema, validate_declaration

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


def create_capabilities_router(authorize: Authorize) -> APIRouter:
    router = APIRouter(prefix="/api/capabilities", tags=["capabilities"])

    @router.get("")
    def list_capabilities(request: Request) -> dict:
        authorize(request)
        # Refresh so a newly-authored/edited declaration appears, and surface any
        # rejected ones (invalid declarations are never served as broken UI).
        caps = load_capabilities()
        return {"capabilities": caps, "load_errors": LOAD_ERRORS}

    @router.get("/schema")
    def get_schema(request: Request) -> dict:
        authorize(request)
        return declaration_json_schema()

    @router.post("/validate")
    def validate(request: Request, declaration: dict = Body(...)) -> dict:
        """Validate a declaration without saving it — the shared check the
        authoring builder and the agent tool both call before proposing."""
        authorize(request)
        _require_same_origin(request)
        errors = validate_declaration(declaration)
        return {"valid": not errors, "errors": errors}

    return router
