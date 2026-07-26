from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from hermes_cli import agent_scopes as sc
from hermes_cli.agent_scopes_router import create_agent_scopes_router


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "state").mkdir(parents=True)
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: h)
    sc._HALT_CACHE["value"] = False
    sc._HALT_CACHE["ts"] = 0.0
    yield
    sc._HALT_CACHE["value"] = False
    sc._HALT_CACHE["ts"] = 0.0


def _client(*, gated=False):
    def authorize(request: Request) -> None:
        if request.headers.get("x-test-auth") != "ok":
            raise HTTPException(status_code=401, detail="Unauthorized")

    app = FastAPI()
    app.state.auth_required = gated
    app.include_router(create_agent_scopes_router(authorize))
    return TestClient(app)


OK = {"x-test-auth": "ok", "origin": "http://testserver"}


def test_requires_auth():
    c = _client()
    assert c.get("/api/agent/guardrails").status_code == 401
    assert c.post("/api/agent/guardrails/stop", json={"halted": True}).status_code == 401


def test_read_lists_scopes_and_halt_state():
    c = _client()
    body = c.get("/api/agent/guardrails", headers=OK).json()
    names = {s["name"] for s in body["scopes"]}
    assert {"full", "read_only", "research", "triage"} <= names
    assert body["default_scope"] == "full"
    assert body["halted"] is False


def test_global_stop_round_trip():
    c = _client()
    engaged = c.post("/api/agent/guardrails/stop", headers=OK, json={"halted": True})
    assert engaged.status_code == 200
    assert engaged.json()["halted"] is True
    assert c.get("/api/agent/guardrails", headers=OK).json()["halted"] is True
    released = c.post("/api/agent/guardrails/stop", headers=OK, json={"halted": False})
    assert released.json()["halted"] is False


def test_session_scope_get_set():
    c = _client()
    # Defaults to full.
    assert c.get("/api/agent/guardrails/session/s1", headers=OK).json()["scope"] == "full"
    set_resp = c.put("/api/agent/guardrails/session/s1", headers=OK, json={"scope": "triage"})
    assert set_resp.status_code == 200
    assert set_resp.json()["scope"] == "triage"
    assert c.get("/api/agent/guardrails/session/s1", headers=OK).json()["scope"] == "triage"


def test_unknown_scope_rejected():
    c = _client()
    resp = c.put("/api/agent/guardrails/session/s1", headers=OK, json={"scope": "bogus"})
    assert resp.status_code == 422


def test_writes_require_same_origin_when_gated():
    c = _client(gated=True)
    # No origin header under the gate → rejected.
    resp = c.post(
        "/api/agent/guardrails/stop",
        headers={"x-test-auth": "ok"},
        json={"halted": True},
    )
    assert resp.status_code == 403
