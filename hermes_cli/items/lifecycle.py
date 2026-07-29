"""The item lifecycle — one aggregate, one validated transition model.

An earlier draft of this used `pending → acknowledged → resolved(approved|…)`.
That model is wrong in a way that matters: **approval is a decision, not proof
that anything happened.** A card that collapses to "approved" the instant the
owner clicks it will show a green tick for an email that never sent, and the
owner will find out days later from the person who never replied.

So the lifecycle separates three things the old model conflated:

1. **Surfacing** — the item exists and may need attention (`open`,
   `acknowledged`, `awaiting_decision`, `snoozed`).
2. **Deciding** — the owner has chosen (`approved`, `denied`, `expired`,
   `canceled`).
3. **Executing** — the world was actually changed, and we verified it
   (`queued`, `executing`, `succeeded`, `failed`), plus the reversal path
   (`compensating`, `compensated`, `compensation_failed`).

`succeeded` is reachable *only* from `executing`, so nothing can report success
without having run. That is the whole point of the state machine.
"""
from __future__ import annotations

from enum import Enum
from typing import Iterable


class State(str, Enum):
    # -- surfacing ---------------------------------------------------------
    OPEN = "open"
    ACKNOWLEDGED = "acknowledged"
    AWAITING_DECISION = "awaiting_decision"
    MODIFYING = "modifying"
    SNOOZED = "snoozed"
    # -- decided -----------------------------------------------------------
    DENIED = "denied"
    EXPIRED = "expired"
    CANCELED = "canceled"
    APPROVED = "approved"
    # -- executing ---------------------------------------------------------
    QUEUED = "queued"
    EXECUTING = "executing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    # -- reversal ----------------------------------------------------------
    COMPENSATING = "compensating"
    COMPENSATED = "compensated"
    COMPENSATION_FAILED = "compensation_failed"


class NotificationClass(str, Enum):
    """Sort order and interrupt policy. Order of declaration is the sort order."""

    BLOCKING = "blocking"
    ACTIONABLE = "actionable"
    OPPORTUNITY = "opportunity"
    INFORMATIONAL = "informational"


#: Sort rank. Blocking first because Imperator cannot continue without an answer.
CLASS_RANK: dict[str, int] = {
    NotificationClass.BLOCKING.value: 0,
    NotificationClass.ACTIONABLE.value: 1,
    NotificationClass.OPPORTUNITY.value: 2,
    NotificationClass.INFORMATIONAL.value: 3,
}

#: Only blocking items may interrupt. Everything else accumulates into the
#: digest — the brief's default is batching, with interruption the exception.
MAY_TOAST: frozenset[str] = frozenset({NotificationClass.BLOCKING.value})

#: States where the item is done and needs nothing further from anyone.
TERMINAL: frozenset[State] = frozenset({
    State.DENIED,
    State.EXPIRED,
    State.CANCELED,
    State.SUCCEEDED,
    State.COMPENSATED,
})

#: Done, but *badly* — these stay visible because a human may need to repair
#: them. A failed compensation in particular means the world is in a state we
#: tried and failed to undo, which is the one outcome that must never go quiet.
NEEDS_ATTENTION: frozenset[State] = frozenset({
    State.FAILED,
    State.COMPENSATION_FAILED,
})

#: The legal moves. Everything not listed here is refused, so an impossible
#: history cannot be written even by a buggy caller.
TRANSITIONS: dict[State, frozenset[State]] = {
    State.OPEN: frozenset({
        State.ACKNOWLEDGED, State.AWAITING_DECISION, State.SNOOZED,
        State.EXPIRED, State.CANCELED,
    }),
    State.ACKNOWLEDGED: frozenset({
        State.AWAITING_DECISION, State.SNOOZED, State.EXPIRED, State.CANCELED,
    }),
    State.AWAITING_DECISION: frozenset({
        State.MODIFYING, State.APPROVED, State.DENIED, State.SNOOZED,
        State.EXPIRED, State.CANCELED,
    }),
    # Modifying returns to a decision with a *new* artifact version, so the
    # owner always approves the exact payload they last looked at.
    State.MODIFYING: frozenset({State.AWAITING_DECISION, State.CANCELED}),
    State.SNOOZED: frozenset({
        State.OPEN, State.AWAITING_DECISION, State.EXPIRED, State.CANCELED,
    }),
    # A decision hands off to execution. Approval alone is never an outcome.
    State.APPROVED: frozenset({State.QUEUED, State.CANCELED}),
    State.QUEUED: frozenset({State.EXECUTING, State.CANCELED, State.FAILED}),
    State.EXECUTING: frozenset({State.SUCCEEDED, State.FAILED}),
    # A retry after failure re-enters the queue rather than jumping to running.
    State.FAILED: frozenset({State.QUEUED, State.CANCELED}),
    # Undo runs against something that actually happened.
    State.SUCCEEDED: frozenset({State.COMPENSATING}),
    State.COMPENSATING: frozenset({State.COMPENSATED, State.COMPENSATION_FAILED}),
    # A failed compensation may be retried; it never silently becomes fine.
    State.COMPENSATION_FAILED: frozenset({State.COMPENSATING}),
    State.COMPENSATED: frozenset(),
    State.DENIED: frozenset(),
    State.EXPIRED: frozenset(),
    State.CANCELED: frozenset(),
}


class IllegalTransition(ValueError):
    """Raised for a move the lifecycle does not allow."""

    def __init__(self, frm: State, to: State) -> None:
        allowed = ", ".join(sorted(s.value for s in TRANSITIONS.get(frm, frozenset())))
        super().__init__(
            f"cannot move item from {frm.value!r} to {to.value!r}; "
            f"allowed from {frm.value!r}: {allowed or '(terminal)'}"
        )
        self.frm = frm
        self.to = to


def can_transition(frm: State | str, to: State | str) -> bool:
    return State(to) in TRANSITIONS.get(State(frm), frozenset())


def assert_transition(frm: State | str, to: State | str) -> None:
    f, t = State(frm), State(to)
    if t not in TRANSITIONS.get(f, frozenset()):
        raise IllegalTransition(f, t)


def is_terminal(state: State | str) -> bool:
    return State(state) in TERMINAL


def needs_attention(state: State | str) -> bool:
    return State(state) in NEEDS_ATTENTION


def is_decided(state: State | str) -> bool:
    """Has the owner chosen? Distinct from whether anything has happened yet."""
    s = State(state)
    return s not in {
        State.OPEN, State.ACKNOWLEDGED, State.AWAITING_DECISION,
        State.MODIFYING, State.SNOOZED,
    }


def is_executed(state: State | str) -> bool:
    """Did the action actually run and get verified?

    Deliberately narrow: `approved` is *not* executed, which is the distinction
    the whole module exists to preserve.
    """
    return State(state) in {
        State.SUCCEEDED, State.COMPENSATING, State.COMPENSATED,
        State.COMPENSATION_FAILED,
    }


def sort_key(item: dict) -> tuple:
    """Stream ordering: class rank, then oldest first within a class."""
    rank = CLASS_RANK.get(item.get("klass", NotificationClass.INFORMATIONAL.value), 99)
    return (rank, item.get("created_at", 0.0), item.get("id", ""))


def may_interrupt(item: dict, *, stream_focused: bool) -> bool:
    """Whether this item may toast.

    Two conditions, both required: it is blocking, and the owner is not already
    looking at the stream. Toasting what someone is already reading is the
    duplicate-announcement problem in its most irritating form.
    """
    if stream_focused:
        return False
    if item.get("klass") not in MAY_TOAST:
        return False
    return not is_decided(item.get("state", State.OPEN))


def open_states() -> Iterable[State]:
    """States where the item is still waiting on a person."""
    return (
        State.OPEN, State.ACKNOWLEDGED, State.AWAITING_DECISION,
        State.MODIFYING, State.SNOOZED,
    )
