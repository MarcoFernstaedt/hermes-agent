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

Four properties make it worth having:

*Bound to the call.* The token carries the tool name and a fingerprint of the
arguments. Approving one call cannot execute a different one, and mutating
arguments between consent and execution invalidates the token rather than
silently widening what was agreed.

*One use.* `consume()` succeeds once. A replayed token is refused, so a retry
loop cannot turn one approval into several executions.

*Short-lived.* Consent goes stale. A token that outlives the conversation it
came from is a standing grant nobody remembers giving.

*Fail closed.* Every path that cannot establish a capability refuses, including
the paths where the check itself fails. An exception in the permission layer
must never read as permission.
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
SOURCE_HUMAN = "human"          # a person answered a prompt or a card
SOURCE_TRUSTED_TOOL = "trusted" # an APPROVAL-tier tool the owner opted in to
SOURCE_STANDING = "standing"    # an explicitly modelled scoped exception

_VALID_SOURCES = frozenset({SOURCE_HUMAN, SOURCE_TRUSTED_TOOL, SOURCE_STANDING})


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


@dataclass(frozen=True)
class Capability:
    token: str
    tool_name: str
    tool_call_id: str
    args_fingerprint: str
    source: str
    minted_at: float


class _Broker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._live: dict[str, Capability] = {}

    def mint(
        self,
        *,
        tool_name: str,
        tool_call_id: str,
        args: Any,
        source: str,
        now: Optional[float] = None,
    ) -> Capability:
        """Create a capability. Call this **only** after a real decision.

        `tool_call_id` is required and must be non-empty: without a correlation
        identity there is no way to tell which call a decision belonged to, and
        a capability that could match any call is not a capability. Failing
        closed here is the point.
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

        cap = Capability(
            token=uuid.uuid4().hex,
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            args_fingerprint=argument_fingerprint(args),
            source=source,
            minted_at=time.time() if now is None else now,
        )
        with self._lock:
            self._live[cap.token] = cap
        return cap

    def consume(
        self,
        token: Optional[str],
        *,
        tool_name: str,
        args: Any,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        now: Optional[float] = None,
    ) -> Capability:
        """Spend a capability, or raise. Never returns False — refusals raise.

        Raising rather than returning a boolean is deliberate: a caller that
        forgets to check a boolean executes anyway, and this is the one check
        where forgetting must not be survivable.
        """
        ts = time.time() if now is None else now
        if not token:
            raise CapabilityError(
                f"{tool_name} requires approval and no approval was presented"
            )
        with self._lock:
            # Popped, not read: spending is what makes it one-use, and doing it
            # under the same lock means two concurrent replays cannot both win.
            cap = self._live.pop(token, None)
        if cap is None:
            raise CapabilityError(
                f"the approval presented for {tool_name} is not valid, or has "
                "already been used"
            )
        if cap.tool_name != tool_name:
            raise CapabilityError(
                f"the approval was for {cap.tool_name}, not {tool_name}"
            )
        if ts - cap.minted_at > ttl_seconds:
            raise CapabilityError(
                f"the approval for {tool_name} has expired; ask again"
            )
        if cap.args_fingerprint != argument_fingerprint(args):
            raise CapabilityError(
                f"the arguments for {tool_name} changed after it was approved; "
                "the call being made is not the call that was agreed"
            )
        return cap

    def revoke_all(self) -> None:
        """Drop every live capability. For a stop, a logout, or a test."""
        with self._lock:
            self._live.clear()

    def live_count(self) -> int:
        with self._lock:
            return len(self._live)


_broker = _Broker()

mint = _broker.mint
consume = _broker.consume
revoke_all = _broker.revoke_all
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
