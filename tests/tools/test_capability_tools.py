from __future__ import annotations

import json

import pytest

from hermes_cli.capabilities import declarations as decl


def test_legal_transitions_and_coerce():
    lc = {
        "field": "status",
        "states": ["a", "b", "c"],
        "initial": "a",
        "transitions": [{"from": "a", "to": ["b"]}, {"from": "*", "to": ["c"]}],
    }
    assert sorted(decl.legal_transitions(lc, "a")) == ["b", "c"]
    assert decl.can_transition(lc, "a", "b") is True
    assert decl.can_transition(lc, "a", "z") is False
    assert decl.can_transition(lc, "b", "c") is True  # via '*'

    cap = {"fields": [{"name": "title"}, {"name": "status"}]}
    assert decl.coerce_fields(cap, {"title": "x", "junk": 1}) == {"title": "x"}


def test_build_tools_generates_expected_toolset():
    import tools.capability_tools as ct

    tools = ct.build_tools()
    names = {t[0]: t[4] for t in tools}  # name -> tier
    assert names.get("reading_list") == "auto"
    assert names.get("reading_get") == "auto"
    assert names.get("reading_create") == "approval"
    assert names.get("reading_advance") == "approval"
    # Delete is never generated (stays fail-safe).
    assert "reading_delete" not in names
    # A second declaration (tasks.json) generates its toolset from the same
    # generator with no bespoke code — reads AUTO, writes APPROVAL, no delete.
    assert names.get("task_list") == "auto"
    assert names.get("task_get") == "auto"
    assert names.get("task_create") == "approval"
    assert names.get("task_advance") == "approval"
    assert "task_delete" not in names


@pytest.fixture
def temp_store(tmp_path, monkeypatch):
    from hermes_cli.entities import router as ent_router

    db = tmp_path / "entities.sqlite3"
    monkeypatch.setattr(ent_router, "default_database_path", lambda: db)
    return db


def _handler(name):
    import tools.capability_tools as ct

    for n, _ts, _schema, handler, _tier in ct.build_tools():
        if n == name:
            return handler
    raise AssertionError(f"tool {name} not built")


def test_create_list_get_advance_flow(temp_store, monkeypatch):
    monkeypatch.setattr("hermes_cli.audit_log.record", lambda **kw: None, raising=False)

    created = json.loads(_handler("reading_create")({"title": "Dune", "author": "Herbert"}))
    assert created["title"] == "Dune"
    assert created["status"] == "to_read"  # defaulted to initial
    rid = created["id"]

    listed = json.loads(_handler("reading_list")({}))
    assert listed["total"] == 1
    assert listed["items"][0]["id"] == rid

    got = json.loads(_handler("reading_get")({"id": rid}))
    assert got["author"] == "Herbert"

    advanced = json.loads(_handler("reading_advance")({"id": rid, "to": "reading"}))
    assert advanced["status"] == "reading"
    assert advanced["version"] == 2


def test_advance_rejects_illegal_transition(temp_store, monkeypatch):
    monkeypatch.setattr("hermes_cli.audit_log.record", lambda **kw: None, raising=False)
    created = json.loads(_handler("reading_create")({"title": "X"}))
    # to_read -> done is not a legal transition (must go through reading).
    out = json.loads(_handler("reading_advance")({"id": created["id"], "to": "done"}))
    assert "error" in out
    assert "Cannot move" in out["error"]


def test_notify_dashboard_noop_without_env(monkeypatch):
    import tools.capability_tools as ct

    monkeypatch.delenv("HERMES_TUI_SIDECAR_URL", raising=False)
    # No URL → returns cleanly, opens nothing.
    ct._notify_dashboard("task", "id1", "created", 1)


def test_notify_dashboard_posts_hint(monkeypatch):
    import urllib.request

    import tools.capability_tools as ct

    monkeypatch.setenv(
        "HERMES_TUI_SIDECAR_URL", "ws://127.0.0.1:9119/api/pub?token=SEKRET&channel=tab-7"
    )
    captured: dict = {}

    class _FakeOpener:
        def open(self, req, timeout=None):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["token"] = req.headers.get("X-hermes-session-token")
            captured["body"] = req.data

            class _R:
                def read(self_inner):
                    return b""

            return _R()

    monkeypatch.setattr(urllib.request, "build_opener", lambda *a, **k: _FakeOpener())
    ct._notify_dashboard("task", "id1", "created", 3)

    assert captured["url"] == "http://127.0.0.1:9119/api/entities/task/id1/notify"
    assert captured["method"] == "POST"
    assert captured["token"] == "SEKRET"
    assert json.loads(captured["body"]) == {"action": "created", "version": 3}


def test_notify_dashboard_skips_gated_internal_credential(monkeypatch):
    import urllib.request

    import tools.capability_tools as ct

    # Gated binds authenticate the sidecar with ?internal=, not a session token
    # — nothing to reuse for a REST call, so notify must not attempt a request.
    monkeypatch.setenv(
        "HERMES_TUI_SIDECAR_URL", "ws://127.0.0.1:9119/api/pub?internal=CRED&channel=tab-7"
    )

    def _boom(*a, **k):
        raise AssertionError("must not open a connection without a token")

    monkeypatch.setattr(urllib.request, "build_opener", _boom)
    ct._notify_dashboard("task", "id1", "created", 1)


def test_list_filters_by_status(temp_store, monkeypatch):
    monkeypatch.setattr("hermes_cli.audit_log.record", lambda **kw: None, raising=False)
    a = json.loads(_handler("reading_create")({"title": "A"}))
    _handler("reading_create")({"title": "B"})
    _handler("reading_advance")({"id": a["id"], "to": "reading"})

    reading = json.loads(_handler("reading_list")({"status": "reading"}))
    assert reading["total"] == 1
    assert reading["items"][0]["title"] == "A"
