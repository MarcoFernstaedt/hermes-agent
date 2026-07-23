"""Encrypted-at-rest store for OAuth tokens and other per-account secrets.

Every external integration (Spotify, Google, ...) persists its access and
refresh tokens here rather than in plaintext on disk. Tokens are encrypted
with a machine-local Fernet key and kept in a small SQLite database alongside
the other ``~/.hermes`` state. The store also tracks a per-account status so a
revoked or expired refresh token surfaces as a first-class ``needs_reauth``
state the UI can act on, instead of a crash or silent stall.

Threat model, stated honestly: this protects tokens against casual disk
access, accidental inclusion in a backup or a commit, and log leakage. It is
NOT protection against an attacker who already has read access to
``~/.hermes``, because the encryption key lives there too — a self-hosted,
single-user app has no KMS to lean on. Set ``HERMES_TOKEN_KEY`` (a urlsafe
base64 Fernet key) to supply the key from a real secret manager and keep it
off disk entirely.

The store never logs token material and never returns it except through the
explicit ``load_token`` call.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from cryptography.fernet import Fernet, InvalidToken

from hermes_cli.config import get_hermes_home

# Per-account lifecycle status. ``active`` tokens are usable; ``needs_reauth``
# means the refresh token was revoked/expired and the user must reconnect —
# the UI keeps serving cached data read-only while this is set.
STATUS_ACTIVE = "active"
STATUS_NEEDS_REAUTH = "needs_reauth"
_VALID_STATUSES = {STATUS_ACTIVE, STATUS_NEEDS_REAUTH}

_KEY_ENV = "HERMES_TOKEN_KEY"
_KEY_FILENAME = "token_store.key"
_DB_FILENAME = "oauth_tokens.db"

_lock = threading.RLock()


def _hermes_home() -> Path:
    home = Path(get_hermes_home())
    home.mkdir(parents=True, exist_ok=True)
    return home


def _key_path() -> Path:
    return _hermes_home() / _KEY_FILENAME


def _load_or_create_key() -> bytes:
    """Resolve the Fernet key: env override first, then an on-disk key file
    created once with owner-only permissions."""
    env_key = os.environ.get(_KEY_ENV, "").strip()
    if env_key:
        return env_key.encode("utf-8")

    path = _key_path()
    if path.exists():
        return path.read_bytes().strip()

    key = Fernet.generate_key()
    # Write the key with owner-only perms. Create the file restricted from the
    # start rather than chmod-after-write so it is never briefly world-readable.
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, key)
    finally:
        os.close(fd)
    return key


def _fernet() -> Fernet:
    return Fernet(_load_or_create_key())


def _db_path() -> Path:
    return _hermes_home() / _DB_FILENAME


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()))
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS oauth_tokens (
            provider   TEXT NOT NULL,
            account    TEXT NOT NULL,
            ciphertext BLOB NOT NULL,
            status     TEXT NOT NULL DEFAULT 'active',
            updated_at REAL NOT NULL,
            PRIMARY KEY (provider, account)
        )
        """
    )
    return conn


def save_token(
    provider: str,
    account: str,
    token: Dict[str, Any],
    status: str = STATUS_ACTIVE,
) -> None:
    """Encrypt and persist a token payload for ``(provider, account)``.

    ``token`` is any JSON-serialisable dict (access_token, refresh_token,
    expiry, scope, ...). Overwrites any existing entry. Saving always sets a
    fresh ``updated_at`` and, by default, marks the account active again.
    """
    if status not in _VALID_STATUSES:
        raise ValueError(f"invalid status: {status!r}")
    blob = _fernet().encrypt(json.dumps(token).encode("utf-8"))
    with _lock, _connect() as conn:
        conn.execute(
            """
            INSERT INTO oauth_tokens (provider, account, ciphertext, status, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(provider, account) DO UPDATE SET
                ciphertext = excluded.ciphertext,
                status = excluded.status,
                updated_at = excluded.updated_at
            """,
            (provider, account, blob, status, time.time()),
        )


def load_token(provider: str, account: str) -> Optional[Dict[str, Any]]:
    """Return the decrypted token payload, or ``None`` if absent.

    Raises ``InvalidToken`` only if the ciphertext cannot be decrypted with
    the current key (e.g. the key file was replaced), which is a real,
    surfaceable error rather than a silent empty return.
    """
    with _lock, _connect() as conn:
        row = conn.execute(
            "SELECT ciphertext FROM oauth_tokens WHERE provider = ? AND account = ?",
            (provider, account),
        ).fetchone()
    if row is None:
        return None
    plain = _fernet().decrypt(row[0])
    return json.loads(plain.decode("utf-8"))


def get_status(provider: str, account: str) -> Optional[str]:
    with _lock, _connect() as conn:
        row = conn.execute(
            "SELECT status FROM oauth_tokens WHERE provider = ? AND account = ?",
            (provider, account),
        ).fetchone()
    return row[0] if row else None


def set_status(provider: str, account: str, status: str) -> None:
    """Update lifecycle status without touching the token payload. Used to
    flip an account to ``needs_reauth`` when a refresh fails."""
    if status not in _VALID_STATUSES:
        raise ValueError(f"invalid status: {status!r}")
    with _lock, _connect() as conn:
        conn.execute(
            "UPDATE oauth_tokens SET status = ?, updated_at = ? "
            "WHERE provider = ? AND account = ?",
            (status, time.time(), provider, account),
        )


def list_accounts() -> List[Dict[str, Any]]:
    """List connected accounts (metadata only — never token material). Drives
    the 'connected accounts' UI: provider, account, status, updated_at."""
    with _lock, _connect() as conn:
        rows = conn.execute(
            "SELECT provider, account, status, updated_at FROM oauth_tokens "
            "ORDER BY provider, account"
        ).fetchall()
    return [
        {"provider": p, "account": a, "status": s, "updated_at": u}
        for (p, a, s, u) in rows
    ]


def delete_token(provider: str, account: str) -> bool:
    """Remove an account's token entirely (disconnect). Returns True if a row
    was removed. Callers are responsible for clearing the account's cached
    data separately."""
    with _lock, _connect() as conn:
        cur = conn.execute(
            "DELETE FROM oauth_tokens WHERE provider = ? AND account = ?",
            (provider, account),
        )
        return cur.rowcount > 0


def import_legacy_google_token(account: str = "default") -> bool:
    """One-time import of the Workspace skill's plaintext ``google_token.json``
    into the encrypted store.

    The ``skills/productivity/google-workspace`` skill historically wrote the
    Google OAuth token in plaintext at ``~/.hermes/google_token.json``. This
    copies it under ``provider="google"`` so the encrypted store becomes the
    source of truth. It is idempotent — it does nothing once a google token
    already exists in the store — and it deliberately does NOT delete the
    plaintext file yet, because the skill still reads it directly; the plaintext
    is removed only when the skill is cut over to read through the store (a
    later phase). Returns True if it imported on this call.
    """
    if load_token("google", account) is not None:
        return False
    legacy = _hermes_home() / "google_token.json"
    if not legacy.exists():
        return False
    try:
        data = json.loads(legacy.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(data, dict):
        return False
    save_token("google", account, data, status=STATUS_ACTIVE)
    return True


def can_decrypt() -> bool:
    """True if the store's ciphertexts are readable with the current key.
    Cheap health check for startup diagnostics."""
    try:
        with _lock, _connect() as conn:
            row = conn.execute(
                "SELECT ciphertext FROM oauth_tokens LIMIT 1"
            ).fetchone()
        if row is None:
            return True
        _fernet().decrypt(row[0])
        return True
    except (InvalidToken, Exception):
        return False
