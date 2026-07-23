"""Backend module registry — one registration mounts a module's UI + agent sides.

A ``ModuleSpec`` bundles the three things a module wires into the app:

- ``create_router(authorize)`` → the FastAPI ``APIRouter`` the UI calls.
- ``register_tools()`` → registers the agent tools (which call the same
  service the router does).
- ``startup()`` → optional idempotent migration / warm-up run at boot.

Plus ``settings_defaults`` merged into the global settings store. The registry
keeps these uniform so the web server mounts every module the same way and no
module is half-wired (a router with no tools, or tools with no UI).

This is the forward path for new modules (Media is the first). The existing
``jobs`` and ``life`` routers stay mounted the legacy way until they are
opportunistically migrated onto a ``ModuleSpec`` — moving working code for
tidiness alone isn't worth the regression risk.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

# FastAPI is imported lazily by callers; the registry only stores callables.
Authorize = Callable[..., Any]


@dataclass(frozen=True)
class ModuleSpec:
    """Declarative description of a backend module."""

    id: str
    # Given the shared auth dependency, return an APIRouter to include.
    create_router: Optional[Callable[[Authorize], Any]] = None
    # Register the module's agent tools (self-registers via tools.registry).
    register_tools: Optional[Callable[[], None]] = None
    # Idempotent startup work (schema migration, cache warm), run once at boot.
    startup: Optional[Callable[[], None]] = None
    # Default settings merged into the global store under this module id.
    settings_defaults: Dict[str, Any] = field(default_factory=dict)


_registry: "Dict[str, ModuleSpec]" = {}


def register_module(spec: ModuleSpec) -> None:
    """Register a module spec. Re-registering the same id replaces it."""
    _registry[spec.id] = spec


def get_modules() -> List[ModuleSpec]:
    return list(_registry.values())


def mount_modules(app: Any, authorize: Authorize) -> List[str]:
    """Include every registered module's router on ``app``. Returns the ids
    mounted. Modules without a router are skipped (slot/tool-only modules)."""
    mounted: List[str] = []
    for spec in _registry.values():
        if spec.create_router is None:
            continue
        app.include_router(spec.create_router(authorize))
        mounted.append(spec.id)
    return mounted


def register_all_tools() -> List[str]:
    """Run every module's tool registrar. Returns ids that registered tools."""
    registered: List[str] = []
    for spec in _registry.values():
        if spec.register_tools is None:
            continue
        spec.register_tools()
        registered.append(spec.id)
    return registered


def run_startup() -> None:
    """Run every module's idempotent startup hook. Each is guarded so one
    module's failure cannot block the others (or app boot)."""
    import logging

    logger = logging.getLogger(__name__)
    for spec in _registry.values():
        if spec.startup is None:
            continue
        try:
            spec.startup()
        except Exception:
            logger.warning("Module %s startup hook failed", spec.id, exc_info=True)


def settings_defaults() -> Dict[str, Dict[str, Any]]:
    """Merged per-module settings defaults, keyed by module id."""
    return {
        spec.id: dict(spec.settings_defaults)
        for spec in _registry.values()
        if spec.settings_defaults
    }


def _reset_for_tests() -> None:
    _registry.clear()
