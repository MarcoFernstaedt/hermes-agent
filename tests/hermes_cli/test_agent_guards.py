"""Agent guards — outbound secret-scan, rate ceilings, anomaly flags."""
from __future__ import annotations

import pytest

from hermes_cli import agent_guards as g
from hermes_cli.module_permissions import Tier


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "state").mkdir(parents=True)
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: h)
    return h


@pytest.fixture(autouse=True)
def _clean():
    g.reset_state()
    yield
    g.reset_state()


def test_categorize():
    assert g.categorize("bookmark_get", Tier.AUTO) is None
    assert g.categorize("email_send", Tier.APPROVAL) == g.SEND
    assert g.categorize("gmail_reply", Tier.APPROVAL) == g.SEND
    assert g.categorize("entity_delete", Tier.ALWAYS_APPROVAL) == g.DELETE
    assert g.categorize("email_trash", Tier.APPROVAL) == g.DELETE
    assert g.categorize("write_file", Tier.APPROVAL) == g.WRITE


def test_scan_secrets_detects_high_confidence():
    assert "aws_access_key" in g.scan_secrets("here AKIAABCDEFGHIJKLMNOP end")
    assert "private_key_block" in g.scan_secrets("-----BEGIN RSA PRIVATE KEY-----\nx")
    assert "github_token" in g.scan_secrets("ghp_" + "a" * 40)
    assert g.scan_secrets("just a normal sentence with no secrets") == []


def test_outbound_secret_blocks_send_in_enforce(home, monkeypatch):
    monkeypatch.setenv("HERMES_OUTBOUND_SECRET_SCAN", "enforce")
    refusal = g.pre_dispatch_check(
        "email_send",
        {"to": "a@b.c", "body": "my key is AKIAABCDEFGHIJKLMNOP"},
        tier=Tier.APPROVAL,
    )
    assert refusal is not None
    assert "credential" in refusal.lower()


def test_outbound_secret_observed_not_blocked(home, monkeypatch):
    monkeypatch.setenv("HERMES_OUTBOUND_SECRET_SCAN", "observe")
    refusal = g.pre_dispatch_check(
        "email_send",
        {"to": "a@b.c", "body": "ghp_" + "b" * 40},
        tier=Tier.APPROVAL,
    )
    assert refusal is None
    from hermes_cli import audit_log

    rows = audit_log.query(module="agent_guards", limit=10)
    assert any(r["action"] == "outbound_secret_detected" for r in rows)


def test_secret_scan_does_not_touch_writes(home, monkeypatch):
    monkeypatch.setenv("HERMES_OUTBOUND_SECRET_SCAN", "enforce")
    # A write (not a send) carrying a secret-looking string is not an outbound
    # leak — e.g. saving your own key to the vault. Not blocked by the scan.
    assert (
        g.pre_dispatch_check(
            "write_file",
            {"path": "/vault/keys.md", "content": "AKIAABCDEFGHIJKLMNOP"},
            tier=Tier.APPROVAL,
        )
        is None
    )


def test_rate_ceiling_enforced(home, monkeypatch):
    monkeypatch.setenv("HERMES_AGENT_RATE_LIMIT", "enforce")
    monkeypatch.setenv("HERMES_RATE_LIMIT_SEND", "3")
    for _ in range(3):
        assert g.pre_dispatch_check("email_send", {"to": "a@b.c"}, tier=Tier.APPROVAL) is None
    blocked = g.pre_dispatch_check("email_send", {"to": "a@b.c"}, tier=Tier.APPROVAL)
    assert blocked is not None
    assert "rate ceiling" in blocked.lower()


def test_rate_ceiling_observe_allows_but_audits(home, monkeypatch):
    monkeypatch.setenv("HERMES_AGENT_RATE_LIMIT", "observe")
    monkeypatch.setenv("HERMES_RATE_LIMIT_WRITE", "2")
    for _ in range(4):
        assert g.pre_dispatch_check("write_file", {"p": 1}, tier=Tier.APPROVAL) is None
    from hermes_cli import audit_log

    rows = audit_log.query(module="agent_guards", limit=20)
    assert any(r["action"] == "rate_ceiling_exceeded" for r in rows)


def test_reads_are_never_gated(home, monkeypatch):
    monkeypatch.setenv("HERMES_AGENT_RATE_LIMIT", "enforce")
    monkeypatch.setenv("HERMES_RATE_LIMIT_WRITE", "1")
    for _ in range(50):
        assert g.pre_dispatch_check("bookmark_list", {}, tier=Tier.AUTO) is None


def test_burst_delete_flag(home):
    from hermes_cli import audit_log

    for _ in range(g._BURST_DELETE_THRESHOLD):
        g.pre_dispatch_check("entity_delete", {"id": "x"}, tier=Tier.ALWAYS_APPROVAL)
    rows = audit_log.query(module="agent_guards", limit=20)
    assert any(r["action"] == "burst_delete" for r in rows)
