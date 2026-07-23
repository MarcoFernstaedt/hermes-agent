"""Tests for the lean Gmail REST client."""

import importlib

import pytest


@pytest.fixture()
def gmail(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_cli.secure_store as secure_store
    import hermes_cli.google.gmail as gmail_mod
    import hermes_cli.google.oauth as oauth

    importlib.reload(secure_store)
    importlib.reload(oauth)
    importlib.reload(gmail_mod)
    monkeypatch.setattr(oauth, "get_access_token", lambda account="default": "TOK")
    monkeypatch.setattr(gmail_mod.oauth, "get_access_token", lambda account="default": "TOK")
    return gmail_mod


class _Resp:
    def __init__(self, status, payload=None, headers=None, text=""):
        self.status_code = status
        self._payload = payload or {}
        self.headers = headers or {}
        self.text = text
        self.content = b"x" if payload is not None else b""

    def json(self):
        return self._payload


def _record(gmail_mod, monkeypatch, responses):
    calls = []

    def fake_request(method, url, params=None, json=None, headers=None, timeout=None):
        calls.append({"method": method, "url": url, "params": params, "json": json, "headers": headers})
        return responses.pop(0)

    monkeypatch.setattr(gmail_mod.httpx, "request", fake_request)
    return calls


def test_list_messages_builds_query(gmail, monkeypatch):
    calls = _record(gmail, monkeypatch, [_Resp(200, {"messages": [{"id": "1", "threadId": "t1"}]})])
    client = gmail.GmailClient()
    out = client.list_messages(q="is:unread", max_results=500)
    assert out["messages"][0]["id"] == "1"
    assert calls[0]["params"]["q"] == "is:unread"
    assert calls[0]["params"]["maxResults"] == 100  # clamped
    assert calls[0]["headers"]["Authorization"] == "Bearer TOK"


def test_get_message_metadata_requests_headers(gmail, monkeypatch):
    calls = _record(gmail, monkeypatch, [_Resp(200, {"id": "1"})])
    gmail.GmailClient().get_message("1")
    assert calls[0]["params"]["format"] == "metadata"
    assert "Subject" in calls[0]["params"]["metadataHeaders"]


def test_401_triggers_one_refresh_retry(gmail, monkeypatch):
    # Seed a token so _force_expire has something to rewrite.
    import hermes_cli.secure_store as secure_store

    secure_store.save_token("google", "default", {"access_token": "a", "refresh_token": "r"})
    calls = _record(gmail, monkeypatch, [_Resp(401, {}), _Resp(200, {"id": "1"})])
    out = gmail.GmailClient().get_message("1")
    assert out == {"id": "1"}
    assert len(calls) == 2  # retried once after refresh


def test_429_raises_rate_limit(gmail, monkeypatch):
    _record(gmail, monkeypatch, [_Resp(429, {}, headers={"Retry-After": "3"})])
    with pytest.raises(gmail.GmailError) as exc:
        gmail.GmailClient().list_messages()
    assert "rate limited" in str(exc.value)


def test_modify_and_trash_issue_correct_requests(gmail, monkeypatch):
    calls = _record(gmail, monkeypatch, [_Resp(200, {}), _Resp(200, {})])
    client = gmail.GmailClient()
    client.modify_message("m1", remove=["UNREAD", "INBOX"])
    client.trash_message("m2")
    assert calls[0]["url"].endswith("/messages/m1/modify")
    assert calls[0]["json"]["removeLabelIds"] == ["UNREAD", "INBOX"]
    assert calls[1]["url"].endswith("/messages/m2/trash")


def test_parse_metadata_flattens_row():
    msg = {
        "id": "1",
        "threadId": "t1",
        "snippet": "hello there",
        "labelIds": ["UNREAD", "INBOX", "STARRED"],
        "payload": {
            "headers": [
                {"name": "From", "value": "Alice <a@example.com>"},
                {"name": "Subject", "value": "Hi"},
                {"name": "Date", "value": "Wed, 23 Jul 2026 10:00:00 -0700"},
            ],
            "parts": [{"filename": "report.pdf", "mimeType": "application/pdf"}],
        },
    }
    from hermes_cli.google.gmail import parse_metadata

    row = parse_metadata(msg)
    assert row["from"] == "Alice <a@example.com>"
    assert row["subject"] == "Hi"
    assert row["unread"] is True
    assert row["starred"] is True
    assert row["has_attachment"] is True
    assert row["thread_id"] == "t1"
