"""A one-use ticket that says a human agreed to *this* call.

The gap this closes: `module_permissions` classified tools into AUTO / APPROVAL
/ ALWAYS_APPROVAL, and nothing in the dispatch path consumed the classification.
`resolve()` had no production callers. Gmail was safe only because its own
handler happened to contain a Gmail-shaped gate — every other non-AUTO tool
executed on the strength of a tier that was recorded and never enforced, and
`registry.dispatch()` reached handlers without consulting it at all.

So the rule moves out of the handlers and into the chokepoint, and it is stated
as a capability rather than a flag:

**A non-AUTO tool cannot execute without a capability, and a capability cannot
exist without a human decision.** Not "was approved" as a boolean somebody
might set early — a token minted at the moment of consent, bound to the exact
call, and destroyed by being used.

What "the exact call" means, and why each field is in the binding:

*Session identity.* Consent given in one conversation must not authorise a call
in another. Two sessions can be running the same tool with the same arguments
at the same time and only one of them was agreed to.

*Tool call id.* The correlation identity the model assigned. Without it there
is no way to say which call a decision belonged to, and a capability that could
match any call is not a capability.

*Tool name and post-middleware argument hash.* Approving one call must not
execute a different one. The hash is taken where execution happens, not where
the request was formed: the middleware layers legitimately rewrite arguments,
and snapshotting before them refuses honest calls (observed live on the
terminal tool).

*Tier.* A tool whose classification tightened between consent and execution has
not been consented to at its new tier. Comparing it means a tier change takes
effect on capabilities already in flight.

*Receipt.* Which authoritative response produced this, so the audit can answer
"who said yes" and a source can be revoked without unpicking individual tokens.

*Expiry.* Consent goes stale. A token that outlives the exchange it came from
is a standing grant nobody remembers giving.

Two indexes, one object. A capability can be spent by presenting its token —
useful when a caller can carry one — or by presenting the call identity it was
minted for, which is what the dispatch chokepoint does. Identity lookup is not
a weaker check: the identity is not a secret, but nothing can *mint* by knowing
it, and the mint only exists because a human answered a prompt describing that
exact call.

Everything here fails closed. Every path that cannot establish a capability
refuses, including the paths where the check itself fails. An exception in the
permission layer must never read as permission.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Optional

#: How long a minted capability stays usable. Consent goes stale: a token that
#: outlives the exchange it came from is a standing grant by another name.
DEFAULT_TTL_SECONDS = 300

#: Where a capability may come from. Recorded so an audit can answer "who said
#: yes", and so a source can be revoked without unpicking individual tokens.
#:
#: A person answered the prompt for *this* call, just now. The only source an
#: ALWAYS_APPROVAL tool will accept.
SOURCE_HUMAN = "human"
#: An APPROVAL-tier tool the owner marked trusted — consent given once, in
#: settings, to a named tool running without a prompt.
SOURCE_TRUSTED_TOOL = "trusted"
#: A prior authoritative answer of "session" or "always" that covers this call.
#: Still human consent, but given earlier and to a class of calls rather than
#: to this one, so it is recorded differently.
SOURCE_STANDING = "standing"
#: The owner turned the gate off (``--yolo``). Recorded rather than silently
#: allowed, because an audit that cannot tell this apart from a real answer is
#: not an audit.
SOURCE_OWNER_BYPASS = "owner_bypass"

_VALID_SOURCES = frozenset(
    {SOURCE_HUMAN, SOURCE_TRUSTED_TOOL, SOURCE_STANDING, SOURCE_OWNER_BYPASS}
)


class CapabilityError(RuntimeError):
    """A capability could not be established. Always a refusal, never a warning."""


def argument_fingerprint(args: Any) -> str:
    """A stable hash of the arguments a decision was made about.

    Binding the token to this is what stops a call being approved and then
    executed with different arguments — the middleware layers legitimately
    rewrite args, so the fingerprint is taken at the same boundary the check
    happens at, and a mismatch means the thing being run is not the thing that
    was agreed.
    """
    body = json.dumps(args, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]


def call_identity(
    *, session_id: str, tool_call_id: str, tool_name: str, args_fingerprint: str
) -> str:
    """The key a capability is filed under, so dispatch can find its own.

    Every component is part of the identity because every component is part of
    what was agreed. Changing any of them describes a different call.
    """
    return f"{session_id}\x1f{tool_call_id}\x1f{tool_name}\x1f{args_fingerprint}"


@dataclass(frozen=True)
class Capability:
    token: str
    session_id: str
    tool_name: str
    tool_call_id: str
    args_fingerprint: str
    tier: str
    receipt: str
    source: str
    minted_at: float
    expires_at: float

    @property
    def identity(self) -> str:
        return call_identity(
            session_id=self.session_id,
            tool_call_id=self.tool_call_id,
            tool_name=self.tool_name,
            args_fingerprint=self.args_fingerprint,
        )


#: The tier that may never be satisfied by anything but a person answering now.
#: Kept as a literal so this module does not import the permission registry at
#: definition time; the value is `module_permissions.Tier.ALWAYS_APPROVAL.value`
#: and a test asserts they have not drifted apart.
TIER_ALWAYS_APPROVAL = "always_approval"


class _Broker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_token: dict[str, Capability] = {}
        self._by_identity: dict[str, str] = {}

    def mint(
        self,
        *,
        tool_name: str,
        tool_call_id: str,
        args: Any,
        source: str,
        session_id: str = "",
        tier: str = TIER_ALWAYS_APPROVAL,
        receipt: str = "",
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        now: Optional[float] = None,
    ) -> Capability:
        """Create a capability. Call this **only** at a trusted response boundary.

        Every refusal here is a fail-closed refusal: a missing call id, an
        unknown source, or an ALWAYS_APPROVAL tool being minted from anything
        other than a person answering now.

        That last rule is the one the tier system is *for*. It holds here, in
        the broker, and not only in the caller — a caller that forgets it, or a
        future caller that never knew it, cannot mint a standing grant for a
        tool the owner declared always-ask.
        """
        if not tool_name:
            raise CapabilityError("a capability needs the tool it authorises")
        if not tool_call_id:
            raise CapabilityError(
                "a capability needs the call it authorises; refusing to mint one "
                "that could match any call"
            )
        if source not in _VALID_SOURCES:
            raise CapabilityError(f"unknown capability source {source!r}")
        if tier == TIER_ALWAYS_APPROVAL and source != SOURCE_HUMAN:
            raise CapabilityError(
                f"{tool_name} is always-approval and cannot be authorised by "
                f"{source!r}; only a person answering this call can approve it"
            )
        if not receipt:
            raise CapabilityError(
                "a capability needs the identity of the response that created "
                "it; an approval nobody can be traced to is not evidence"
            )

        ts = time.time() if now is None else now
        cap = Capability(
            token=uuid.uuid4().hex,
            session_id=session_id or "",
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            args_fingerprint=argument_fingerprint(args),
            tier=tier,
            receipt=receipt,
            source=source,
            minted_at=ts,
            expires_at=ts + max(int(ttl_seconds), 0),
        )
        with self._lock:
            self._by_token[cap.token] = cap
            self._by_identity[cap.identity] = cap.token
        _record_grant(cap, args)
        return cap

    def consume(
        self,
        token: Optional[str] = None,
        *,
        tool_name: str,
        args: Any,
        session_id: str = "",
        tool_call_id: str = "",
        tier: Optional[str] = None,
        now: Optional[float] = None,
    ) -> Capability:
        """Spend a capability, or raise. Never returns False — refusals raise.

        Raising rather than returning a boolean is deliberate: a caller that
        forgets to check a boolean executes anyway, and this is the one check
        where forgetting must not be survivable.

        With no ``token``, the capability is looked up by the identity of the
        call being made. That is the production path: the chokepoint knows who
        it is, which call it is, and what the arguments finally became, and
        those four things are exactly what was approved.
        """
        ts = time.time() if now is None else now
        fingerprint = argument_fingerprint(args)

        with self._lock:
            # Popped, not read: spending is what makes it one-use, and doing it
            # under one lock means two concurrent replays cannot both win.
            if token:
                cap = self._by_token.pop(token, None)
                if cap is not None:
                    self._by_identity.pop(cap.identity, None)
            else:
                identity = call_identity(
                    session_id=session_id,
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    args_fingerprint=fingerprint,
                )
                held = self._by_identity.pop(identity, None)
                cap = self._by_token.pop(held, None) if held else None

        if cap is None:
            raise CapabilityError(
                f"{tool_name} requires the owner's approval and none was "
                "presented, or the one presented has already been used"
            )
        if cap.tool_name != tool_name:
            raise CapabilityError(
                f"the approval was for {cap.tool_name}, not {tool_name}"
            )
        if tool_call_id and cap.tool_call_id != tool_call_id:
            raise CapabilityError(
                f"the approval for {tool_name} was for a different tool call"
            )
        if session_id and cap.session_id and cap.session_id != session_id:
            raise CapabilityError(
                f"the approval for {tool_name} was given in another session"
            )
        if ts > cap.expires_at:
            raise CapabilityError(
                f"the approval for {tool_name} has expired; ask again"
            )
        if cap.args_fingerprint != fingerprint:
            raise CapabilityError(
                f"the arguments for {tool_name} changed after it was approved; "
                "the call being made is not the call that was agreed"
            )
        if tier is not None and cap.tier != tier:
            raise CapabilityError(
                f"{tool_name} was approved as {cap.tier!r} but is now {tier!r}; "
                "the tier changed after consent was given"
            )
        return cap

    def revoke_all(self) -> None:
        """Drop every live capability. For a stop, a logout, or a test."""
        with self._lock:
            self._by_token.clear()
            self._by_identity.clear()

    def revoke_session(self, session_id: str) -> int:
        """Drop every capability minted for one session. For /stop and /new."""
        with self._lock:
            doomed = [
                t for t, c in self._by_token.items() if c.session_id == session_id
            ]
            for t in doomed:
                cap = self._by_token.pop(t, None)
                if cap is not None:
                    self._by_identity.pop(cap.identity, None)
        return len(doomed)

    def live_count(self) -> int:
        with self._lock:
            return len(self._by_token)


def _record_grant(cap: Capability, args: Any) -> None:
    """Tell `approval_integrity` a *real* grant exists for this call.

    That module used to be fed by an unconditional snapshot taken before any
    consent, so a grant always existed and "verified" meant only "nobody
    mutated the payload". Feeding it from here instead means a grant exists if
    and only if somebody actually approved something.
    """
    try:
        from hermes_cli import approval_integrity

        approval_integrity.record_grant(
            cap.tool_call_id,
            cap.tool_name,
            args,
            context={"middleware": (f"capability:{cap.source}",)},
        )
    except Exception:
        pass


_broker = _Broker()

mint = _broker.mint
consume = _broker.consume
revoke_all = _broker.revoke_all
revoke_session = _broker.revoke_session
live_count = _broker.live_count


def requires_capability(tool_name: str, trusted_tools: tuple = ()) -> bool:
    """Whether this tool may not execute without one.

    Fails closed on *any* error: if the permission layer cannot answer, the
    answer is "yes, it needs approval". An exception here previously meant the
    tier was skipped, which turned a broken permission lookup into an open
    door.
    """
    try:
        from hermes_cli.module_permissions import Decision, resolve

        return resolve(tool_name, trusted_tools) is not Decision.ALLOW
    except Exception:
        return True
