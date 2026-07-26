"""Capability declarations + pure lifecycle helpers (Python mirror).

Kept deliberately small and dependency-free so the agent-tool generator
(tools/capability_tools.py) and its tests can import it without pulling in the
web server. The declarations are the single source: JSON documents under
``definitions/`` that both this Python side and the dashboard UI (via GET
/api/capabilities) read — a capability is authored once and consumed twice.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# Capability declarations are JSON documents consumed by both the agent-tool
# generator (here) and the dashboard UI (via GET /api/capabilities). Each
# declares the entity, fields, an optional lifecycle (status field + states +
# legal transitions), views, and which operations the agent may perform. Note:
# "delete" is never exposed — a destructive op stays fail-safe.
#
# Two sources:
#   1. Core ``definitions/*.json`` — always loaded (the built-in hub areas).
#   2. Plugin modules — a directory under ``plugins/`` (bundled) or
#      ``~/.hermes/plugins/`` (user) carrying a ``capability.json`` (or
#      ``dashboard/capability.json``). This is how a capability-shaped module is
#      installed (drop the dir) and removed (delete it) with no per-module JS
#      bundle: the host's one generic renderer draws it. A declaration is *data*,
#      not executable code, so it loads by default; a disabled plugin's
#      declaration is skipped. Core ids win over plugin ids on collision.

_DEFINITIONS_DIR = Path(__file__).parent / "definitions"


def _disabled_plugin_names() -> set[str]:
    """Plugin keys the operator has disabled (best-effort; empty if unavailable)."""
    try:
        from hermes_cli.plugins import _get_disabled_plugins

        return _get_disabled_plugins()
    except Exception:
        return set()


def _plugin_module_dirs() -> list[Path]:
    """Base directories that may contain capability-module dirs."""
    dirs: list[Path] = []
    bundled = os.getenv("HERMES_BUNDLED_PLUGINS")
    dirs.append(Path(bundled) if bundled else Path(__file__).resolve().parents[2] / "plugins")
    try:
        from hermes_constants import get_hermes_home

        dirs.append(get_hermes_home() / "plugins")
    except Exception:
        pass
    return dirs


def _plugin_capability_files() -> list[Path]:
    """``capability.json`` files under enabled plugin-module directories."""
    out: list[Path] = []
    disabled = _disabled_plugin_names()
    for base in _plugin_module_dirs():
        try:
            if not base.is_dir():
                continue
            children = sorted(base.iterdir())
        except Exception:
            continue
        for child in children:
            if not child.is_dir() or child.name in disabled:
                continue
            for rel in ("capability.json", "dashboard/capability.json"):
                candidate = child / rel
                if candidate.is_file():
                    out.append(candidate)
    return out


def load_capabilities() -> list[dict[str, Any]]:
    """Load capability declarations — core first, then plugin modules — deduped
    by id (core wins). See the module docstring for the two sources."""
    files: list[Path] = []
    if _DEFINITIONS_DIR.is_dir():
        files.extend(sorted(_DEFINITIONS_DIR.glob("*.json")))
    files.extend(_plugin_capability_files())

    caps: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path in files:
        try:
            decl = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        cid = decl.get("id")
        if not cid or cid in seen:
            continue
        seen.add(cid)
        caps.append(decl)
    return caps


CAPABILITIES: list[dict[str, Any]] = load_capabilities()


def legal_transitions(lifecycle: dict[str, Any], from_status: str) -> list[str]:
    """Target states reachable from ``from_status`` (honouring a ``"*"`` from)."""
    out: list[str] = []
    seen: set[str] = set()
    for t in lifecycle.get("transitions", []):
        if t.get("from") in (from_status, "*"):
            for to in t.get("to", []):
                if to not in seen:
                    seen.add(to)
                    out.append(to)
    return out


def can_transition(lifecycle: dict[str, Any], from_status: str, to_status: str) -> bool:
    return to_status in legal_transitions(lifecycle, from_status)


def field_names(capability: dict[str, Any]) -> list[str]:
    return [f["name"] for f in capability.get("fields", [])]


def coerce_fields(capability: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    """Keep only declared fields from an agent-supplied payload (drops unknown
    keys so a capability's data shape stays what it declared)."""
    allowed = set(field_names(capability))
    return {k: v for k, v in data.items() if k in allowed}
