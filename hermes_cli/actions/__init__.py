"""Action substrate — one declaration per mutating operation.

Phase 1 of the ambient layer. Everything downstream registers into this: undo
reads its rollback semantics, the automation ladder reads its consequence class,
the item card reads its effect sentence, and the agent reaches it through one
bounded tool rather than a per-action schema in every prompt.
"""
from hermes_cli.actions.registry import (
    ActionRegistry,
    ActionSpec,
    Consequence,
    LADDER_CAPPED,
    Rollback,
    registry,
)
from hermes_cli.actions.idempotency import IdempotencyStore, idempotency_key

__all__ = [
    "ActionRegistry",
    "ActionSpec",
    "Consequence",
    "IdempotencyStore",
    "LADDER_CAPPED",
    "Rollback",
    "idempotency_key",
    "registry",
]
