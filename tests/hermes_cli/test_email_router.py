"""Tests for the Gmail read/triage router, using a fake client."""

import importlib

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402


class _FakeClient:
    def __init__(self):
        self.calls = []

    def list_labels(self):
        return {"labels": [{"id": "INBOX", "name": "INBOX"}]}

    def list_messages(self, **kw):
        self.calls.append(("list", kw))
        return {"messages": [{"id": "m1", "threadId": "t1"}], "nextPageToken": "np"}

    def get_message(self, mid, fmt="metadata"):
        return {
            "id": mid,
            "threadId": "t1",
            "snippet": "hi",
            "labelIds": ["UNREAD", "INBOX"],
            "payload": {"headers": [{"name": "Subject", "value": "Hello"}]},
        }

    def modify_message(self, mid, add=None, remove=None):
        self.calls.append(("modify", mid, add, remove))
        return {"id": mid, "labelIds": []}

    def trash_message(self, mid):
        self.calls.append(("trash", mid))
        return {"id": mid, "labelIds": ["TRASH"]}

    def send_message(self, raw, thread_id=None):
        self.calls.append(("send", raw, thread_id))
        return {"id": "sent1", "threadId": thread_id or "t9"}

    def create_draft(self, raw, thread_id=None):
        self.calls.append(("draft", raw, thread_id))
        return {"id": "d1"}

    def send_draft(self, draft_id):
        self.calls.append(("send_draft", draft_id))
        return {"id": "sent2"}

    def list_drafts(self, max_results=25):
        return {"drafts": []}


def _client(fake):
    from hermes_cli.email.router import create_email_router

    app = FastAPI()
    app.include_router(create_email_router(lambda: None, client_factory=lambda: fake))
    return TestClient(app)


def test_labels_and_list_and_metadata():
    fake = _FakeClient()
    c = _client(fake)

    assert c.get("/api/email/labels").json()["labels"][0]["id"] == "INBOX"

    listed = c.get("/api/email/messages?q=is:unread&max_results=10").json()
    assert listed["messages"][0]["id"] == "m1"
    assert listed["nextPageToken"] == "np"

    meta = c.post("/api/email/messages/metadata", json={"ids": ["m1"]}).json()
    row = meta["messages"][0]
    assert row["subject"] == "Hello"
    assert row["unread"] is True


def test_modify_and_trash():
    fake = _FakeClient()
    c = _client(fake)
    assert c.post("/api/email/messages/m1/modify", json={"remove": ["UNREAD"]}).status_code == 200
    assert c.post("/api/email/messages/m2/trash").status_code == 200
    assert ("modify", "m1", [], ["UNREAD"]) in fake.calls
    assert ("trash", "m2") in fake.calls


def test_send_requires_recipient_and_sends():
    fake = _FakeClient()
    c = _client(fake)
    # No recipient -> 422 before any client call.
    assert c.post("/api/email/send", json={"subject": "x", "body": "y"}).status_code == 422
    # With a recipient -> sends.
    resp = c.post(
        "/api/email/send",
        json={"to": ["a@x.com"], "subject": "Hi", "body": "yo", "thread_id": "t1"},
    )
    assert resp.status_code == 200
    assert resp.json()["id"] == "sent1"
    assert any(call[0] == "send" and call[2] == "t1" for call in fake.calls)


def test_draft_create_and_send():
    fake = _FakeClient()
    c = _client(fake)
    assert c.post("/api/email/drafts", json={"to": ["a@x.com"], "body": "hi"}).json()["id"] == "d1"
    assert c.post("/api/email/drafts/d1/send").json()["id"] == "sent2"


def test_reauth_maps_to_409():
    from hermes_cli.google import GoogleReauthRequired

    class _Dead:
        def list_labels(self):
            raise GoogleReauthRequired("dead")

    c = _client(_Dead())
    resp = c.get("/api/email/labels")
    assert resp.status_code == 409
    assert resp.json()["detail"] == "google_needs_reauth"


def test_connection_reports_not_connected(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_cli.secure_store as secure_store
    import hermes_cli.google.oauth as oauth

    importlib.reload(secure_store)
    importlib.reload(oauth)

    c = _client(_FakeClient())
    body = c.get("/api/email/connection").json()
    assert body["connected"] is False
