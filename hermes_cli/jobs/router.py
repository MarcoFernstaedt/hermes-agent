from __future__ import annotations

import os
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Literal, Never
from urllib.parse import quote, urlsplit

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from hermes_cli.jobs.assets import AssetNotFoundError, JobAssetStore
from hermes_cli.jobs.models import JOB_STATUSES, JobStatus
from hermes_cli.jobs.repository import (
    InvalidTransitionError,
    JobNotFoundError,
    JobRepository,
    StaleJobError,
)

Authorize = Callable[[Request], None]


class StatusUpdateRequest(BaseModel):
    status: JobStatus
    expected_status: JobStatus
    expected_updated_at: str


def _raise_availability(exc: sqlite3.OperationalError) -> Never:
    code = getattr(exc, "sqlite_errorcode", None)
    if code is not None and code & 0xFF in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
        raise HTTPException(
            status_code=503, detail="Jobs data is temporarily unavailable"
        ) from None
    raise exc


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
    return repository, JobAssetStore(database, packet_root)


def initialize_jobs() -> None:
    database, packet_root = _paths()
    if database.is_file() and packet_root.is_dir():
        JobRepository(database).migrate()


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


def create_jobs_router(authorize: Authorize, *, initialize: bool = True) -> APIRouter:
    if initialize:
        initialize_jobs()
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
            for item in items:
                item["assets"] = assets.list_for_job(item["id"])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        except sqlite3.OperationalError as exc:
            _raise_availability(exc)
        source_statuses = sorted(
            {item["status"] for item in all_items}.difference(JOB_STATUSES)
        )
        return {
            "items": items,
            "total": len(items),
            "filters": {
                "statuses": [*JOB_STATUSES, *source_statuses],
                "lanes": sorted({item["lane"] for item in all_items}),
                "freshness": ["active", "stale", "unknown"],
            },
        }

    @router.get("/summary")
    def get_summary(request: Request) -> dict:
        authorize(request)
        repository, _ = _services()
        try:
            return repository.summary()
        except sqlite3.OperationalError as exc:
            _raise_availability(exc)

    @router.get("/{job_id}/history")
    def get_history(job_id: int, request: Request) -> dict:
        authorize(request)
        repository, _ = _services()
        try:
            events = repository.status_history(job_id)
        except JobNotFoundError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        except sqlite3.OperationalError as exc:
            _raise_availability(exc)
        return {"events": events}

    @router.patch("/{job_id}/status", response_model=None)
    def update_status(
        job_id: int, body: StatusUpdateRequest, request: Request
    ) -> dict | JSONResponse:
        authorize(request)
        _require_same_origin(request)
        repository, _ = _services()
        try:
            result = repository.transition_status(
                job_id,
                body.status,
                expected_status=body.expected_status,
                expected_updated_at=body.expected_updated_at,
            )
        except JobNotFoundError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        except StaleJobError as exc:
            return JSONResponse(
                status_code=409,
                content={"detail": "Job status changed", "current": exc.current},
            )
        except InvalidTransitionError:
            raise HTTPException(
                status_code=409, detail="Invalid status transition"
            ) from None
        except sqlite3.OperationalError as exc:
            _raise_availability(exc)
        label = body.status.replace("_", " ").title()
        return {**result, "announcement": f"Status updated to {label}."}

    @router.get("/{job_id}/assets/{asset_id}")
    def get_asset(
        job_id: int,
        asset_id: int,
        request: Request,
        disposition: Literal["inline", "attachment"] = Query("attachment"),
    ) -> StreamingResponse:
        authorize(request)
        _, assets = _services()
        try:
            asset = assets.open_asset(job_id, asset_id)
        except AssetNotFoundError:
            raise HTTPException(status_code=404, detail="Asset not found") from None
        except sqlite3.OperationalError as exc:
            _raise_availability(exc)
        quoted_name = quote(asset.name)
        headers = {
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Length": str(asset.size),
            "Content-Disposition": (
                f'{disposition}; filename="{asset.name}"'
                if quoted_name == asset.name
                else f"{disposition}; filename*=utf-8''{quoted_name}"
            ),
        }
        if disposition == "inline":
            headers["Content-Security-Policy"] = (
                "default-src 'none'; style-src 'unsafe-inline'"
            )
        return StreamingResponse(
            asset.file,
            media_type=asset.media_type,
            headers=headers,
            background=BackgroundTask(asset.file.close),
        )

    return router
