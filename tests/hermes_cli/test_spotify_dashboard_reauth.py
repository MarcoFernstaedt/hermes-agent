"""In-interface Spotify re-auth fallback (the token-expiry path).

The live OAuth round-trip (callback + token exchange) needs real Spotify
credentials and a browser, so it can't run here; these cover the verifiable
core: the not-configured guidance path and authorize-URL generation.
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest

from hermes_cli import auth


def test_needs_client_id_when_unconfigured(monkeypatch):
    monkeypatch.setattr(auth, "get_provider_auth_state", lambda _p: {})

    def _raise(*_a, **_k):
        raise auth.AuthError("missing", code="spotify_client_id_missing")

    monkeypatch.setattr(auth, "_spotify_client_id", _raise)
    out = auth.begin_spotify_dashboard_reauth()
    assert out["configured"] is False
    assert out["needs_client_id"] is True
    assert out["docs_url"] and out["dashboard_url"]


def test_returns_authorize_url_when_configured(monkeypatch):
    monkeypatch.setattr(auth, "get_provider_auth_state", lambda _p: {})
    monkeypatch.setattr(auth, "_spotify_client_id", lambda *_a, **_k: "CLIENT123")
    # Don't actually bind the loopback listener — the worker thread is a no-op.
    monkeypatch.setattr(auth, "_spotify_wait_for_callback", lambda *a, **k: {"error": "test-stop"})

    out = auth.begin_spotify_dashboard_reauth()
    assert out["configured"] is True
    url = out["auth_url"]
    parts = urlsplit(url)
    assert parts.netloc  # a real accounts.spotify.com-style host
    q = parse_qs(parts.query)
    assert q["client_id"] == ["CLIENT123"]
    assert q["response_type"] == ["code"]
    assert q["code_challenge_method"] == ["S256"]
    assert "state" in q and "code_challenge" in q
    assert out["redirect_uri"].startswith("http")


def test_status_reports_pending_then_settles(monkeypatch):
    monkeypatch.setattr(auth, "get_provider_auth_state", lambda _p: {})
    monkeypatch.setattr(auth, "_spotify_client_id", lambda *_a, **_k: "CLIENT123")
    # A state mismatch makes the worker settle to error quickly and deterministically.
    monkeypatch.setattr(
        auth, "_spotify_wait_for_callback",
        lambda *a, **k: {"code": "x", "state": "wrong"},
    )
    auth.begin_spotify_dashboard_reauth()
    # Give the daemon worker a beat to settle.
    import time

    for _ in range(50):
        st = auth.spotify_dashboard_reauth_status()
        if st["status"] in ("connected", "error"):
            break
        time.sleep(0.02)
    assert auth.spotify_dashboard_reauth_status()["status"] == "error"
