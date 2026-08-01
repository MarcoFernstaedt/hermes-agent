"""Is this integration actually working — asked in six parts, not one.

The defect this exists to prevent is inferring authentication from something
that is not authentication: a file existing, a login page rendering, a port
being open. Home Assistant is the worked example from the live audit. The
container is running. The root URL returns 200. `HASS_URL` is set. And the
integration is **not usable**, because there is no token — the unauthenticated
API correctly returns 401. Three of those four signals say "working". Collapse
them into one boolean and the dashboard reports a lie, which is worse than
reporting nothing, because the owner stops checking.

So a capability answers six independent questions:

``supported``       the code to talk to it exists in this build
``configured``      the settings it needs are present
``credential``      a credential is present — presence only, never the value
``reachable``       the endpoint answered at all
``authenticated``   the endpoint accepted our credential
``proven``          a real operation succeeded, and when

``state`` is derived from those in a fixed precedence so the UI never has to
decide, and every non-operational state carries exactly one safe next action —
a status that reports a problem and no remedy makes the reader go and find one,
which is the work the status was supposed to save.

``proven_at`` is the only field that answers "did this ever really work". It is
null until something did. Nothing in this module sets it optimistically.

**No secret value ever crosses this boundary.** Not truncated, not masked, not
"just the last four". The tests assert that by searching the whole serialized
payload for each known secret.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

#: Ordered worst-to-best. The first failing check decides the state, so a
#: capability with no credential is never reported as merely "unreachable".
STATE_UNSUPPORTED = "unsupported"
STATE_NOT_CONFIGURED = "not_configured"
STATE_NO_CREDENTIAL = "no_credential"
STATE_UNREACHABLE = "unreachable"
STATE_NOT_AUTHENTICATED = "not_authenticated"
STATE_UNPROVEN = "unproven"
STATE_OPERATIONAL = "operational"

#: The order the UI groups by, and the order `summarize()` reports worst-first.
STATE_ORDER = (
    STATE_UNSUPPORTED,
    STATE_NOT_CONFIGURED,
    STATE_NO_CREDENTIAL,
    STATE_UNREACHABLE,
    STATE_NOT_AUTHENTICATED,
    STATE_UNPROVEN,
    STATE_OPERATIONAL,
)

#: Human wording, fixed here so two surfaces cannot describe one state
#: differently. "Configured but unverified" and "not connected" mean different
#: things and lead to different actions.
STATE_LABELS = {
    STATE_UNSUPPORTED: "Not available in this build",
    STATE_NOT_CONFIGURED: "Not connected",
    STATE_NO_CREDENTIAL: "Configured, no credential",
    STATE_UNREACHABLE: "Configured but unreachable",
    STATE_NOT_AUTHENTICATED: "Reachable but not authenticated",
    STATE_UNPROVEN: "Authenticated but unverified",
    STATE_OPERATIONAL: "Operational",
}


@dataclass
class CapabilityStatus:
    """One integration's honest state. Construct with facts, not conclusions."""

    key: str
    label: str
    #: What the integration is for, in the owner's terms — not the vendor's.
    purpose: str = ""
    supported: bool = True
    configured: bool = False
    has_credential: bool = False
    reachable: Optional[bool] = None
    authenticated: Optional[bool] = None
    #: Timestamp of the last operation that actually succeeded. Null until one
    #: has. Never set from a config read or a reachability probe.
    proven_at: Optional[float] = None
    #: Exactly one safe thing the owner can do next. Empty only when
    #: operational.
    next_action: str = ""
    #: Free-text detail that must never contain a secret.
    detail: str = ""
    #: Capabilities intentionally held back from this release, so the UI can
    #: say "read-only in this release" rather than implying more.
    read_only: bool = False
    notes: List[str] = field(default_factory=list)

    @property
    def state(self) -> str:
        """The first failing check wins.

        Ordered deliberately: reporting a token-less Home Assistant as
        "unreachable" would send the owner to debug a network that is fine.
        """
        if not self.supported:
            return STATE_UNSUPPORTED
        if not self.configured:
            return STATE_NOT_CONFIGURED
        if not self.has_credential:
            return STATE_NO_CREDENTIAL
        if self.reachable is False:
            return STATE_UNREACHABLE
        if self.authenticated is False:
            return STATE_NOT_AUTHENTICATED
        # Unknown reachability/auth is not success. A probe that never ran
        # leaves `None`, and `None` must not be read as "fine".
        if self.reachable is None or self.authenticated is None:
            return STATE_UNPROVEN
        if self.proven_at is None:
            return STATE_UNPROVEN
        return STATE_OPERATIONAL

    @property
    def usable(self) -> bool:
        """True only when something has actually worked."""
        return self.state == STATE_OPERATIONAL

    def to_dict(self) -> Dict[str, Any]:
        state = self.state
        return {
            "key": self.key,
            "label": self.label,
            "purpose": self.purpose,
            "state": state,
            "state_label": STATE_LABELS[state],
            "usable": self.usable,
            "read_only": self.read_only,
            # Presence booleans only. A credential's value never appears here,
            # not masked and not truncated — a masked secret in a log is still
            # a secret in a log, and the mask is not the part that leaks.
            "supported": self.supported,
            "configured": self.configured,
            "has_credential": self.has_credential,
            "reachable": self.reachable,
            "authenticated": self.authenticated,
            "proven_at": self.proven_at,
            "next_action": self.next_action,
            "detail": self.detail,
            "notes": list(self.notes),
        }


def summarize(statuses: List[CapabilityStatus]) -> Dict[str, Any]:
    """Group for display, worst state first.

    Worst-first because the only reason to read this list is to find what needs
    attention; sorting alphabetically buries the one broken row among nine
    working ones.
    """
    rank = {s: i for i, s in enumerate(STATE_ORDER)}
    ordered = sorted(statuses, key=lambda s: (rank[s.state], s.label.lower()))
    return {
        "capabilities": [s.to_dict() for s in ordered],
        "operational_count": sum(1 for s in statuses if s.usable),
        "total_count": len(statuses),
        "needs_attention": [
            s.key for s in ordered if s.state not in (STATE_OPERATIONAL, STATE_UNSUPPORTED)
        ],
    }
