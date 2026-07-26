"""Session capability scopes + the global stop — server-enforced agent guardrails.

A chat session runs in a named *scope* that switches whole tool categories off.
The scope is enforced at the one place every tool call passes through
(``tools.registry.ToolRegistry.dispatch``): a scoped-out tool is **refused**,
not merely hidden. The *global stop* is a persisted flag that halts all
agent-initiated tool activity at the same chokepoint.

Enforcement only engages when an agent turn has *armed* a scope (a contextvar the
runtime sets per turn). Internal/system tool calls — which never arm a scope —
are never gated, so this can't break machinery that legitimately calls tools.

Scopes are expressed over the existing permission tiers (module_permissions):

* ``full``       — everything (subject to the normal approval tiers). Default.
* ``read_only``  — only AUTO-tier reads. Nothing writes, sends, or deletes.
* ``research``   — reads everywhere, no writes (same guarantee as read_only).
* ``triage``     — AUTO + APPROVAL, but writes only in the ``email`` toolset, so
                   it can label/archive email yet never send (ALWAYS_APPROVAL)
                   or touch any other module.
"""
from __future__ import annotations

import json
import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from hermes_cli.module_permissions import Tier, get_tier

DEFAULT_SCOPE = "full"

# Armed per agent turn by the runtime; None means "not an agent call" (internal
# machinery) and enforcement is skipped entirely for that call.
_ACTIVE_SCOPE: ContextVar[Optional[str]] = ContextVar("imperator_active_scope", default=None)

_STATE_LOCK = threading.Lock()

# The halt flag is consulted on every dispatch; cache it briefly so a global stop
# doesn't cost a file read per tool call. Invalidated immediately on write.
_HALT_CACHE: dict[str, float | bool] = {"value": False, "ts": 0.0}
_HALT_TTL_SECONDS = 0.5


@dataclass(frozen=True)
class Scope:
    name: str
    label: str
    description: str
    allow_tiers: frozenset[Tier]
    # When set, non-AUTO (write) tools are permitted only in these toolsets.
    write_toolsets: Optional[frozenset[str]] = None


BUILTIN_SCOPES: dict[str, Scope] = {
    "full": Scope(
        "full", "Full", "Every tool, subject to the normal approval tiers.",
        frozenset({Tier.AUTO, Tier.APPROVAL, Tier.ALWAYS_APPROVAL}),
    ),
    "read_only": Scope(
        "read_only", "Read-only", "Only reads. Nothing writes, sends, or deletes.",
        frozenset({Tier.AUTO}),
    ),
    "research": Scope(
        "research", "Research", "Reads everywhere; no writes anywhere.",
        frozenset({Tier.AUTO}),
    ),
    "triage": Scope(
        "triage", "Triage", "Reads, plus label/archive email — never send, delete, or other writes.",
        frozenset({Tier.AUTO, Tier.APPROVAL}),
        write_toolsets=frozenset({"email"}),
    ),
}


def list_scopes() -> list[dict]:
    return [
        {"name": s.name, "label": s.label, "description": s.description}
        for s in BUILTIN_SCOPES.values()
    ]


def _toolset_of(tool_name: str) -> str:
    try:
        from tools.registry import registry

        entry = registry.get_entry(tool_name)
        return getattr(entry, "toolset", "") or ""
    except Exception:
        return ""


def scope_permits(scope_name: str, tool_name: str) -> bool:
    """Whether ``scope_name`` allows ``tool_name`` to run at all."""
    scope = BUILTIN_SCOPES.get(scope_name) or BUILTIN_SCOPES[DEFAULT_SCOPE]
    tier = get_tier(tool_name)
    if tier not in scope.allow_tiers:
        return False
    if tier is not Tier.AUTO and scope.write_toolsets is not None:
        return _toolset_of(tool_name) in scope.write_toolsets
    return True


# -- active scope (per agent turn) -----------------------------------------

def set_active_scope(scope_name: Optional[str]):
    """Arm the scope for the current call stack (an agent turn). Returns the
    token so the runtime can reset it. ``None`` disarms enforcement."""
    return _ACTIVE_SCOPE.set(scope_name)


def get_active_scope() -> Optional[str]:
    return _ACTIVE_SCOPE.get()


def reset_active_scope(token) -> None:
    try:
        _ACTIVE_SCOPE.reset(token)
    except Exception:
        pass


# -- persisted global stop + per-session scope -----------------------------

def _state_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "state" / "agent-guardrails.json"


def _load_state() -> dict:
    try:
        return json.loads(_state_path().read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(state: dict) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state), encoding="utf-8")


def is_agent_halted() -> bool:
    now = time.monotonic()
    with _STATE_LOCK:
        if now - float(_HALT_CACHE["ts"]) < _HALT_TTL_SECONDS:
            return bool(_HALT_CACHE["value"])
        value = bool(_load_state().get("halted", False))
        _HALT_CACHE["value"] = value
        _HALT_CACHE["ts"] = now
        return value


def set_agent_halt(halted: bool) -> bool:
    with _STATE_LOCK:
        state = _load_state()
        state["halted"] = bool(halted)
        _save_state(state)
        _HALT_CACHE["value"] = bool(halted)
        _HALT_CACHE["ts"] = time.monotonic()
    return bool(halted)


def get_session_scope(session_id: str) -> str:
    with _STATE_LOCK:
        scopes = _load_state().get("session_scopes", {})
    scope = scopes.get(session_id, DEFAULT_SCOPE)
    return scope if scope in BUILTIN_SCOPES else DEFAULT_SCOPE


def set_session_scope(session_id: str, scope_name: str) -> str:
    if scope_name not in BUILTIN_SCOPES:
        raise ValueError(f"unknown scope: {scope_name}")
    with _STATE_LOCK:
        state = _load_state()
        state.setdefault("session_scopes", {})[session_id] = scope_name
        _save_state(state)
    return scope_name


# -- the enforcement gate (called from registry.dispatch) ------------------

def enforce_dispatch(tool_name: str) -> Optional[str]:
    """Return a refusal message if this tool call must be blocked, else None.

    The global stop is unconditional: once engaged it halts *all* tool activity
    at the chokepoint, whether or not a scope is armed. The per-scope restriction
    applies only to armed agent turns — an unarmed internal/system call carries no
    scope and is never scope-gated.
    """
    if is_agent_halted():
        return (
            "Agent halted — all tool activity is paused by the global stop. "
            "Release the stop to continue."
        )
    scope = _ACTIVE_SCOPE.get()
    if scope is None:
        return None
    if not scope_permits(scope, tool_name):
        return (
            f"Tool '{tool_name}' is not permitted in the '{scope}' session scope."
        )
    return None
