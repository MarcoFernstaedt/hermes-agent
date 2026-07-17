from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli.dashboard.media import (
    MediaSettings,
    create_media_router,
    list_audiobook_chapters,
    parse_single_byte_range,
)


def _write_chapter(root: Path, name: str, content: bytes = b"0123456789") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    target = root / name
    target.write_bytes(content)
    return target


def test_audiobook_index_uses_natural_order_and_opaque_ids(tmp_path: Path):
    _write_chapter(tmp_path, "CHAPTER 10.mp3")
    _write_chapter(tmp_path, "CHAPTER 2.mp3")
    _write_chapter(tmp_path, "ignore.txt")

    chapters = list_audiobook_chapters(tmp_path)

    assert [chapter.title for chapter in chapters] == ["CHAPTER 2", "CHAPTER 10"]
    assert all("/" not in chapter.id for chapter in chapters)
    assert all(str(tmp_path) not in chapter.model_dump_json() for chapter in chapters)
    assert all(chapter.stream_url.endswith("/stream") for chapter in chapters)


@pytest.mark.parametrize(
    ("header", "size", "expected"),
    [
        ("bytes=0-9", 100, (0, 9)),
        ("bytes=10-", 100, (10, 99)),
        ("bytes=-10", 100, (90, 99)),
    ],
)
def test_parse_single_byte_range(header: str, size: int, expected: tuple[int, int]):
    assert parse_single_byte_range(header, size) == expected


@pytest.mark.parametrize(
    "header",
    ["bytes=100-101", "bytes=9-4", "items=0-1", "bytes=0-1,4-5"],
)
def test_parse_single_byte_range_rejects_invalid_or_unsatisfiable_ranges(header: str):
    with pytest.raises(ValueError):
        parse_single_byte_range(header, 10)


def test_audiobook_stream_supports_authenticated_style_range_requests(tmp_path: Path):
    _write_chapter(tmp_path, "CHAPTER 1.mp3")
    router = create_media_router(MediaSettings(audiobook_root=tmp_path))
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    index = client.get("/api/media/audiobooks")
    chapter_id = index.json()["chapters"][0]["id"]
    response = client.get(
        f"/api/media/audiobooks/{chapter_id}/stream",
        headers={"Range": "bytes=2-5"},
    )

    assert response.status_code == 206
    assert response.content == b"2345"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-range"] == "bytes 2-5/10"
    assert str(tmp_path) not in response.text


def test_spotify_state_normalizes_no_device_without_exposing_credentials(tmp_path: Path):
    class FakeSpotifyClient:
        access_token = "must-not-leak"

        def get_playback_state(self, *, market=None):
            return {"status_code": 204, "empty": True, "message": "No active device"}

    router = create_media_router(
        MediaSettings(audiobook_root=tmp_path),
        spotify_client_factory=FakeSpotifyClient,
    )
    app = FastAPI()
    app.include_router(router)
    response = TestClient(app).get("/api/media/spotify/state")

    assert response.status_code == 200
    assert response.json() == {
        "provider": "spotify",
        "status": "needs_device",
        "message": "No active device",
        "playback": None,
    }
    assert "must-not-leak" not in response.text


def test_spotify_control_rejects_unapproved_actions(tmp_path: Path):
    router = create_media_router(MediaSettings(audiobook_root=tmp_path))
    app = FastAPI()
    app.include_router(router)

    response = TestClient(app).post(
        "/api/media/spotify/control",
        json={"action": "delete_everything"},
    )

    assert response.status_code == 422


def test_query_token_auth_is_limited_to_opaque_audiobook_stream_paths():
    from hermes_cli.web_server import _query_token_path_allowed

    assert _query_token_path_allowed(
        "/api/media/audiobooks/0123456789abcdef01234567/stream"
    )
    assert not _query_token_path_allowed("/api/media/spotify/state")
    assert not _query_token_path_allowed("/api/media/audiobooks/../stream")
    assert not _query_token_path_allowed(
        "/api/media/audiobooks/0123456789abcdef01234567/stream/extra"
    )
