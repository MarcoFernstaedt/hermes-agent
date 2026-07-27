"""HTTP surface for system/release provenance — read-only, behind the token."""
from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Request

from hermes_cli import provenance

Authorize = Callable[[Request], None]


def create_system_router(authorize: Authorize) -> APIRouter:
    router = APIRouter(prefix="/api/system", tags=["system"])

    @router.get("/provenance")
    def read_provenance(request: Request) -> dict:
        authorize(request)
        return provenance.collect()

    return router
