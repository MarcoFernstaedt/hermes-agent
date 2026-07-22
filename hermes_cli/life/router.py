from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from hermes_cli.life.repository import LifeRepository
from hermes_constants import get_hermes_home

Authorize = Callable[[Request], None]


class HabitCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    category: str = Field(min_length=1, max_length=40)
    target: float = Field(default=1, gt=0, le=10000)
    unit: str = Field(default="check", min_length=1, max_length=30)


class HabitUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    category: str | None = Field(default=None, min_length=1, max_length=40)
    target: float | None = Field(default=None, gt=0, le=10000)
    unit: str | None = Field(default=None, min_length=1, max_length=30)
    active: bool | None = None


class EntryUpdate(BaseModel):
    day: str
    value: float = Field(ge=0, le=100000)
    note: str = Field(default="", max_length=300)


class ReflectionUpdate(BaseModel):
    wake_time: str = Field(default="", max_length=5)
    bedtime: str = Field(default="", max_length=5)
    energy: int | None = Field(default=None, ge=1, le=5)
    mood: str = Field(default="", max_length=40)
    win: str = Field(default="", max_length=500)
    obstacle: str = Field(default="", max_length=500)
    lesson: str = Field(default="", max_length=500)
    tomorrow: str = Field(default="", max_length=500)


def default_database_path() -> Path:
    return get_hermes_home() / "state" / "life-progress.sqlite3"


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


def create_life_router(
    authorize: Authorize,
    *,
    database_path: Path | str | None = None,
    initialize: bool = True,
) -> APIRouter:
    repository = LifeRepository(database_path or default_database_path())
    if initialize:
        repository.migrate()
    router = APIRouter(prefix="/api/life", tags=["life-progress"])

    @router.get("/today")
    def get_today(request: Request, day: str | None = None) -> dict:
        authorize(request)
        try:
            return repository.today(day=day)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None

    @router.get("/history")
    def get_history(
        request: Request,
        end_day: str | None = None,
        days: int = Query(default=14, ge=1, le=90),
    ) -> dict:
        authorize(request)
        try:
            return {"items": repository.history(end_day=end_day, days=days)}
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None

    @router.post("/habits")
    def create_habit(body: HabitCreate, request: Request) -> dict:
        authorize(request)
        _require_same_origin(request)
        try:
            return repository.create_habit(**body.model_dump())
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None

    @router.patch("/habits/{habit_id}")
    def update_habit(habit_id: int, body: HabitUpdate, request: Request) -> dict:
        authorize(request)
        _require_same_origin(request)
        try:
            return repository.update_habit(
                habit_id,
                **body.model_dump(exclude_none=True),
            )
        except LookupError:
            raise HTTPException(status_code=404, detail="Habit not found") from None
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None

    @router.put("/entries/{habit_id}")
    def set_entry(habit_id: int, body: EntryUpdate, request: Request) -> dict:
        authorize(request)
        _require_same_origin(request)
        try:
            repository.set_entry(habit_id, **body.model_dump())
            return repository.today(day=body.day)
        except LookupError:
            raise HTTPException(status_code=404, detail="Habit not found") from None
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None

    @router.put("/reflections/{day}")
    def set_reflection(day: str, body: ReflectionUpdate, request: Request) -> dict:
        authorize(request)
        _require_same_origin(request)
        try:
            repository.set_reflection(day=day, **body.model_dump())
            return repository.today(day=day)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None

    return router
