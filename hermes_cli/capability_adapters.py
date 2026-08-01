"""What each integration's real signals say — read, never assumed.

Every function here reports what it can *cheaply and locally* determine, and
leaves the rest `None`. That is the discipline: a probe that did not run leaves
`None`, and `CapabilityStatus` treats `None` as unproven rather than fine. None
of these adapters performs a network call, connects an account, or mutates
anything; the expensive proofs belong to the live acceptance run, not to a
dashboard page load.

Each adapter is also the single place that knows one integration's *shape* —
which env var carries its URL, which store holds its token — so the status
endpoint stays free of per-vendor trivia and a new integration is one function.
"""
from __future__ import annotations

import os
import shutil
from typing import List, Optional

from hermes_cli.capability_status import CapabilityStatus


def _env(*names: str) -> Optional[str]:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return None


def google_status() -> CapabilityStatus:
    """Google Workspace, via the existing native wrapper and encrypted store.

    Deliberately delegates to `google_auth_status`, so the dashboard card and
    the command line can never disagree about whether Google is connected.
    """
    status = CapabilityStatus(
        key="google",
        label="Google Workspace",
        purpose="Calendar and email, read-only in this release.",
        read_only=True,
    )
    try:
        from hermes_cli.google_auth_status import describe_google_auth

        report = describe_google_auth()
    except Exception as exc:  # pragma: no cover - defensive
        status.supported = False
        status.detail = f"The Google adapter could not be loaded: {exc}"
        status.next_action = "Check the install, then re-run the status command."
        return status

    state = report["state"]
    status.configured = state != "not_connected"
    status.has_credential = bool(report["has_refresh_token"])
    status.detail = report["summary"]
    status.next_action = report["remedy"]
    if report["scopes"]:
        status.notes.append(f"{len(report['scopes'])} scope(s) granted")

    if state == "usable":
        # A refresh token that the store believes is live. Reachability and a
        # real API call are *not* claimed here — no network was touched — so
        # this lands at `unproven` until an operation succeeds.
        status.reachable = None
        status.authenticated = None
    elif state == "reauth_required":
        status.reachable = True
        status.authenticated = False
    elif state == "unreadable":
        status.has_credential = False
        status.notes.append("The stored token cannot be decrypted with the current key.")
    return status


def home_assistant_status() -> CapabilityStatus:
    """Home Assistant.

    The live audit is the reason this adapter exists in this shape: the
    container runs, the root URL returns 200, and `HASS_URL` is set — while the
    API correctly returns 401 because there is no token. Reporting that as
    "reachable" alone, or worse as "connected", is the exact lie the contract
    is built to prevent. No token ⇒ `no_credential`, whatever the network says.
    """
    status = CapabilityStatus(
        key="home_assistant",
        label="Home Assistant",
        purpose="Home status and read-only entities. No control in this release.",
        read_only=True,
    )
    url = _env("HASS_URL", "HOMEASSISTANT_URL")
    token = _env("HASS_TOKEN", "HOMEASSISTANT_TOKEN")

    status.configured = bool(url)
    status.has_credential = bool(token)
    status.notes.append("Read-only: entities and scenes are listed, never actuated.")

    if not url:
        status.detail = "No Home Assistant URL is configured."
        status.next_action = "Set HASS_URL to the Home Assistant base URL."
        return status
    if not token:
        status.detail = (
            "Home Assistant is configured and may well be running, but no "
            "long-lived access token is present, so nothing can be read."
        )
        status.next_action = (
            "Create a long-lived access token in Home Assistant and set HASS_TOKEN."
        )
        return status

    status.detail = "A URL and token are configured; no call has been made to verify them."
    status.next_action = "Run the live acceptance check to prove the connection."
    return status


def voice_status() -> CapabilityStatus:
    """Local speech-to-text and text-to-speech.

    Both halves are local, so "configured" is a real answer here — but the
    microphone-to-speaker path crosses physical devices this process cannot
    see, so `proven_at` stays null until a human runs it.
    """
    status = CapabilityStatus(
        key="voice",
        label="Voice",
        purpose="Push-to-talk. Never always-listening.",
    )
    try:
        import faster_whisper  # noqa: F401

        stt = True
    except Exception:
        stt = False

    tts = shutil.which("edge-tts") is not None or _is_importable("edge_tts")

    status.supported = stt or tts
    status.configured = stt and tts
    # Local models are not credentials; there is nothing to hold.
    status.has_credential = stt and tts

    if not stt and not tts:
        status.detail = "Neither local speech-to-text nor text-to-speech is installed."
        status.next_action = "Install faster-whisper and edge-tts."
        return status
    if not stt:
        status.detail = "Text-to-speech is available; local speech-to-text is not installed."
        status.next_action = "Install faster-whisper to enable push-to-talk."
        return status
    if not tts:
        status.detail = "Speech-to-text is available; text-to-speech is not installed."
        status.next_action = "Install edge-tts to enable spoken replies."
        return status

    status.detail = (
        "Local speech-to-text and text-to-speech are both installed. The full "
        "microphone-to-speaker path crosses physical devices and has not been "
        "proven from here."
    )
    status.next_action = "Run the push-to-talk acceptance check on the target device."
    status.notes.append("Audio is not retained after transcription.")
    return status


def _is_importable(module: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def _unconnected(
    key: str, label: str, purpose: str, env_names: tuple, next_action: str
) -> CapabilityStatus:
    """A vendor with a native adapter interface and no connection yet.

    These exist so the dashboard can say `Not connected` truthfully and offer
    one safe next step, rather than rendering an invented balance or an empty
    KPI tile. Nothing here connects, and nothing here mutates.
    """
    status = CapabilityStatus(key=key, label=label, purpose=purpose, read_only=True)
    credential = _env(*env_names)
    status.configured = bool(credential)
    status.has_credential = bool(credential)
    if not credential:
        status.detail = f"{label} is not connected."
        status.next_action = next_action
        return status
    status.detail = f"A {label} credential is present; no call has been made to verify it."
    status.next_action = f"Run the live acceptance check to prove {label}."
    return status


def stripe_status() -> CapabilityStatus:
    status = _unconnected(
        "stripe",
        "Stripe",
        "Read-only revenue figures. No charges, refunds or payment links.",
        ("STRIPE_API_KEY", "STRIPE_SECRET_KEY"),
        "Add a restricted, read-only Stripe key when revenue figures are wanted.",
    )
    status.notes.append("Any mutation stays approval-gated and is out of scope here.")
    return status


def plaid_status() -> CapabilityStatus:
    status = _unconnected(
        "plaid",
        "Plaid",
        "Read-only balances. No transaction initiation, ever.",
        ("PLAID_SECRET", "PLAID_CLIENT_ID"),
        "Connect Plaid through its own consent flow when balances are wanted.",
    )
    status.notes.append("Bank websites are never automated.")
    return status


def twilio_status() -> CapabilityStatus:
    status = _unconnected(
        "twilio",
        "Phone",
        "Calls and SMS. Nothing is sent without explicit approval.",
        ("TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID"),
        "Connect Twilio when a phone number is wanted. No number is purchased here.",
    )
    return status


def browser_capability_status(key: str, label: str, purpose: str) -> CapabilityStatus:
    """Camera and location: the browser owns the permission, not the server.

    Reported as supported-and-unproven rather than guessed at, because this
    process genuinely cannot know whether a device exists or a permission was
    granted — only the page can, at the moment the owner asks for it.
    """
    return CapabilityStatus(
        key=key,
        label=label,
        purpose=purpose,
        supported=True,
        configured=True,
        has_credential=True,
        reachable=None,
        authenticated=None,
        detail="Granted by the browser, per session, only when you start it.",
        next_action="Start it from the page when you want it.",
        notes=["Session-bound. Nothing is retained or activated remotely."],
    )


def all_capabilities() -> List[CapabilityStatus]:
    """Every integration the dashboard reports on.

    Each adapter is wrapped: one failing adapter must not blank the whole page,
    because the page is how the owner finds out something is wrong.
    """
    builders = [
        google_status,
        home_assistant_status,
        voice_status,
        stripe_status,
        plaid_status,
        twilio_status,
        lambda: browser_capability_status(
            "camera", "Camera", "Describe what the camera sees, one frame at a time."
        ),
        lambda: browser_capability_status(
            "location", "Location", "Current location for the task at hand. No history."
        ),
    ]
    out: List[CapabilityStatus] = []
    for build in builders:
        try:
            out.append(build())
        except Exception as exc:  # pragma: no cover - defensive
            out.append(
                CapabilityStatus(
                    key="unknown",
                    label="Unavailable",
                    supported=False,
                    detail=f"This capability could not be inspected: {exc}",
                    next_action="Check the logs for the failing adapter.",
                )
            )
    return out
