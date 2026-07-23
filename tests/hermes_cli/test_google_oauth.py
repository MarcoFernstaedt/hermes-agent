"""Tests for the unified Google OAuth token manager."""

import importlib
import time

import pytest


@pytest.fixture()
def google(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("HERMES_TOKEN_KEY", raising=False)
    import hermes_cli.secure_store as secure_store
    import hermes_cli.google.oauth as oauth

    importlib.reload(secure_store)
    importlib.reload(oauth)
    return oauth, secure_store


def _seed(secure_store, **overrides):
    token = {
        "client_id": "cid",
        "client_secret": "csecret",
        "refresh_token": "rtok",
        "access_token": "old-access",
        "token_uri": "https://oauth2.googleapis.com/token",
        "expires_at": time.time() + 3600,  # valid for an hour
        "scopes": ["https://www.googleapis.com/auth/gmail.modify"],
    }
    token.update(overrides)
    secure_store.save_token("google", "default", token)


def test_returns_valid_token_without_refresh(google):
    oauth, secure_store = google
    _seed(secure_store)
    posted = []
    monkeypatch_post(oauth, posted, (200, {}))
    assert oauth.get_access_token() == "old-access"
    assert posted == []  # not expired -> no network call


def test_refreshes_expired_token(google):
    oauth, secure_store = google
    _seed(secure_store, expires_at=time.time() - 10)  # already expired
    posted = []
    monkeypatch_post(oauth, posted, (200, {"access_token": "new-access", "expires_in": 3600}))
    assert oauth.get_access_token() == "new-access"
    assert len(posted) == 1
    # Persisted for next time.
    assert secure_store.load_token("google", "default")["access_token"] == "new-access"


def test_invalid_grant_flags_needs_reauth(google):
    oauth, secure_store = google
    _seed(secure_store, expires_at=time.time() - 10)
    monkeypatch_post(oauth, [], (400, {"error": "invalid_grant"}))
    with pytest.raises(oauth.GoogleReauthRequired):
        oauth.get_access_token()
    assert secure_store.get_status("google", "default") == secure_store.STATUS_NEEDS_REAUTH
    status = oauth.connection_status()
    assert status["connected"] is True
    assert status["needs_reauth"] is True


def test_not_connected_raises(google):
    oauth, _ = google
    with pytest.raises(oauth.GoogleAuthError):
        oauth.get_access_token()
    assert oauth.connection_status()["connected"] is False


def test_expiry_iso_string_is_parsed(google):
    oauth, secure_store = google
    # Google's authorized-user JSON stores expiry as an ISO string.
    _seed(secure_store, expires_at=None, expiry="2020-01-01T00:00:00Z")
    posted = []
    monkeypatch_post(oauth, posted, (200, {"access_token": "fresh", "expires_in": 3600}))
    assert oauth.get_access_token() == "fresh"  # ISO expiry in the past -> refreshed
    assert len(posted) == 1


def monkeypatch_post(oauth, sink, result):
    def fake_post(url, data):
        sink.append({"url": url, "data": data})
        return result

    oauth._post_token = fake_post
