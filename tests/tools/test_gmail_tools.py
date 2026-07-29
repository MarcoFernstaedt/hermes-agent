"""Tests for the native Gmail agent tools (search / read / draft)."""

import importlib
import json

import pytest


@pytest.fixture()
def gmail_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_cli.audit_log as audit_log
    import tools.gmail_tools as gt

    importlib.reload(audit_log)

    class _Fake:
        def list_messages(self, **kw):
            return {"messages": [{"id": "m1", "threadId": "t1"}], "nextPageToken": "np"}

        def get_message(self, mid, fmt="metadata"):
            return {
                "id": mid, "threadId": "t1", "snippet": "hi",
                "labelIds": ["UNREAD"],
                "payload": {
                    "mimeType": "text/plain",
                    "headers": [{"name": "Subject", "value": "Hello"}],
                    "body": {"data": "aGVsbG8gYm9keQ"},  # "hello body"
                },
            }

        def create_draft(self, raw, thread_id=None):
            self.raw = raw
            return {"id": "draft-1"}

    monkeypatch.setattr(gt, "_client", lambda: _Fake())
    return gt, audit_log


def _payload(result: str) -> dict:
    return json.loads(result)


def test_search_returns_rows(gmail_tools):
    gt, _ = gmail_tools
    out = _payload(gt._handle_gmail_search({"query": "is:unread"}))
    # tool_result wraps data; find the messages regardless of envelope shape.
    text = json.dumps(out)
    assert "m1" in text and "Hello" in text


def test_read_includes_body_text(gmail_tools):
    gt, _ = gmail_tools
    out = json.dumps(_payload(gt._handle_gmail_read({"message_id": "m1"})))
    assert "hello body" in out
    assert "Hello" in out


def test_read_requires_id(gmail_tools):
    gt, _ = gmail_tools
    out = json.dumps(_payload(gt._handle_gmail_read({})))
    assert "required" in out.lower()


def test_draft_creates_and_audits(gmail_tools):
    gt, audit_log = gmail_tools
    out = json.dumps(_payload(gt._handle_gmail_draft({"to": "a@x.com", "subject": "Hi", "body": "yo"})))
    assert "draft-1" in out
    assert "cannot send" in out.lower()  # explicit no-send note
    entries = audit_log.query(module="email")
    assert len(entries) == 1
    assert entries[0]["action"] == "draft.create"
    assert "a@x.com" in entries[0]["target"]


def test_draft_requires_recipient(gmail_tools):
    gt, audit_log = gmail_tools
    out = json.dumps(_payload(gt._handle_gmail_draft({"subject": "x"})))
    assert "required" in out.lower()
    assert audit_log.query(module="email") == []  # nothing drafted, nothing audited


def test_permission_tiers_registered():
    import tools.gmail_tools  # noqa: F401  (self-registers on import)
    from hermes_cli.module_permissions import Tier, get_tier

    assert get_tier("gmail_search") is Tier.AUTO
    assert get_tier("gmail_draft") is Tier.APPROVAL
    # Never registered -> fail safe. The agent has no direct send tool.
    assert get_tier("gmail_send") is Tier.ALWAYS_APPROVAL
