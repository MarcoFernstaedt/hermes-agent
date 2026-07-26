"""Approval integrity — the approved payload must equal the executed payload."""
from __future__ import annotations

import pytest

from hermes_cli import approval_integrity as ai


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "state").mkdir(parents=True)
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: h)
    return h


@pytest.fixture(autouse=True)
def _clean_records(monkeypatch):
    ai._RECORDS.clear()
    # Default to enforce for the assertions unless a test overrides it.
    monkeypatch.setenv("HERMES_APPROVAL_INTEGRITY", "enforce")
    yield
    ai._RECORDS.clear()


def test_canonical_hash_is_order_independent():
    a = ai.canonical_hash("email_send", {"to": "x@y.z", "subject": "hi"})
    b = ai.canonical_hash("email_send", {"subject": "hi", "to": "x@y.z"})
    assert a == b
    # Different payload → different hash.
    assert a != ai.canonical_hash("email_send", {"to": "z@y.z", "subject": "hi"})
    # Tool name is part of the identity.
    assert a != ai.canonical_hash("email_draft", {"to": "x@y.z", "subject": "hi"})


def test_matching_payload_passes(home):
    args = {"path": "/notes/a.md", "content": "hello"}
    ai.record_grant("call-1", "write_file", args)
    assert ai.verify_at_execution("call-1", "write_file", args) is None


def test_changed_payload_refused_in_enforce(home):
    ai.record_grant("call-2", "write_file", {"path": "/a", "content": "ok"})
    refusal = ai.verify_at_execution("call-2", "write_file", {"path": "/etc/passwd", "content": "ok"})
    assert refusal is not None
    assert "integrity" in refusal.lower()


def test_record_is_consumed(home):
    ai.record_grant("call-3", "write_file", {"x": 1})
    assert ai.verify_at_execution("call-3", "write_file", {"x": 1}) is None
    # A second verify has nothing recorded → not gated.
    assert ai.verify_at_execution("call-3", "write_file", {"x": 999}) is None


def test_observe_mode_audits_but_allows(home, monkeypatch):
    monkeypatch.setenv("HERMES_APPROVAL_INTEGRITY", "observe")
    ai.record_grant("call-4", "email_send", {"to": "a@b.c"})
    # Mismatch — but observe mode lets it proceed.
    assert ai.verify_at_execution("call-4", "email_send", {"to": "evil@x.y"}) is None
    from hermes_cli import audit_log

    rows = audit_log.query(module="approval_integrity", limit=10)
    assert any(r["action"] == "payload_changed_after_approval" for r in rows)
    assert rows[0]["outcome"] == "observed"


def test_off_mode_is_noop(home, monkeypatch):
    monkeypatch.setenv("HERMES_APPROVAL_INTEGRITY", "off")
    ai.record_grant("call-5", "write_file", {"x": 1})
    assert "call-5" not in ai._RECORDS  # not even recorded
    assert ai.verify_at_execution("call-5", "write_file", {"x": 2}) is None


def test_no_call_id_is_noop(home):
    ai.record_grant("", "write_file", {"x": 1})
    assert ai.verify_at_execution("", "write_file", {"x": 1}) is None
    assert not ai._RECORDS


def test_clear_forgets_record(home):
    ai.record_grant("call-6", "write_file", {"x": 1})
    ai.clear("call-6")
    assert ai.verify_at_execution("call-6", "write_file", {"x": 1}) is None
    assert "call-6" not in ai._RECORDS


def test_gated_tool_through_handle_function_call_is_not_false_refused(home):
    """A human-gated (APPROVAL) tool whose payload is unchanged between the
    approval snapshot and dispatch must run — enforce mode must not regress the
    normal path. Exercises the real record→verify wiring in handle_function_call."""
    import json as _json

    import model_tools
    from hermes_cli.module_permissions import Tier, register_tool_permission
    from tools.registry import registry

    register_tool_permission("t_apr", Tier.APPROVAL)
    registry.register(
        name="t_apr",
        toolset="demo",
        schema={"name": "t_apr", "parameters": {"type": "object", "properties": {}}},
        handler=lambda _a, **_k: _json.dumps({"ok": True}),
    )
    try:
        out = _json.loads(
            model_tools.handle_function_call(
                "t_apr", {"x": 1}, session_id="s", tool_call_id="tc-1"
            )
        )
        assert out.get("ok") is True
        # The record was consumed by the successful dispatch.
        assert "tc-1" not in ai._RECORDS
    finally:
        registry.deregister("t_apr")


def test_ttl_eviction(home, monkeypatch):
    ai.record_grant("old", "write_file", {"x": 1})
    # Fast-forward past the TTL by ageing the record.
    rec = ai._RECORDS["old"]
    ai._RECORDS["old"] = ai._Record(rec.digest, rec.tool_name, rec.created_at - ai._TTL_SECONDS - 1)
    ai.record_grant("new", "write_file", {"y": 2})  # triggers eviction sweep
    assert "old" not in ai._RECORDS
    assert "new" in ai._RECORDS
