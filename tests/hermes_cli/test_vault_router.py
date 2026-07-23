"""Tests for the vault router with a real temp vault."""

import importlib

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    root.mkdir()
    monkeypatch.setenv("HERMES_VAULT_PATH", str(root))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    import hermes_cli.vault.config as config
    import hermes_cli.vault.paths as paths
    import hermes_cli.vault.notes as notes
    import hermes_cli.vault.router as router

    for m in (config, paths, notes, router):
        importlib.reload(m)

    app = FastAPI()
    app.include_router(router.create_vault_router(lambda: None))
    return TestClient(app), root


def test_status_configured(client):
    c, root = client
    body = c.get("/api/vault/status").json()
    assert body["configured"] is True
    assert body["root"] == str(root.resolve())


def test_create_read_search_backlinks_flow(client):
    c, _ = client
    assert c.post("/api/vault/create", json={"path": "target.md", "content": "# Target\n"}).status_code == 200
    c.post("/api/vault/create", json={"path": "src.md", "content": "See [[target]] here.\n"})

    note = c.get("/api/vault/note?path=target.md").json()
    assert note["title"] == "Target"

    results = c.get("/api/vault/search?q=target").json()["results"]
    assert any(r["path"] == "target.md" for r in results)

    backlinks = c.get("/api/vault/backlinks?path=target.md").json()["backlinks"]
    assert any(b["path"] == "src.md" for b in backlinks)


def test_append_and_write_conflict(client):
    c, root = client
    c.post("/api/vault/create", json={"path": "a.md", "content": "v1"})
    assert c.post("/api/vault/append", json={"path": "a.md", "text": "more"}).status_code == 200

    # A stale expected_mtime triggers a conflict.
    resp = c.post("/api/vault/write", json={"path": "a.md", "content": "v2", "expected_mtime": 1.0})
    assert resp.status_code == 409
    assert resp.json()["detail"] == "conflict_note_changed_on_disk"


def test_traversal_rejected(client):
    c, _ = client
    resp = c.get("/api/vault/note?path=../../etc/passwd")
    assert resp.status_code == 400
    assert resp.json()["detail"] == "invalid_path"


def test_create_duplicate_conflict(client):
    c, _ = client
    c.post("/api/vault/create", json={"path": "dup.md", "content": "x"})
    resp = c.post("/api/vault/create", json={"path": "dup.md", "content": "y"})
    assert resp.status_code == 409
    assert resp.json()["detail"] == "note_already_exists"
