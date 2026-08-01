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


#: Speech-to-text providers other than the local model, and the credential
#: each one needs. Checking only `faster_whisper` reported "not installed" on a
#: machine where dictation worked perfectly through a remote provider — and,
#: worse, told the owner nothing about audio leaving the device.
_REMOTE_STT_KEYS = {
    "groq": ("GROQ_API_KEY",),
    "openai": ("VOICE_TOOLS_OPENAI_KEY", "OPENAI_API_KEY"),
    "elevenlabs": ("ELEVENLABS_API_KEY",),
    "mistral": ("MISTRAL_API_KEY",),
    "xai": ("XAI_API_KEY",),
    "deepinfra": ("DEEPINFRA_API_KEY",),
}


def _remote_stt_providers() -> list:
    """Which remote transcription providers have a credential present."""
    import os

    return sorted(
        name
        for name, keys in _REMOTE_STT_KEYS.items()
        if any(os.environ.get(k) for k in keys)
    )


def voice_status() -> CapabilityStatus:
    """Speech-to-text and text-to-speech, reported as they actually work.

    Two corrections over the first version of this adapter, both of which made
    it describe a different product from the one that ships:

    *Capture is the browser's, and it exists.* `web/src/lib/use-dictation.ts`
    holds a real push-to-talk implementation — `getUserMedia`, `MediaRecorder`,
    and a POST to `/api/audio/transcribe` — wired into the chat composer. The
    earlier reading of this file as "no capture path" was wrong. The microphone
    is opened by the page, per press, and the tracks are stopped when the press
    ends; there is no always-listening mode and no server-side device access.

    *Transcription is not only local.* Six providers are supported and the
    local model is merely the default. Checking `faster_whisper` alone reported
    "install faster-whisper to enable push-to-talk" on machines where dictation
    already worked through Groq or OpenAI.

    The second correction matters beyond accuracy: if a remote provider is the
    one in use, the recording leaves the machine. That is the single fact an
    owner needs before pressing the button, so it is stated on the card rather
    than left to be inferred from a config file.
    """
    status = CapabilityStatus(
        key="voice",
        label="Voice",
        purpose="Push-to-talk. Never always-listening.",
    )
    local_stt = _is_importable("faster_whisper")
    remote_stt = _remote_stt_providers()
    stt = local_stt or bool(remote_stt)

    tts = shutil.which("edge-tts") is not None or _is_importable("edge_tts")

    status.supported = stt or tts
    status.configured = stt and tts
    # A local model is not a credential; a remote provider's key is, and it is
    # already held in the secure store rather than here.
    status.has_credential = stt and tts

    # The half that is true regardless of which providers are installed: the
    # capture path is in the page and it works.
    status.notes.append(
        "The microphone is opened by the page, per press, and released when "
        "the press ends. Nothing listens between presses."
    )
    status.notes.append("Audio is not retained after transcription.")
    if remote_stt and not local_stt:
        status.notes.append(
            f"Transcription runs on a remote provider ({', '.join(remote_stt)}), "
            "so the recording leaves this machine."
        )
    elif local_stt:
        status.notes.append(
            "Transcription runs locally; the recording does not leave this machine."
        )

    if not stt and not tts:
        status.detail = (
            "Push-to-talk capture is built into the composer, but nothing can "
            "transcribe it and nothing can speak back."
        )
        status.next_action = (
            "Install faster-whisper for local transcription (or set a provider "
            "key), and edge-tts for spoken replies."
        )
        return status
    if not stt:
        status.detail = (
            "Spoken replies are available; nothing can transcribe what the "
            "composer records."
        )
        status.next_action = (
            "Install faster-whisper, or set a key for one of the remote "
            "transcription providers."
        )
        return status
    if not tts:
        status.detail = (
            "Push-to-talk dictation is available end to end; nothing can speak "
            "replies back."
        )
        status.next_action = "Install edge-tts to enable spoken replies."
        return status

    status.detail = (
        "Push-to-talk dictation and spoken replies are both available. The full "
        "microphone-to-speaker path crosses physical devices and has not been "
        "proven from here."
    )
    status.next_action = "Run the push-to-talk acceptance check on the target device."
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

    This process genuinely cannot know whether a device exists or a permission
    was granted — only the page can, at the moment the owner asks for it. So
    what this card can honestly report is whether the *app* has anything that
    would ask.

    It previously said "Start it from the page when you want it" and reported
    `configured: True`. Neither is true: `web/src/` contains no
    `getUserMedia({ video })` and no `navigator.geolocation` call. What exists
    is `web/src/lib/sensorConsent.ts`, a consent state model — the rules for
    how a grant would behave, with nothing yet wired to request one. Saying
    "start it" describes a button that is not there.

    The microphone is the opposite case and is reported by `voice_status`: the
    capture path is real, and the card says so.
    """
    return CapabilityStatus(
        key=key,
        label=label,
        purpose=purpose,
        # The browser can do this; the app does not yet ask it to.
        supported=True,
        configured=False,
        has_credential=False,
        reachable=None,
        authenticated=None,
        detail=(
            "Not requested by anything yet. The consent rules exist; no screen "
            "asks the browser for this permission, so there is nothing to grant."
        ),
        next_action="Nothing to do here until a screen needs it.",
        notes=[
            "Would be session-bound and per-use. Nothing is retained or "
            "activated remotely.",
        ],
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
