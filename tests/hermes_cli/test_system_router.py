from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from hermes_cli import provenance
from hermes_cli.system_router import create_system_router


def _client():
    def authorize(request: Request) -> None:
        if request.headers.get("x-test-auth") != "ok":
            raise HTTPException(status_code=401, detail="Unauthorized")

    app = FastAPI()
    app.include_router(create_system_router(authorize))
    return TestClient(app)


OK = {"x-test-auth": "ok"}


def test_requires_auth():
    assert _client().get("/api/system/provenance").status_code == 401


def test_provenance_shape():
    body = _client().get("/api/system/provenance", headers=OK).json()
    assert "backend" in body and "frontend" in body and "process" in body
    assert "commit" in body["backend"]
    assert "commit_drift" in body
    assert isinstance(body["process"]["uptime_seconds"], (int, float))


def test_collect_reports_drift(monkeypatch):
    monkeypatch.setattr(provenance, "backend_commit", lambda: {
        "commit": "aaaa", "commit_short": "aaaa", "branch": "main", "dirty": False})
    monkeypatch.setattr(provenance, "frontend_build_info", lambda: {
        "commit": "bbbb", "commit_short": "bbbb", "branch": "main", "dirty": False,
        "built_at": None})
    out = provenance.collect()
    assert out["commit_drift"] is True

    # Same commit → no drift.
    monkeypatch.setattr(provenance, "frontend_build_info", lambda: {
        "commit": "aaaa", "commit_short": "aaaa", "branch": "main", "dirty": False,
        "built_at": None})
    assert provenance.collect()["commit_drift"] is False


def test_unknown_commits_are_not_drift(monkeypatch):
    monkeypatch.setattr(provenance, "backend_commit", lambda: {
        "commit": "unknown", "commit_short": "unknown", "branch": "unknown", "dirty": None})
    monkeypatch.setattr(provenance, "frontend_build_info", lambda: {
        "commit": "unknown", "commit_short": "unknown", "branch": "unknown", "dirty": None,
        "built_at": None})
    assert provenance.collect()["commit_drift"] is False
