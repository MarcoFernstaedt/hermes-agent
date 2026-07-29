"""Shared authed request helper for Google REST APIs.

One place for the Bearer-token + 401-refresh-retry + 429 handling that Gmail,
Calendar and Tasks all need, so each client is just endpoint shapes.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import httpx

from hermes_cli.google import oauth


class GoogleApiError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def google_request(
    base: str,
    method: str,
    path: str,
    *,
    account: str = "default",
    params: Optional[Dict[str, Any]] = None,
    json: Optional[Dict[str, Any]] = None,
    timeout: float = 20.0,
    _retry: bool = True,
) -> Dict[str, Any]:
    token = oauth.get_access_token(account)
    resp = httpx.request(
        method,
        f"{base}{path}",
        params=params,
        json=json,
        headers={"Authorization": f"Bearer {token}"},
        timeout=timeout,
    )
    if resp.status_code == 401 and _retry:
        _force_expire(account)
        return google_request(
            base, method, path, account=account, params=params, json=json,
            timeout=timeout, _retry=False,
        )
    if resp.status_code == 429:
        raise GoogleApiError(
            f"Google rate limited; retry after {resp.headers.get('Retry-After', '?')}s",
            429,
        )
    if resp.status_code >= 400:
        raise GoogleApiError(f"Google API {resp.status_code}: {resp.text[:200]}", resp.status_code)
    if not resp.content:
        return {}
    return resp.json()


def _force_expire(account: str) -> None:
    from hermes_cli import secure_store

    token = secure_store.load_token("google", account)
    if not token:
        return
    token.pop("access_token", None)
    token.pop("token", None)
    token["expires_at"] = 0
    secure_store.save_token("google", account, token)
