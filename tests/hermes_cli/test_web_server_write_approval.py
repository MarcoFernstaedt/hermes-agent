import asyncio
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from hermes_cli import web_server


SAFE_SUCCESS = {
    "success": True,
    "subsystem": "memory",
    "pending_id": "mem12345",
    "decision": "approve",
}


def _authed_client() -> TestClient:
    return TestClient(
        web_server.app,
        headers={web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN},
    )


def test_write_approval_route_is_protected():
    response = TestClient(web_server.app).post(
        "/api/write-approval",
        json={"subsystem": "memory", "pending_id": "mem12345", "decision": "approve"},
    )

    assert response.status_code == 401


def test_dashboard_write_approval_returns_only_confirmed_safe_fields(monkeypatch):
    monkeypatch.setattr(
        web_server,
        "_resolve_dashboard_write_approval",
        lambda _request, _profile: {**SAFE_SUCCESS, "payload": "PRIVATE"},
    )

    response = _authed_client().post(
        "/api/write-approval?profile=default",
        json={"subsystem": "memory", "pending_id": "mem12345", "decision": "approve"},
    )

    assert response.status_code == 200
    assert response.json() == SAFE_SUCCESS
    assert "PRIVATE" not in response.text


@pytest.mark.parametrize(
    "body",
    [
        {"subsystem": "other", "pending_id": "safe", "decision": "approve"},
        {"subsystem": "memory", "pending_id": "../unsafe", "decision": "approve"},
        {"subsystem": "memory", "pending_id": "", "decision": "approve"},
        {"subsystem": "memory", "pending_id": "x" * 65, "decision": "approve"},
        {"subsystem": "memory", "pending_id": "safe", "decision": "other"},
    ],
)
def test_write_approval_request_rejects_invalid_structured_input(body):
    response = _authed_client().post("/api/write-approval", json=body)

    assert response.status_code == 422
    assert "PRIVATE" not in response.text


def test_dashboard_write_approval_runs_in_requested_profile_scope(monkeypatch):
    entered = []

    @contextmanager
    def fake_scope(profile):
        entered.append(profile)
        yield

    monkeypatch.setattr(web_server, "_profile_scope", fake_scope)
    monkeypatch.setattr(
        "hermes_cli.write_approval_commands.resolve_pending_write",
        lambda subsystem, pending_id, decision, memory_store=None: {
            "success": True,
            "subsystem": subsystem,
            "pending_id": pending_id,
            "decision": decision,
        },
    )
    request = web_server.WriteApprovalRequest(
        subsystem="skills", pending_id="skill123", decision="reject"
    )

    result = asyncio.run(web_server.resolve_dashboard_write_approval(request, profile="client"))

    assert result == {
        "success": True,
        "subsystem": "skills",
        "pending_id": "skill123",
        "decision": "reject",
    }
    assert entered == ["client"]


def test_dashboard_memory_approval_uses_configured_store_limits(monkeypatch):
    from tools.memory_tool import MemoryStore

    configured_store = MemoryStore(memory_char_limit=17, user_char_limit=23)
    seen = {}
    monkeypatch.setattr(
        "tools.memory_tool.load_on_disk_store", lambda: configured_store
    )

    def fake_resolve(subsystem, pending_id, decision, memory_store=None):
        seen["store"] = memory_store
        return {
            "success": True,
            "subsystem": subsystem,
            "pending_id": pending_id,
            "decision": decision,
        }

    monkeypatch.setattr(
        "hermes_cli.write_approval_commands.resolve_pending_write", fake_resolve
    )
    request = web_server.WriteApprovalRequest(
        subsystem="memory", pending_id="mem12345", decision="approve"
    )

    result = web_server._resolve_dashboard_write_approval(request, profile=None)

    assert result == SAFE_SUCCESS
    assert seen["store"] is configured_store
    assert seen["store"].memory_char_limit == 17
    assert seen["store"].user_char_limit == 23


@pytest.mark.parametrize(
    "error",
    ["apply_failed", "not_found", "in_progress", "decision_conflict"],
)
def test_dashboard_write_approval_returns_safe_domain_failure(monkeypatch, error):
    request = web_server.WriteApprovalRequest(
        subsystem="skills", pending_id="skill123", decision="reject"
    )
    monkeypatch.setattr(
        web_server,
        "_resolve_dashboard_write_approval",
        lambda _request, _profile: {
            "success": False,
            "error": error,
            "payload": "PRIVATE-STAGED-SKILL",
            "exception": "PRIVATE-TRACE",
        },
    )

    result = asyncio.run(web_server.resolve_dashboard_write_approval(request))

    assert result == {
        "success": False,
        "subsystem": "skills",
        "pending_id": "skill123",
        "decision": "reject",
        "error": error,
    }
    assert "PRIVATE" not in str(result)


def test_dashboard_write_approval_filters_unexpected_exception_details(monkeypatch, caplog):
    request = web_server.WriteApprovalRequest(
        subsystem="skills", pending_id="skill123", decision="approve"
    )

    def fail(_request, _profile):
        raise RuntimeError("PRIVATE-STAGED-SKILL")

    monkeypatch.setattr(web_server, "_resolve_dashboard_write_approval", fail)

    result = asyncio.run(web_server.resolve_dashboard_write_approval(request))

    assert result == {
        "success": False,
        "subsystem": "skills",
        "pending_id": "skill123",
        "decision": "approve",
        "error": "apply_failed",
    }
    assert "PRIVATE" not in str(result)
    assert "PRIVATE" not in caplog.text
