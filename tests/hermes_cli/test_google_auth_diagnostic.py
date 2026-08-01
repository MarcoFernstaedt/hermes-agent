"""The redacted Google-auth diagnostic, and the provisioning path into it.

Two things had to be answerable without a live send and without pasting a
token anywhere: *is Google connected*, and *how do I connect it*. The review
could not answer either, so `gmail_send` could not be exercised end to end.

The hard rule these tests exist to hold: this surface reports **presence and
state, never values**. A diagnostic that prints a refresh token to help you
debug is a diagnostic that puts a refresh token in a terminal buffer, a
screenshot, and a handoff document.
"""
from __future__ import annotations

import json

import pytest


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A private ~/.hermes for each test.

    `secure_store` does `from hermes_cli.config import get_hermes_home` at
    import time, so it holds its own reference — patching the config module
    alone leaves it writing to the real home, and every test in this file
    shares one token store. Patch the name where it is *looked up*.
    """
    h = tmp_path / "home"
    h.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setattr("hermes_cli.config.get_hermes_home", lambda: h)
    monkeypatch.setattr("hermes_cli.secure_store.get_hermes_home", lambda: h)
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: h)
    return h


SECRETS = {
    "client_id": "1234.apps.googleusercontent.com",
    "client_secret": "GOCSPX-super-secret-value",
    "refresh_token": "1//0e-REFRESH-TOKEN-VALUE",
    "access_token": "ya29.ACCESS-TOKEN-VALUE",
    "token_uri": "https://oauth2.googleapis.com/token",
    "scopes": ["https://www.googleapis.com/auth/gmail.send"],
    "expires_at": 4_102_444_800.0,  # far future
}


def describe(**kw):
    from hermes_cli.google_auth_status import describe_google_auth

    return describe_google_auth(**kw)


class TestNoTokenAtAll:
    def test_it_says_not_connected_rather_than_failing(self, home):
        report = describe()
        assert report["state"] == "not_connected"
        assert report["usable"] is False
        assert "not connected" in report["summary"].lower()

    def test_it_names_the_way_to_fix_it(self, home):
        # A diagnostic that reports a problem and no remedy makes the reader
        # go and find one, which is the work the diagnostic was meant to save.
        assert "provision" in describe()["remedy"].lower()


class TestAUsableToken:
    def test_it_reports_usable(self, home):
        from hermes_cli import secure_store

        secure_store.save_token("google", "default", SECRETS)
        report = describe()
        assert report["state"] == "usable"
        assert report["usable"] is True

    def test_it_reports_the_shape_without_the_substance(self, home):
        from hermes_cli import secure_store

        secure_store.save_token("google", "default", SECRETS)
        report = describe()

        assert report["has_refresh_token"] is True
        assert report["has_client_credentials"] is True
        assert report["scopes"] == ["https://www.googleapis.com/auth/gmail.send"]
        assert report["access_token_expired"] is False

    @pytest.mark.parametrize(
        "secret",
        ["GOCSPX-super-secret-value", "1//0e-REFRESH-TOKEN-VALUE", "ya29.ACCESS-TOKEN-VALUE"],
    )
    def test_no_secret_value_appears_anywhere_in_the_report(self, home, secret):
        from hermes_cli import secure_store

        secure_store.save_token("google", "default", SECRETS)
        blob = json.dumps(describe(), default=str)
        assert secret not in blob

    def test_an_expired_access_token_is_still_usable(self, home):
        # A refresh token is what makes an account usable; the access token
        # expiring every hour is ordinary, not a fault.
        from hermes_cli import secure_store

        secure_store.save_token(
            "google", "default", {**SECRETS, "expires_at": 1.0}
        )
        report = describe()
        assert report["access_token_expired"] is True
        assert report["state"] == "usable"


class TestReauthRequired:
    def test_it_is_reported_distinctly_from_missing(self, home):
        # "Revoked" and "never connected" need different actions from the
        # owner, so they cannot share one failure state.
        from hermes_cli import secure_store

        secure_store.save_token(
            "google", "default", SECRETS,
            status=secure_store.STATUS_NEEDS_REAUTH,
        )
        report = describe()
        assert report["state"] == "reauth_required"
        assert report["usable"] is False
        assert "reconnect" in report["remedy"].lower()

    def test_a_token_with_no_refresh_token_cannot_be_usable(self, home):
        from hermes_cli import secure_store

        token = {k: v for k, v in SECRETS.items() if k != "refresh_token"}
        secure_store.save_token("google", "default", token)
        report = describe()
        assert report["usable"] is False
        assert report["has_refresh_token"] is False


class TestUnreadableStore:
    def test_a_key_mismatch_is_its_own_state(self, home, monkeypatch):
        # Reporting "not connected" here would send the owner to re-authorise
        # a token that is present and fine — the key changed, not the grant.
        from cryptography.fernet import InvalidToken

        from hermes_cli import secure_store

        secure_store.save_token("google", "default", SECRETS)
        monkeypatch.setattr(
            secure_store, "load_token",
            lambda p, a: (_ for _ in ()).throw(InvalidToken()),
        )
        report = describe()
        assert report["state"] == "unreadable"
        assert report["usable"] is False
        assert "key" in report["remedy"].lower()


class TestProvisioning:
    def test_it_imports_an_explicit_file(self, home):
        from hermes_cli import secure_store
        from hermes_cli.google_auth_status import provision_google_auth

        src = home / "elsewhere" / "token.json"
        src.parent.mkdir(parents=True)
        src.write_text(json.dumps(SECRETS), encoding="utf-8")

        result = provision_google_auth(source=src)
        assert result["imported"] is True
        assert result["account"] == "default"
        assert secure_store.load_token("google", "default")["refresh_token"] == (
            SECRETS["refresh_token"]
        )

    def test_it_finds_the_legacy_location_with_no_argument(self, home):
        from hermes_cli import secure_store
        from hermes_cli.google_auth_status import provision_google_auth

        (home / "google_token.json").write_text(json.dumps(SECRETS), encoding="utf-8")
        assert provision_google_auth()["imported"] is True
        assert secure_store.load_token("google", "default") is not None

    def test_it_refuses_a_file_that_is_not_a_google_token(self, home):
        # Storing the wrong JSON would produce a "connected" account that
        # fails at the first send, which is the worst time to find out.
        from hermes_cli.google_auth_status import provision_google_auth

        bad = home / "bad.json"
        bad.write_text(json.dumps({"hello": "world"}), encoding="utf-8")

        result = provision_google_auth(source=bad)
        assert result["imported"] is False
        assert "refresh_token" in result["reason"]

    def test_it_does_not_overwrite_without_being_asked(self, home):
        from hermes_cli import secure_store
        from hermes_cli.google_auth_status import provision_google_auth

        secure_store.save_token("google", "default", {**SECRETS, "refresh_token": "keep-me"})
        src = home / "new.json"
        src.write_text(json.dumps(SECRETS), encoding="utf-8")

        result = provision_google_auth(source=src)
        assert result["imported"] is False
        assert "already" in result["reason"].lower()
        assert secure_store.load_token("google", "default")["refresh_token"] == "keep-me"

    def test_replace_is_explicit(self, home):
        from hermes_cli import secure_store
        from hermes_cli.google_auth_status import provision_google_auth

        secure_store.save_token("google", "default", {**SECRETS, "refresh_token": "old"})
        src = home / "new.json"
        src.write_text(json.dumps(SECRETS), encoding="utf-8")

        assert provision_google_auth(source=src, replace=True)["imported"] is True
        assert secure_store.load_token("google", "default")["refresh_token"] == (
            SECRETS["refresh_token"]
        )

    def test_importing_clears_a_stale_reauth_flag(self, home):
        from hermes_cli import secure_store
        from hermes_cli.google_auth_status import provision_google_auth

        secure_store.save_token(
            "google", "default", SECRETS,
            status=secure_store.STATUS_NEEDS_REAUTH,
        )
        src = home / "new.json"
        src.write_text(json.dumps(SECRETS), encoding="utf-8")
        provision_google_auth(source=src, replace=True)

        assert secure_store.get_status("google", "default") == secure_store.STATUS_ACTIVE

    def test_a_missing_source_says_so_plainly(self, home):
        from hermes_cli.google_auth_status import provision_google_auth

        result = provision_google_auth(source=home / "nope.json")
        assert result["imported"] is False
        # The path has to appear: "no token file" without saying which one
        # leaves the reader guessing which of several they meant.
        assert "no token file found" in result["reason"].lower()
        assert "nope.json" in result["reason"]

    @pytest.mark.parametrize("secret", ["GOCSPX-super-secret-value", "1//0e-REFRESH-TOKEN-VALUE"])
    def test_the_provisioning_result_carries_no_secret_either(self, home, secret):
        from hermes_cli.google_auth_status import provision_google_auth

        src = home / "token.json"
        src.write_text(json.dumps(SECRETS), encoding="utf-8")
        blob = json.dumps(provision_google_auth(source=src), default=str)
        assert secret not in blob


class TestTheCommandLine:
    def test_status_prints_a_report_and_no_secrets(self, home, capsys):
        from hermes_cli import secure_store
        from hermes_cli.google_auth_status import main

        secure_store.save_token("google", "default", SECRETS)
        code = main(["status"])
        out = capsys.readouterr().out

        assert code == 0
        assert "usable" in out
        for secret in SECRETS["refresh_token"], SECRETS["client_secret"]:
            assert secret not in out

    def test_status_exits_nonzero_when_not_usable(self, home, capsys):
        from hermes_cli.google_auth_status import main

        assert main(["status"]) == 1

    def test_json_output_is_the_same_report(self, home, capsys):
        from hermes_cli import secure_store
        from hermes_cli.google_auth_status import main

        secure_store.save_token("google", "default", SECRETS)
        main(["status", "--json"])
        report = json.loads(capsys.readouterr().out)

        assert report["state"] == "usable"
        assert report["has_refresh_token"] is True

    def test_provision_reports_what_it_did(self, home, capsys):
        from hermes_cli.google_auth_status import main

        (home / "google_token.json").write_text(json.dumps(SECRETS), encoding="utf-8")
        assert main(["provision"]) == 0
        assert "imported" in capsys.readouterr().out.lower()
