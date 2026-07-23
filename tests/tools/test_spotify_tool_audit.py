"""Spotify agent write-tools record to the shared audit log."""

import importlib

import pytest


class _FakeClient:
    def create_playlist(self, **kw):
        return {"id": "pl1", "name": kw.get("name")}

    def add_playlist_items(self, **kw):
        return {"snapshot_id": "s1"}

    def remove_playlist_items(self, **kw):
        return {"snapshot_id": "s2"}

    def update_playlist_details(self, **kw):
        return {"ok": True}

    def save_library_items(self, **kw):
        return {"ok": True}

    def remove_saved_tracks(self, **kw):
        return {"ok": True}

    def get_my_playlists(self, **kw):
        return {"items": []}


@pytest.fixture()
def spotify_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_cli.audit_log as audit_log

    importlib.reload(audit_log)
    from plugins.spotify import tools

    monkeypatch.setattr(tools, "_spotify_client", lambda: _FakeClient())
    return tools, audit_log


def test_playlist_create_is_audited(spotify_tools):
    tools, audit_log = spotify_tools
    tools._handle_spotify_playlists({"action": "create", "name": "Focus"})
    entries = audit_log.query(module="media")
    assert len(entries) == 1
    e = entries[0]
    assert e["tool"] == "spotify"
    assert e["action"] == "playlist.create"
    assert e["target"] == "Focus"
    assert e["outcome"] == "ok"


def test_playlist_add_and_remove_items_audited(spotify_tools):
    tools, audit_log = spotify_tools
    tools._handle_spotify_playlists(
        {"action": "add_items", "playlist_id": "37i9dQZF1DXcBWIGoYBM5M",
         "uris": ["spotify:track:4iV5W9uYEdYUVa79Axb7Rh"]}
    )
    tools._handle_spotify_playlists(
        {"action": "remove_items", "playlist_id": "37i9dQZF1DXcBWIGoYBM5M",
         "uris": ["spotify:track:4iV5W9uYEdYUVa79Axb7Rh"]}
    )
    actions = [e["action"] for e in audit_log.query(module="media")]
    assert "playlist.add_items" in actions
    assert "playlist.remove_items" in actions


def test_library_save_and_remove_audited(spotify_tools):
    tools, audit_log = spotify_tools
    tools._handle_spotify_library(
        {"kind": "tracks", "action": "save",
         "uris": ["spotify:track:4iV5W9uYEdYUVa79Axb7Rh"]}
    )
    tools._handle_spotify_library(
        {"kind": "tracks", "action": "remove",
         "ids": ["4iV5W9uYEdYUVa79Axb7Rh"]}
    )
    actions = [e["action"] for e in audit_log.query(module="media")]
    assert "library.save.tracks" in actions
    assert "library.remove.tracks" in actions


def test_reads_are_not_audited(spotify_tools):
    tools, audit_log = spotify_tools
    tools._handle_spotify_playlists({"action": "list"})
    assert audit_log.query(module="media") == []
