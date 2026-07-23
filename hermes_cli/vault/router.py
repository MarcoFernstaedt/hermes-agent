"""Obsidian vault HTTP surface (me-path).

Status, note list, read (parsed), search, backlinks, and safe writes
(append/create/overwrite with backup + mtime-conflict guard). Path validation
and atomic writes live in the vault core; this layer maps errors to clean HTTP.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from hermes_cli.vault import notes as vnotes
from hermes_cli.vault.config import VaultNotConfigured, vault_root
from hermes_cli.vault.paths import VaultPathError

Authorize = Callable[[Request], Any]


class AppendBody(BaseModel):
    path: str
    text: str


class CreateBody(BaseModel):
    path: str
    content: str = ""


class WriteBody(BaseModel):
    path: str
    content: str
    expected_mtime: Optional[float] = None


def _map(exc: Exception):
    if isinstance(exc, VaultNotConfigured):
        raise HTTPException(status_code=409, detail="vault_not_configured")
    if isinstance(exc, VaultPathError):
        raise HTTPException(status_code=400, detail="invalid_path")
    if isinstance(exc, vnotes.VaultConflict):
        raise HTTPException(status_code=409, detail="conflict_note_changed_on_disk")
    if isinstance(exc, vnotes.VaultExists):
        raise HTTPException(status_code=409, detail="note_already_exists")
    if isinstance(exc, FileNotFoundError):
        raise HTTPException(status_code=404, detail="not_found")
    raise exc


def create_vault_router(authorize: Authorize) -> APIRouter:
    router = APIRouter(prefix="/api/vault", tags=["vault"])
    dep = [Depends(authorize)]

    @router.get("/status", dependencies=dep)
    async def status() -> dict[str, Any]:
        root = vault_root()
        return {"configured": root is not None, "root": str(root) if root else None}

    @router.get("/notes", dependencies=dep)
    async def notes() -> dict[str, Any]:
        try:
            return {"notes": vnotes.list_notes()}
        except Exception as exc:
            _map(exc)

    @router.get("/note", dependencies=dep)
    async def note(path: str = Query(...)) -> dict[str, Any]:
        try:
            return vnotes.read_note(path)
        except Exception as exc:
            _map(exc)

    @router.get("/search", dependencies=dep)
    async def search(q: str = Query(...)) -> dict[str, Any]:
        try:
            return {"results": vnotes.search_notes(q)}
        except Exception as exc:
            _map(exc)

    @router.get("/backlinks", dependencies=dep)
    async def backlinks(path: str = Query(...)) -> dict[str, Any]:
        try:
            return {"backlinks": vnotes.backlinks(path)}
        except Exception as exc:
            _map(exc)

    @router.post("/append", dependencies=dep)
    async def append(body: AppendBody = Body(...)) -> dict[str, Any]:
        try:
            return vnotes.append_to_note(body.path, body.text)
        except Exception as exc:
            _map(exc)

    @router.post("/create", dependencies=dep)
    async def create(body: CreateBody = Body(...)) -> dict[str, Any]:
        try:
            return vnotes.create_note(body.path, body.content)
        except Exception as exc:
            _map(exc)

    @router.post("/write", dependencies=dep)
    async def write(body: WriteBody = Body(...)) -> dict[str, Any]:
        try:
            return vnotes.write_note(body.path, body.content, expected_mtime=body.expected_mtime)
        except Exception as exc:
            _map(exc)

    return router
