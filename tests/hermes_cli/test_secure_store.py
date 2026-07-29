"""Tests for the encrypted OAuth token store (hermes_cli.secure_store)."""

import importlib
import json

import pytest


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """Isolate the store to a tmp HERMES_HOME with a fresh generated key."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("HERMES_TOKEN_KEY", raising=False)
    import hermes_cli.secure_store as secure_store

    importlib.reload(secure_store)
    return secure_store


def test_save_and_load_round_trip(store):
    token = {"access_token": "abc", "refresh_token": "xyz", "scope": "read"}
    store.save_token("spotify", "default", token)
    assert store.load_token("spotify", "default") == token
    assert store.load_token("spotify", "missing") is None


def test_ciphertext_is_encrypted_at_rest(store, tmp_path):
    store.save_token("spotify", "default", {"refresh_token": "SUPERSECRET"})
    # The raw DB bytes must not contain the plaintext secret anywhere.
    db_bytes = (tmp_path / "oauth_tokens.db").read_bytes()
    assert b"SUPERSECRET" not in db_bytes


def test_key_file_is_owner_only(store, tmp_path):
    store.save_token("spotify", "default", {"a": 1})
    key = tmp_path / "token_store.key"
    assert key.exists()
    # Owner read/write only (0o600), no group/other bits.
    assert (key.stat().st_mode & 0o777) == 0o600


def test_status_transitions_and_list(store):
    store.save_token("google", "me@example.com", {"refresh_token": "r"})
    assert store.get_status("google", "me@example.com") == store.STATUS_ACTIVE
    store.set_status("google", "me@example.com", store.STATUS_NEEDS_REAUTH)
    assert store.get_status("google", "me@example.com") == store.STATUS_NEEDS_REAUTH

    accounts = store.list_accounts()
    assert accounts == [
        {
            "provider": "google",
            "account": "me@example.com",
            "status": store.STATUS_NEEDS_REAUTH,
            "updated_at": pytest.approx(accounts[0]["updated_at"]),
        }
    ]
    # Re-saving flips the account back to active.
    store.save_token("google", "me@example.com", {"refresh_token": "r2"})
    assert store.get_status("google", "me@example.com") == store.STATUS_ACTIVE


def test_delete_token(store):
    store.save_token("spotify", "default", {"a": 1})
    assert store.delete_token("spotify", "default") is True
    assert store.load_token("spotify", "default") is None
    assert store.delete_token("spotify", "default") is False


def test_invalid_status_rejected(store):
    with pytest.raises(ValueError):
        store.save_token("spotify", "default", {"a": 1}, status="bogus")


def test_import_legacy_google_token_idempotent(store, tmp_path):
    legacy = tmp_path / "google_token.json"
    legacy.write_text(json.dumps({"refresh_token": "legacy", "scopes": ["x"]}))

    assert store.import_legacy_google_token() is True
    assert store.load_token("google", "default") == {
        "refresh_token": "legacy",
        "scopes": ["x"],
    }
    # Second call is a no-op: it must not clobber an existing store entry.
    store.save_token("google", "default", {"refresh_token": "rotated"})
    assert store.import_legacy_google_token() is False
    assert store.load_token("google", "default")["refresh_token"] == "rotated"


def test_import_legacy_absent_file_is_noop(store):
    assert store.import_legacy_google_token() is False


def test_env_key_override(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet

    key = Fernet.generate_key().decode()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_TOKEN_KEY", key)
    import hermes_cli.secure_store as secure_store

    importlib.reload(secure_store)
    secure_store.save_token("spotify", "default", {"a": 1})
    # No key file is written when the key comes from the environment.
    assert not (tmp_path / "token_store.key").exists()
    assert secure_store.load_token("spotify", "default") == {"a": 1}
    assert secure_store.can_decrypt() is True
