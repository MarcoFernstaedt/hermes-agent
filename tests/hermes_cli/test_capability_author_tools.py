"""The capability-authoring agent tools: propose (never apply), validated."""
from __future__ import annotations

import json

import pytest


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "state").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: h)
    return h


def valid_decl() -> dict:
    return {
        "id": "recipes",
        "label": "Recipes",
        "title_field": "name",
        "fields": [{"name": "name", "label": "Name", "type": "text"}],
        "views": [{"id": "table", "kind": "table", "default": True}],
    }


def test_permissions_are_registered():
    from hermes_cli.module_permissions import Tier, get_tier
    import tools.capability_author_tools  # noqa: F401 — registers on import

    assert get_tier("capability_list") is Tier.AUTO
    assert get_tier("capability_propose") is Tier.APPROVAL  # gated — never AUTO


def test_propose_files_a_pending_proposal(home):
    from tools.capability_author_tools import _handle_propose

    out = json.loads(_handle_propose({"declaration": valid_decl(), "summary": "cook"}))
    assert out["proposed"] is True
    assert out["status"] == "pending"

    # It is queued, not applied — the capability does not exist yet.
    from hermes_cli.capabilities.declarations import load_capabilities
    assert not any(c["id"] == "recipes" for c in load_capabilities())

    # ...but the proposal is in the queue for approval.
    from hermes_cli.review.store import ReviewStore
    store = ReviewStore(home / "state" / "review.sqlite3")
    pending = store.list(status="pending")
    assert len(pending) == 1 and pending[0]["kind"] == "capability"


def test_propose_rejects_invalid_declaration(home):
    from tools.capability_author_tools import _handle_propose

    bad = valid_decl()
    bad["fields"] = []  # invalid
    out = json.loads(_handle_propose({"declaration": bad}))
    assert "error" in out
    assert "validation" in out["error"].lower()

    # Nothing queued when validation fails.
    from hermes_cli.review.store import ReviewStore
    store = ReviewStore(home / "state" / "review.sqlite3")
    assert store.list() == []


def test_propose_accepts_json_string_declaration(home):
    from tools.capability_author_tools import _handle_propose

    out = json.loads(_handle_propose({"declaration": json.dumps(valid_decl())}))
    assert out["proposed"] is True


def test_list_reports_existing(home):
    from tools.capability_author_tools import _handle_list

    out = json.loads(_handle_list({}))
    ids = {c["id"] for c in out["capabilities"]}
    assert {"tasks", "contacts", "reading"} <= ids
