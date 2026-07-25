from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from hermes_cli.entities.router import create_entities_router
from hermes_cli.entities.store import EntityStore


def _client(tmp_path, *, gated=False, events=None):
    store = EntityStore(tmp_path / "entities.sqlite3")
    store.migrate()

    def authorize(request: Request) -> None:
        if request.headers.get("x-test-auth") != "ok":
            raise HTTPException(status_code=401, detail="Unauthorized")

    async def publish(channel: str, payload: dict) -> None:
        if events is not None:
            events.append((channel, payload))

    app = FastAPI()
    app.state.auth_required = gated
    app.include_router(
        create_entities_router(
            authorize, store_factory=lambda: store, publish=publish
        )
    )
    return TestClient(app)


OK = {"x-test-auth": "ok", "origin": "http://testserver"}


def test_requires_auth(tmp_path):
    c = _client(tmp_path)
    assert c.get("/api/entities/job").status_code == 401
    assert c.post("/api/entities/job", json={"data": {}}).status_code == 401


def test_crud_lifecycle(tmp_path):
    c = _client(tmp_path)
    created = c.post(
        "/api/entities/job", headers=OK, json={"data": {"company": "Acme", "status": "saved"}}
    )
    assert created.status_code == 200
    eid = created.json()["id"]
    assert created.json()["version"] == 1

    got = c.get(f"/api/entities/job/{eid}", headers=OK)
    assert got.status_code == 200
    assert got.json()["data"]["company"] == "Acme"

    listed = c.get("/api/entities/job", headers=OK)
    assert listed.json()["total"] == 1

    # Filtered list via query param.
    filtered = c.get("/api/entities/job?status=saved", headers=OK)
    assert filtered.json()["total"] == 1
    assert c.get("/api/entities/job?status=applied", headers=OK).json()["total"] == 0

    updated = c.patch(
        f"/api/entities/job/{eid}",
        headers=OK,
        json={"data": {"company": "Acme", "status": "applied"}, "expected_version": 1},
    )
    assert updated.status_code == 200
    assert updated.json()["version"] == 2

    deleted = c.delete(f"/api/entities/job/{eid}", headers=OK)
    assert deleted.status_code == 200
    assert c.get(f"/api/entities/job/{eid}", headers=OK).status_code == 404


def test_version_conflict_returns_409(tmp_path):
    c = _client(tmp_path)
    eid = c.post("/api/entities/job", headers=OK, json={"data": {"s": "a"}}).json()["id"]
    c.patch(
        f"/api/entities/job/{eid}",
        headers=OK,
        json={"data": {"s": "b"}, "expected_version": 1},
    )
    stale = c.patch(
        f"/api/entities/job/{eid}",
        headers=OK,
        json={"data": {"s": "c"}, "expected_version": 1},
    )
    assert stale.status_code == 409
    assert stale.json()["current"]["version"] == 2


def test_type_mismatch_is_not_found(tmp_path):
    c = _client(tmp_path)
    eid = c.post("/api/entities/job", headers=OK, json={"data": {}}).json()["id"]
    # Same id under the wrong type path → 404.
    assert c.get(f"/api/entities/note/{eid}", headers=OK).status_code == 404


def test_writes_emit_entity_events(tmp_path):
    events: list = []
    c = _client(tmp_path, events=events)
    eid = c.post("/api/entities/job", headers=OK, json={"data": {"s": "a"}}).json()["id"]
    c.patch(
        f"/api/entities/job/{eid}",
        headers=OK,
        json={"data": {"s": "b"}, "expected_version": 1},
    )
    c.delete(f"/api/entities/job/{eid}", headers=OK)

    actions = [(ch, p["type"], p["action"]) for ch, p in events]
    assert actions == [
        ("entities", "job", "created"),
        ("entities", "job", "updated"),
        ("entities", "job", "deleted"),
    ]
    assert all(p["kind"] == "entity" and p["id"] == eid for _, p in events)


def test_writes_require_same_origin_when_gated(tmp_path):
    c = _client(tmp_path, gated=True)
    # No origin header on a gated app → 403 for writes.
    resp = c.post("/api/entities/job", headers={"x-test-auth": "ok"}, json={"data": {}})
    assert resp.status_code == 403


def test_notify_rebroadcasts_without_writing(tmp_path):
    events: list = []
    c = _client(tmp_path, events=events)
    # A cross-process writer (the agent) hints an already-persisted change.
    resp = c.post(
        "/api/entities/task/abc123/notify",
        headers={"x-test-auth": "ok"},
        json={"action": "created", "version": 1},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    # It emits the same frame a UI write would, but touches no record.
    assert events == [
        ("entities", {"kind": "entity", "type": "task", "id": "abc123", "action": "created", "version": 1})
    ]
    assert c.get("/api/entities/task", headers=OK).json()["total"] == 0


def test_notify_requires_auth(tmp_path):
    c = _client(tmp_path)
    assert c.post("/api/entities/task/x/notify").status_code == 401


def test_notify_coerces_unknown_action(tmp_path):
    events: list = []
    c = _client(tmp_path, events=events)
    c.post("/api/entities/task/x/notify", headers={"x-test-auth": "ok"}, json={"action": "bogus"})
    assert events[0][1]["action"] == "updated"
