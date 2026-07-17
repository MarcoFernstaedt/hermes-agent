"""Native Command Center media API.

The router reuses Hermes' Spotify PKCE client and exposes owned audiobooks by
opaque chapter ID. Provider credentials and raw filesystem paths never cross
the dashboard API boundary.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import tempfile
from contextlib import contextmanager
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol, cast

from fastapi import APIRouter, HTTPException, Query, Request
from hermes_constants import (
    get_default_hermes_root,
    get_hermes_home,
    reset_hermes_home_override,
    set_hermes_home_override,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

_AUDIO_EXTENSIONS = frozenset({".mp3", ".m4a", ".m4b", ".aac", ".flac", ".ogg", ".wav"})
_DEFAULT_AUDIOBOOK_ROOT = Path("~/audiobooks/Your First 100 Million").expanduser()
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
_NATURAL_PART_RE = re.compile(r"(\d+)")
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


@dataclass(frozen=True)
class MediaSettings:
    audiobook_root: Path = _DEFAULT_AUDIOBOOK_ROOT
    runtime_root: Path | None = None

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
    progress: "AudiobookProgress | None" = None


class AudiobookProgress(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chapter_id: str = Field(pattern=r"^[a-f0-9]{24}$")
    position_seconds: float = Field(ge=0, le=31_536_000)
    duration_seconds: float = Field(gt=0, le=31_536_000)
    playback_rate: float = Field(ge=0.5, le=3.0)

    @model_validator(mode="after")
    def clamp_position(self) -> "AudiobookProgress":
        if self.position_seconds > self.duration_seconds:
            raise ValueError("Position cannot exceed duration")
        return self


class SpotifyState(BaseModel):
    provider: Literal["spotify"] = "spotify"
    status: Literal["ready", "needs_auth", "needs_device", "degraded"]
    message: str
    playback: dict[str, Any] | None = None
    capabilities: dict[str, bool] = Field(default_factory=dict)
    devices: list[dict[str, Any]] = Field(default_factory=list)
    queue: list[dict[str, Any]] = Field(default_factory=list)


class SpotifySearchResults(BaseModel):
    provider: Literal["spotify"] = "spotify"
    query: str
    items: list[dict[str, Any]]


class SpotifyControl(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal[
        "play", "pause", "previous", "next", "seek", "volume",
        "transfer", "queue", "play_uri",
    ]
    device_id: str | None = Field(default=None, min_length=1, max_length=128)
    position_ms: int | None = Field(default=None, ge=0, le=86_400_000)
    volume_percent: int | None = Field(default=None, ge=0, le=100)
    uri: str | None = Field(default=None, pattern=r"^spotify:track:[A-Za-z0-9]+$")
    play: bool = False

    @model_validator(mode="after")
    def validate_action_fields(self) -> "SpotifyControl":
        required = {
            "seek": self.position_ms,
            "volume": self.volume_percent,
            "transfer": self.device_id,
            "queue": self.uri,
            "play_uri": self.uri,
        }
        if self.action in required and required[self.action] is None:
            raise ValueError(f"{self.action} requires its command value")
        allowed = {
            "play": {"action", "device_id"},
            "pause": {"action", "device_id"},
            "previous": {"action", "device_id"},
            "next": {"action", "device_id"},
            "seek": {"action", "device_id", "position_ms"},
            "volume": {"action", "device_id", "volume_percent"},
            "transfer": {"action", "device_id", "play"},
            "queue": {"action", "device_id", "uri"},
            "play_uri": {"action", "device_id", "uri"},
        }[self.action]
        if self.model_fields_set - allowed:
            raise ValueError(f"{self.action} received incompatible command fields")
        return self


class SpotifyClientProtocol(Protocol):
    def get_playback_state(self, *, market: str | None = None) -> Any: ...
    def start_playback(self, *, device_id: str | None = None, **kwargs: Any) -> Any: ...
    def pause_playback(self, *, device_id: str | None = None) -> Any: ...
    def skip_previous(self, *, device_id: str | None = None) -> Any: ...
    def skip_next(self, *, device_id: str | None = None) -> Any: ...
    def get_devices(self) -> Any: ...
    def get_queue(self) -> Any: ...
    def search(self, **kwargs: Any) -> Any: ...
    def seek(self, *, position_ms: int, device_id: str | None = None) -> Any: ...
    def set_volume(self, *, volume_percent: int, device_id: str | None = None) -> Any: ...
    def transfer_playback(self, *, device_id: str, play: bool = False) -> Any: ...
    def add_to_queue(self, *, uri: str, device_id: str | None = None) -> Any: ...


def _default_spotify_client() -> SpotifyClientProtocol:
    from plugins.spotify.client import SpotifyClient

    return cast(SpotifyClientProtocol, SpotifyClient())



def _runtime_root(settings: MediaSettings) -> Path:
    return settings.runtime_root or (get_hermes_home() / "state" / "media")

def _current_profile_key() -> str:
    home = get_hermes_home().resolve()
    root = get_default_hermes_root().resolve()
    if home == root:
        return "default"
    try:
        rel = home.relative_to(root / "profiles")
    except ValueError:
        return hashlib.sha256(str(home).encode("utf-8")).hexdigest()[:24]
    return rel.parts[0] if rel.parts else "default"

def _validate_profile(profile: str | None) -> str | None:
    if profile is None or not profile.strip():
        return None
    value = profile.strip()
    if not _PROFILE_RE.fullmatch(value):
        raise HTTPException(status_code=422, detail="Invalid profile")
    return value

def _profile_home(profile: str | None) -> Path:
    selected = _validate_profile(profile)
    if selected is None:
        return get_hermes_home()
    root = get_default_hermes_root()
    return root if selected == "default" else root / "profiles" / selected

def _profile_storage_key(profile: str | None) -> str:
    selected = _validate_profile(profile)
    return selected if selected is not None else _current_profile_key()

@contextmanager
def _spotify_profile_scope(profile: str | None):
    token = set_hermes_home_override(_profile_home(profile))
    try:
        yield
    finally:
        reset_hermes_home_override(token)

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


def _progress_path(runtime_root: Path, profile: str) -> Path:
    profile_key = hashlib.sha256(profile.encode("utf-8")).hexdigest()[:24]
    return runtime_root.expanduser() / f"audiobook-progress-{profile_key}.json"


def _load_progress(runtime_root: Path, profile: str) -> AudiobookProgress | None:
    path = _progress_path(runtime_root, profile)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return AudiobookProgress.model_validate(payload)
    except (FileNotFoundError, OSError, ValueError, TypeError):
        return None


def _save_progress(runtime_root: Path, profile: str, progress: AudiobookProgress) -> None:
    root = runtime_root.expanduser()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    path = _progress_path(root, profile)
    lock_path = path.with_suffix(path.suffix + ".lock")
    payload = progress.model_dump_json()
    with lock_path.open("a+b") as lock_handle:
        if os.name != "nt":
            import fcntl
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            fd, tmp_name = tempfile.mkstemp(
                prefix=path.name + ".",
                suffix=".tmp",
                dir=root,
                text=True,
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.chmod(tmp_name, 0o600)
                os.replace(tmp_name, path)
                dir_fd = os.open(root, os.O_RDONLY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            finally:
                try:
                    os.unlink(tmp_name)
                except FileNotFoundError:
                    pass
        finally:
            if os.name != "nt":
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


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


def _normalized_track(item: Any, *, search_result: bool = False) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    artists = item.get("artists") if isinstance(item.get("artists"), list) else []
    normalized: dict[str, Any] = {
        "name": item.get("name"),
        "uri": item.get("uri"),
        "duration_ms": item.get("duration_ms"),
        "artists": [
            artist.get("name")
            for artist in artists
            if isinstance(artist, dict) and artist.get("name")
        ],
    }
    if search_result:
        album = item.get("album") if isinstance(item.get("album"), dict) else {}
        images = album.get("images") if isinstance(album.get("images"), list) else []
        first_image = images[0] if images and isinstance(images[0], dict) else {}
        normalized["album"] = album.get("name")
        normalized["image_url"] = first_image.get("url")
    return normalized


def _normalized_devices(payload: Any) -> list[dict[str, Any]]:
    devices = payload.get("devices") if isinstance(payload, dict) else None
    if not isinstance(devices, list):
        return []
    return [
        {
            "id": device.get("id"),
            "name": device.get("name"),
            "type": device.get("type"),
            "is_active": bool(device.get("is_active")),
            "is_restricted": bool(device.get("is_restricted")),
            "volume_percent": device.get("volume_percent"),
        }
        for device in devices
        if isinstance(device, dict) and device.get("id")
    ]


_SPOTIFY_CAPABILITIES = {
    "playback": True,
    "search": True,
    "queue": True,
    "devices": True,
    "transfer": True,
    "seek": True,
    "volume": True,
}


def _spotify_state(client: SpotifyClientProtocol) -> SpotifyState:
    try:
        devices = _normalized_devices(client.get_devices())
    except Exception:
        devices = []
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
            capabilities=_SPOTIFY_CAPABILITIES,
            devices=devices,
        )
    if not isinstance(payload, dict):
        return SpotifyState(status="degraded", message="Spotify returned an invalid response.")
    try:
        queue_payload = client.get_queue()
        raw_queue = queue_payload.get("queue") if isinstance(queue_payload, dict) else []
        queue = [track for item in raw_queue if (track := _normalized_track(item))]
    except Exception:
        queue = []
    return SpotifyState(
        status="ready",
        message="Spotify playback is ready.",
        playback=_normalized_playback(payload),
        capabilities=_SPOTIFY_CAPABILITIES,
        devices=devices,
        queue=queue,
    )


def create_media_router(
    settings: MediaSettings | None = None,
    *,
    spotify_client_factory: Callable[[], SpotifyClientProtocol] = _default_spotify_client,
) -> APIRouter:
    configured = settings or MediaSettings.from_environment()
    router = APIRouter(prefix="/api/media", tags=["media"])

    @router.get("/spotify/state", response_model=SpotifyState)
    async def spotify_state(profile: str | None = Query(default=None)) -> SpotifyState:
        try:
            with _spotify_profile_scope(profile):
                client = spotify_client_factory()
                return _spotify_state(client)
        except Exception as exc:
            if type(exc).__name__ == "SpotifyAuthRequiredError":
                return SpotifyState(
                    status="needs_auth",
                    message="Connect Spotify to use playback controls.",
                )
            return SpotifyState(
                status="degraded",
                message="Spotify is temporarily unavailable.",
            )

    @router.post("/spotify/control", response_model=SpotifyState)
    async def spotify_control(command: SpotifyControl, profile: str | None = Query(default=None)) -> SpotifyState:
        try:
            with _spotify_profile_scope(profile):
                client = spotify_client_factory()
                if command.action == "play":
                    client.start_playback(device_id=command.device_id)
                elif command.action == "pause":
                    client.pause_playback(device_id=command.device_id)
                elif command.action == "previous":
                    client.skip_previous(device_id=command.device_id)
                elif command.action == "next":
                    client.skip_next(device_id=command.device_id)
                elif command.action == "seek":
                    assert command.position_ms is not None
                    client.seek(position_ms=command.position_ms, device_id=command.device_id)
                elif command.action == "volume":
                    assert command.volume_percent is not None
                    client.set_volume(
                        volume_percent=command.volume_percent,
                        device_id=command.device_id,
                    )
                elif command.action == "transfer":
                    assert command.device_id is not None
                    client.transfer_playback(device_id=command.device_id, play=command.play)
                elif command.action == "queue":
                    assert command.uri is not None
                    client.add_to_queue(uri=command.uri, device_id=command.device_id)
                else:
                    assert command.uri is not None
                    client.start_playback(device_id=command.device_id, uris=[command.uri])
                return _spotify_state(client)
        except Exception as exc:
            if type(exc).__name__ == "SpotifyAuthRequiredError":
                return SpotifyState(status="needs_auth", message="Connect Spotify to use playback controls.")
            return SpotifyState(status="degraded", message="Spotify control failed safely.")

    @router.get("/spotify/search", response_model=SpotifySearchResults)
    async def spotify_search(
        q: str = Query(min_length=1, max_length=120),
        limit: int = Query(default=10, ge=1, le=50),
        profile: str | None = Query(default=None),
    ) -> SpotifySearchResults:
        query = q.strip()
        if not query:
            raise HTTPException(status_code=422, detail="Search query is required")
        try:
            with _spotify_profile_scope(profile):
                client = spotify_client_factory()
                payload = client.search(
                    query=query,
                    search_types=["track"],
                    limit=min(limit, 20),
                    offset=0,
                    market="US",
                )
        except Exception as exc:
            if type(exc).__name__ == "SpotifyAuthRequiredError":
                raise HTTPException(status_code=401, detail="Spotify connection required") from exc
            raise HTTPException(
                status_code=503,
                detail="Spotify search is temporarily unavailable",
            ) from exc
        tracks = payload.get("tracks") if isinstance(payload, dict) else {}
        raw_items = tracks.get("items") if isinstance(tracks, dict) else []
        if not isinstance(raw_items, list):
            raw_items = []
        items = [
            track
            for item in raw_items
            if (track := _normalized_track(item, search_result=True))
        ]
        return SpotifySearchResults(query=query, items=items)

    @router.get("/audiobooks", response_model=AudiobookIndex)
    async def audiobook_index(
        profile: str | None = Query(default=None),
    ) -> AudiobookIndex:
        try:
            chapters = list_audiobook_chapters(configured.audiobook_root)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        progress = _load_progress(_runtime_root(configured), _profile_storage_key(profile))
        if progress is not None and not any(
            chapter.id == progress.chapter_id for chapter in chapters
        ):
            progress = None
        return AudiobookIndex(
            book="Your First Hundred Million",
            chapters=chapters,
            progress=progress,
        )

    @router.post("/audiobooks/progress", response_model=AudiobookProgress)
    async def audiobook_progress(
        progress: AudiobookProgress,
        profile: str | None = Query(default=None),
    ) -> AudiobookProgress:
        profile_key = _profile_storage_key(profile)
        try:
            _resolve_chapter(configured.audiobook_root, progress.chapter_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Chapter not found") from exc
        try:
            _save_progress(_runtime_root(configured), profile_key, progress)
        except OSError as exc:
            raise HTTPException(
                status_code=503,
                detail="Audiobook progress could not be saved",
            ) from exc
        return progress

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
