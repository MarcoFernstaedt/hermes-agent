"""Tiered permission model for module agent-tools.

Every capability a module exposes to the agent declares a permission tier.
The tier decides whether the agent may run the tool automatically or must get
explicit approval first. This is the single place that answer is computed, so
no module can accidentally ship a self-approving destructive tool.

Tiers
-----
- ``AUTO``: read-only or trivially reversible (search, list, get playback
  state, player transport). Runs without approval.
- ``APPROVAL``: creates something new (create event, append to note, add to a
  playlist, draft a reply). Requires approval by default, but the user may
  mark an individual tool "trusted" so it runs automatically thereafter.
- ``ALWAYS_APPROVAL``: destructive or irreversible, or it sends something on
  my behalf (send email, trash email, delete a note or event, respond to an
  invitation). Always requires explicit approval. It can NEVER be
  auto-approved — the trusted-tools set is ignored for this tier. That
  invariant is enforced here and covered by a test.

The registry has two sources. Each module's ``tools.py`` may declare its own
tiers at import time by calling ``register_tool_permission``; and
``hermes_cli.tool_tiers`` declares the whole production catalogue, applied
lazily on first lookup so there is no import-order rule to get wrong. The two
must agree — ``register_tool_permission`` raises on a conflicting tier, so a
module quietly downgrading a tool the catalogue classifies is a loud error
rather than a silent hole.

Per-call escalation
-------------------
A tier is a property of a tool name, and some tools are not one action. The
same ``browser_console`` that reads the page's log evaluates arbitrary
JavaScript when given ``expression``; the same ``terminal`` that runs
``git status`` runs ``curl … | sh``. Classifying those by name means either
gating the harmless majority or leaving the dangerous minority permanently
trustable — and "permanently trustable" is the specific failure, because the
owner marks the *name* trusted and the dangerous call inherits the grant.

``register_call_escalation`` attaches a predicate to a tool name that may
*raise* the tier for one call based on its arguments. It can never lower one:
the declared tier is a floor, so an escalation can only ever add friction.
A predicate that raises an exception escalates to ALWAYS_APPROVAL, because a
rule that could not decide has not decided the call is safe.

Resolution reads the user's trusted-tools set (persisted in the settings store)
and returns a decision. That decision is consumed at ``registry.dispatch()``,
which is the one place every tool call passes through: a tool that needs
approval cannot reach its handler without a one-use capability, and a
capability cannot exist without an authoritative human response. See
``hermes_cli.tool_capability`` for the chain between the two.
"""

from __future__ import annotations

import enum
import logging
import threading
from typing import Any, Callable, Dict, Iterable, Optional, Set

logger = logging.getLogger(__name__)


class Tier(str, enum.Enum):
    AUTO = "auto"
    APPROVAL = "approval"
    ALWAYS_APPROVAL = "always_approval"


class Decision(str, enum.Enum):
    ALLOW = "allow"
    REQUIRE_APPROVAL = "require_approval"


_lock = threading.RLock()
#: Tiers a module registered at runtime. Cleared by `_reset_for_tests`.
_registry: Dict[str, Tier] = {}
#: Tiers derived from an owner's *declaration* rather than from code — the
#: capability tools, whose names are not knowable until a capability is
#: written. Kept apart from `_registry` because clearing them is never right:
#: they are a property of what the owner declared, and `_register()` runs once
#: at import, so a reset used to lose them for the rest of the process and
#: every generated read tool silently became always-approval.
_declared: Dict[str, Tier] = {}
_catalogue_cache: Dict[str, Tier] | None = None

#: A rule that may raise one call's tier above its tool's declared tier.
#: Returns the tier this call deserves, or None to leave it alone.
CallEscalation = Callable[[Any], Optional[Tier]]

#: Per-call escalation rules, by tool name. Like `_declared`, these describe
#: what the build says rather than what a process accumulated, so
#: `_reset_for_tests` leaves them alone: losing them would silently downgrade
#: `browser_console(expression=...)` back to a read for the rest of the run.
_escalations: Dict[str, tuple] = {}

#: Strictness order. Used only to take a maximum — nothing here ever compares
#: for "less strict than" in a way that could pick the weaker of two answers.
_TIER_RANK = {Tier.AUTO: 0, Tier.APPROVAL: 1, Tier.ALWAYS_APPROVAL: 2}


def _catalogue() -> Dict[str, Tier]:
    """The declared production catalogue, as a lookup.

    Consulted on every miss rather than copied into the registry once. The
    first version applied it behind a one-shot flag, which made the answer
    depend on whether anything had cleared the registry since — a hazard with
    no upside, because the catalogue is static data and re-reading it is a dict
    lookup. A tier that can change depending on what ran earlier is not a tier.

    A failure to load leaves this empty, so every affected tool falls back to
    ALWAYS_APPROVAL. That is the correct direction to fail.
    """
    global _catalogue_cache
    if _catalogue_cache is None:
        try:
            from hermes_cli.tool_tiers import apply_escalations, catalogue

            _catalogue_cache = catalogue()
            # Loaded together, deliberately. The per-call escalations are part
            # of the same declaration as the tiers, and every lookup path goes
            # through here — so there is no import-order rule that could leave
            # `browser_console(expression=...)` classified as a read.
            apply_escalations()
        except Exception:  # pragma: no cover - defensive
            _catalogue_cache = {}
    return _catalogue_cache


def register_tool_permission(tool_name: str, tier: Tier) -> None:
    """Declare a tool's permission tier. Called at module-import time.

    Re-registering the same tool with the same tier is a harmless no-op;
    changing the tier of an already-registered tool raises, because a silent
    tier change could downgrade a destructive tool.
    """
    # The catalogue counts as an existing declaration, so a module quietly
    # disagreeing with it is a loud import error rather than a silent hole —
    # and it stays loud whether or not anything has cleared the registry.
    declared = _catalogue().get(tool_name)
    if declared is not None and declared != tier:
        raise ValueError(
            f"tool {tool_name!r} already registered as {declared.value!r}; "
            f"refusing to change to {tier.value!r}"
        )
    with _lock:
        existing = _registry.get(tool_name)
        if existing is not None and existing != tier:
            raise ValueError(
                f"tool {tool_name!r} already registered as {existing.value!r}; "
                f"refusing to change to {tier.value!r}"
            )
        _registry[tool_name] = tier


def declare_tool_permission(tool_name: str, tier: Tier) -> None:
    """Declare a tier for a tool generated from an owner's declaration.

    Same conflict rules as `register_tool_permission`; the difference is
    lifetime. These outlive a registry reset because they describe what was
    declared, not what a process happened to register.
    """
    declared = _catalogue().get(tool_name)
    if declared is not None and declared != tier:
        raise ValueError(
            f"tool {tool_name!r} already registered as {declared.value!r}; "
            f"refusing to change to {tier.value!r}"
        )
    with _lock:
        existing = _declared.get(tool_name)
        if existing is not None and existing != tier:
            raise ValueError(
                f"tool {tool_name!r} already declared as {existing.value!r}; "
                f"refusing to change to {tier.value!r}"
            )
        _declared[tool_name] = tier


def get_tier(tool_name: str) -> Tier:
    """Return a tool's tier. Unregistered tools default to ALWAYS_APPROVAL —
    fail safe: an unknown tool is treated as the most restrictive, never the
    least."""
    with _lock:
        registered = _registry.get(tool_name) or _declared.get(tool_name)
    if registered is not None:
        return registered
    return _catalogue().get(tool_name, Tier.ALWAYS_APPROVAL)


def register_call_escalation(tool_name: str, predicate: CallEscalation) -> None:
    """Attach a rule that may raise the tier of one call to ``tool_name``.

    Registering the same predicate object twice is a no-op, so an import that
    runs more than once does not stack duplicates. Order does not matter:
    `tier_for_call` takes the strictest answer, not the first.
    """
    with _lock:
        existing = _escalations.get(tool_name, ())
        if predicate in existing:
            return
        _escalations[tool_name] = existing + (predicate,)


def tier_for_call(tool_name: str, args: Any = None) -> Tier:
    """The tier of *this* call: the declared tier, possibly raised.

    The declared tier is a floor. An escalation that returns a weaker tier is
    ignored rather than honoured, so no rule added later can turn a gated tool
    into an ungated one by returning `Tier.AUTO`.
    """
    base = get_tier(tool_name)
    with _lock:
        predicates = _escalations.get(tool_name, ())
    if not predicates:
        return base

    strictest = base
    for predicate in predicates:
        try:
            raised = predicate(args)
        except Exception:
            # A rule that could not decide has not decided the call is safe.
            logger.warning(
                "permission escalation for %s raised; treating the call as "
                "always-approval", tool_name, exc_info=True,
            )
            return Tier.ALWAYS_APPROVAL
        if raised is None:
            continue
        if not isinstance(raised, Tier):
            return Tier.ALWAYS_APPROVAL
        if _TIER_RANK[raised] > _TIER_RANK[strictest]:
            strictest = raised
    return strictest


def resolve(tool_name: str, trusted_tools: Iterable[str] = ()) -> Decision:
    """Decide whether ``tool_name`` may run automatically.

    ``trusted_tools`` is the user's opt-in set of APPROVAL-tier tools that
    should run without prompting. It has NO effect on ALWAYS_APPROVAL tools.

    This answers the question at the level of a *name*, which is what the
    settings UI asks. The gate asks about a call and must use `resolve_call`:
    a tool whose dangerous form is reachable through an argument is not
    described by its name alone.
    """
    tier = get_tier(tool_name)
    if tier is Tier.AUTO:
        return Decision.ALLOW
    if tier is Tier.ALWAYS_APPROVAL:
        # Non-negotiable: destructive/irreversible tools always prompt.
        return Decision.REQUIRE_APPROVAL
    # APPROVAL tier: allow only if the user has explicitly trusted this tool.
    trusted: Set[str] = set(trusted_tools)
    return Decision.ALLOW if tool_name in trusted else Decision.REQUIRE_APPROVAL


def resolve_call(
    tool_name: str, args: Any = None, trusted_tools: Iterable[str] = ()
) -> Decision:
    """Decide whether *this call* to ``tool_name`` may run automatically.

    Same rules as `resolve`, applied to the escalated tier. The consequence
    worth stating: a tool the owner marked trusted still prompts for the
    arguments an escalation raised to ALWAYS_APPROVAL, because that tier
    ignores the trusted set by construction.
    """
    tier = tier_for_call(tool_name, args)
    if tier is Tier.AUTO:
        return Decision.ALLOW
    if tier is Tier.ALWAYS_APPROVAL:
        return Decision.REQUIRE_APPROVAL
    trusted: Set[str] = set(trusted_tools)
    return Decision.ALLOW if tool_name in trusted else Decision.REQUIRE_APPROVAL


def can_be_trusted(tool_name: str) -> bool:
    """True if it is even legal to add this tool to the trusted set. Guards the
    settings UI so an ALWAYS_APPROVAL tool can never be offered an
    auto-approve toggle."""
    return get_tier(tool_name) is Tier.APPROVAL


def registered_permissions() -> Dict[str, str]:
    """Snapshot of tool -> tier for diagnostics / the settings UI."""
    with _lock:
        merged = {**_catalogue(), **_declared, **_registry}
    return {name: tier.value for name, tier in sorted(merged.items())}


def _reset_for_tests() -> None:
    """Clear runtime registrations. The catalogue is data, not state.

    A test that resets this gets the declared tiers back, because those are not
    something the process accumulated — they are what the build says.
    """
    with _lock:
        _registry.clear()
