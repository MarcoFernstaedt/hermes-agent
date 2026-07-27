"""Apply-handlers — the only code allowed to enact an approved proposal.

A handler is registered per proposal ``kind``. Applying a proposal dispatches to
its handler; a kind with no handler cannot be applied (fail-safe). Handlers run
only after a human has approved, and must be idempotent enough that a retry after
a transient failure is safe.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

# kind -> handler(payload) -> human-readable outcome string.
_HANDLERS: dict[str, Callable[[dict[str, Any]], str]] = {}


class ApplyError(RuntimeError):
    """A handler could not apply the proposal (surfaced to the reviewer)."""


def register_handler(kind: str, fn: Callable[[dict[str, Any]], str]) -> None:
    _HANDLERS[kind] = fn


def has_handler(kind: str) -> bool:
    return kind in _HANDLERS


def apply_payload(kind: str, payload: dict[str, Any]) -> str:
    handler = _HANDLERS.get(kind)
    if handler is None:
        raise ApplyError(f"no apply-handler registered for kind '{kind}'")
    return handler(payload)


# -- built-in handler: capability -----------------------------------------

def _apply_capability(payload: dict[str, Any]) -> str:
    """Persist an approved capability declaration to the user definitions dir.

    Re-validates at apply time (never trust a payload just because it was
    proposed) and writes only on success, so an approved-but-invalid declaration
    can never land as broken UI."""
    from hermes_cli.capabilities.declarations import _user_definitions_dir
    from hermes_cli.capabilities.schema import validate_declaration

    declaration = payload.get("declaration")
    if not isinstance(declaration, dict):
        raise ApplyError("payload.declaration must be an object")
    errors = validate_declaration(declaration)
    if errors:
        raise ApplyError("declaration failed validation: " + "; ".join(errors))

    target_dir = _user_definitions_dir()
    if target_dir is None:
        raise ApplyError("no writable capabilities directory available")
    target_dir.mkdir(parents=True, exist_ok=True)
    cid = declaration["id"]
    path = Path(target_dir) / f"{cid}.json"
    path.write_text(json.dumps(declaration, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return f"capability '{cid}' written to {path}"


def _apply_improvement(payload: dict[str, Any]) -> str:
    """A platform improvement proposal is advisory — approving it records the
    owner's intent to act; there is no code to run. (The follow-up, if any, is
    its own proposal.) So 'applying' just acknowledges it."""
    what = payload.get("action") or payload.get("recommendation") or "improvement"
    return f"acknowledged: {what}"


def register_builtin_handlers() -> None:
    """Register the handlers that ship with the platform. Idempotent."""
    register_handler("capability", _apply_capability)
    register_handler("improvement", _apply_improvement)


register_builtin_handlers()
