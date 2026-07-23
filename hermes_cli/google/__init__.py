"""Unified Google integration for the dashboard.

One Google connection, one token store, shared by every Google-backed module
(Email, Calendar) and — eventually — the Workspace agent skill. Tokens live in
the encrypted ``hermes_cli.secure_store`` (imported from the skill's legacy
plaintext ``google_token.json`` at startup). This package talks to Google's
REST APIs directly over httpx rather than pulling in the heavyweight
``google-api-python-client`` / ``google-auth`` stack, so the backend gains no
new dependency.
"""

from hermes_cli.google.oauth import (  # noqa: F401
    GoogleAuthError,
    GoogleReauthRequired,
    connection_status,
    get_access_token,
)
