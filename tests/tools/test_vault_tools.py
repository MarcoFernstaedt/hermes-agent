"""Tests for native Obsidian vault agent tools."""

import importlib
import json

import pytest


@pytest.fixture()
def vt(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    root.mkdir()
    monkeypatch.setenv("HERMES_VAULT_PATH", str(root))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    import hermes_cli.vault.config as config
    import hermes_cli.vault.paths as paths
    import hermes_cli.vault.notes as notes
    import hermes_cli.audit_log as audit_log
    import tools.vault_tools as vt

    for m in (config, paths, notes, audit_log, vt):
        importlib.reload(m)
    return vt, notes, audit_log


def test_read_search_are_reads(vt):
    vtmod, notes, audit_log = vt
    notes.create_note("a.md", "# A\n\nhello world #topic\n")
    assert "A" in json.dumps(json.loads(vtmod._handle_read({"path": "a.md"})))
    assert "a.md" in json.dumps(json.loads(vtmod._handle_search({"query": "hello"})))
    assert audit_log.query(module="vault") == []


def test_append_and_create_audited(vt):
    vtmod, _, audit_log = vt
    json.loads(vtmod._handle_create({"path": "n.md", "content": "x"}))
    json.loads(vtmod._handle_append({"path": "n.md", "text": "more"}))
    actions = [e["action"] for e in audit_log.query(module="vault")]
    assert "note.create" in actions and "note.append" in actions


def test_append_daily_creates_dated_note(vt):
    import datetime

    vtmod, notes, _ = vt
    json.loads(vtmod._handle_append_daily({"text": "journal entry"}))
    today = datetime.date.today().isoformat()
    parsed = notes.read_note(f"daily/{today}.md")
    assert "journal entry" in parsed["body"]


def test_traversal_refused(vt):
    vtmod, _, _ = vt
    out = json.dumps(json.loads(vtmod._handle_read({"path": "../../etc/passwd"})))
    assert "outside the vault" in out.lower()


def test_permission_tiers():
    import tools.vault_tools  # noqa: F401
    from hermes_cli.module_permissions import Tier, get_tier

    assert get_tier("vault_read") is Tier.AUTO
    assert get_tier("vault_append") is Tier.APPROVAL
    assert get_tier("vault_create") is Tier.APPROVAL
    # No overwrite/delete tools -> fail safe.
    assert get_tier("vault_overwrite") is Tier.ALWAYS_APPROVAL
    assert get_tier("vault_delete") is Tier.ALWAYS_APPROVAL
