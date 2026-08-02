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


def resolved_stt() -> dict:
    """What transcription would actually do, asked of the code that does it.

    This calls `tools.transcription_tools._get_provider` — the same resolver
    `transcribe_audio` calls, on the same config — rather than re-deriving the
    answer from environment variables. The re-derived version was wrong in four
    separate ways, each of which made the card describe a different product:

    * it ignored ``stt.enabled: false``, so a deliberately disabled microphone
      surface reported as working;
    * it ignored an explicit ``stt.provider``, so a machine pinned to Groq was
      reported as transcribing locally because `faster_whisper` happened to be
      importable;
    * it never looked at command-type providers, so a working
      ``stt.providers.<name>`` setup reported "nothing can transcribe";
    * it treated "a credential is present" as "this provider is what runs",
      which is not the same claim and was frequently the wrong one.

    ``allow_install=False``: resolving must not install a package as a side
    effect of rendering a status card.
    """
    from tools import transcription_tools as stt_tools

    config = stt_tools._load_stt_config()
    enabled = stt_tools.is_stt_enabled(config)
    explicit = isinstance(config, dict) and "provider" in config
    requested = ""
    if isinstance(config, dict):
        requested = str(config.get("provider") or "").strip().lower()

    provider = stt_tools._get_provider(config, allow_install=False)
    return {
        "enabled": enabled,
        "explicit": explicit,
        "requested": requested,
        "provider": provider,
        "available": provider not in ("", "none"),
        "privacy": stt_tools.stt_privacy(provider),
    }


def resolved_tts() -> dict:
    """What spoken replies would actually do, asked the same way.

    `edge-tts` being importable was never the question: `tts.provider` chooses
    among eleven built-ins plus command and plugin providers, and the answer
    determines both whether anything speaks and whether the text leaves the
    machine.
    """
    from hermes_cli.tool_tiers import LOCAL_TTS_PROVIDERS
    from tools import tts_tool

    config = tts_tool._load_tts_config()
    provider = tts_tool._get_provider(config)
    command_config = tts_tool._resolve_command_provider_config(provider, config)

    if command_config is not None:
        kind, privacy = "command", "unknown"
    elif provider in LOCAL_TTS_PROVIDERS:
        kind, privacy = "builtin", "local"
    elif provider in tts_tool.BUILTIN_TTS_PROVIDERS:
        kind, privacy = "builtin", "remote"
    elif _tts_plugin_registered(provider):
        kind, privacy = "plugin", "unknown"
    else:
        # An unrecognised name is not a provider; `text_to_speech_tool` falls
        # through its elif chain to the Edge default, so that is what would
        # actually speak. Reporting the typo back as if it were the provider
        # would understate what happens to the reply text.
        provider, kind, privacy = tts_tool.DEFAULT_PROVIDER, "builtin", "remote"

    return {"provider": provider, "kind": kind, "privacy": privacy}


def _tts_plugin_registered(provider: str) -> bool:
    """Whether a TTS plugin claims this name. Discovery is not forced.

    `text_to_speech_tool` re-runs discovery with `force=True` when a first
    lookup misses. A status card must not: forcing plugin discovery is real
    work with real import side effects, and being one refresh out of date is a
    smaller error than doing that on a page load.
    """
    try:
        from agent.tts_registry import get_provider
        from hermes_cli.plugins import _ensure_plugins_discovered

        _ensure_plugins_discovered()
        return get_provider((provider or "").strip().lower()) is not None
    except Exception:
        return False


#: Human-readable reasons a resolved-away provider is unavailable, keyed by
#: what the owner asked for. Only used to write the next action.
_STT_REMEDIES = {
    "local": "Install faster-whisper, or set HERMES_LOCAL_STT_COMMAND to a local whisper CLI.",
    "local_command": "Set HERMES_LOCAL_STT_COMMAND to a working local whisper CLI.",
    "groq": "Set GROQ_API_KEY.",
    "openai": "Set OPENAI_API_KEY (or VOICE_TOOLS_OPENAI_KEY).",
    "mistral": "Install the mistralai package and set MISTRAL_API_KEY.",
    "xai": "Set XAI_API_KEY.",
    "elevenlabs": "Set ELEVENLABS_API_KEY.",
    "deepinfra": "Set DEEPINFRA_API_KEY.",
}


def voice_status() -> CapabilityStatus:
    """Speech-to-text and text-to-speech, reported as they actually work.

    The rule this adapter now follows: *ask the runtime, do not re-derive it*.
    Both halves resolve through the same functions the transcription and
    speech paths call, on the same config, so the card cannot claim a provider
    the runtime would not pick, cannot miss one the runtime would, and cannot
    call a remote provider local.

    The capture half is separate and stated unconditionally, because it is
    true regardless of provider: `web/src/lib/use-dictation.ts` opens the
    microphone per press through `getUserMedia`/`MediaRecorder` and stops the
    tracks when the press ends. There is no always-listening mode and no
    server-side device access.
    """
    status = CapabilityStatus(
        key="voice",
        label="Voice",
        purpose="Push-to-talk. Never always-listening.",
    )

    try:
        stt = resolved_stt()
    except Exception as exc:  # pragma: no cover - defensive
        status.supported = False
        status.detail = f"The transcription resolver could not be consulted: {exc}"
        status.next_action = "Check the install, then re-run the status command."
        return status
    try:
        tts = resolved_tts()
    except Exception as exc:  # pragma: no cover - defensive
        tts = {"provider": "", "kind": "unknown", "privacy": "unknown"}
        status.notes.append(f"The speech resolver could not be consulted: {exc}")

    stt_ok = bool(stt["available"])
    tts_ok = bool(tts["provider"])

    status.supported = stt_ok or tts_ok
    status.configured = stt_ok and tts_ok
    # A local model is not a credential; a remote provider's key is, and it is
    # already held in the secure store rather than here.
    status.has_credential = stt_ok and tts_ok

    status.notes.append(
        "The microphone is opened by the page, per press, and released when "
        "the press ends. Nothing listens between presses."
    )
    status.notes.append("Audio is not retained after transcription.")

    # Privacy, stated from the provider that would actually run — never from
    # what happens to be installed alongside it.
    if stt_ok:
        if stt["privacy"] == "local":
            status.notes.append(
                f"Transcription runs locally ({stt['provider']}); the recording "
                "does not leave this machine."
            )
        elif stt["privacy"] == "remote":
            status.notes.append(
                f"Transcription runs on a remote provider ({stt['provider']}), "
                "so the recording leaves this machine."
            )
        else:
            status.notes.append(
                f"Transcription runs through a configured provider "
                f"({stt['provider']}) whose destination this cannot determine. "
                "Check what that command or plugin does before dictating "
                "anything sensitive."
            )
    if tts_ok:
        if tts["privacy"] == "remote":
            status.notes.append(
                f"Spoken replies are generated by a remote provider "
                f"({tts['provider']}), so the reply text leaves this machine."
            )
        elif tts["privacy"] == "unknown":
            status.notes.append(
                f"Spoken replies run through a configured {tts['kind']} provider "
                f"({tts['provider']}) whose destination this cannot determine."
            )

    if not stt["enabled"]:
        status.detail = (
            "Transcription is switched off in config (stt.enabled: false), so "
            "the push-to-talk button records nothing that can be read back."
        )
        status.next_action = "Set stt.enabled: true in config.yaml to re-enable it."
        return status

    if not stt_ok and not tts_ok:
        status.detail = (
            "Push-to-talk capture is built into the composer, but nothing can "
            "transcribe it and nothing can speak back."
        )
        status.next_action = (
            "Install faster-whisper for local transcription (or set a provider "
            "key), and configure a TTS provider for spoken replies."
        )
        return status
    if not stt_ok:
        if stt["explicit"] and stt["requested"]:
            status.detail = (
                f"Spoken replies are available. Transcription is pinned to "
                f"'{stt['requested']}' in config, and that provider is not "
                "usable on this machine, so nothing transcribes — the local "
                "model is deliberately not substituted for an explicit choice."
            )
            status.next_action = _STT_REMEDIES.get(
                stt["requested"],
                f"Make the '{stt['requested']}' provider usable, or change "
                "stt.provider to one that is.",
            )
        else:
            status.detail = (
                "Spoken replies are available; nothing can transcribe what the "
                "composer records."
            )
            status.next_action = (
                "Install faster-whisper, or set a key for one of the remote "
                "transcription providers."
            )
        return status
    if not tts_ok:
        status.detail = (
            "Push-to-talk dictation is available end to end; nothing can speak "
            "replies back."
        )
        status.next_action = "Configure a TTS provider to enable spoken replies."
        return status

    status.detail = (
        f"Push-to-talk dictation ({stt['provider']}) and spoken replies "
        f"({tts['provider']}) are both available. The full microphone-to-speaker "
        "path crosses physical devices and has not been proven from here."
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
