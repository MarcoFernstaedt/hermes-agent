"""Session scopes + the global stop, enforced at the dispatch chokepoint."""
from __future__ import annotations

import json

import pytest

from hermes_cli import agent_scopes as sc
from hermes_cli.module_permissions import Tier, register_tool_permission
from tools.registry import registry


@pytest.fixture(autouse=True)
def _reset_halt_cache():
    """The halt flag is cached module-side; clear it around every test so state
    never leaks between tests (and the global stop always starts released)."""
    sc._HALT_CACHE["value"] = False
    sc._HALT_CACHE["ts"] = 0.0
    yield
    sc._HALT_CACHE["value"] = False
    sc._HALT_CACHE["ts"] = 0.0


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "state").mkdir(parents=True)
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: h)
    return h


@pytest.fixture
def sample_tools():
    """A read (AUTO), a generic write (APPROVAL), a destructive tool
    (ALWAYS_APPROVAL), and an email write (APPROVAL, toolset=email)."""
    def handler(_args, **_kw):
        return json.dumps({"ok": True})

    def reg(name, toolset, tier):
        register_tool_permission(name, tier)
        registry.register(name=name, toolset=toolset,
                          schema={"name": name, "parameters": {"type": "object", "properties": {}}},
                          handler=handler)

    reg("t_read", "demo", Tier.AUTO)
    reg("t_write", "demo", Tier.APPROVAL)
    reg("t_destroy", "demo", Tier.ALWAYS_APPROVAL)
    reg("t_email_label", "email", Tier.APPROVAL)
    yield
    for n in ("t_read", "t_write", "t_destroy", "t_email_label"):
        try:
            registry.deregister(n)
        except Exception:
            pass


def test_scope_permits_matrix(sample_tools):
    # read_only: only the AUTO read.
    assert sc.scope_permits("read_only", "t_read")
    assert not sc.scope_permits("read_only", "t_write")
    assert not sc.scope_permits("read_only", "t_destroy")
    # full: everything.
    assert all(sc.scope_permits("full", t) for t in ("t_read", "t_write", "t_destroy"))
    # triage: reads + email writes, but not generic writes or destructive.
    assert sc.scope_permits("triage", "t_read")
    assert sc.scope_permits("triage", "t_email_label")
    assert not sc.scope_permits("triage", "t_write")     # write outside email
    assert not sc.scope_permits("triage", "t_destroy")   # ALWAYS_APPROVAL (send/delete)


def test_dispatch_unarmed_is_never_gated(home, sample_tools):
    # No active scope (internal/system call) → dispatch runs normally.
    out = json.loads(registry.dispatch("t_destroy", {}))
    assert out.get("ok") is True


def test_unarmed_call_is_still_halted_by_global_stop(home, sample_tools):
    # The global stop is unconditional: it blocks even internal/unscoped calls.
    sc.set_agent_halt(True)
    try:
        blocked = json.loads(registry.dispatch("t_read", {}))
        assert blocked.get("refused") is True
        assert "halted" in blocked["error"].lower()
    finally:
        sc.set_agent_halt(False)
    assert json.loads(registry.dispatch("t_read", {})).get("ok") is True


def test_dispatch_enforces_scope_when_armed(home, sample_tools):
    token = sc.set_active_scope("read_only")
    try:
        blocked = json.loads(registry.dispatch("t_write", {}))
        assert blocked.get("refused") is True
        assert "read_only" in blocked["error"]
        allowed = json.loads(registry.dispatch("t_read", {}))
        assert allowed.get("ok") is True
    finally:
        sc.reset_active_scope(token)


def test_global_stop_refuses_all_armed_calls(home, sample_tools):
    sc.set_agent_halt(True)
    token = sc.set_active_scope("full")
    try:
        blocked = json.loads(registry.dispatch("t_read", {}))
        assert blocked.get("refused") is True
        assert "halted" in blocked["error"].lower()
    finally:
        sc.reset_active_scope(token)
        sc.set_agent_halt(False)
    # After release, an armed call runs again.
    token = sc.set_active_scope("full")
    try:
        assert json.loads(registry.dispatch("t_read", {})).get("ok") is True
    finally:
        sc.reset_active_scope(token)


def test_handle_function_call_arms_session_scope(home, sample_tools):
    """The runtime hook in model_tools.handle_function_call arms the session's
    scope so a scoped-out tool is refused end-to-end (not just at the raw
    registry level). A session pinned to read_only must have its write refused
    and its read allowed — proving the arming actually reaches the chokepoint."""
    import model_tools

    sc.set_session_scope("sess-A", "read_only")

    blocked = json.loads(
        model_tools.handle_function_call("t_write", {}, session_id="sess-A")
    )
    assert blocked.get("refused") is True
    assert "read_only" in blocked["error"]

    allowed = json.loads(
        model_tools.handle_function_call("t_read", {}, session_id="sess-A")
    )
    assert allowed.get("ok") is True

    # A different session with no pin defaults to full → the write runs.
    ran = json.loads(
        model_tools.handle_function_call("t_write", {}, session_id="sess-B")
    )
    assert ran.get("ok") is True


def test_halt_and_session_scope_persist(home):
    assert sc.is_agent_halted() is False
    sc.set_agent_halt(True)
    assert sc.is_agent_halted() is True

    assert sc.get_session_scope("s1") == sc.DEFAULT_SCOPE
    sc.set_session_scope("s1", "triage")
    assert sc.get_session_scope("s1") == "triage"
    with pytest.raises(ValueError):
        sc.set_session_scope("s1", "bogus")


def test_list_scopes():
    names = {s["name"] for s in sc.list_scopes()}
    assert {"full", "read_only", "research", "triage"} <= names
