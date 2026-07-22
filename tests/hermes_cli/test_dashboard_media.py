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


def test_audiobook_stream_supports_full_response_and_sanitized_416(tmp_path: Path):
    _write_chapter(tmp_path, "CHAPTER 1.mp3")
    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state")
    ))
    client = TestClient(app)
    chapter_id = client.get("/api/media/audiobooks").json()["chapters"][0]["id"]

    full = client.get(f"/api/media/audiobooks/{chapter_id}/stream")
    invalid = client.get(
        f"/api/media/audiobooks/{chapter_id}/stream",
        headers={"Range": "bytes=20-30"},
    )

    assert full.status_code == 200
    assert full.content == b"0123456789"
    assert full.headers["content-length"] == "10"
    assert invalid.status_code == 416
    assert invalid.headers["content-range"] == "bytes */10"
    assert str(tmp_path) not in invalid.text


def test_audiobook_progress_persists_per_profile_without_paths(tmp_path: Path):
    _write_chapter(tmp_path, "CHAPTER 1.mp3")
    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state")
    ))
    client = TestClient(app)
    chapter_id = client.get("/api/media/audiobooks", params={"profile": "reader-profile"}).json()["chapters"][0]["id"]

    saved = client.post(
        "/api/media/audiobooks/progress",
        params={"profile": "reader-profile"},
        json={
            "chapter_id": chapter_id,
            "position_seconds": 37.5,
            "duration_seconds": 120.0,
            "playback_rate": 1.25,
        },
    )

    assert saved.status_code == 200
    assert saved.json()["chapter_id"] == chapter_id
    index_a = client.get("/api/media/audiobooks", params={"profile": "reader-profile"})
    index_b = client.get("/api/media/audiobooks", params={"profile": "reader-b"})
    assert index_a.json()["progress"] == saved.json()
    assert index_b.json()["progress"] is None
    persisted = "".join(path.read_text() for path in (tmp_path / "state").glob("*.json"))
    assert str(tmp_path) not in persisted
    assert "reader-profile" not in persisted



def test_audiobook_progress_write_is_atomic_private_and_leaves_no_temp_files(tmp_path: Path):
    _write_chapter(tmp_path, "CHAPTER 1.mp3")
    state_root = tmp_path / "state"
    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=state_root)
    ))
    client = TestClient(app)
    chapter_id = client.get("/api/media/audiobooks", params={"profile": "reader"}).json()["chapters"][0]["id"]

    response = client.post(
        "/api/media/audiobooks/progress",
        params={"profile": "reader"},
        json={
            "chapter_id": chapter_id,
            "position_seconds": 8,
            "duration_seconds": 80,
            "playback_rate": 1.5,
        },
    )

    assert response.status_code == 200
    assert oct(state_root.stat().st_mode & 0o777) == "0o700"
    progress_files = list(state_root.glob("audiobook-progress-*.json"))
    assert len(progress_files) == 1
    assert oct(progress_files[0].stat().st_mode & 0o777) == "0o600"
    assert list(state_root.glob("*.tmp")) == []
    assert list(state_root.glob("audiobook-progress-*.json.*.tmp")) == []

def test_audiobook_progress_rejects_unknown_chapter_and_unsafe_profile(tmp_path: Path):
    _write_chapter(tmp_path, "CHAPTER 1.mp3")
    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state")
    ))
    client = TestClient(app)
    payload = {
        "chapter_id": "0" * 24,
        "position_seconds": 1,
        "duration_seconds": 2,
        "playback_rate": 1,
    }

    assert client.post(
        "/api/media/audiobooks/progress", params={"profile": "reader"}, json=payload
    ).status_code == 404
    assert client.post(
        "/api/media/audiobooks/progress", params={"profile": "../../escape"}, json=payload
    ).status_code == 422
    assert client.post(
        "/api/media/audiobooks/progress", params={"profile": ".."}, json=payload
    ).status_code == 422
    assert client.post(
        "/api/media/audiobooks/progress", params={"profile": "reader.profile"}, json=payload
    ).status_code == 422


def test_spotify_state_normalizes_no_device_without_exposing_credentials(tmp_path: Path):
    class FakeSpotifyClient:
        sensitive_runtime = "must-not-leak"

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
        "capabilities": {
            "playback": True,
            "search": True,
            "queue": True,
            "devices": True,
            "transfer": True,
            "seek": True,
            "volume": True,
            "shuffle": True,
            "repeat": True,
            "context": True,
            "recently_played": True,
            "playlists": True,
        },
        "devices": [],
        "queue": [],
    }
    assert "must-not-leak" not in response.text



def test_spotify_routes_resolve_selected_profile_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.config import get_hermes_home

    default_home = tmp_path / "default-home"
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    observed: list[Path] = []

    class FakeSpotifyClient:
        def __init__(self):
            observed.append(get_hermes_home())

        def get_devices(self):
            observed.append(get_hermes_home())
            return {"devices": []}

        def get_playback_state(self, *, market=None):
            observed.append(get_hermes_home())
            return {"empty": True, "message": "No active device"}

    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state"),
        spotify_client_factory=FakeSpotifyClient,
    ))

    response = TestClient(app).get(
        "/api/media/spotify/state",
        params={"profile": "worker"},
    )

    assert response.status_code == 200
    assert observed
    assert set(observed) == {default_home / "profiles" / "worker"}
    assert get_hermes_home() == default_home

def test_spotify_factory_auth_failures_are_sanitized_for_all_routes(tmp_path: Path):
    class SpotifyAuthRequiredError(Exception):
        pass

    def unavailable_client():
        raise SpotifyAuthRequiredError("credential-material-must-not-leak")

    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state"),
        spotify_client_factory=unavailable_client,
    ))
    client = TestClient(app)

    state = client.get("/api/media/spotify/state")
    control = client.post("/api/media/spotify/control", json={"action": "pause"})
    search = client.get("/api/media/spotify/search", params={"q": "focus"})

    assert state.status_code == 200
    assert state.json()["status"] == "needs_auth"
    assert control.status_code == 200
    assert control.json()["status"] == "needs_auth"
    assert search.status_code == 401
    assert "credential-material-must-not-leak" not in (
        state.text + control.text + search.text
    )


def test_spotify_control_rejects_unapproved_actions(tmp_path: Path):
    router = create_media_router(MediaSettings(audiobook_root=tmp_path))
    app = FastAPI()
    app.include_router(router)

    response = TestClient(app).post(
        "/api/media/spotify/control",
        json={"action": "delete_everything"},
    )

    assert response.status_code == 422


def test_spotify_state_normalizes_devices_queue_and_capabilities(tmp_path: Path):
    class FakeSpotifyClient:
        sensitive_runtime = "must-not-leak"

        def get_playback_state(self, *, market=None):
            return {
                "is_playing": True,
                "progress_ms": 1200,
                "item": {
                    "name": "Safe track",
                    "uri": "spotify:track:opaque",
                    "duration_ms": 240000,
                    "artists": [{"name": "Safe artist", "href": "private"}],
                    "external_urls": {"spotify": "https://upstream.invalid"},
                },
                "device": {"id": "device-1", "name": "Office", "volume_percent": 35},
                "raw_secret": "must-not-leak",
            }

        def get_devices(self):
            return {"devices": [{
                "id": "device-1", "name": "Office", "type": "Computer",
                "is_active": True, "is_restricted": False, "volume_percent": 35,
                "private": "must-not-leak",
            }]}

        def get_queue(self):
            return {"queue": [{
                "name": "Queued track", "uri": "spotify:track:queued",
                "duration_ms": 180000, "artists": [{"name": "Queue artist"}],
            }]}

    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state"),
        spotify_client_factory=FakeSpotifyClient,
    ))

    response = TestClient(app).get("/api/media/spotify/state")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ready"
    assert payload["capabilities"] == {
        "playback": True, "search": True, "queue": True, "devices": True,
        "transfer": True, "seek": True, "volume": True,
        "shuffle": True, "repeat": True, "context": True,
        "recently_played": True, "playlists": True,
    }
    assert payload["playback"]["shuffle_state"] is False
    assert payload["playback"]["repeat_state"] == "off"
    assert payload["devices"] == [{
        "id": "device-1", "name": "Office", "type": "Computer",
        "is_active": True, "is_restricted": False, "volume_percent": 35,
    }]
    assert payload["queue"][0]["name"] == "Queued track"
    assert "must-not-leak" not in response.text
    assert "external_urls" not in response.text


def test_spotify_search_is_allowlisted_normalized_and_bounded(tmp_path: Path):
    calls = []

    class FakeSpotifyClient:
        def search(self, **kwargs):
            calls.append(kwargs)
            return {"tracks": {"items": [{
                "name": "Result", "uri": "spotify:track:result", "duration_ms": 123,
                "artists": [{"name": "Artist"}],
                "album": {"name": "Album", "images": [{"url": "https://image.invalid"}]},
                "raw": "must-not-leak",
            }]}}

    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state"),
        spotify_client_factory=FakeSpotifyClient,
    ))
    client = TestClient(app)

    response = client.get("/api/media/spotify/search", params={"q": "focus", "limit": 50})

    assert response.status_code == 200
    assert calls == [{
        "query": "focus", "search_types": ["track"], "limit": 20,
        "offset": 0, "market": "US",
    }]
    assert response.json() == {
        "provider": "spotify", "query": "focus",
        "items": [{
            "type": "track",
            "name": "Result", "uri": "spotify:track:result", "duration_ms": 123,
            "artists": ["Artist"], "album": "Album",
            "image_url": "https://image.invalid",
        }],
    }
    assert "must-not-leak" not in response.text
    assert client.get("/api/media/spotify/search", params={"q": " "}).status_code == 422


@pytest.mark.parametrize(
    ("payload", "expected_call"),
    [
        ({"action": "seek", "position_ms": 42000, "device_id": "dev"}, ("seek", 42000, "dev")),
        ({"action": "volume", "volume_percent": 65, "device_id": "dev"}, ("volume", 65, "dev")),
        ({"action": "transfer", "device_id": "dev", "play": True}, ("transfer", "dev", True)),
        ({"action": "queue", "uri": "spotify:track:queued", "device_id": "dev"}, ("queue", "spotify:track:queued", "dev")),
        ({"action": "play_uri", "uri": "spotify:track:play", "device_id": "dev"}, ("play_uri", "spotify:track:play", "dev")),
    ],
)
def test_spotify_control_dispatches_only_typed_allowlisted_commands(
    tmp_path: Path,
    payload: dict,
    expected_call: tuple,
):
    calls = []

    class FakeSpotifyClient:
        def seek(self, *, position_ms, device_id=None):
            calls.append(("seek", position_ms, device_id))

        def set_volume(self, *, volume_percent, device_id=None):
            calls.append(("volume", volume_percent, device_id))

        def transfer_playback(self, *, device_id, play=False):
            calls.append(("transfer", device_id, play))

        def add_to_queue(self, *, uri, device_id=None):
            calls.append(("queue", uri, device_id))

        def start_playback(self, *, device_id=None, uris=None, **kwargs):
            calls.append(("play_uri", uris[0], device_id))

        def get_playback_state(self, *, market=None):
            return {"empty": True, "message": "No active device"}

    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state"),
        spotify_client_factory=FakeSpotifyClient,
    ))

    response = TestClient(app).post("/api/media/spotify/control", json=payload)

    assert response.status_code == 200
    assert calls == [expected_call]


@pytest.mark.parametrize(
    "payload",
    [
        {"action": "seek"},
        {"action": "volume", "volume_percent": 101},
        {"action": "transfer"},
        {"action": "queue", "uri": "https://attacker.invalid"},
        {"action": "play_uri", "uri": "spotify:playlist:not-allowed"},
        {"action": "pause", "uri": "spotify:track:not-used"},
        {"action": "play", "volume_percent": 50},
        {"action": "seek", "position_ms": 10, "play": True},
    ],
)
def test_spotify_control_rejects_missing_or_unsafe_command_fields(tmp_path: Path, payload: dict):
    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state")
    ))

    response = TestClient(app).post("/api/media/spotify/control", json=payload)

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("payload", "expected_call"),
    [
        ({"action": "shuffle", "shuffle_state": True}, ("shuffle", True, None)),
        ({"action": "repeat", "repeat_state": "track", "device_id": "dev"}, ("repeat", "track", "dev")),
        (
            {"action": "play_context", "context_uri": "spotify:album:abc123"},
            ("play_context", "spotify:album:abc123", None),
        ),
        (
            {"action": "play_context", "context_uri": "spotify:playlist:xyz789", "device_id": "dev"},
            ("play_context", "spotify:playlist:xyz789", "dev"),
        ),
    ],
)
def test_spotify_control_dispatches_shuffle_repeat_and_context(
    tmp_path: Path,
    payload: dict,
    expected_call: tuple,
):
    calls = []

    class FakeSpotifyClient:
        def set_shuffle(self, *, state, device_id=None):
            calls.append(("shuffle", state, device_id))

        def set_repeat(self, *, state, device_id=None):
            calls.append(("repeat", state, device_id))

        def start_playback(self, *, device_id=None, context_uri=None, **kwargs):
            calls.append(("play_context", context_uri, device_id))

        def get_playback_state(self, *, market=None):
            return {"empty": True, "message": "No active device"}

    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state"),
        spotify_client_factory=FakeSpotifyClient,
    ))

    response = TestClient(app).post("/api/media/spotify/control", json=payload)

    assert response.status_code == 200
    assert calls == [expected_call]


@pytest.mark.parametrize(
    "payload",
    [
        {"action": "shuffle"},
        {"action": "repeat", "repeat_state": "sideways"},
        {"action": "play_context", "context_uri": "spotify:track:abc"},
        {"action": "play_context", "context_uri": "https://attacker.invalid"},
        {"action": "shuffle", "shuffle_state": True, "repeat_state": "off"},
    ],
)
def test_spotify_control_rejects_bad_shuffle_repeat_context(tmp_path: Path, payload: dict):
    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state")
    ))
    response = TestClient(app).post("/api/media/spotify/control", json=payload)
    assert response.status_code == 422


def test_spotify_search_supports_multiple_types_and_normalizes_each(tmp_path: Path):
    calls = []

    class FakeSpotifyClient:
        def search(self, **kwargs):
            calls.append(kwargs)
            return {
                "tracks": {"items": [{
                    "name": "Song", "uri": "spotify:track:t1", "duration_ms": 1000,
                    "artists": [{"name": "Band"}],
                    "album": {"name": "LP", "images": [{"url": "https://img/t.jpg"}]},
                }]},
                "albums": {"items": [{
                    "name": "Great Album", "uri": "spotify:album:a1",
                    "artists": [{"name": "Band"}],
                    "images": [{"url": "https://img/a.jpg"}],
                }]},
                "artists": {"items": [{
                    "name": "Band", "uri": "spotify:artist:ar1",
                    "followers": {"total": 12345},
                    "images": [{"url": "https://img/ar.jpg"}],
                }]},
                "playlists": {"items": [{
                    "name": "Focus", "uri": "spotify:playlist:p1",
                    "owner": {"display_name": "DJ"}, "tracks": {"total": 42},
                    "images": [{"url": "https://img/p.jpg"}],
                }]},
            }

    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state"),
        spotify_client_factory=FakeSpotifyClient,
    ))
    response = TestClient(app).get(
        "/api/media/spotify/search",
        params={"q": "focus", "types": "track,album,artist,playlist,evil"},
    )

    assert response.status_code == 200
    # The unknown "evil" kind is dropped before hitting Spotify.
    assert calls[0]["search_types"] == ["track", "album", "artist", "playlist"]
    items = response.json()["items"]
    kinds = [item["type"] for item in items]
    assert kinds == ["track", "album", "artist", "playlist"]
    by_type = {item["type"]: item for item in items}
    assert by_type["album"]["subtitle"] == "Band"
    assert by_type["artist"]["subtitle"] == "12,345 followers"
    assert by_type["playlist"]["subtitle"] == "42 tracks · DJ"
    assert by_type["playlist"]["uri"] == "spotify:playlist:p1"


def test_spotify_recently_played_dedupes_and_normalizes(tmp_path: Path):
    class FakeSpotifyClient:
        def get_recently_played(self, *, limit=20):
            return {"items": [
                {"track": {"name": "A", "uri": "spotify:track:a", "duration_ms": 1, "artists": [{"name": "X"}]}},
                {"track": {"name": "A", "uri": "spotify:track:a", "duration_ms": 1, "artists": [{"name": "X"}]}},
                {"track": {"name": "B", "uri": "spotify:track:b", "duration_ms": 2, "artists": [{"name": "Y"}]}},
            ]}

    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state"),
        spotify_client_factory=FakeSpotifyClient,
    ))
    response = TestClient(app).get("/api/media/spotify/recently-played")

    assert response.status_code == 200
    items = response.json()["items"]
    assert [item["uri"] for item in items] == ["spotify:track:a", "spotify:track:b"]


def test_spotify_playlists_are_normalized(tmp_path: Path):
    class FakeSpotifyClient:
        def get_my_playlists(self, *, limit=20, offset=0):
            return {"items": [{
                "name": "Roadtrip", "uri": "spotify:playlist:rt",
                "owner": {"display_name": "Me"}, "tracks": {"total": 12},
                "images": [{"url": "https://img/rt.jpg"}],
            }]}

    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state"),
        spotify_client_factory=FakeSpotifyClient,
    ))
    response = TestClient(app).get("/api/media/spotify/playlists")

    assert response.status_code == 200
    items = response.json()["items"]
    assert items[0]["type"] == "playlist"
    assert items[0]["uri"] == "spotify:playlist:rt"
    assert items[0]["image_url"] == "https://img/rt.jpg"


@pytest.mark.parametrize("path", ["/api/media/spotify/playlists", "/api/media/spotify/recently-played"])
def test_spotify_browse_surfaces_degrade_to_empty_200_on_failure(tmp_path: Path, path: str):
    # These are fetched automatically on page load; a 401 here would be read
    # by the SPA as a stale dashboard session and trigger a reload loop.
    class SpotifyAuthRequiredError(Exception):
        pass

    class FakeSpotifyClient:
        def get_my_playlists(self, *, limit=20, offset=0):
            raise SpotifyAuthRequiredError("not connected")

        def get_recently_played(self, *, limit=20):
            raise SpotifyAuthRequiredError("not connected")

    app = FastAPI()
    app.include_router(create_media_router(
        MediaSettings(audiobook_root=tmp_path, runtime_root=tmp_path / "state"),
        spotify_client_factory=FakeSpotifyClient,
    ))
    response = TestClient(app).get(path)

    assert response.status_code == 200
    assert response.json()["items"] == []


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


@pytest.mark.parametrize(
    ("method", "path", "json_body"),
    [
        ("get", "/api/media/spotify/state", None),
        ("get", "/api/media/audiobooks", None),
        ("post", "/api/media/spotify/control", {"action": "pause"}),
        (
            "post",
            "/api/media/audiobooks/progress",
            {
                "chapter_id": "0" * 24,
                "position_seconds": 1,
                "duration_seconds": 2,
                "playback_rate": 1,
            },
        ),
    ],
)
def test_native_media_routes_require_dashboard_authorization(method: str, path: str, json_body: dict | None):
    from hermes_cli import web_server

    previous_required = getattr(web_server.app.state, "auth_required", None)
    previous_host = getattr(web_server.app.state, "bound_host", None)
    web_server.app.state.auth_required = False
    web_server.app.state.bound_host = None
    try:
        client = TestClient(web_server.app)
        response = client.request(method.upper(), path, json=json_body)
    finally:
        web_server.app.state.auth_required = previous_required
        web_server.app.state.bound_host = previous_host

    assert response.status_code == 401
