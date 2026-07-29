"""The item stream — one record, many projections.

Phase 2 of the ambient layer. The review queue, the notification stream, the
shell glance and chat's reference chips all read this one table; none of them
keeps its own copy of an item's state.
"""
from hermes_cli.items.lifecycle import (
    CLASS_RANK,
    IllegalTransition,
    MAY_TOAST,
    NEEDS_ATTENTION,
    NotificationClass,
    State,
    TERMINAL,
    TRANSITIONS,
    assert_transition,
    can_transition,
    is_decided,
    is_executed,
    is_terminal,
    may_interrupt,
    needs_attention,
    sort_key,
)

__all__ = [
    "CLASS_RANK",
    "IllegalTransition",
    "MAY_TOAST",
    "NEEDS_ATTENTION",
    "NotificationClass",
    "State",
    "TERMINAL",
    "TRANSITIONS",
    "assert_transition",
    "can_transition",
    "is_decided",
    "is_executed",
    "is_terminal",
    "may_interrupt",
    "needs_attention",
    "sort_key",
]
