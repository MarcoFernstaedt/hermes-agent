"""Universal undo — inverse operations recorded at the time of the action.

Phase 6 of the ambient layer. The psychology the brief is after is that
approvals get faster because mistakes are cheap; that only holds if "undo"
means the world actually changed back, which is why nothing here reports
success before it has been verified.
"""
from hermes_cli.undo.journal import (
    DEFAULT_IN_FLIGHT_TIMEOUT_SECONDS,
    DEFAULT_RETENTION_SECONDS,
    IN_FLIGHT_STATUSES,
    REPAIR_STATUSES,
    JournalEntry,
    UndoJournal,
    UndoNotPossible,
    permanence_sentence,
)

__all__ = [
    "DEFAULT_IN_FLIGHT_TIMEOUT_SECONDS",
    "DEFAULT_RETENTION_SECONDS",
    "IN_FLIGHT_STATUSES",
    "REPAIR_STATUSES",
    "JournalEntry",
    "UndoJournal",
    "UndoNotPossible",
    "permanence_sentence",
]
