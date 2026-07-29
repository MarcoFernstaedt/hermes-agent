"""The review queue: store, apply-handlers, and the HTTP surface."""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from hermes_cli.review.router import create_review_router
from hermes_cli.review.store import ProposalConflict, ReviewStore


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "state").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: h)
    return h


@pytest.fixture
def store(tmp_path):
    return ReviewStore(tmp_path / "review.sqlite3")


def valid_capability() -> dict:
    return {
        "id": "notes",
        "label": "Notes",
        "title_field": "title",
        "fields": [{"name": "title", "label": "Title", "type": "text"}],
        "views": [{"id": "table", "kind": "table", "default": True}],
    }


# -- store ----------------------------------------------------------------

def test_store_lifecycle(store):
    p = store.create(kind="capability", title="Add Notes", summary="a notes tracker")
    assert p["status"] == "pending"
    assert store.counts() == {"pending": 1}
    approved = store.approve(p["id"])
    assert approved["status"] == "approved"
    applied = store.mark_applied(p["id"], outcome="done")
    assert applied["status"] == "applied" and applied["outcome"] == "done"


def test_store_rejects_double_decision(store):
    p = store.create(kind="skill", title="x")
    store.approve(p["id"])
    with pytest.raises(ProposalConflict):
        store.approve(p["id"])  # already approved
    with pytest.raises(ProposalConflict):
        store.reject(p["id"])


# -- HTTP surface + capability apply --------------------------------------

def _client(store, gated=False):
    def authorize(request: Request) -> None:
        if request.headers.get("x-test-auth") != "ok":
            raise HTTPException(status_code=401, detail="Unauthorized")

    app = FastAPI()
    app.state.auth_required = gated
    app.include_router(create_review_router(authorize, store_factory=lambda: store))
    return TestClient(app)


OK = {"x-test-auth": "ok", "origin": "http://testserver"}


def test_requires_auth(store):
    c = _client(store)
    assert c.get("/api/review").status_code == 401
    assert c.post("/api/review", json={"kind": "skill", "title": "x"}).status_code == 401


def test_approve_applies_capability_end_to_end(home, store):
    c = _client(store)
    created = c.post("/api/review", headers=OK, json={
        "kind": "capability", "title": "Add Notes", "source": "agent",
        "payload": {"declaration": valid_capability()},
    })
    assert created.status_code == 200
    pid = created.json()["id"]

    approved = c.post(f"/api/review/{pid}/approve", headers=OK)
    assert approved.status_code == 200
    body = approved.json()
    assert body["status"] == "applied", body
    # The declaration was written to the user capabilities dir and now loads.
    from hermes_cli.capabilities.declarations import load_capabilities
    assert any(cap["id"] == "notes" for cap in load_capabilities())


def test_approve_rejects_invalid_capability_at_apply(home, store):
    c = _client(store)
    bad = valid_capability()
    bad["title_field"] = "ghost"  # not a declared field
    pid = c.post("/api/review", headers=OK, json={
        "kind": "capability", "title": "Bad", "payload": {"declaration": bad},
    }).json()["id"]
    body = c.post(f"/api/review/{pid}/approve", headers=OK).json()
    # Approved but application failed validation — never written.
    assert body["status"] == "failed"
    assert "validation" in body["outcome"].lower()


def test_reject_flow(store):
    c = _client(store)
    pid = c.post("/api/review", headers=OK, json={"kind": "skill", "title": "x"}).json()["id"]
    body = c.post(f"/api/review/{pid}/reject", headers=OK).json()
    assert body["status"] == "rejected"


def test_unknown_kind_rejected(store):
    c = _client(store)
    resp = c.post("/api/review", headers=OK, json={"kind": "nonsense", "title": "x"})
    assert resp.status_code == 422


def test_same_origin_required_when_gated(store):
    c = _client(store, gated=True)
    resp = c.post("/api/review", headers={"x-test-auth": "ok"},
                  json={"kind": "skill", "title": "x"})
    assert resp.status_code == 403


def test_no_handler_kind_marks_failed(home, store):
    # A kind with no registered handler is approved but cannot apply — fail-safe.
    c = _client(store)
    pid = c.post("/api/review", headers=OK, json={"kind": "automation", "title": "x"}).json()["id"]
    body = c.post(f"/api/review/{pid}/approve", headers=OK).json()
    assert body["status"] == "failed"
    assert "handler" in body["outcome"].lower()
