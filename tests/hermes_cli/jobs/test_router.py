from __future__ import annotations

import os
import sqlite3
import time

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


def _status_payload(status):
    return {
        "status": status,
        "expected_status": "packet_ready_not_applied",
        "expected_updated_at": "2026-07-17T00:00:00Z",
    }


def test_router_initializes_migration_once_and_reads_never_migrate(
    jobs_db, packet_root, monkeypatch
):
    from hermes_cli.jobs.repository import JobRepository

    original = JobRepository.migrate
    migrations = 0

    def counted_migration(self):
        nonlocal migrations
        migrations += 1
        return original(self)

    monkeypatch.setattr(JobRepository, "migrate", counted_migration)
    client = _router_client(jobs_db, packet_root, monkeypatch)

    assert migrations == 1
    assert client.get("/api/jobs", headers={"x-test-auth": "ok"}).status_code == 200
    assert (
        client.get("/api/jobs/summary", headers={"x-test-auth": "ok"}).status_code
        == 200
    )
    assert migrations == 1


def test_reads_remain_available_under_a_reserved_writer(
    jobs_db, packet_root, monkeypatch
):
    client = _router_client(jobs_db, packet_root, monkeypatch)
    writer = sqlite3.connect(jobs_db, isolation_level=None)
    writer.execute("BEGIN IMMEDIATE")
    started = time.monotonic()
    try:
        response = client.get("/api/jobs/summary", headers={"x-test-auth": "ok"})
    finally:
        writer.execute("ROLLBACK")
        writer.close()

    assert time.monotonic() - started < 1.0
    assert response.status_code == 200


def test_busy_read_returns_bounded_availability_response(
    jobs_db, packet_root, monkeypatch
):
    client = _router_client(jobs_db, packet_root, monkeypatch)
    writer = sqlite3.connect(jobs_db, isolation_level=None)
    writer.execute("BEGIN EXCLUSIVE")
    started = time.monotonic()
    try:
        response = client.get("/api/jobs/summary", headers={"x-test-auth": "ok"})
    finally:
        writer.execute("ROLLBACK")
        writer.close()

    assert time.monotonic() - started < 1.0
    assert response.status_code == 503
    assert response.json() == {"detail": "Jobs data is temporarily unavailable"}


def test_jobs_routes_require_authentication(jobs_db, packet_root, monkeypatch):
    client = _router_client(jobs_db, packet_root, monkeypatch)

    assert client.get("/api/jobs").status_code == 401
    assert client.get("/api/jobs/summary").status_code == 401
    assert (
        client.patch("/api/jobs/1/status", json=_status_payload("applied")).status_code
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
    assert summary.json()["counts"]["packet_ready"] == 1
    assert summary.json()["counts"]["total"] == 1
    assert asset.status_code == 200
    assert asset.content == b"packet"
    assert asset.headers["x-content-type-options"] == "nosniff"
    assert asset.headers["cache-control"] == "private, no-store"


def test_asset_response_keeps_opened_file_when_path_is_swapped(
    jobs_db, packet_root, tmp_path, monkeypatch
):
    from hermes_cli.jobs.assets import JobAssetStore

    asset_path = (
        packet_root / "Example Co" / "Support Engineer" / "Application Packet.md"
    )
    outside = tmp_path / "outside.md"
    outside.write_bytes(b"outside")
    swapped = False

    def swap_path() -> None:
        nonlocal swapped
        if swapped:
            return
        asset_path.unlink()
        os.symlink(outside, asset_path)
        swapped = True

    original_resolve = JobAssetStore.resolve

    def resolving_then_swap(self, job_id, asset_id):
        path = original_resolve(self, job_id, asset_id)
        swap_path()
        return path

    monkeypatch.setattr(JobAssetStore, "resolve", resolving_then_swap)
    if hasattr(JobAssetStore, "open_asset"):
        original_open = JobAssetStore.open_asset

        def opening_then_swap(self, job_id, asset_id):
            opened = original_open(self, job_id, asset_id)
            swap_path()
            return opened

        monkeypatch.setattr(JobAssetStore, "open_asset", opening_then_swap)

    client = _router_client(jobs_db, packet_root, monkeypatch)
    response = client.get(
        "/api/jobs/1/assets/1?disposition=inline",
        headers={"x-test-auth": "ok"},
    )

    assert swapped is True
    assert response.status_code == 200
    assert response.content == b"packet"
    assert response.headers["content-type"].startswith("text/markdown")
    assert response.headers["content-disposition"].startswith("inline;")
    assert response.headers["content-security-policy"]
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


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
        "/api/jobs/1/status", headers=headers, json=_status_payload("applied")
    )
    hostile = client.patch(
        "/api/jobs/1/status",
        headers={**headers, "origin": "https://evil.example"},
        json=_status_payload("applied"),
    )
    success = client.patch(
        "/api/jobs/1/status",
        headers={**headers, "origin": "http://testserver"},
        json=_status_payload("applied"),
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
        json=_status_payload("pending"),
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Invalid status transition"}


def test_status_write_returns_current_row_when_observation_is_stale(
    jobs_db, packet_root, monkeypatch
):
    import sqlite3

    client = _router_client(jobs_db, packet_root, monkeypatch)
    headers = {"x-test-auth": "ok"}
    observed = client.get("/api/jobs", headers=headers).json()["items"][0]
    with sqlite3.connect(jobs_db) as connection:
        connection.execute(
            "UPDATE jobs SET status = 'applied', updated_at = '2026-07-17T13:00:00Z' WHERE id = 1"
        )

    response = client.patch(
        "/api/jobs/1/status",
        headers=headers,
        json={
            "status": "withdrawn",
            "expected_status": observed["status"],
            "expected_updated_at": observed["updated_at"],
        },
    )

    assert response.status_code == 409
    assert response.json() == {
        "detail": "Job status changed",
        "current": {
            "id": 1,
            "status": "applied",
            "updated_at": "2026-07-17T13:00:00Z",
            "applied_at": None,
        },
    }
    with sqlite3.connect(jobs_db) as connection:
        assert (
            connection.execute("SELECT status FROM jobs WHERE id = 1").fetchone()[0]
            == "applied"
        )


def test_native_dashboard_mount_uses_existing_session_auth(
    jobs_db, packet_root, monkeypatch
):
    from hermes_cli import web_server

    monkeypatch.setenv("HERMES_JOBS_DB_PATH", str(jobs_db))
    monkeypatch.setenv("HERMES_JOBS_PACKET_ROOT", str(packet_root))
    monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
    from hermes_cli.jobs.router import initialize_jobs

    initialize_jobs()
    client = TestClient(web_server.app)

    unauthorized = client.get("/api/jobs/summary")
    authorized = client.get(
        "/api/jobs/summary",
        headers={web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN},
    )

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
