"""The chain from a human saying yes to a handler being allowed to run.

`execution_capability` describes what a capability *is*. `module_permissions`
describes which tools need one. This is the part that was missing between them:
the thing that actually asks a person, and mints only when a person answered.

Before this, nothing minted. The gate at `registry.dispatch()` could consume a
capability but no production path created one, so in `enforce` mode every
non-AUTO tool refused and in `observe` mode every non-AUTO tool ran. Meanwhile
`approval_integrity` recorded a "grant" for every gated call *before* any
consent existed, which made its verification mean only "nobody mutated the
payload" — a pre-consent pseudo-grant that read like evidence and was not.

The chain, in order, with the property each step carries:

1. **A real approval request reaches the human.** Through
   `tools.approval.request_tool_approval`, which is the same gate a dangerous
   shell command goes through — the same card, the same buttons, the same
   timeout, the same "silence is not consent".
2. **Only an authoritative positive response creates evidence.** The gate
   returns ``approved: True`` from five different places and only two of them
   are a person answering. It now calls back at the exact point each positive
   outcome is produced, naming which one it was, and does not call back at all
   on the two auto-approve paths where nobody consented.
3. **The capability is minted at that boundary** — inside the callback, in the
   approval thread, at the moment of consent. Not before it, and not by the
   caller afterwards.
4. **It is bound to the call**: session, tool call id, tool name, the argument
   hash as it stands at the execution chokepoint, the receipt of the response,
   the tier, and an expiry.
5. **Dispatch requires and compares those fields**, then consumes atomically
   before the handler is entered. A refusal means the handler was never called,
   which is the only kind of refusal worth having.
6. **Everything fails closed.** A missing correlation id, an unreadable trust
   list, a permission lookup that raises, a mint that fails, evidence that
   cannot be written — all of them refuse.

One consequence worth stating plainly: a tool with a finer-grained gate of its
own is now gated twice. `terminal` is the case that matters — it carries the
dangerous-command detector, which asks about `rm -rf` and not about `ls`. The
tier layer sits above that and asks about *the shell*, once, and the owner can
answer it permanently by trusting the tool. The per-command gate keeps firing
underneath regardless, because trusting the shell is not the same as trusting
every command in it.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from hermes_cli import execution_capability as capabilities
from hermes_cli.execution_capability import Capability, CapabilityError

logger = logging.getLogger(__name__)

#: How a gate's own account of who approved maps onto a capability source.
#: Anything not in here is not an authorisation this module knows how to
#: record, and is refused rather than guessed at.
_SOURCE_BY_DECISION = {
    "human_gateway": capabilities.SOURCE_HUMAN,
    "human_cli": capabilities.SOURCE_HUMAN,
    "standing_session": capabilities.SOURCE_STANDING,
    "standing_permanent": capabilities.SOURCE_STANDING,
    "owner_bypass": capabilities.SOURCE_OWNER_BYPASS,
}

#: Argument values longer than this are truncated in the approval preview. The
#: card has to describe the real action, but a 40KB file body pasted into a
#: notification is not a description of anything.
_PREVIEW_VALUE_CHARS = 300
_PREVIEW_MAX_KEYS = 24


def _tier_of(tool_name: str, args: Any = None):
    """The tier of this call — the declared one, possibly raised by its args.

    `tier_for_call` is used rather than `get_tier` because several tools are
    not one action: `browser_console` reads a log or evaluates JavaScript,
    `terminal` runs `ls` or `curl | sh`. The escalated tier is what decides
    `once_only` below, so the dangerous form of a tool the owner trusts is
    minted for that call and nothing else.
    """
    from hermes_cli.module_permissions import Tier, tier_for_call

    return tier_for_call(tool_name, args), Tier


def approval_preview(tool_name: str, args: Any) -> dict:
    """What the owner is being asked to judge.

    The card must describe the action being taken, so the arguments are shown
    rather than hidden — but run through the same redactor every other approval
    surface uses, and truncated, so a token that wandered into a payload does
    not get read aloud by a phone notification.
    """
    from agent.redact import redact_sensitive_text

    rendered: dict[str, str] = {}
    if isinstance(args, dict):
        for key in list(args)[:_PREVIEW_MAX_KEYS]:
            try:
                text = args[key] if isinstance(args[key], str) else repr(args[key])
            except Exception:
                text = "<unrenderable>"
            if len(text) > _PREVIEW_VALUE_CHARS:
                text = text[:_PREVIEW_VALUE_CHARS] + f"… (+{len(text) - _PREVIEW_VALUE_CHARS} chars)"
            rendered[str(key)] = redact_sensitive_text(text)
        if len(args) > _PREVIEW_MAX_KEYS:
            rendered["…"] = f"and {len(args) - _PREVIEW_MAX_KEYS} more arguments"
    elif args not in (None, {}):
        rendered["arguments"] = redact_sensitive_text(repr(args))[:_PREVIEW_VALUE_CHARS]
    return {"tool": tool_name, "arguments": rendered}


def authorise(
    *,
    tool_name: str,
    args: Any,
    session_id: str = "",
    tool_call_id: str = "",
    token: Optional[str] = None,
    trusted_tools: tuple = (),
    prompt: bool = True,
) -> Optional[Capability]:
    """Establish the right to run ``tool_name`` with exactly these arguments.

    Returns the spent capability, or None when the tool's tier does not need
    one. Raises `CapabilityError` on every other outcome — there is no falsy
    return that a caller could forget to check.

    ``session_id`` and ``tool_call_id`` default to empty only so the signature
    reads as keyword-only; both are *required* for a gated tool and refused
    below when absent. A capability that matches any session or any call is not
    scoped to either.

    ``prompt=False`` answers the question without asking anybody: an existing
    capability is still honoured, and its absence is a refusal rather than a
    reason to interrupt the owner. That is what `observe` mode needs. Asking
    while not enforcing produces a card whose answer is discarded — the call
    runs either way — which trains the owner that the cards do not mean
    anything, and is a much worse failure than the gap it was measuring.
    """
    from hermes_cli.module_permissions import Decision, resolve_call

    tier, Tier = _tier_of(tool_name, args)
    if resolve_call(tool_name, args, trusted_tools) is Decision.ALLOW:
        # Either AUTO, or an APPROVAL-tier tool the owner explicitly trusted.
        # Both are decisions the owner already made; neither needs a ticket.
        #
        # `resolve_call`, not `resolve`: the owner trusted a tool name, and
        # this asks whether that grant covers *these arguments*. It does not
        # cover the escalated forms — arbitrary JavaScript in the page, a
        # chosen output path, a dangerous shell command — which land at
        # ALWAYS_APPROVAL for this call and ignore the trusted set entirely.
        return None

    identity = dict(
        session_id=session_id,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        tier=tier.value,
    )

    if token:
        # An explicitly presented ticket is answered on its own terms, and
        # before the correlation-id requirement below: the token already
        # carries the binding it was minted with, so a caller that can produce
        # one has an approval to check rather than an approval to ask for.
        # Falling through to a fresh prompt would turn "you replayed a spent
        # approval" into "here, have another one".
        return capabilities.consume(token, args=args, **identity)

    if not tool_call_id or not tool_call_id.strip():
        # Without a correlation identity a capability cannot be bound to a
        # call, so there is nothing that could be approved. Refusing is the
        # only honest answer; the staged `observe` mode is where this shows up
        # as a measurable gap rather than a broken tool.
        raise CapabilityError(
            f"{tool_name} needs the owner's approval, but this call carries no "
            "tool call id to bind an approval to"
        )
    if not session_id or not session_id.strip():
        raise CapabilityError(
            f"{tool_name} needs the owner's approval, but this call carries no "
            "session id to bind an approval to"
        )

    try:
        return capabilities.consume(args=args, **identity)
    except CapabilityError:
        pass  # Nothing minted for this call yet — go and ask.

    if not prompt:
        # Measuring, not enforcing. The caller will let the call through and
        # record what it would have refused; interrupting the owner for an
        # answer that changes nothing is not measurement.
        raise CapabilityError(
            f"{tool_name} would need the owner's approval and none has been "
            "given for this call"
        )

    minted: list[Capability] = []

    def _on_response(
        choice: str, decided_by: str, receipt: str, actor: str
    ) -> None:
        """The trusted response boundary. Raising here refuses the action."""
        source = _SOURCE_BY_DECISION.get(decided_by)
        if source is None:
            raise CapabilityError(
                f"approval for {tool_name} arrived from an unrecognised "
                f"decision path {decided_by!r}"
            )
        if not actor or not actor.strip():
            # The transport did not tell us who answered. That is not a
            # formality: a grant nobody can be traced to cannot be reviewed,
            # revoked, or held against anyone, so it is not evidence of a
            # decision and must not become one.
            raise CapabilityError(
                f"approval for {tool_name} carried no approver identity"
            )
        cap = capabilities.mint(
            args=args,
            source=source,
            receipt=f"{decided_by}:{choice}:{receipt}",
            approver=actor.strip(),
            **identity,
        )
        # Persist the evidence before the capability is usable. If the audit
        # cannot record who approved what, the approval is revoked and the
        # handler is never entered — an action that happened with no record of
        # its authorisation is worse than an action that did not happen.
        if not _record_grant_durably(cap, args):
            capabilities.revoke(cap.token)
            raise CapabilityError(
                f"the approval for {tool_name} could not be recorded; refusing "
                "to run an action whose authorisation cannot be audited"
            )
        minted.append(cap)

    from tools.approval import request_tool_approval

    outcome = request_tool_approval(
        tool_name,
        f"{tool_name} is a {tier.value.replace('_', ' ')} tool and needs your "
        "approval to run",
        rule_key=f"tier:{tool_name}",
        preview=approval_preview(tool_name, args),
        # ALWAYS_APPROVAL means *this call and no other*: no session cache, no
        # --yolo, no cron auto-approve, nothing persisted. That restriction is
        # the entire difference between the two gated tiers.
        once_only=tier is Tier.ALWAYS_APPROVAL,
        on_authoritative_response=_on_response,
    )

    if not outcome.get("approved"):
        raise CapabilityError(
            outcome.get("message") or f"{tool_name} was not approved"
        )
    if not minted:
        # Approved, but by a path that authorises nobody: a cron job under
        # `cron_mode: approve`, or the historical non-interactive fall-open.
        # Those produce no consent and therefore no capability.
        raise CapabilityError(
            f"{tool_name} was allowed through without anyone approving it "
            "(no interactive user or gateway was present); refusing to treat "
            "that as consent"
        )

    # Spend it here rather than returning the minted object directly, so the
    # one-use property is exercised by the same code path a presented token
    # takes and cannot be true only on paper.
    return capabilities.consume(minted[0].token, args=args, **identity)


def _record_grant_durably(cap: Capability, args: Any) -> bool:
    """Write the approval to the audit log. False when it did not land.

    Returns rather than raises so the caller can revoke first. The audit call
    is deliberately *not* wrapped in a swallow-everything: the whole point of
    this record is that it exists, and "we tried" is not the same claim.
    """
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor=cap.approver,
            module="capability",
            tool=cap.tool_name,
            action="approval_granted",
            target=cap.tool_call_id,
            decision="approved",
            outcome="minted",
            detail={
                "session_id": cap.session_id,
                "tier": cap.tier,
                "source": cap.source,
                "receipt": cap.receipt,
                # The hash, never the arguments: this record must not become a
                # second place the payload lives.
                "args_fingerprint": cap.args_fingerprint,
                "expires_at": cap.expires_at,
            },
        )
        return True
    except Exception:
        return False
