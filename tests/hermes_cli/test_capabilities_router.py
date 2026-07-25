from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from hermes_cli.capabilities.router import create_capabilities_router


def _client() -> TestClient:
    def authorize(request: Request) -> None:
        if request.headers.get("x-test-auth") != "ok":
            raise HTTPException(status_code=401, detail="Unauthorized")

    app = FastAPI()
    app.include_router(create_capabilities_router(authorize))
    return TestClient(app)


OK = {"x-test-auth": "ok"}


def test_requires_auth():
    assert _client().get("/api/capabilities").status_code == 401


def test_serves_declarations():
    resp = _client().get("/api/capabilities", headers=OK)
    assert resp.status_code == 200
    caps = resp.json()["capabilities"]
    ids = {c["id"] for c in caps}
    # Every declaration authored under definitions/ is served (a new area is a
    # new JSON file, no code) — assert on the ones that ship today.
    assert {"reading", "tasks"} <= ids
    reading = next(c for c in caps if c["id"] == "reading")
    # The wire shape the frontend registry maps from.
    assert reading["title_field"] == "title"
    assert reading["lifecycle"]["initial"] == "to_read"
    assert {f["name"] for f in reading["fields"]} >= {"title", "author", "status"}
    assert reading["agent"]["expose"] == ["list", "get", "create", "advance"]


def test_serves_wire_shape_for_every_declaration():
    caps = _client().get("/api/capabilities", headers=OK).json()["capabilities"]
    # Contract the frontend registry relies on for each served declaration.
    for cap in caps:
        assert cap["id"] and cap["label"]
        assert "title_field" in cap
        assert isinstance(cap["fields"], list) and cap["fields"]
        assert isinstance(cap["views"], list) and cap["views"]
