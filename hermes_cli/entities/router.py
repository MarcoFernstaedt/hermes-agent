"""HTTP surface for the generic entity store.

Restful CRUD under /api/entities/{type}. Reads are open behind the session
token; writes additionally require a same-origin request (like the life/jobs
writers). Optimistic-concurrency conflicts surface as 409 with the current
record so the client can rebase.
"""
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from hermes_cli.entities.store import (
    EntityConflictError,
    EntityNotFoundError,
    EntityStore,
)
from hermes_constants import get_hermes_home

Authorize = Callable[[Request], None]


class EntityCreate(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)


class EntityUpdate(BaseModel):
    data: dict[str, Any]
    expected_version: int = Field(ge=1)


def default_database_path() -> Path:
    return get_hermes_home() / "state" / "entities.sqlite3"


_STORE: EntityStore | None = None


def initialize_entities() -> None:
    global _STORE
    _STORE = EntityStore(default_database_path())
    _STORE.migrate()


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


def create_entities_router(
    authorize: Authorize,
    *,
    store_factory: Optional[Callable[[], EntityStore]] = None,
    initialize: bool = True,
) -> APIRouter:
    if initialize and store_factory is None:
        initialize_entities()

    def _store() -> EntityStore:
        if store_factory is not None:
            return store_factory()
        if _STORE is None:
            raise HTTPException(status_code=503, detail="Entity store not configured")
        return _STORE

    router = APIRouter(prefix="/api/entities", tags=["entities"])

    @router.get("/{entity_type}")
    def list_entities(
        entity_type: str,
        request: Request,
        limit: int = Query(default=100, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
    ) -> dict:
        authorize(request)
        # Any query param other than limit/offset becomes an equality filter.
        filters = {
            k: v
            for k, v in request.query_params.items()
            if k not in ("limit", "offset")
        }
        try:
            return _store().list(
                entity_type, filters=filters or None, limit=limit, offset=offset
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None

    @router.post("/{entity_type}")
    def create_entity(
        entity_type: str, request: Request, body: EntityCreate = Body(...)
    ) -> dict:
        authorize(request)
        _require_same_origin(request)
        try:
            return _store().create(entity_type, body.data)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None

    @router.get("/{entity_type}/{entity_id}")
    def get_entity(entity_type: str, entity_id: str, request: Request) -> dict:
        authorize(request)
        entity = _store().get(entity_id)
        if entity is None or entity["type"] != entity_type:
            raise HTTPException(status_code=404, detail="Entity not found")
        return entity

    @router.patch("/{entity_type}/{entity_id}", response_model=None)
    def update_entity(
        entity_type: str,
        entity_id: str,
        request: Request,
        body: EntityUpdate = Body(...),
    ) -> dict | JSONResponse:
        authorize(request)
        _require_same_origin(request)
        store = _store()
        existing = store.get(entity_id)
        if existing is None or existing["type"] != entity_type:
            raise HTTPException(status_code=404, detail="Entity not found")
        try:
            return store.update(
                entity_id, body.data, expected_version=body.expected_version
            )
        except EntityNotFoundError:
            raise HTTPException(status_code=404, detail="Entity not found") from None
        except EntityConflictError as exc:
            return JSONResponse(
                status_code=409,
                content={"detail": "Entity version conflict", "current": exc.current},
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None

    @router.delete("/{entity_type}/{entity_id}")
    def delete_entity(entity_type: str, entity_id: str, request: Request) -> dict:
        authorize(request)
        _require_same_origin(request)
        store = _store()
        existing = store.get(entity_id)
        if existing is None or existing["type"] != entity_type:
            raise HTTPException(status_code=404, detail="Entity not found")
        store.delete(entity_id)
        return {"deleted": True, "id": entity_id}

    return router
