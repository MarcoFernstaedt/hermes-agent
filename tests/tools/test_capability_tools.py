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


def test_list_filters_by_status(temp_store, monkeypatch):
    monkeypatch.setattr("hermes_cli.audit_log.record", lambda **kw: None, raising=False)
    a = json.loads(_handler("reading_create")({"title": "A"}))
    _handler("reading_create")({"title": "B"})
    _handler("reading_advance")({"id": a["id"], "to": "reading"})

    reading = json.loads(_handler("reading_list")({"status": "reading"}))
    assert reading["total"] == 1
    assert reading["items"][0]["title"] == "A"
