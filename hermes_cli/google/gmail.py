"""Lean Gmail REST client for the dashboard.

Talks to the Gmail API v1 directly over httpx using an access token from the
unified Google OAuth manager — no google-api-python-client. Covers the read +
triage surface the Email module needs: list/search (via Gmail's own query
syntax), fetch a message or thread, list labels, modify labels (archive, mark
read/unread, star), and trash/untrash. Compose/send lands in a later slice.

Every list render is served from ``list_messages`` (ids only) plus cheap
``metadata`` fetches; the expensive ``full`` format is used only when a message
is opened. ``parse_metadata`` flattens a metadata message into the fields a
list row needs.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

from hermes_cli.google import oauth

_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"


class GmailError(Exception):
    pass


class GmailClient:
    def __init__(self, account: str = "default", *, timeout: float = 20.0):
        self._account = account
        self._timeout = timeout

    # -- transport ---------------------------------------------------------
    def _send(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
        _retry: bool = True,
    ) -> Dict[str, Any]:
        """Perform one authed Gmail request. Refreshes + retries once on 401
        (stale access token); surfaces 429 Retry-After as a GmailError the
        caller can back off on."""
        token = oauth.get_access_token(self._account)
        resp = httpx.request(
            method,
            f"{_BASE}{path}",
            params=params,
            json=json,
            headers={"Authorization": f"Bearer {token}"},
            timeout=self._timeout,
        )
        if resp.status_code == 401 and _retry:
            # Force a refresh by discarding the (now-invalid) access token.
            token_data = _force_expire(self._account)
            if token_data:
                return self._send(method, path, params=params, json=json, _retry=False)
        if resp.status_code == 429:
            raise GmailError(
                f"Gmail rate limited; retry after {resp.headers.get('Retry-After', '?')}s"
            )
        if resp.status_code >= 400:
            raise GmailError(f"Gmail API {resp.status_code}: {resp.text[:200]}")
        if not resp.content:
            return {}
        return resp.json()

    # -- reads -------------------------------------------------------------
    def list_messages(
        self,
        *,
        q: Optional[str] = None,
        label_ids: Optional[List[str]] = None,
        max_results: int = 25,
        page_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        """List message ids matching a Gmail query. Returns
        ``{messages: [{id, threadId}], nextPageToken}``."""
        params: Dict[str, Any] = {"maxResults": max(1, min(int(max_results), 100))}
        if q:
            params["q"] = q
        if label_ids:
            params["labelIds"] = label_ids
        if page_token:
            params["pageToken"] = page_token
        return self._send("GET", "/messages", params=params)

    def get_message(self, message_id: str, *, fmt: str = "metadata") -> Dict[str, Any]:
        params = {"format": fmt}
        if fmt == "metadata":
            params["metadataHeaders"] = ["From", "To", "Subject", "Date"]
        return self._send("GET", f"/messages/{message_id}", params=params)

    def get_thread(self, thread_id: str, *, fmt: str = "metadata") -> Dict[str, Any]:
        return self._send("GET", f"/threads/{thread_id}", params={"format": fmt})

    def list_labels(self) -> Dict[str, Any]:
        return self._send("GET", "/labels")

    # -- label / lifecycle writes -----------------------------------------
    def modify_message(
        self,
        message_id: str,
        *,
        add: Optional[List[str]] = None,
        remove: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        return self._send(
            "POST",
            f"/messages/{message_id}/modify",
            json={"addLabelIds": add or [], "removeLabelIds": remove or []},
        )

    def batch_modify(
        self, message_ids: List[str], *, add: Optional[List[str]] = None,
        remove: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        return self._send(
            "POST",
            "/messages/batchModify",
            json={"ids": message_ids, "addLabelIds": add or [], "removeLabelIds": remove or []},
        )

    def trash_message(self, message_id: str) -> Dict[str, Any]:
        return self._send("POST", f"/messages/{message_id}/trash")

    def untrash_message(self, message_id: str) -> Dict[str, Any]:
        return self._send("POST", f"/messages/{message_id}/untrash")

    # -- send / drafts -----------------------------------------------------
    def send_message(self, raw: str, *, thread_id: Optional[str] = None) -> Dict[str, Any]:
        """Send a base64url RFC 2822 message. ``thread_id`` keeps a reply in
        its conversation (must match the referenced message's thread)."""
        payload: Dict[str, Any] = {"raw": raw}
        if thread_id:
            payload["threadId"] = thread_id
        return self._send("POST", "/messages/send", json=payload)

    def create_draft(self, raw: str, *, thread_id: Optional[str] = None) -> Dict[str, Any]:
        message: Dict[str, Any] = {"raw": raw}
        if thread_id:
            message["threadId"] = thread_id
        return self._send("POST", "/drafts", json={"message": message})

    def update_draft(self, draft_id: str, raw: str, *, thread_id: Optional[str] = None) -> Dict[str, Any]:
        message: Dict[str, Any] = {"raw": raw}
        if thread_id:
            message["threadId"] = thread_id
        return self._send("PUT", f"/drafts/{draft_id}", json={"message": message})

    def send_draft(self, draft_id: str) -> Dict[str, Any]:
        return self._send("POST", "/drafts/send", json={"id": draft_id})

    def list_drafts(self, *, max_results: int = 25) -> Dict[str, Any]:
        return self._send("GET", "/drafts", params={"maxResults": max(1, min(int(max_results), 100))})


def _force_expire(account: str) -> Optional[Dict[str, Any]]:
    """Drop the cached access token so the next get_access_token refreshes.
    Returns the token dict if one exists."""
    from hermes_cli import secure_store

    token = secure_store.load_token("google", account)
    if not token:
        return None
    token.pop("access_token", None)
    token.pop("token", None)
    token["expires_at"] = 0
    secure_store.save_token("google", account, token)
    return token


def _header(headers: List[Dict[str, str]], name: str) -> str:
    lname = name.lower()
    for h in headers:
        if str(h.get("name", "")).lower() == lname:
            return str(h.get("value", ""))
    return ""


def parse_metadata(message: Dict[str, Any]) -> Dict[str, Any]:
    """Flatten a Gmail ``metadata`` message into a list-row shape: sender,
    subject, snippet, date, unread + attachment flags, labels."""
    payload = message.get("payload") or {}
    headers = payload.get("headers") or []
    label_ids = message.get("labelIds") or []
    return {
        "id": message.get("id"),
        "thread_id": message.get("threadId"),
        "from": _header(headers, "From"),
        "to": _header(headers, "To"),
        "subject": _header(headers, "Subject"),
        "date": _header(headers, "Date"),
        "snippet": message.get("snippet", ""),
        "unread": "UNREAD" in label_ids,
        "starred": "STARRED" in label_ids,
        "has_attachment": _has_attachment(payload),
        "labels": label_ids,
    }


def _decode_b64url(data: str) -> str:
    import base64

    try:
        pad = "=" * ((4 - len(data) % 4) % 4)
        return base64.urlsafe_b64decode(data + pad).decode("utf-8", "replace")
    except Exception:
        return ""


def extract_plain_text(message: Dict[str, Any], *, limit: int = 20000) -> str:
    """Best plain-text rendering of a full message for an agent to read:
    prefer text/plain parts; fall back to a crude tag-strip of text/html."""
    payload = message.get("payload") or {}
    text_parts: List[str] = []
    html_parts: List[str] = []

    def walk(part: Dict[str, Any]) -> None:
        mime = part.get("mimeType") or ""
        body = part.get("body") or {}
        if not part.get("filename") and body.get("data"):
            if mime == "text/plain":
                text_parts.append(_decode_b64url(body["data"]))
            elif mime == "text/html":
                html_parts.append(_decode_b64url(body["data"]))
        for child in part.get("parts", []) or []:
            walk(child)

    walk(payload)
    out = "\n".join(text_parts).strip()
    if not out and html_parts:
        import re

        stripped = re.sub(r"<[^>]+>", " ", "\n".join(html_parts))
        out = re.sub(r"[ \t]+", " ", stripped).strip()
    return out[:limit]


def _has_attachment(payload: Dict[str, Any]) -> bool:
    for part in payload.get("parts", []) or []:
        if part.get("filename"):
            return True
        if _has_attachment(part):
            return True
    return False
