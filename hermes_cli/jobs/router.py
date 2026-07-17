from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from hermes_cli.jobs.assets import AssetNotFoundError, JobAssetStore
from hermes_cli.jobs.models import JOB_STATUSES, JobStatus
from hermes_cli.jobs.repository import (
    InvalidTransitionError,
    JobNotFoundError,
    JobRepository,
)

Authorize = Callable[[Request], None]


class StatusUpdateRequest(BaseModel):
    status: JobStatus


def _paths() -> tuple[Path, Path]:
    search_root = Path.home() / "obsidian-vault" / "05 - Job Search"
    database = Path(
        os.environ.get(
            "HERMES_JOBS_DB_PATH", search_root / "Job Search Applications.sqlite3"
        )
    )
    packet_root = Path(
        os.environ.get("HERMES_JOBS_PACKET_ROOT", search_root / "Applications")
    )
    return database, packet_root


def _services() -> tuple[JobRepository, JobAssetStore]:
    database, packet_root = _paths()
    if not database.is_file() or not packet_root.is_dir():
        raise HTTPException(status_code=503, detail="Jobs data is not configured")
    repository = JobRepository(database)
    repository.migrate()
    return repository, JobAssetStore(database, packet_root)


def _require_same_origin(request: Request) -> None:
    if not getattr(request.app.state, "auth_required", False):
        return
    supplied = request.headers.get("origin") or request.headers.get("referer")
    if not supplied:
        raise HTTPException(status_code=403, detail="Same-origin request required")
    source = urlsplit(supplied)
    expected = urlsplit(str(request.base_url))
    if (source.scheme.lower(), source.netloc.lower()) != (
        expected.scheme.lower(),
        expected.netloc.lower(),
    ):
        raise HTTPException(status_code=403, detail="Same-origin request required")


def create_jobs_router(authorize: Authorize) -> APIRouter:
    router = APIRouter(prefix="/api/jobs", tags=["jobs"])

    @router.get("")
    def list_jobs(
        request: Request,
        status: str | None = None,
        lane: str | None = None,
        freshness: str | None = None,
        q: str | None = None,
    ) -> dict:
        authorize(request)
        repository, assets = _services()
        try:
            items = repository.list_jobs(
                status=status, lane=lane, freshness=freshness, query=q
            )
            all_items = repository.list_jobs()
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        for item in items:
            item["assets"] = assets.list_for_job(item["id"])
        return {
            "items": items,
            "total": len(items),
            "filters": {
                "statuses": list(JOB_STATUSES),
                "lanes": sorted({item["lane"] for item in all_items}),
                "freshness": ["active", "stale", "unknown"],
            },
        }

    @router.get("/summary")
    def get_summary(request: Request) -> dict:
        authorize(request)
        repository, _ = _services()
        return repository.summary()

    @router.patch("/{job_id}/status")
    def update_status(job_id: int, body: StatusUpdateRequest, request: Request) -> dict:
        authorize(request)
        _require_same_origin(request)
        repository, _ = _services()
        try:
            result = repository.transition_status(job_id, body.status)
        except JobNotFoundError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        except InvalidTransitionError:
            raise HTTPException(
                status_code=409, detail="Invalid status transition"
            ) from None
        label = body.status.replace("_", " ").title()
        return {**result, "announcement": f"Status updated to {label}."}

    @router.get("/{job_id}/assets/{asset_id}")
    def get_asset(
        job_id: int,
        asset_id: int,
        request: Request,
        disposition: Literal["inline", "attachment"] = Query("attachment"),
    ) -> FileResponse:
        authorize(request)
        _, assets = _services()
        try:
            path = assets.resolve(job_id, asset_id)
            media_type = assets.media_type(job_id, asset_id)
        except AssetNotFoundError:
            raise HTTPException(status_code=404, detail="Asset not found") from None
        headers = {
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        }
        if disposition == "inline":
            headers["Content-Security-Policy"] = (
                "default-src 'none'; style-src 'unsafe-inline'"
            )
        return FileResponse(
            path,
            media_type=media_type,
            headers=headers,
            filename=path.name,
            content_disposition_type=disposition,
        )

    return router
