"""The action registry — one declaration per mutating operation.

Structural parity, made structural. A mutating operation is declared once here
and that single declaration drives its API validation, its permission tier, its
idempotency behaviour, its audit shape, its rollback semantics, and the agent's
access to it. The web interface has no privileged mutation path: it calls the
same registered action the agent would.

Two design rules are load-bearing and both came from review.

**Rollback is a three-way choice, not a boolean.** An earlier draft required
each action to declare either an inverse or the literal IRREVERSIBLE. That is
wrong in a way that would have shipped quiet lies: a calendar update, an
external label change, or a Home Assistant call has no transactionally reliable
undo, but it is not irreversible either — it has a *compensation*, a best-effort
second action whose success has to be verified against the source. Collapsing
compensation into "inverse" would let the UI promise an undo it cannot deliver.
So:

- ``inverse``       — a restoration we control transactionally. Undo is truthful.
- ``compensation``  — a best-effort reversal that must be verified at the source.
- ``irreversible``  — no safe reversal exists; say so at approval time.

**The agent surface stays narrow.** Every registered action is *reachable* by
the agent, but registration does not mint a core model tool. Hermes pays for
every core tool schema on every model call, so a registry of hundreds of actions
would inflate the prompt for every turn regardless of relevance. Actions are
invoked through a small bounded surface (``hub_action``) that resolves an action
id at call time. Parity without prompt cost.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional


class Rollback(str, Enum):
    """How, or whether, an action can be taken back."""

    INVERSE = "inverse"
    COMPENSATION = "compensation"
    IRREVERSIBLE = "irreversible"


class Consequence(str, Enum):
    """Blast radius, which drives approval policy and the automation ladder.

    Deliberately *not* "does it write?". Consequence-based authority is the
    locked operating model: ordinary reversible internal work should not need
    repeated approval, while anything that leaves the machine or cannot be taken
    back does — regardless of how small the diff is.
    """

    #: Reads and inspection. No state change.
    NONE = "none"
    #: Reversible, internal, ours. Safe to execute without repeated approval.
    INTERNAL_REVERSIBLE = "internal_reversible"
    #: Internal but not cleanly reversible (hard delete past retention).
    INTERNAL_IRREVERSIBLE = "internal_irreversible"
    #: Changes state in a third-party system we do not own.
    EXTERNAL_REVERSIBLE = "external_reversible"
    #: Leaves the machine and cannot be recalled: sends, spend, signing, posts.
    EXTERNAL_IRREVERSIBLE = "external_irreversible"
    #: Changes the platform's own authority: credentials, scopes, plugins.
    AUTHORITY = "authority"


#: Consequence classes that may never reach the ladder's autonomous rung.
#: Capped at rung 4 ("executes after exact approval") no matter how much trust
#: history an action accumulates.
LADDER_CAPPED = frozenset({
    Consequence.EXTERNAL_IRREVERSIBLE,
    Consequence.INTERNAL_IRREVERSIBLE,
    Consequence.AUTHORITY,
})

_ID_RE = re.compile(r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$")


@dataclass(frozen=True)
class ActionSpec:
    """One mutating operation, declared once.

    ``rollback`` and ``rollback_detail`` are checked together at registration:
    an INVERSE or COMPENSATION must name the action that performs it, and an
    IRREVERSIBLE must state why. There is no fourth option and no default, so
    "nobody thought about undo" cannot pass registration.
    """

    id: str
    label: str
    module: str
    consequence: Consequence
    rollback: Rollback
    handler: Callable[..., Any]
    #: For INVERSE/COMPENSATION: the action id that reverses this one.
    #: For IRREVERSIBLE: a plain-language reason, shown at approval time.
    rollback_detail: str
    #: JSON Schema for the typed input. Validated identically for UI and agent.
    input_schema: dict[str, Any] = field(default_factory=dict)
    #: Permission tier name; resolved against module_permissions at dispatch.
    tier: str = "APPROVAL"
    #: Whether repeats with the same idempotency key must collapse to one run.
    idempotent: bool = True
    #: Human sentence describing what happens on approval. Shown on the card.
    effect: str = ""
    #: Surfaces this action should appear on (menu, palette, context).
    surfaces: tuple[str, ...] = ()

    @property
    def mutating(self) -> bool:
        return self.consequence is not Consequence.NONE

    @property
    def ladder_capped(self) -> bool:
        """True when this action can never be promoted to autonomous."""
        return self.consequence in LADDER_CAPPED

    @property
    def reversible(self) -> bool:
        """Whether the UI may offer undo. Compensation counts — with verification."""
        return self.rollback in (Rollback.INVERSE, Rollback.COMPENSATION)


class ActionRegistry:
    """The one place a mutating operation is declared."""

    def __init__(self) -> None:
        self._actions: dict[str, ActionSpec] = {}

    def register(self, spec: ActionSpec) -> ActionSpec:
        if not _ID_RE.match(spec.id):
            raise ValueError(
                f"action id {spec.id!r} must be 'module.verb' in lower_snake_case"
            )
        if spec.id in self._actions:
            raise ValueError(f"action {spec.id!r} is already registered")

        # The check that makes undo structural rather than aspirational.
        if spec.mutating:
            if not spec.rollback_detail.strip():
                raise ValueError(
                    f"action {spec.id!r} declares rollback={spec.rollback.value} "
                    "but no rollback_detail: name the reversing action, or state "
                    "why no safe reversal exists"
                )
            if spec.rollback in (Rollback.INVERSE, Rollback.COMPENSATION):
                if not _ID_RE.match(spec.rollback_detail):
                    raise ValueError(
                        f"action {spec.id!r} declares rollback={spec.rollback.value} "
                        f"so rollback_detail must be the reversing action id, got "
                        f"{spec.rollback_detail!r}"
                    )
        elif spec.rollback is not Rollback.IRREVERSIBLE:
            # A read cannot be undone because it changed nothing. Forcing it to
            # claim an inverse would make the registry lie about its own shape.
            raise ValueError(
                f"action {spec.id!r} has consequence=none and must declare "
                "rollback=IRREVERSIBLE with detail 'no state change'"
            )
        return self._register(spec)

    def _register(self, spec: ActionSpec) -> ActionSpec:
        self._actions[spec.id] = spec
        return spec

    def get(self, action_id: str) -> Optional[ActionSpec]:
        return self._actions.get(action_id)

    def all(self) -> list[ActionSpec]:
        return sorted(self._actions.values(), key=lambda s: s.id)

    def mutating(self) -> list[ActionSpec]:
        return [s for s in self.all() if s.mutating]

    def for_surface(self, surface: str) -> list[ActionSpec]:
        """Actions that should appear on a given surface.

        The menu, the context menu and the command palette all read from here,
        so an action cannot exist in one and be missing from another.
        """
        return [s for s in self.all() if surface in s.surfaces]

    def unresolved_rollbacks(self) -> list[str]:
        """Mutating actions whose reversing action is not itself registered.

        The build-time guard: declaring `rollback_detail="mail.unarchive"` is
        worthless if nothing by that name exists. Returns human-readable
        problems so a failing test can name the offender.
        """
        problems: list[str] = []
        for spec in self.mutating():
            if spec.rollback is Rollback.IRREVERSIBLE:
                continue
            if spec.rollback_detail not in self._actions:
                problems.append(
                    f"{spec.id} declares {spec.rollback.value} via "
                    f"{spec.rollback_detail!r}, which is not registered"
                )
        return problems


registry = ActionRegistry()
