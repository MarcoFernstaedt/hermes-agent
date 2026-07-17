from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


def _router_client(jobs_db, packet_root, monkeypatch, *, gated=False):
    from hermes_cli.jobs.router import create_jobs_router

    monkeypatch.setenv("HERMES_JOBS_DB_PATH", str(jobs_db))
    monkeypatch.setenv("HERMES_JOBS_PACKET_ROOT", str(packet_root))
    app = FastAPI()
    app.state.auth_required = gated

    def authorize(request: Request) -> None:
        if request.headers.get("x-test-auth") != "ok":
            raise HTTPException(status_code=401, detail="Unauthorized")
        if gated:
            request.state.session = object()

    app.include_router(create_jobs_router(authorize))
    return TestClient(app)


def test_jobs_routes_require_authentication(jobs_db, packet_root, monkeypatch):
    client = _router_client(jobs_db, packet_root, monkeypatch)

    assert client.get("/api/jobs").status_code == 401
    assert client.get("/api/jobs/summary").status_code == 401
    assert (
        client.patch("/api/jobs/1/status", json={"status": "applied"}).status_code
        == 401
    )
    assert client.get("/api/jobs/1/assets/1").status_code == 401


def test_jobs_list_summary_and_asset_contract(jobs_db, packet_root, monkeypatch):
    client = _router_client(jobs_db, packet_root, monkeypatch)
    headers = {"x-test-auth": "ok"}

    listing = client.get("/api/jobs?q=support&freshness=active", headers=headers)
    summary = client.get("/api/jobs/summary", headers=headers)
    asset = client.get("/api/jobs/1/assets/1?disposition=inline", headers=headers)

    assert listing.status_code == 200
    body = listing.json()
    assert body["total"] == 1
    assert body["items"][0]["assets"][0]["name"] == "Application Packet.md"
    assert "path" not in str(body["items"][0]["assets"]).lower()
    assert body["filters"]["statuses"]
    assert summary.status_code == 200
    assert summary.json()["counts"]["qualified_packet_ready"] == 1
    assert asset.status_code == 200
    assert asset.content == b"packet"
    assert asset.headers["x-content-type-options"] == "nosniff"
    assert asset.headers["cache-control"] == "private, no-store"


def test_jobs_filter_metadata_includes_authoritative_source_statuses(
    jobs_db, packet_root, monkeypatch
):
    import sqlite3

    with sqlite3.connect(jobs_db) as connection:
        connection.execute("UPDATE jobs SET status = 'ineligible' WHERE id = 1")
    client = _router_client(jobs_db, packet_root, monkeypatch)

    response = client.get("/api/jobs", headers={"x-test-auth": "ok"})

    assert response.status_code == 200
    assert "ineligible" in response.json()["filters"]["statuses"]


def test_status_write_requires_same_origin_in_cookie_gated_mode(
    jobs_db, packet_root, monkeypatch
):
    client = _router_client(jobs_db, packet_root, monkeypatch, gated=True)
    headers = {"x-test-auth": "ok"}

    missing = client.patch(
        "/api/jobs/1/status", headers=headers, json={"status": "applied"}
    )
    hostile = client.patch(
        "/api/jobs/1/status",
        headers={**headers, "origin": "https://evil.example"},
        json={"status": "applied"},
    )
    success = client.patch(
        "/api/jobs/1/status",
        headers={**headers, "origin": "http://testserver"},
        json={"status": "applied"},
    )

    assert missing.status_code == 403
    assert hostile.status_code == 403
    assert success.status_code == 200
    assert success.json()["status"] == "applied"
    assert success.json()["applied_at"]


def test_status_write_rejects_invalid_transition(jobs_db, packet_root, monkeypatch):
    client = _router_client(jobs_db, packet_root, monkeypatch)

    response = client.patch(
        "/api/jobs/1/status",
        headers={"x-test-auth": "ok"},
        json={"status": "pending"},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Invalid status transition"}


def test_native_dashboard_mount_uses_existing_session_auth(
    jobs_db, packet_root, monkeypatch
):
    from hermes_cli import web_server

    monkeypatch.setenv("HERMES_JOBS_DB_PATH", str(jobs_db))
    monkeypatch.setenv("HERMES_JOBS_PACKET_ROOT", str(packet_root))
    monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
    client = TestClient(web_server.app)

    unauthorized = client.get("/api/jobs/summary")
    authorized = client.get(
        "/api/jobs/summary",
        headers={web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN},
    )

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
