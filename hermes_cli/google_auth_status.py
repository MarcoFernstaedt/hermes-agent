"""Is Google connected, and how do I connect it — answered without a send.

Two questions blocked the live acceptance of `gmail_send`, and neither could
be answered from the repository. The first is diagnostic: an owner (or an agent
acting for one) needs to know whether the account is connected, revoked, or
merely holding an hour-old access token, and the only way to find out was to
attempt a send and read the failure. The second is procedural: there was no
stated path from "I have a Google token on this machine" to "the encrypted
store holds it under ``google/default``".

Both are answered here, under one rule that shapes every line:

**Presence and state, never values.** A diagnostic that prints a refresh token
to help you debug is a diagnostic that puts a refresh token into a terminal
buffer, a screenshot, and a handoff document. So this module reports *whether*
a refresh token exists, *which* scopes were granted, and *when* the access
token expires — and no secret ever crosses the boundary. The tests assert that
by searching the whole serialized report for each secret value.

Usage:

    python -m hermes_cli.google_auth_status status
    python -m hermes_cli.google_auth_status status --json
    python -m hermes_cli.google_auth_status provision [PATH] [--replace]

``status`` exits non-zero when the account is not usable, so it composes with
``&&`` in an acceptance script.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

PROVIDER = "google"
DEFAULT_ACCOUNT = "default"

#: Where the Workspace skill historically wrote its plaintext token. Kept as
#: the zero-argument default so the common case needs no path at all.
LEGACY_TOKEN_FILENAME = "google_token.json"

#: The fields that make a Google "authorized user" token *refreshable*. An
#: access token alone expires within the hour and cannot be renewed, so a
#: payload without these is not a connection — it is a countdown.
_REQUIRED = ("refresh_token", "client_id", "client_secret")

PROVISION_HINT = (
    "provision it with: python -m hermes_cli.google_auth_status provision "
    "[PATH_TO_TOKEN_JSON]"
)


def _home() -> Path:
    from hermes_cli.config import get_hermes_home

    return Path(get_hermes_home())


def _expiry_epoch(token: Dict[str, Any]) -> float:
    """The access token's expiry as a UNIX timestamp, or 0 when unknown.

    Delegated to the same reader the refresh path uses, so the diagnostic can
    never disagree with the code that acts on it.
    """
    from hermes_cli.google.oauth import _expiry_epoch as read

    return read(token)


def describe_google_auth(account: str = DEFAULT_ACCOUNT) -> Dict[str, Any]:
    """Report the connection state for ``google/<account>``. No secret values.

    ``state`` is one of:

    ``not_connected``
        No token in the store. The owner has never connected, or it was
        deleted.
    ``reauth_required``
        A token is present but Google rejected its refresh token
        (``invalid_grant``). Distinct from ``not_connected`` because the
        remedy differs: reconnect the existing account, don't start over.
    ``unreadable``
        Ciphertext exists but will not decrypt with the current key. Reporting
        this as ``not_connected`` would send the owner to re-authorise a grant
        that is present and fine — the key changed, not the permission.
    ``usable``
        A refresh token and client credentials are present, and the account is
        active. An expired *access* token does not change this: renewing it
        every hour is the ordinary path, not a fault.
    """
    from cryptography.fernet import InvalidToken

    from hermes_cli import secure_store

    report: Dict[str, Any] = {
        "provider": PROVIDER,
        "account": account,
        "state": "not_connected",
        "usable": False,
        "has_refresh_token": False,
        "has_client_credentials": False,
        "scopes": [],
        "access_token_expired": True,
        "expires_in_seconds": None,
        "summary": "",
        "remedy": "",
    }

    try:
        token = secure_store.load_token(PROVIDER, account)
    except InvalidToken:
        report["state"] = "unreadable"
        report["summary"] = (
            "A Google token is stored but cannot be decrypted with the current key."
        )
        report["remedy"] = (
            "Restore the original token key (HERMES_TOKEN_KEY or "
            "~/.hermes/token_store.key), or delete the entry and reconnect."
        )
        return report
    except Exception as exc:  # pragma: no cover - defensive
        report["state"] = "unreadable"
        report["summary"] = f"The token store could not be read: {exc}"
        report["remedy"] = "Check ~/.hermes permissions, then re-run this command."
        return report

    if token is None:
        report["summary"] = "Google is not connected for this account."
        report["remedy"] = f"Connect the account, then {PROVISION_HINT}"
        return report

    report["has_refresh_token"] = bool(token.get("refresh_token"))
    report["has_client_credentials"] = bool(
        token.get("client_id") and token.get("client_secret")
    )
    scopes = token.get("scopes") or token.get("scope") or []
    if isinstance(scopes, str):
        scopes = scopes.split()
    report["scopes"] = [str(s) for s in scopes]

    expiry = _expiry_epoch(token)
    if expiry > 0:
        remaining = expiry - time.time()
        report["expires_in_seconds"] = int(remaining)
        report["access_token_expired"] = remaining <= 0
    else:
        # Unknown expiry is treated as expired by the refresh path; say the
        # same thing here rather than implying the token is fresh.
        report["access_token_expired"] = True

    status = secure_store.get_status(PROVIDER, account)
    if status == secure_store.STATUS_NEEDS_REAUTH:
        report["state"] = "reauth_required"
        report["summary"] = (
            "Google rejected the stored refresh token; the grant was revoked "
            "or expired."
        )
        report["remedy"] = "Reconnect the Google account to issue a new refresh token."
        return report

    missing = [f for f in _REQUIRED if not token.get(f)]
    if missing:
        report["state"] = "incomplete"
        report["summary"] = (
            "The stored Google token cannot be refreshed: it is missing "
            + ", ".join(missing)
            + "."
        )
        report["remedy"] = f"Re-export a full authorized-user token, then {PROVISION_HINT}"
        return report

    report["state"] = "usable"
    report["usable"] = True
    report["summary"] = "Google is connected and the token can be refreshed."
    report["remedy"] = ""
    return report


def provision_google_auth(
    source: Optional[Path | str] = None,
    *,
    account: str = DEFAULT_ACCOUNT,
    replace: bool = False,
) -> Dict[str, Any]:
    """Import an authorized-user token JSON into the encrypted store.

    ``source`` defaults to the legacy plaintext location the Workspace skill
    wrote, so the ordinary case takes no argument. Never overwrites an existing
    entry unless ``replace`` is set: silently replacing a working grant with a
    file someone happened to pass is the kind of helpfulness that loses an
    account.

    The payload is validated before it is stored. Accepting arbitrary JSON
    would produce an account that reports "connected" and fails at the first
    send — the worst possible moment to discover it.

    Returns ``{"imported": bool, "reason": str, ...}``. Never echoes the token.
    """
    from hermes_cli import secure_store

    path = Path(source) if source else (_home() / LEGACY_TOKEN_FILENAME)
    result: Dict[str, Any] = {
        "imported": False,
        "provider": PROVIDER,
        "account": account,
        "source": str(path),
        "reason": "",
    }

    if not replace and secure_store.load_token(PROVIDER, account) is not None:
        result["reason"] = (
            f"{PROVIDER}/{account} already has a token; pass --replace to overwrite it."
        )
        return result

    if not path.exists():
        result["reason"] = f"No token file found at {path}."
        return result

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        result["reason"] = f"Could not read {path}: {exc}"
        return result

    if not isinstance(data, dict):
        result["reason"] = f"{path} is not a JSON object."
        return result

    missing = [f for f in _REQUIRED if not data.get(f)]
    if missing:
        result["reason"] = (
            f"{path} is missing {', '.join(missing)} — that is not a refreshable "
            "Google authorized-user token."
        )
        return result

    # STATUS_ACTIVE explicitly: importing a fresh grant clears a stale
    # needs_reauth flag from the account it replaces, which is the whole point
    # of re-provisioning after a revocation.
    secure_store.save_token(
        PROVIDER, account, data, status=secure_store.STATUS_ACTIVE
    )
    result["imported"] = True
    result["reason"] = f"Imported into the encrypted store as {PROVIDER}/{account}."
    # Presence only, so a provisioning log stays safe to paste into a report.
    result["has_refresh_token"] = True
    result["scopes"] = [str(s) for s in (data.get("scopes") or [])]
    return result


def _print_report(report: Dict[str, Any]) -> None:
    print(f"google/{report['account']}: {report['state']}")
    print(f"  {report['summary']}")
    print(f"  refresh token:      {'present' if report['has_refresh_token'] else 'absent'}")
    print(
        f"  client credentials: "
        f"{'present' if report['has_client_credentials'] else 'absent'}"
    )
    if report["scopes"]:
        print(f"  scopes:             {', '.join(report['scopes'])}")
    if report["expires_in_seconds"] is not None:
        seconds = report["expires_in_seconds"]
        when = "expired" if seconds <= 0 else f"in {seconds}s"
        print(f"  access token:       {when}")
    if report["remedy"]:
        print(f"  next:               {report['remedy']}")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m hermes_cli.google_auth_status",
        description="Report or provision Google auth in the encrypted store. "
        "Never prints token values.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status", help="report the connection state")
    status.add_argument("--account", default=DEFAULT_ACCOUNT)
    status.add_argument("--json", action="store_true", dest="as_json")

    prov = sub.add_parser("provision", help="import a token JSON into the store")
    prov.add_argument("path", nargs="?", default=None)
    prov.add_argument("--account", default=DEFAULT_ACCOUNT)
    prov.add_argument("--replace", action="store_true")

    args = parser.parse_args(argv)

    if args.command == "status":
        report = describe_google_auth(account=args.account)
        if args.as_json:
            print(json.dumps(report, indent=2))
        else:
            _print_report(report)
        # Non-zero when unusable, so `status && <acceptance step>` short-circuits.
        return 0 if report["usable"] else 1

    result = provision_google_auth(
        source=args.path, account=args.account, replace=args.replace
    )
    print(("Imported: " if result["imported"] else "Not imported: ") + result["reason"])
    return 0 if result["imported"] else 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
