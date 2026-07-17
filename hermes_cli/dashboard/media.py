"""Native Command Center media API.

The router reuses Hermes' Spotify PKCE client and exposes owned audiobooks by
opaque chapter ID. Provider credentials and raw filesystem paths never cross
the dashboard API boundary.
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol, cast

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

_AUDIO_EXTENSIONS = frozenset({".mp3", ".m4a", ".m4b", ".aac", ".flac", ".ogg", ".wav"})
_DEFAULT_AUDIOBOOK_ROOT = Path("~/audiobooks/Your First 100 Million").expanduser()
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
_NATURAL_PART_RE = re.compile(r"(\d+)")


@dataclass(frozen=True)
class MediaSettings:
    audiobook_root: Path = _DEFAULT_AUDIOBOOK_ROOT

    @classmethod
    def from_environment(cls) -> "MediaSettings":
        raw = os.environ.get("HERMES_AUDIOBOOK_ROOT", "").strip()
        return cls(audiobook_root=Path(raw).expanduser() if raw else _DEFAULT_AUDIOBOOK_ROOT)


class AudiobookChapter(BaseModel):
    id: str
    title: str
    order: int = Field(ge=1)
    stream_url: str


class AudiobookIndex(BaseModel):
    book: str
    chapters: list[AudiobookChapter]


class SpotifyState(BaseModel):
    provider: Literal["spotify"] = "spotify"
    status: Literal["ready", "needs_auth", "needs_device", "degraded"]
    message: str
    playback: dict[str, Any] | None = None


class SpotifyControl(BaseModel):
    action: Literal["play", "pause", "previous", "next"]
    device_id: str | None = None


class SpotifyClientProtocol(Protocol):
    def get_playback_state(self, *, market: str | None = None) -> Any: ...
    def start_playback(self, *, device_id: str | None = None, **kwargs: Any) -> Any: ...
    def pause_playback(self, *, device_id: str | None = None) -> Any: ...
    def skip_previous(self, *, device_id: str | None = None) -> Any: ...
    def skip_next(self, *, device_id: str | None = None) -> Any: ...


def _default_spotify_client() -> SpotifyClientProtocol:
    from plugins.spotify.client import SpotifyClient

    return cast(SpotifyClientProtocol, SpotifyClient())


def _natural_key(value: str) -> tuple[tuple[int, int | str], ...]:
    parts: list[tuple[int, int | str]] = []
    for part in _NATURAL_PART_RE.split(value.casefold()):
        if not part:
            continue
        parts.append((0, int(part)) if part.isdigit() else (1, part))
    return tuple(parts)


def _chapter_id(relative_path: str) -> str:
    return hashlib.sha256(relative_path.encode("utf-8")).hexdigest()[:24]


def _safe_root(root: Path) -> Path:
    try:
        return root.expanduser().resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise FileNotFoundError("Audiobook library is unavailable") from exc


def _indexed_chapter_paths(root: Path) -> list[tuple[str, Path]]:
    resolved_root = _safe_root(root)
    indexed: list[tuple[str, Path]] = []
    for candidate in resolved_root.rglob("*"):
        try:
            resolved = candidate.resolve(strict=True)
        except (FileNotFoundError, OSError, RuntimeError):
            continue
        if not resolved.is_file() or resolved.suffix.casefold() not in _AUDIO_EXTENSIONS:
            continue
        if resolved_root not in resolved.parents:
            continue
        relative = resolved.relative_to(resolved_root).as_posix()
        indexed.append((relative, resolved))
    indexed.sort(key=lambda item: _natural_key(item[0]))
    return indexed


def list_audiobook_chapters(root: Path) -> list[AudiobookChapter]:
    chapters: list[AudiobookChapter] = []
    for order, (relative, _path) in enumerate(_indexed_chapter_paths(root), start=1):
        chapters.append(
            AudiobookChapter(
                id=_chapter_id(relative),
                title=Path(relative).stem,
                order=order,
                stream_url=f"/api/media/audiobooks/{_chapter_id(relative)}/stream",
            )
        )
    return chapters


def _resolve_chapter(root: Path, chapter_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{24}", chapter_id):
        raise FileNotFoundError("Chapter not found")
    for relative, path in _indexed_chapter_paths(root):
        if _chapter_id(relative) == chapter_id:
            return path
    raise FileNotFoundError("Chapter not found")


def parse_single_byte_range(header: str, size: int) -> tuple[int, int]:
    if size <= 0:
        raise ValueError("Empty media file")
    match = _RANGE_RE.fullmatch(header.strip())
    if match is None:
        raise ValueError("Only one byte range is supported")
    start_text, end_text = match.groups()
    if not start_text and not end_text:
        raise ValueError("Invalid byte range")
    if start_text:
        start = int(start_text)
        end = int(end_text) if end_text else size - 1
        if start >= size or end < start:
            raise ValueError("Unsatisfiable byte range")
        return start, min(end, size - 1)
    suffix_length = int(end_text)
    if suffix_length <= 0:
        raise ValueError("Invalid suffix range")
    suffix_length = min(suffix_length, size)
    return size - suffix_length, size - 1


def _read_file_range(path: Path, start: int, end: int, chunk_size: int = 64 * 1024) -> Iterator[bytes]:
    remaining = end - start + 1
    with path.open("rb") as handle:
        handle.seek(start)
        while remaining:
            chunk = handle.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def _normalized_playback(payload: dict[str, Any]) -> dict[str, Any]:
    raw_item = payload.get("item")
    item: dict[str, Any] = raw_item if isinstance(raw_item, dict) else {}
    raw_artists = item.get("artists")
    artists: list[Any] = raw_artists if isinstance(raw_artists, list) else []
    raw_device = payload.get("device")
    device: dict[str, Any] = raw_device if isinstance(raw_device, dict) else {}
    return {
        "is_playing": bool(payload.get("is_playing")),
        "progress_ms": payload.get("progress_ms"),
        "item": {
            "name": item.get("name"),
            "uri": item.get("uri"),
            "duration_ms": item.get("duration_ms"),
            "artists": [artist.get("name") for artist in artists if isinstance(artist, dict) and artist.get("name")],
        }
        if item
        else None,
        "device": {
            "id": device.get("id"),
            "name": device.get("name"),
            "volume_percent": device.get("volume_percent"),
        }
        if device
        else None,
    }


def _spotify_state(client: SpotifyClientProtocol) -> SpotifyState:
    try:
        payload = client.get_playback_state(market="US")
    except Exception as exc:
        name = type(exc).__name__
        if name == "SpotifyAuthRequiredError":
            return SpotifyState(status="needs_auth", message="Connect Spotify to use playback controls.")
        return SpotifyState(status="degraded", message="Spotify is temporarily unavailable.")
    if isinstance(payload, dict) and payload.get("empty"):
        return SpotifyState(
            status="needs_device",
            message=str(payload.get("message") or "No active Spotify device."),
        )
    if not isinstance(payload, dict):
        return SpotifyState(status="degraded", message="Spotify returned an invalid response.")
    return SpotifyState(
        status="ready",
        message="Spotify playback is ready.",
        playback=_normalized_playback(payload),
    )


def create_media_router(
    settings: MediaSettings | None = None,
    *,
    spotify_client_factory: Callable[[], SpotifyClientProtocol] = _default_spotify_client,
) -> APIRouter:
    configured = settings or MediaSettings.from_environment()
    router = APIRouter(prefix="/api/media", tags=["media"])

    @router.get("/spotify/state", response_model=SpotifyState)
    async def spotify_state() -> SpotifyState:
        return _spotify_state(spotify_client_factory())

    @router.post("/spotify/control", response_model=SpotifyState)
    async def spotify_control(command: SpotifyControl) -> SpotifyState:
        client = spotify_client_factory()
        try:
            if command.action == "play":
                client.start_playback(device_id=command.device_id)
            elif command.action == "pause":
                client.pause_playback(device_id=command.device_id)
            elif command.action == "previous":
                client.skip_previous(device_id=command.device_id)
            else:
                client.skip_next(device_id=command.device_id)
        except Exception as exc:
            if type(exc).__name__ == "SpotifyAuthRequiredError":
                return SpotifyState(status="needs_auth", message="Connect Spotify to use playback controls.")
            return SpotifyState(status="degraded", message="Spotify control failed safely.")
        return _spotify_state(client)

    @router.get("/audiobooks", response_model=AudiobookIndex)
    async def audiobook_index() -> AudiobookIndex:
        try:
            chapters = list_audiobook_chapters(configured.audiobook_root)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return AudiobookIndex(book="Your First Hundred Million", chapters=chapters)

    @router.get("/audiobooks/{chapter_id}/stream")
    async def audiobook_stream(chapter_id: str, request: Request) -> StreamingResponse:
        try:
            path = _resolve_chapter(configured.audiobook_root, chapter_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Chapter not found") from exc
        size = path.stat().st_size
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        range_header = request.headers.get("range")
        if not range_header:
            start, end, status_code = 0, size - 1, 200
        else:
            try:
                start, end = parse_single_byte_range(range_header, size)
            except ValueError as exc:
                raise HTTPException(
                    status_code=416,
                    detail=str(exc),
                    headers={"Content-Range": f"bytes */{size}"},
                ) from exc
            status_code = 206
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(end - start + 1),
            "Content-Disposition": "inline",
        }
        if status_code == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return StreamingResponse(
            _read_file_range(path, start, end),
            status_code=status_code,
            media_type=content_type,
            headers=headers,
        )

    return router


router = create_media_router()
