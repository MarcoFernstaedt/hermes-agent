"""Google OAuth token management for the dashboard.

Reads the Google token from the encrypted store, returns a valid access token,
and refreshes it against Google's token endpoint when it has expired — all over
httpx, no Google SDK. Refresh failure (a revoked or expired refresh token,
which Google returns as ``invalid_grant``) is a first-class state, not a crash:
the account is flagged ``needs_reauth`` in the store so the UI can keep serving
cached data read-only and prompt for a one-click reconnect.

Token payload shape is Google's "authorized user" JSON (what the Workspace
skill wrote and Phase 0 imported): it carries ``client_id``, ``client_secret``,
``refresh_token``, ``token``/``access_token``, ``token_uri`` and ``expiry``.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx

from hermes_cli import secure_store

_DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token"
_PROVIDER = "google"
# Refresh a little early so an in-flight request never races expiry.
_EXPIRY_SKEW_SECONDS = 60


class GoogleAuthError(Exception):
    """Google is not connected, or the token is unusable for a reason other
    than an expired refresh token."""


class GoogleReauthRequired(GoogleAuthError):
    """The refresh token was revoked or expired (``invalid_grant``). The user
    must reconnect. The account has been flagged ``needs_reauth`` in the store."""


def _access_token(token: Dict[str, Any]) -> Optional[str]:
    return token.get("access_token") or token.get("token")


def _expiry_epoch(token: Dict[str, Any]) -> float:
    """Return the token's expiry as a UNIX timestamp, or 0 if unknown."""
    raw = token.get("expires_at")
    if isinstance(raw, (int, float)):
        return float(raw)
    iso = token.get("expiry")
    if isinstance(iso, str) and iso:
        text = iso.replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return 0.0
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    return 0.0


def _is_expired(token: Dict[str, Any]) -> bool:
    if not _access_token(token):
        return True
    exp = _expiry_epoch(token)
    if exp <= 0:
        return True  # unknown expiry — refresh to be safe
    return time.time() >= (exp - _EXPIRY_SKEW_SECONDS)


# Seam for tests: the single outbound token POST. Returns (status, json).
def _post_token(url: str, data: Dict[str, str]) -> "tuple[int, Dict[str, Any]]":
    resp = httpx.post(url, data=data, timeout=15.0)
    try:
        payload = resp.json()
    except Exception:
        payload = {}
    return resp.status_code, payload


def _refresh(account: str, token: Dict[str, Any]) -> Dict[str, Any]:
    client_id = token.get("client_id")
    client_secret = token.get("client_secret")
    refresh = token.get("refresh_token")
    if not (client_id and client_secret and refresh):
        raise GoogleAuthError(
            "Google token is missing client credentials; reconnect required."
        )
    url = token.get("token_uri") or _DEFAULT_TOKEN_URL
    status, payload = _post_token(
        url,
        {
            "grant_type": "refresh_token",
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh,
        },
    )
    if status == 400 and payload.get("error") == "invalid_grant":
        secure_store.set_status(_PROVIDER, account, secure_store.STATUS_NEEDS_REAUTH)
        raise GoogleReauthRequired(
            "Google refresh token was revoked or expired; reconnect required."
        )
    if status != 200 or "access_token" not in payload:
        raise GoogleAuthError(
            f"Google token refresh failed ({status}): {payload.get('error', 'unknown')}"
        )

    updated = dict(token)
    updated["access_token"] = payload["access_token"]
    updated.pop("token", None)  # collapse to a single access-token key
    expires_in = payload.get("expires_in")
    if isinstance(expires_in, (int, float)):
        updated["expires_at"] = time.time() + float(expires_in)
        updated.pop("expiry", None)
    # Google may rotate the refresh token; keep the new one if provided.
    if payload.get("refresh_token"):
        updated["refresh_token"] = payload["refresh_token"]
    secure_store.save_token(_PROVIDER, account, updated, status=secure_store.STATUS_ACTIVE)
    return updated


def get_access_token(account: str = "default") -> str:
    """Return a valid Google access token, refreshing if necessary.

    Raises ``GoogleAuthError`` if not connected, or ``GoogleReauthRequired`` if
    the refresh token is dead (the account is flagged needs_reauth first)."""
    token = secure_store.load_token(_PROVIDER, account)
    if not token:
        raise GoogleAuthError("Google is not connected.")
    if _is_expired(token):
        token = _refresh(account, token)
    access = _access_token(token)
    if not access:
        raise GoogleAuthError("Google token has no access token; reconnect required.")
    return access


def connection_status(account: str = "default") -> Dict[str, Any]:
    """Report connection state for the connected-accounts UI. Never returns
    token material."""
    token = secure_store.load_token(_PROVIDER, account)
    status = secure_store.get_status(_PROVIDER, account)
    scopes = []
    if token:
        raw = token.get("scopes") or token.get("scope") or []
        scopes = raw.split() if isinstance(raw, str) else list(raw)
    return {
        "connected": token is not None,
        "needs_reauth": status == secure_store.STATUS_NEEDS_REAUTH,
        "account": (token or {}).get("account") or account if token else None,
        "scopes": scopes,
    }
